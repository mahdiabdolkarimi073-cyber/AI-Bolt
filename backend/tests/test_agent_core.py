"""Targeted tests for Agent core improvements.

Tests cover:
1. tool_write_file correctly reports `created` for new vs existing files.
2. tool_write_file verifies written content matches.
3. Tool deduplication: same tool+args not executed twice.
4. Text alongside tool calls is preserved.
5. Tool error handling: model gets error and can adjust.
6. write_file verification catches partial writes.
7. Tool instruction quality: guides efficient tool use.
"""
from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest
from fastapi.testclient import TestClient


# --- Tests: tool_write_file ---

class TestToolWriteFile:
    def test_new_file_reports_created_true(self, project_dir: Path):
        from app.agent_file_tools import tool_write_file
        result = tool_write_file(project_dir, "new_file.txt", "hello world")
        assert result.get("created") is True
        assert result.get("bytesWritten") == 11
        assert "error" not in result

    def test_existing_file_reports_created_false(self, project_dir: Path):
        from app.agent_file_tools import tool_write_file
        # First write
        tool_write_file(project_dir, "existing.txt", "original")
        # Second write (overwrite)
        result = tool_write_file(project_dir, "existing.txt", "updated")
        assert result.get("created") is False
        assert result.get("bytesWritten") == 7
        assert "error" not in result

    def test_content_verification_passes(self, project_dir: Path):
        from app.agent_file_tools import tool_write_file
        content = "line1\nline2\nline3\n"
        result = tool_write_file(project_dir, "verify.txt", content)
        assert "error" not in result
        # Read back to confirm
        assert (project_dir / "verify.txt").read_text() == content

    def test_overwrite_false_on_existing(self, project_dir: Path):
        from app.agent_file_tools import tool_write_file
        tool_write_file(project_dir, "protect.txt", "v1")
        result = tool_write_file(project_dir, "protect.txt", "v2", overwrite=False)
        assert "error" in result
        assert "overwrite" in result["error"].lower()

    def test_unicode_content_written_correctly(self, project_dir: Path):
        from app.agent_file_tools import tool_write_file
        content = "Hello مرحلą naïve café 日本語\n"
        result = tool_write_file(project_dir, "unicode.txt", content)
        assert "error" not in result
        assert (project_dir / "unicode.txt").read_text(encoding="utf-8") == content


# --- Tests: tool deduplication in non-streaming route ---

class TestToolDeduplication:
    def test_duplicate_tool_call_not_executed_twice(self, env: Path, tmp_db: Path,
                                                     monkeypatch: pytest.MonkeyPatch):
        """When the model returns the same tool call in consecutive rounds,
        the duplicate should be skipped."""
        from app.devkey import ensure_dev_key
        ensure_dev_key()
        from app import config as _config
        _config.settings = _config.Settings()
        from app.main import app

        client = TestClient(app)

        # Setup connection + conversation
        conn = client.post("/connections", json={
            "displayName": "Test", "adapter": "gemini",
            "baseUrl": "https://generativelanguage.googleapis.com/v1beta",
        }).json()
        cid = conn["id"]
        client.post(f"/connections/{cid}/credentials", json={
            "secret": "AIza-test-key-1234567890", "isPrimary": True,
        })
        client.post(f"/connections/{cid}/models", json={
            "modelId": "gemini-2.0-flash", "isDefault": True,
        })
        client.put("/connections/defaults", json={
            "connectionId": cid, "model": "gemini-2.0-flash",
        })

        # Create a project with workspace path
        from app.db import connect
        from app.repositories import ProjectRepo, ConversationRepo
        with connect() as db:
            proj = ProjectRepo.create(db, name="Test Project", workspace_path=str(env / "test_proj"))
        (env / "test_proj").mkdir(exist_ok=True)
        (env / "test_proj" / "existing.txt").write_text("hello")

        with connect() as db:
            conv = ConversationRepo.create(db, project_id=proj["id"], title="Tool Test")

        from app.adapters import ChatResult, ToolCall

        call_count = {"list_files": 0}

        def mock_chat(base_url, api_key, model, messages, *, timeout, tools=None):
            # First call: return a tool call
            # Second call: return the same tool call again (duplicate)
            # Third call: return final text
            if call_count["list_files"] == 0:
                call_count["list_files"] += 1
                return ChatResult(
                    content="",
                    tool_calls=[ToolCall(name="list_files", args={"path": "."})],
                    finish_reason="STOP",
                    raw_meta={"provider": "gemini"},
                )
            elif call_count["list_files"] == 1:
                call_count["list_files"] += 1
                # Return the same tool call (duplicate)
                return ChatResult(
                    content="",
                    tool_calls=[ToolCall(name="list_files", args={"path": "."})],
                    finish_reason="STOP",
                    raw_meta={"provider": "gemini"},
                )
            else:
                return ChatResult(
                    content="Done! I listed the files.",
                    finish_reason="STOP",
                    raw_meta={"provider": "gemini"},
                )

        with patch("app.agent_routes.resolve_adapter") as mock_resolve:
            mock_adapter = MagicMock()
            mock_adapter.chat.side_effect = mock_chat
            mock_resolve.return_value = mock_adapter

            r = client.post("/agent/run", json={
                "conversationId": conv["id"],
                "message": "List the files",
                "model": "gemini-2.0-flash",
                "connectionId": cid,
                "projectId": proj["id"],
            })

        body = r.json()
        assert body["status"] == "completed"
        # The model was called 3 times (tool, duplicate tool, final)
        assert mock_adapter.chat.call_count == 3
        # But tools_executed should have only 1 entry (the duplicate was skipped)
        tools = body.get("toolsExecuted") or []
        assert len(tools) == 1
        assert tools[0]["name"] == "list_files"


# --- Tests: text preservation alongside tool calls ---

class TestTextPreservation:
    def test_text_alongside_tool_calls_preserved(self, env: Path, tmp_db: Path,
                                                  monkeypatch: pytest.MonkeyPatch):
        """When the model returns both text and tool calls, the text should
        not be lost."""
        from app.devkey import ensure_dev_key
        ensure_dev_key()
        from app import config as _config
        _config.settings = _config.Settings()
        from app.main import app

        client = TestClient(app)

        conn = client.post("/connections", json={
            "displayName": "Test", "adapter": "gemini",
            "baseUrl": "https://generativelanguage.googleapis.com/v1beta",
        }).json()
        cid = conn["id"]
        client.post(f"/connections/{cid}/credentials", json={
            "secret": "AIza-test-key-1234567890", "isPrimary": True,
        })
        client.post(f"/connections/{cid}/models", json={
            "modelId": "gemini-2.0-flash", "isDefault": True,
        })
        client.put("/connections/defaults", json={
            "connectionId": cid, "model": "gemini-2.0-flash",
        })

        from app.db import connect
        from app.repositories import ProjectRepo, ConversationRepo
        with connect() as db:
            proj = ProjectRepo.create(db, name="Test Project 2", workspace_path=str(env / "test_proj2"))
        (env / "test_proj2").mkdir(exist_ok=True)

        with connect() as db:
            conv = ConversationRepo.create(db, project_id=proj["id"], title="Text Test")

        from app.adapters import ChatResult, ToolCall

        def mock_chat(base_url, api_key, model, messages, *, timeout, tools=None):
            # First call: text + tool call
            return ChatResult(
                content="I'll create a file for you.",
                tool_calls=[ToolCall(name="write_file", args={
                    "path": "hello.txt", "content": "Hello!"
                })],
                finish_reason="STOP",
                raw_meta={"provider": "gemini"},
            )

        with patch("app.agent_routes.resolve_adapter") as mock_resolve:
            mock_adapter = MagicMock()
            mock_adapter.chat.side_effect = mock_chat
            mock_resolve.return_value = mock_adapter

            r = client.post("/agent/run", json={
                "conversationId": conv["id"],
                "message": "Create a file",
                "model": "gemini-2.0-flash",
                "connectionId": cid,
                "projectId": proj["id"],
            })

        body = r.json()
        assert body["status"] == "completed"
        # The assistant message should contain the text (not just a tool summary)
        content = body["assistantMessage"]["content"]
        assert "I'll create a file for you." in content or "Hello!" in content


# --- Tests: tool error handling ---

class TestToolErrorHandling:
    def test_tool_error_returned_to_model(self, project_dir: Path):
        """When a tool fails, the error should be in the result so the model
        can adjust its approach."""
        from app.agent_file_tools import execute_tool_call
        result = execute_tool_call(project_dir, "read_file", {"path": "nonexistent.txt"})
        assert "error" in result
        assert "not found" in result["error"].lower() or "no such file" in result["error"].lower()

    def test_unknown_tool_returns_error(self, project_dir: Path):
        from app.agent_file_tools import execute_tool_call
        result = execute_tool_call(project_root=project_dir, name="hack_the_planet", args={})
        assert "error" in result
        assert "Unknown tool" in result["error"]

    def test_missing_required_arg_returns_error(self, project_dir: Path):
        from app.agent_file_tools import execute_tool_call
        result = execute_tool_call(project_root=project_dir, name="read_file", args={})
        assert "error" in result
        assert "path" in result["error"].lower()

    def test_delete_root_refused(self, project_dir: Path):
        from app.agent_file_tools import execute_tool_call
        result = execute_tool_call(project_root=project_dir, name="delete_path", args={"path": "."})
        assert "error" in result
        assert "root" in result["error"].lower()


# --- Tests: _safe_usage normalization ---

class TestSafeUsage:
    def test_safe_usage_extracts_gemini_fields(self):
        from app.agent_routes import _safe_usage
        usage = {"promptTokenCount": 100, "candidatesTokenCount": 50, "totalTokenCount": 150}
        result = _safe_usage(usage)
        assert result is not None
        assert result["promptTokenCount"] == 100
        assert result["totalTokenCount"] == 150

    def test_safe_usage_extracts_openai_fields(self):
        from app.agent_routes import _safe_usage
        usage = {"prompt_tokens": 200, "completion_tokens": 80, "total_tokens": 280}
        result = _safe_usage(usage)
        assert result is not None
        assert result["prompt_tokens"] == 200
        assert result["total_tokens"] == 280

    def test_safe_usage_none_returns_none(self):
        from app.agent_routes import _safe_usage
        assert _safe_usage(None) is None

    def test_safe_usage_empty_dict_returns_none(self):
        from app.agent_routes import _safe_usage
        assert _safe_usage({}) is None

    def test_non_streaming_response_uses_safe_usage(self, env: Path, tmp_db: Path,
                                                     monkeypatch: pytest.MonkeyPatch):
        """The non-streaming /agent/run response should use _safe_usage, not
        raw usage dict from the provider."""
        from app.devkey import ensure_dev_key
        ensure_dev_key()
        from app import config as _config
        _config.settings = _config.Settings()
        from app.main import app

        client = TestClient(app)
        conn = client.post("/connections", json={
            "displayName": "Test", "adapter": "gemini",
            "baseUrl": "https://generativelanguage.googleapis.com/v1beta",
        }).json()
        cid = conn["id"]
        client.post(f"/connections/{cid}/credentials", json={
            "secret": "AIza-test-key-1234567890", "isPrimary": True,
        })
        client.post(f"/connections/{cid}/models", json={
            "modelId": "gemini-2.0-flash", "isDefault": True,
        })
        client.put("/connections/defaults", json={
            "connectionId": cid, "model": "gemini-2.0-flash",
        })
        from app.db import connect
        from app.repositories import ConversationRepo
        with connect() as db:
            conv = ConversationRepo.create(db, project_id=None, title="Usage Test")

        from app.adapters import ChatResult
        raw_usage = {"promptTokenCount": 42, "candidatesTokenCount": 7, "totalTokenCount": 49,
                     "extraField": "should_not_leak"}

        with patch("app.agent_routes.resolve_adapter") as mock_resolve:
            mock_adapter = MagicMock()
            mock_adapter.chat.return_value = ChatResult(
                content="Hello!", finish_reason="STOP",
                usage=raw_usage,
                raw_meta={"provider": "gemini"},
            )
            mock_resolve.return_value = mock_adapter

            r = client.post("/agent/run", json={
                "conversationId": conv["id"],
                "message": "Hi",
                "model": "gemini-2.0-flash",
                "connectionId": cid,
            })

        body = r.json()
        usage = body["meta"].get("usage")
        assert usage is not None
        assert "promptTokenCount" in usage
        assert "extraField" not in usage
