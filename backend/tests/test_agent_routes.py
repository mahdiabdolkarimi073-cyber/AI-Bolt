"""Regression tests for agent route timeout handling, AdapterError attribute
access, structured error responses, diagnostic failure events, and runtime
model identity system-prompt injection.

These tests exercise the real agent route with mocked adapter responses to
verify error paths without hitting a real AI provider.
"""
from __future__ import annotations

import time
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(env: Path, tmp_db: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    from app.devkey import ensure_dev_key
    ensure_dev_key()
    from app import config as _config
    _config.settings = _config.Settings()
    from app.main import app
    return TestClient(app)


def _setup_connection_and_conversation(client: TestClient) -> tuple[str, str]:
    """Create a connection with credential + model and a conversation.
    Returns (connection_id, conversation_id)."""
    conn = client.post("/connections", json={
        "displayName": "Test Gemini", "adapter": "gemini",
        "baseUrl": "https://generativelanguage.googleapis.com/v1beta",
    }).json()
    cid = conn["id"]
    client.post(f"/connections/{cid}/credentials", json={
        "secret": "AIza-test-key-1234567890", "isPrimary": True,
    })
    client.post(f"/connections/{cid}/models", json={
        "modelId": "gemini-3.6-flash", "isDefault": True,
    })
    client.put("/connections/defaults", json={
        "connectionId": cid, "model": "gemini-3.6-flash",
    })
    # Create a conversation via the conversations API.
    from app.db import connect
    from app.repositories import ConversationRepo
    with connect() as db:
        conv = ConversationRepo.create(db, project_id=None, title="Test Conv")
    return cid, conv["id"]


class TestAdapterErrorAttributes:
    """Verify AdapterError exposes .message and .category correctly."""

    def test_adapter_error_has_message_attribute(self):
        from app.adapters import AdapterError, CATEGORY_TIMEOUT
        exc = AdapterError(CATEGORY_TIMEOUT, "The Gemini request timed out.")
        assert exc.message == "The Gemini request timed out."
        assert exc.category == CATEGORY_TIMEOUT
        assert exc.status_code is None
        # str(exc) also works (via super().__init__)
        assert "timed out" in str(exc)

    def test_adapter_error_with_status_code(self):
        from app.adapters import AdapterError, CATEGORY_AUTH_FAILED
        exc = AdapterError(CATEGORY_AUTH_FAILED, "Auth failed.", status_code=401)
        assert exc.message == "Auth failed."
        assert exc.category == CATEGORY_AUTH_FAILED
        assert exc.status_code == 401


class TestTimeoutHandling:
    """Verify timeout errors are handled safely and reported as timeouts."""

    def test_timeout_returns_structured_error(self, client: TestClient):
        cid, conv_id = _setup_connection_and_conversation(client)
        from app.adapters import AdapterError, CATEGORY_TIMEOUT

        with patch("app.agent_routes.resolve_adapter") as mock_resolve:
            mock_adapter = MagicMock()
            mock_adapter.chat.side_effect = AdapterError(
                CATEGORY_TIMEOUT, "The Gemini request timed out."
            )
            mock_resolve.return_value = mock_adapter

            r = client.post("/agent/run", json={
                "conversationId": conv_id,
                "message": "Hello",
                "model": "gemini-3.6-flash",
                "connectionId": cid,
            })

        assert r.status_code == 200
        body = r.json()
        assert body["status"] == "failed"
        assert body["error"]["code"] == "timeout"
        assert "timed out" in body["error"]["message"].lower()
        # Must NOT be misreported as auth_failed or invalid_model
        assert body["error"]["code"] != "auth_failed"
        assert body["error"]["code"] != "invalid_model"
        # Meta should include diagnostic fields
        assert body["meta"]["modelSubstituted"] is False
        assert body["meta"]["selectedModel"] == "gemini-3.6-flash"
        assert body["meta"]["requestId"]  # should have a request ID

    def test_timeout_does_not_crash_with_attribute_error(self, client: TestClient):
        """The original bug: AdapterError had no .message attribute, causing
        AttributeError during exception handling. This test ensures the handler
        can access the error message without a second exception."""
        cid, conv_id = _setup_connection_and_conversation(client)
        from app.adapters import AdapterError, CATEGORY_TIMEOUT

        with patch("app.agent_routes.resolve_adapter") as mock_resolve:
            mock_adapter = MagicMock()
            mock_adapter.chat.side_effect = AdapterError(
                CATEGORY_TIMEOUT, "The Gemini request timed out."
            )
            mock_resolve.return_value = mock_adapter

            r = client.post("/agent/run", json={
                "conversationId": conv_id,
                "message": "Hello",
                "model": "gemini-3.6-flash",
                "connectionId": cid,
            })

        # The response should be a structured error, NOT a 500 from an
        # unhandled AttributeError.
        assert r.status_code == 200
        body = r.json()
        assert body["status"] == "failed"
        assert body["error"]["code"] == "timeout"

    def test_timeout_logs_diagnostic_event(self, client: TestClient):
        cid, conv_id = _setup_connection_and_conversation(client)
        from app.adapters import AdapterError, CATEGORY_TIMEOUT

        with patch("app.agent_routes.resolve_adapter") as mock_resolve:
            mock_adapter = MagicMock()
            mock_adapter.chat.side_effect = AdapterError(
                CATEGORY_TIMEOUT, "The Gemini request timed out."
            )
            mock_resolve.return_value = mock_adapter

            client.post("/agent/run", json={
                "conversationId": conv_id,
                "message": "Hello",
                "model": "gemini-3.6-flash",
                "connectionId": cid,
            })

        # Check that a diagnostic event was logged.
        diags = client.get("/diagnostics", params={
            "connectionId": cid, "eventType": "ai_request_failure",
        }).json()
        assert len(diags) >= 1
        diag = diags[0]
        assert diag["eventType"] == "ai_request_failure"
        assert diag["status"] == "error"
        assert "timed out" in diag["message"].lower()
        assert diag["details"]["category"] == "timeout"
        assert diag["details"]["requestId"]


class TestStructuredErrorResponse:
    """Verify all error categories produce structured, safe responses."""

    def test_auth_error_returns_auth_category(self, client: TestClient):
        cid, conv_id = _setup_connection_and_conversation(client)
        from app.adapters import AdapterError, CATEGORY_AUTH_FAILED

        with patch("app.agent_routes.resolve_adapter") as mock_resolve:
            mock_adapter = MagicMock()
            mock_adapter.chat.side_effect = AdapterError(
                CATEGORY_AUTH_FAILED, "Authentication failed.", status_code=401,
            )
            mock_resolve.return_value = mock_adapter

            r = client.post("/agent/run", json={
                "conversationId": conv_id,
                "message": "Hello",
                "model": "gemini-3.6-flash",
                "connectionId": cid,
            })

        body = r.json()
        assert body["error"]["code"] == "auth_failed"
        assert body["error"]["message"] == "Authentication failed."

    def test_invalid_model_error_returns_invalid_model_category(self, client: TestClient):
        cid, conv_id = _setup_connection_and_conversation(client)
        from app.adapters import AdapterError, CATEGORY_INVALID_MODEL

        with patch("app.agent_routes.resolve_adapter") as mock_resolve:
            mock_adapter = MagicMock()
            mock_adapter.chat.side_effect = AdapterError(
                CATEGORY_INVALID_MODEL, "Model not found.", status_code=404,
            )
            mock_resolve.return_value = mock_adapter

            r = client.post("/agent/run", json={
                "conversationId": conv_id,
                "message": "Hello",
                "model": "gemini-3.6-flash",
                "connectionId": cid,
            })

        body = r.json()
        assert body["error"]["code"] == "invalid_model"

    def test_no_credentials_returns_provider_not_ready(self, client: TestClient):
        conn = client.post("/connections", json={
            "displayName": "No Key", "adapter": "gemini",
        }).json()
        cid = conn["id"]
        client.post(f"/connections/{cid}/models", json={
            "modelId": "gemini-3.6-flash", "isDefault": True,
        })
        client.put("/connections/defaults", json={
            "connectionId": cid, "model": "gemini-3.6-flash",
        })
        from app.db import connect
        from app.repositories import ConversationRepo
        with connect() as db:
            conv = ConversationRepo.create(db, project_id=None, title="No Key Conv")

        r = client.post("/agent/run", json={
            "conversationId": conv["id"],
            "message": "Hello",
            "model": "gemini-3.6-flash",
            "connectionId": cid,
        })
        body = r.json()
        assert body["status"] == "failed"
        assert body["error"]["code"] == "provider_not_ready"


class TestModelSubstitutionDiagnostics:
    """Verify model substitution is tracked and reported, never silent."""

    def test_empty_model_falls_back_to_default_with_flag(self, client: TestClient):
        cid, conv_id = _setup_connection_and_conversation(client)
        from app.adapters import ChatResult

        with patch("app.agent_routes.resolve_adapter") as mock_resolve:
            mock_adapter = MagicMock()
            mock_adapter.chat.return_value = ChatResult(
                content="Hello!",
                finish_reason="STOP",
                usage={"promptTokenCount": 10, "candidatesTokenCount": 5, "totalTokenCount": 15},
                raw_meta={"provider": "gemini", "modelVersion": "gemini-3.6-flash-001"},
            )
            mock_resolve.return_value = mock_adapter

            r = client.post("/agent/run", json={
                "conversationId": conv_id,
                "message": "Hello",
                "model": "",  # empty — should fall back to default
                "connectionId": cid,
            })

        body = r.json()
        assert body["status"] == "completed"
        assert body["meta"]["model"] == "gemini-3.6-flash"
        assert body["meta"]["modelSubstituted"] is True
        assert body["meta"]["selectedModel"] is None
        assert body["meta"]["providerReportedModel"] == "gemini-3.6-flash-001"
        assert body["meta"]["providerActualModelConfirmed"] is True

    def test_explicit_model_not_substituted(self, client: TestClient):
        cid, conv_id = _setup_connection_and_conversation(client)
        from app.adapters import ChatResult

        with patch("app.agent_routes.resolve_adapter") as mock_resolve:
            mock_adapter = MagicMock()
            mock_adapter.chat.return_value = ChatResult(
                content="Hello!",
                finish_reason="STOP",
                raw_meta={"provider": "gemini"},
            )
            mock_resolve.return_value = mock_adapter

            r = client.post("/agent/run", json={
                "conversationId": conv_id,
                "message": "Hello",
                "model": "gemini-3.6-flash",
                "connectionId": cid,
            })

        body = r.json()
        assert body["meta"]["modelSubstituted"] is False
        assert body["meta"]["selectedModel"] == "gemini-3.6-flash"
        # No providerReportedModel in this mock
        assert body["meta"]["providerReportedModel"] is None
        assert body["meta"]["providerActualModelConfirmed"] is False

    def test_no_model_and_no_default_returns_error(self, client: TestClient):
        conn = client.post("/connections", json={
            "displayName": "No Default", "adapter": "gemini",
        }).json()
        cid = conn["id"]
        client.post(f"/connections/{cid}/credentials", json={
            "secret": "AIza-test-key-1234567890", "isPrimary": True,
        })
        # No model added — no default
        client.put("/connections/defaults", json={
            "connectionId": cid, "model": None,
        })
        from app.db import connect
        from app.repositories import ConversationRepo
        with connect() as db:
            conv = ConversationRepo.create(db, project_id=None, title="No Default Conv")

        r = client.post("/agent/run", json={
            "conversationId": conv["id"],
            "message": "Hello",
            "model": "",
            "connectionId": cid,
        })
        body = r.json()
        assert body["status"] == "failed"
        assert body["error"]["code"] == "invalid_request"
        assert "No model selected" in body["error"]["message"]


class TestRuntimeModelIdentityPrompt:
    """Verify the system prompt includes runtime model metadata so the
    assistant never guesses its identity."""

    def test_runtime_block_injected_into_messages(self, client: TestClient):
        """The adapter should receive a system message containing runtime
        model metadata (selectedModel, resolvedModel, etc)."""
        cid, conv_id = _setup_connection_and_conversation(client)
        from app.adapters import ChatResult

        captured_messages: list[dict] = []

        def capture_chat(base_url, api_key, model, messages, *, timeout):
            captured_messages.extend(messages)
            return ChatResult(content="I am the model specified in my runtime metadata.",
                              finish_reason="STOP",
                              raw_meta={"provider": "gemini", "modelVersion": "gemini-3.6-flash-001"})

        with patch("app.agent_routes.resolve_adapter") as mock_resolve:
            mock_adapter = MagicMock()
            mock_adapter.chat.side_effect = capture_chat
            mock_resolve.return_value = mock_adapter

            r = client.post("/agent/run", json={
                "conversationId": conv_id,
                "message": "Which model are you?",
                "model": "gemini-3.6-flash",
                "connectionId": cid,
            })

        assert r.status_code == 200
        body = r.json()
        assert body["status"] == "completed"

        # Verify a system message with runtime metadata was injected.
        system_msgs = [m for m in captured_messages if m["role"] == "system"]
        runtime_msgs = [m for m in system_msgs if "RUNTIME MODEL METADATA" in m["content"]]
        assert len(runtime_msgs) == 1
        runtime_content = runtime_msgs[0]["content"]
        assert "resolvedModel: gemini-3.6-flash" in runtime_content
        assert "selectedModel: gemini-3.6-flash" in runtime_content
        assert "modelSubstituted: false" in runtime_content
        # The identity rules must be present
        assert "Never invent" in runtime_content
        assert "Never declare a model nonexistent" in runtime_content

    def test_runtime_block_with_substituted_model(self, client: TestClient):
        """When model is substituted, the runtime block should show both
        selectedModel (empty) and resolvedModel (default)."""
        cid, conv_id = _setup_connection_and_conversation(client)
        from app.adapters import ChatResult

        captured_messages: list[dict] = []

        def capture_chat(base_url, api_key, model, messages, *, timeout):
            captured_messages.extend(messages)
            return ChatResult(content="Response", finish_reason="STOP",
                              raw_meta={"provider": "gemini"})

        with patch("app.agent_routes.resolve_adapter") as mock_resolve:
            mock_adapter = MagicMock()
            mock_adapter.chat.side_effect = capture_chat
            mock_resolve.return_value = mock_adapter

            client.post("/agent/run", json={
                "conversationId": conv_id,
                "message": "What model are you?",
                "model": "",  # empty → substituted
                "connectionId": cid,
            })

        system_msgs = [m for m in captured_messages if m["role"] == "system"]
        runtime_msgs = [m for m in system_msgs if "RUNTIME MODEL METADATA" in m["content"]]
        assert len(runtime_msgs) == 1
        content = runtime_msgs[0]["content"]
        assert "modelSubstituted: true" in content
        assert "resolvedModel: gemini-3.6-flash" in content


class TestConfigurableTimeout:
    """Verify timeout is configurable via settings."""

    def test_timeout_setting_exists(self):
        from app.config import Settings
        s = Settings()
        assert hasattr(s, "agent_timeout_seconds")
        assert s.agent_timeout_seconds > 0
        # Default should be reasonable for generation (not 30s)
        assert s.agent_timeout_seconds >= 60.0

    def test_timeout_passed_to_adapter(self, client: TestClient):
        cid, conv_id = _setup_connection_and_conversation(client)
        from app.adapters import ChatResult

        captured_timeout: list[float] = []

        def capture_chat(base_url, api_key, model, messages, *, timeout):
            captured_timeout.append(timeout)
            return ChatResult(content="ok", finish_reason="STOP", raw_meta={"provider": "gemini"})

        with patch("app.agent_routes.resolve_adapter") as mock_resolve:
            mock_adapter = MagicMock()
            mock_adapter.chat.side_effect = capture_chat
            mock_resolve.return_value = mock_adapter

            client.post("/agent/run", json={
                "conversationId": conv_id,
                "message": "Hello",
                "model": "gemini-3.6-flash",
                "connectionId": cid,
            })

        assert len(captured_timeout) == 1
        from app.config import settings
        assert captured_timeout[0] == float(settings.agent_timeout_seconds)


class TestRetryBehavior:
    """Verify retry only happens for transient errors and never changes model."""

    def test_non_retryable_error_not_retried(self, client: TestClient):
        cid, conv_id = _setup_connection_and_conversation(client)
        from app.adapters import AdapterError, CATEGORY_AUTH_FAILED

        with patch("app.agent_routes.resolve_adapter") as mock_resolve:
            mock_adapter = MagicMock()
            mock_adapter.chat.side_effect = AdapterError(
                CATEGORY_AUTH_FAILED, "Auth failed.", status_code=401,
            )
            mock_resolve.return_value = mock_adapter

            r = client.post("/agent/run", json={
                "conversationId": conv_id,
                "message": "Hello",
                "model": "gemini-3.6-flash",
                "connectionId": cid,
            })

        body = r.json()
        assert body["error"]["code"] == "auth_failed"
        # Should have been called exactly once (no retry)
        assert mock_adapter.chat.call_count == 1

    def test_retryable_error_retried_once(self, client: TestClient):
        cid, conv_id = _setup_connection_and_conversation(client)
        from app.adapters import AdapterError, CATEGORY_TIMEOUT, ChatResult

        with patch("app.agent_routes.resolve_adapter") as mock_resolve:
            mock_adapter = MagicMock()
            # First call: timeout. Second call: success.
            mock_adapter.chat.side_effect = [
                AdapterError(CATEGORY_TIMEOUT, "Timed out."),
                ChatResult(content="Success on retry", finish_reason="STOP",
                           raw_meta={"provider": "gemini"}),
            ]
            mock_resolve.return_value = mock_adapter

            r = client.post("/agent/run", json={
                "conversationId": conv_id,
                "message": "Hello",
                "model": "gemini-3.6-flash",
                "connectionId": cid,
            })

        body = r.json()
        assert body["status"] == "completed"
        assert body["assistantMessage"]["content"] == "Success on retry"
        # Should have been called twice (1 original + 1 retry)
        assert mock_adapter.chat.call_count == 2
        # Model should never change during retry
        for call_args in mock_adapter.chat.call_args_list:
            assert call_args.args[2] == "gemini-3.6-flash"
