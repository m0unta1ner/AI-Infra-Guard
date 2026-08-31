import json

import pytest
import httpx
from pydantic import ValidationError

from agent_scan.core.agent_adapter import adapter
from agent_scan.core.agent_adapter.adapter import (
    AIProviderClient,
    ProviderConfig,
    ProviderResponseInfo,
)
from agent_scan.core.agent_adapter.sse_parser import (
    SSEParseError,
    SSEParserConfig,
    parse_configured_sse,
)


def target_config(**overrides):
    values = {
        "require_done": True,
        "chunks": [{"when": {"Object": "content", "Type": "text", "Status": "in_progress"}, "text_path": "Text"}],
        "completed": [{"when": {"Object": "content", "Type": "text", "Status": "completed"}, "text_path": "Text"}],
        "fallback_completed": [{"when": {"Object": "message", "Type": "message", "Status": "completed"}, "text_path": "Content[0].Text"}],
        "done": [{"when": {"Object": "response", "Status": "completed"}}],
        "errors": [{"when": {"Object": "error"}, "message_path": "Message"}],
        "metadata": {"usage_path": "Usage", "timing_path": "Timing"},
    }
    values.update(overrides)
    return SSEParserConfig(**values)


TARGET_SSE = """:ping\n\n
data: {"Object":"response","Status":"created","SequenceNumber":"1"}\n\n
data: {"Object":"content","Type":"text","Status":"in_progress","Text":"你好"}\n\n
data: {"Object":"content","Type":"text","Status":"in_progress","Text":"！"}\n\n
data: {"Object":"content","Type":"text","Status":"completed","Text":"你好！我在的。有什么需要帮忙的，尽管说 🙂"}\n\n
data: {"Object":"message","Type":"message","Status":"completed","Content":[{"Type":"text","Text":"fallback"}]}\n\n
data: {"Object":"response","Status":"completed","Usage":{"InputTokens":10,"OutputTokens":5},"Timing":{"TtftMs":12.5}}\n\n
"""


def test_target_sse_prefers_completed_and_extracts_metadata():
    raw, usage, metadata = parse_configured_sse(TARGET_SSE.splitlines(keepends=True), target_config())
    assert raw["content"] == "你好！我在的。有什么需要帮忙的，尽管说 🙂"
    assert usage == {"InputTokens": 10, "OutputTokens": 5}
    assert metadata["timing"] == {"TtftMs": 12.5}
    assert metadata["sse_completed"] is True


def test_fallback_completed_supports_array_path():
    text = (
        'data: {"Object":"message","Type":"message","Status":"completed",'
        '"Content":[{"Text":"fallback answer"}]}\n\n'
        'data: {"Object":"response","Status":"completed"}\n\n'
    )
    raw, _, _ = parse_configured_sse(text.splitlines(keepends=True), target_config())
    assert raw["content"] == "fallback answer"


def test_chunks_are_used_only_as_fallback_and_multiline_data_is_supported():
    config = SSEParserConfig(
        require_done=False,
        chunks=[{"when": {"kind": "chunk"}, "text_path": "payload.text"}],
    )
    text = 'data: {"kind":"chunk",\n' 'data: "payload":{"text":"hello"}}\r\n\r\n'
    raw, _, _ = parse_configured_sse(text.splitlines(keepends=True), config)
    assert raw["content"] == "hello"


def test_missing_done_and_error_event_fail():
    with pytest.raises(SSEParseError, match="before a configured completion"):
        parse_configured_sse(['data: {"Object":"content","Type":"text","Status":"completed","Text":"x"}\n', "\n"], target_config())
    with pytest.raises(SSEParseError, match="bad request"):
        parse_configured_sse(['data: {"Object":"error","Message":"bad request"}\n', "\n"], target_config())


def test_invalid_or_unknown_config_is_rejected():
    with pytest.raises(ValidationError):
        SSEParserConfig(chunks=[{"text_path": "items[-1]"}], require_done=False)
    with pytest.raises(ValidationError):
        SSEParserConfig(chunks=[{"text_path": "text", "unknown": True}], require_done=False)
    with pytest.raises(ValidationError):
        SSEParserConfig(chunks=[{"when": {"bad path": 1}, "text_path": "text"}], require_done=False)


def test_event_and_response_limits():
    config = SSEParserConfig(chunks=[{"text_path": "text"}], require_done=False, max_events=1)
    with pytest.raises(SSEParseError, match="exceeded 1 events"):
        parse_configured_sse(['data: {"text":"a"}\n', "\n", 'data: {"text":"b"}\n', "\n"], config)


def test_builtin_openai_sse_regression():
    raw, usage = AIProviderClient()._parse_sse_response(
        'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n'
        'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n'
        'data: {"choices":[{"delta":{"content":" world"},"finish_reason":"stop"}],"usage":{"total_tokens":3}}\n\n'
        "data: [DONE]\n\n"
    )
    assert raw["choices"][0]["message"]["content"] == "Hello world"
    assert usage == {"total_tokens": 3}


def _mock_http_client(monkeypatch, handler):
    real_client = httpx.Client
    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(
        adapter.httpx,
        "Client",
        lambda **kwargs: real_client(transport=transport, **kwargs),
    )


def test_explicit_sse_config_forces_parsing_with_wrong_content_type(monkeypatch):
    _mock_http_client(
        monkeypatch,
        lambda request: httpx.Response(
            200,
            headers={"content-type": "application/json"},
            text=TARGET_SSE,
        ),
    )
    result = AIProviderClient()._make_http_request(
        "https://agent.example/chat", "POST", {}, {}, sse_config=target_config()
    )
    assert result.success is True
    assert result.provider_response.output.startswith("你好！")
    assert result.provider_response.metadata["is_sse"] is True


def test_http_error_is_not_hidden_by_sse_completion_validation(monkeypatch):
    _mock_http_client(
        monkeypatch,
        lambda request: httpx.Response(
            401,
            headers={"content-type": "text/event-stream"},
            text='data: {"error":{"message":"unauthorized"}}\n\n',
        ),
    )
    result = AIProviderClient()._make_http_request(
        "https://agent.example/chat", "POST", {}, {}, sse_config=target_config()
    )
    assert result.success is False
    assert "status 401" in result.message
    assert "unauthorized" in result.message
    assert "SSE response parsing failed" not in result.message


def test_timeout_ms_is_strictly_bounded():
    with pytest.raises(ValidationError):
        ProviderConfig(timeout_ms=999)
    with pytest.raises(ValidationError):
        ProviderConfig(timeout_ms=300001)


def test_provider_response_accepts_internal_field_names_with_aliases():
    response = ProviderResponseInfo(
        session_id="session-1",
        token_usage={"InputTokens": 10, "OutputTokens": 4},
    )
    assert response.session_id == "session-1"
    assert response.token_usage == {"InputTokens": 10, "OutputTokens": 4}


def test_eino_event_stream_uses_final_response_without_duplicate_deltas():
    config = SSEParserConfig(
        require_done=True,
        accept_done_marker=False,
        chunks=[{"when": {"type": "response_delta"}, "text_path": "message"}],
        completed=[{"when": {"type": "response"}, "text_path": "message"}],
        done=[{"when": {"type": "done"}}],
        errors=[{"when": {"type": "error"}, "message_path": "message"}],
    )
    events = [
        {"type": "conversation", "message": "会话已创建"},
        {"type": "heartbeat"},
        {"type": "response_start", "message": ""},
        {"type": "response_delta", "message": "你好！我是 Sec", "data": {"accumulated": "你好！我是 Sec"}},
        {"type": "response_delta", "message": "PilotAI，专业的", "data": {"accumulated": "你好！我是 SecPilotAI，专业的"}},
        {"type": "eino_usage_summary", "message": "Eino token usage summary", "data": {"totalTokens": 24964}},
        {"type": "finalization_result", "message": "Agent 终态核验完成", "data": {"outcome": "succeeded"}},
        {"type": "response", "message": "你好！我是 SecPilotAI，专业的网络安全渗透测试代理。"},
        {"type": "done", "message": ""},
    ]
    sse_text = "".join(
        f"data: {json.dumps(event, ensure_ascii=False)}\n\n" for event in events
    )

    raw, usage, metadata = parse_configured_sse(
        sse_text.splitlines(keepends=True), config
    )

    assert raw["content"] == "你好！我是 SecPilotAI，专业的网络安全渗透测试代理。"
    assert raw["content"].count("你好！我是 Sec") == 1
    assert usage is None
    assert metadata["sse_completed"] is True
    assert metadata["sse_event_count"] == len(events)


def test_concatenated_json_objects_are_not_valid_sse():
    config = SSEParserConfig(
        require_done=True,
        accept_done_marker=False,
        completed=[{"when": {"type": "response"}, "text_path": "message"}],
        done=[{"when": {"type": "done"}}],
    )
    concatenated = (
        '{"type":"response","message":"answer"}'
        '{"type":"done","message":""}'
    )
    with pytest.raises(SSEParseError, match="before a configured completion"):
        parse_configured_sse([concatenated], config)
