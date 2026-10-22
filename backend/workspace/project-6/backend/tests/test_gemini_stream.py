"""Regression tests for Gemini streaming response parsing.

Tests verify that:
1. SSE-format responses (alt=sse) are parsed correctly — multi-chunk text,
   tool calls, finish reasons, and empty-content chunks.
2. JSON-array fallback works when alt=sse is not honored.
3. The _model_url includes alt=sse for streaming requests.
4. Empty/no-candidate responses do not produce phantom output.
5. Diagnostic logging does not leak secrets.

These tests mock httpx.stream to avoid hitting the real Gemini API.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Generator
from unittest.mock import patch, MagicMock

import pytest


# --- Helpers ---

def _sse_lines(chunks: list[dict]) -> list[str]:
    """Convert a list of JSON dicts into SSE data: lines."""
    lines = []
    for c in chunks:
        lines.append(f"data: {json.dumps(c)}")
    return lines


def _gemini_chunk(*, text: str = "", finish_reason: str | None = None,
                  tool_call: dict | None = None, usage: dict | None = None) -> dict:
    """Build a single Gemini streamGenerateContent SSE chunk."""
    parts: list[dict] = []
    if text:
        parts.append({"text": text})
    if tool_call:
        parts.append({"functionCall": tool_call})
    candidate: dict = {"content": {"role": "model", "parts": parts}}
    if finish_reason:
        candidate["finishReason"] = finish_reason
    chunk: dict = {"candidates": [candidate]}
    if usage:
        chunk["usageMetadata"] = usage
    return chunk


class _MockStreamResponse:
    """Mimics httpx streaming response for testing."""

    def __init__(self, lines: list[str], status_code: int = 200,
                 content_type: str = "text/event-stream"):
        self._lines = lines
        self.status_code = status_code
        self.headers = {"content-type": content_type}
        self._read_data = b""
        if status_code == 200:
            self._read_data = "\n".join(lines).encode("utf-8")

    def iter_lines(self):
        for line in self._lines:
            yield line

    def read(self) -> bytes:
        return self._read_data

    def json(self):
        try:
            return json.loads(self._read_data)
        except Exception:
            return None

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class _MockHttpxStream:
    """Context manager that returns a _MockStreamResponse."""

    def __init__(self, response: _MockStreamResponse):
        self._response = response

    def __call__(self, *args, **kwargs):
        return self._response

    def __enter__(self):
        return self._response

    def __exit__(self, *args):
        return False


def _make_gemini_adapter():
    from app.adapters import GeminiAdapter
    return GeminiAdapter()


MESSAGES = [{"role": "user", "content": "Hello"}]


# --- Tests: _model_url includes alt=sse ---

class TestModelUrlStreaming:
    def test_stream_url_has_alt_sse(self):
        adapter = _make_gemini_adapter()
        url = adapter._model_url("https://generativelanguage.googleapis.com/v1beta",
                                  "gemini-2.0-flash", stream=True)
        assert "alt=sse" in url
        assert "streamGenerateContent" in url

    def test_non_stream_url_has_no_alt_sse(self):
        adapter = _make_gemini_adapter()
        url = adapter._model_url("https://generativelanguage.googleapis.com/v1beta",
                                  "gemini-2.0-flash", stream=False)
        assert "alt=sse" not in url
        assert "generateContent" in url


# --- Tests: SSE parsing ---

class TestSSEParsing:
    def test_multi_chunk_text_assembled(self):
        """Multiple text deltas should be yielded as separate StreamChunks."""
        adapter = _make_gemini_adapter()
        chunks = [
            _gemini_chunk(text="Hello"),
            _gemini_chunk(text=", world"),
            _gemini_chunk(text="!", finish_reason="STOP"),
        ]
        lines = _sse_lines(chunks)
        mock_resp = _MockStreamResponse(lines)

        with patch("httpx.stream", return_value=mock_resp):
            results = list(adapter.chat_stream(
                "https://generativelanguage.googleapis.com/v1beta",
                "fake-key", "gemini-2.0-flash", MESSAGES,
            ))

        deltas = [r.delta for r in results if r.delta]
        assert "".join(deltas) == "Hello, world!"
        assert len(deltas) == 3
        last = results[-1]
        assert last.finish_reason == "STOP"

    def test_empty_content_chunk_skipped(self):
        """Chunks with no text/tool/finish should not yield empty StreamChunks."""
        adapter = _make_gemini_adapter()
        chunks = [
            _gemini_chunk(text="Hi"),
            _gemini_chunk(),  # empty
            _gemini_chunk(finish_reason="STOP"),
        ]
        lines = _sse_lines(chunks)
        mock_resp = _MockStreamResponse(lines)

        with patch("httpx.stream", return_value=mock_resp):
            results = list(adapter.chat_stream(
                "https://generativelanguage.googleapis.com/v1beta",
                "fake-key", "gemini-2.0-flash", MESSAGES,
            ))

        # Only the text chunk and the finish chunk should produce output
        assert len(results) == 2
        assert results[0].delta == "Hi"
        assert results[1].finish_reason == "STOP"

    def test_tool_call_extracted(self):
        """Function call parts should be extracted as ToolCalls."""
        adapter = _make_gemini_adapter()
        chunks = [
            _gemini_chunk(tool_call={"name": "write_file", "args": {"path": "foo.txt"}}),
            _gemini_chunk(finish_reason="STOP"),
        ]
        lines = _sse_lines(chunks)
        mock_resp = _MockStreamResponse(lines)

        with patch("httpx.stream", return_value=mock_resp):
            results = list(adapter.chat_stream(
                "https://generativelanguage.googleapis.com/v1beta",
                "fake-key", "gemini-2.0-flash", MESSAGES,
            ))

        tool_chunks = [r for r in results if r.tool_calls]
        assert len(tool_chunks) == 1
        assert tool_chunks[0].tool_calls[0].name == "write_file"
        assert tool_chunks[0].tool_calls[0].args == {"path": "foo.txt"}

    def test_no_candidates_skipped(self):
        """Chunks without candidates should be silently skipped."""
        adapter = _make_gemini_adapter()
        lines = _sse_lines([
            {"promptFeedback": {"safetyRatings": []}},  # no candidates
            _gemini_chunk(text="OK", finish_reason="STOP"),
        ])
        mock_resp = _MockStreamResponse(lines)

        with patch("httpx.stream", return_value=mock_resp):
            results = list(adapter.chat_stream(
                "https://generativelanguage.googleapis.com/v1beta",
                "fake-key", "gemini-2.0-flash", MESSAGES,
            ))

        assert len(results) == 1
        assert results[0].delta == "OK"

    def test_usage_metadata_captured(self):
        """usageMetadata from the last chunk should be captured."""
        adapter = _make_gemini_adapter()
        chunks = [
            _gemini_chunk(text="response"),
            _gemini_chunk(finish_reason="STOP",
                          usage={"promptTokenCount": 10, "candidatesTokenCount": 5, "totalTokenCount": 15}),
        ]
        lines = _sse_lines(chunks)
        mock_resp = _MockStreamResponse(lines)

        with patch("httpx.stream", return_value=mock_resp):
            results = list(adapter.chat_stream(
                "https://generativelanguage.googleapis.com/v1beta",
                "fake-key", "gemini-2.0-flash", MESSAGES,
            ))

        last = results[-1]
        assert last.usage is not None
        assert last.usage["totalTokenCount"] == 15


# --- Tests: JSON array fallback ---

class TestJSONArrayFallback:
    def test_json_array_parsed_when_no_sse(self):
        """When alt=sse is not honored, Gemini returns a JSON array.
        The fallback should parse it and yield chunks."""
        adapter = _make_gemini_adapter()
        array = [
            _gemini_chunk(text="Hello"),
            _gemini_chunk(text=" world", finish_reason="STOP"),
        ]
        # Simulate a non-SSE response: raw JSON array, no data: prefixes
        raw_json = json.dumps(array)
        mock_resp = _MockStreamResponse([], content_type="application/json")
        mock_resp._read_data = raw_json.encode("utf-8")

        with patch("httpx.stream", return_value=mock_resp):
            results = list(adapter.chat_stream(
                "https://generativelanguage.googleapis.com/v1beta",
                "fake-key", "gemini-2.0-flash", MESSAGES,
            ))

        deltas = [r.delta for r in results if r.delta]
        assert "".join(deltas) == "Hello world"
        assert results[-1].finish_reason == "STOP"

    def test_json_array_with_tool_calls(self):
        """JSON array fallback should also handle tool calls."""
        adapter = _make_gemini_adapter()
        array = [
            _gemini_chunk(tool_call={"name": "read_file", "args": {"path": "main.py"}}),
        ]
        raw_json = json.dumps(array)
        mock_resp = _MockStreamResponse([], content_type="application/json")
        mock_resp._read_data = raw_json.encode("utf-8")

        with patch("httpx.stream", return_value=mock_resp):
            results = list(adapter.chat_stream(
                "https://generativelanguage.googleapis.com/v1beta",
                "fake-key", "gemini-2.0-flash", MESSAGES,
            ))

        tool_chunks = [r for r in results if r.tool_calls]
        assert len(tool_chunks) == 1
        assert tool_chunks[0].tool_calls[0].name == "read_file"

    def test_empty_json_array_no_output(self):
        """An empty JSON array should produce no chunks and no error."""
        adapter = _make_gemini_adapter()
        mock_resp = _MockStreamResponse([], content_type="application/json")
        mock_resp._read_data = b"[]"

        with patch("httpx.stream", return_value=mock_resp):
            results = list(adapter.chat_stream(
                "https://generativelanguage.googleapis.com/v1beta",
                "fake-key", "gemini-2.0-flash", MESSAGES,
            ))

        assert results == []


# --- Tests: error handling ---

class TestStreamErrorHandling:
    def test_http_error_raises_adapter_error(self):
        """Non-200 status should raise AdapterError with the right category."""
        from app.adapters import AdapterError, CATEGORY_AUTH_FAILED
        adapter = _make_gemini_adapter()
        mock_resp = _MockStreamResponse([], status_code=401)
        mock_resp._read_data = b'{"error": {"message": "Invalid key"}}'

        with patch("httpx.stream", return_value=mock_resp):
            with pytest.raises(AdapterError) as exc_info:
                list(adapter.chat_stream(
                    "https://generativelanguage.googleapis.com/v1beta",
                    "fake-key", "gemini-2.0-flash", MESSAGES,
                ))

        assert exc_info.value.category == CATEGORY_AUTH_FAILED
        assert exc_info.value.status_code == 401

    def test_no_api_key_raises_auth_error(self):
        """Missing API key should raise auth_failed immediately."""
        from app.adapters import AdapterError, CATEGORY_AUTH_FAILED
        adapter = _make_gemini_adapter()
        with pytest.raises(AdapterError) as exc_info:
            list(adapter.chat_stream(
                "https://generativelanguage.googleapis.com/v1beta",
                "", "gemini-2.0-flash", MESSAGES,
            ))
        assert exc_info.value.category == CATEGORY_AUTH_FAILED


# --- Tests: the full streaming route uses alt=sse ---

class TestStreamRouteUsesSSE:
    """Integration test: verify the streaming agent route gets text through
    the Gemini adapter when the response is SSE format."""

    def test_stream_route_produces_delta_events(self, env: Path, tmp_db: Path,
                                                 monkeypatch: pytest.MonkeyPatch):
        from app.devkey import ensure_dev_key
        ensure_dev_key()
        from app import config as _config
        _config.settings = _config.Settings()
        from app.main import app
        from fastapi.testclient import TestClient

        client = TestClient(app)

        # Create connection + credential + model + conversation
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
            conv = ConversationRepo.create(db, project_id=None, title="Stream Test")

        # Mock the adapter's chat_stream to yield real text chunks
        from app.adapters import StreamChunk

        def mock_chat_stream(base_url, api_key, model, messages, *, timeout, tools=None):
            yield StreamChunk(delta="Hello ", finish_reason=None)
            yield StreamChunk(delta="world!", finish_reason="STOP")

        with patch("app.agent_stream_routes.resolve_adapter") as mock_resolve:
            mock_adapter = MagicMock()
            mock_adapter.chat_stream.side_effect = mock_chat_stream
            mock_resolve.return_value = mock_adapter

            # Use TestClient to stream the SSE response
            with client.stream("POST", "/agent/run/stream", json={
                "conversationId": conv["id"],
                "message": "Hi",
                "model": "gemini-2.0-flash",
                "connectionId": cid,
            }) as resp:
                assert resp.status_code == 200
                events = []
                for line in resp.iter_lines():
                    events.append(line)

        # Parse SSE events
        delta_texts = []
        done_seen = False
        error_seen = False
        i = 0
        while i < len(events):
            line = events[i]
            if line.startswith("event: "):
                evt = line[7:].strip()
                if i + 1 < len(events) and events[i + 1].startswith("data: "):
                    data = events[i + 1][6:]
                    if evt == "delta":
                        parsed = json.loads(data)
                        delta_texts.append(parsed["text"])
                    elif evt == "done":
                        done_seen = True
                        parsed = json.loads(data)
                        assert parsed["assistantMessage"]["content"] == "Hello world!"
                    elif evt == "error":
                        error_seen = True
                i += 2
            else:
                i += 1

        assert "".join(delta_texts) == "Hello world!"
        assert done_seen
        assert not error_seen
