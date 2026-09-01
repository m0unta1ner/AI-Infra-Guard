"""Configurable, bounded parser for Server-Sent Events responses."""

import json
import re
from typing import Any, Dict, Iterable, List, Optional, Tuple

from pydantic import BaseModel, ConfigDict, Field, model_validator


class SSEParseError(ValueError):
    """Raised when an SSE stream is invalid, incomplete, or exceeds a limit."""


class _StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class SSEMatchRule(_StrictModel):
    when: Dict[str, Any] = Field(default_factory=dict)
    text_path: str


class SSEErrorRule(_StrictModel):
    when: Dict[str, Any] = Field(default_factory=dict)
    message_path: str


class SSEMetadataConfig(_StrictModel):
    usage_path: Optional[str] = None
    timing_path: Optional[str] = None


class SSEDoneRule(_StrictModel):
    when: Dict[str, Any] = Field(default_factory=dict)


class SSEParserConfig(_StrictModel):
    chunks: List[SSEMatchRule] = Field(default_factory=list)
    completed: List[SSEMatchRule] = Field(default_factory=list)
    fallback_completed: List[SSEMatchRule] = Field(default_factory=list)
    done: List[SSEDoneRule] = Field(default_factory=list)
    errors: List[SSEErrorRule] = Field(default_factory=list)
    metadata: SSEMetadataConfig = Field(default_factory=SSEMetadataConfig)
    require_done: bool = True
    accept_done_marker: bool = True
    max_events: int = Field(default=10_000, ge=1, le=100_000)
    max_response_bytes: int = Field(default=4 * 1024 * 1024, ge=1024, le=32 * 1024 * 1024)

    @model_validator(mode="after")
    def validate_rules(self):
        if not (self.chunks or self.completed or self.fallback_completed):
            raise ValueError("SSE config requires at least one content extraction rule")
        if self.require_done and not (self.done or self.accept_done_marker):
            raise ValueError("require_done requires a done rule or accept_done_marker=true")
        for rule in [*self.chunks, *self.completed, *self.fallback_completed]:
            _parse_path(rule.text_path)
            for path in rule.when:
                _parse_path(path)
        for rule in self.errors:
            _parse_path(rule.message_path)
            for path in rule.when:
                _parse_path(path)
        for rule in self.done:
            for path in rule.when:
                _parse_path(path)
        if self.metadata.usage_path:
            _parse_path(self.metadata.usage_path)
        if self.metadata.timing_path:
            _parse_path(self.metadata.timing_path)
        return self


_PATH_TOKEN = re.compile(r"([A-Za-z_][A-Za-z0-9_-]*)|\[(\d+)\]")


def _parse_path(path: str) -> List[Any]:
    if not path or len(path) > 256:
        raise ValueError(f"Invalid SSE field path: {path!r}")
    tokens: List[Any] = []
    for part in path.split("."):
        if not part:
            raise ValueError(f"Invalid SSE field path: {path!r}")
        part_position = 0
        for match in _PATH_TOKEN.finditer(part):
            if match.start() != part_position:
                raise ValueError(f"Invalid SSE field path: {path!r}")
            token = match.group(1)
            if token is not None:
                tokens.append(token)
            else:
                index = int(match.group(2))
                if index > 10_000:
                    raise ValueError(f"SSE field path index is too large: {path!r}")
                tokens.append(index)
            part_position = match.end()
        if part_position != len(part):
            raise ValueError(f"Invalid SSE field path: {path!r}")
    if len(tokens) > 32:
        raise ValueError("SSE field path contains too many components")
    return tokens


def get_path(value: Any, path: str) -> Any:
    current = value
    for token in _parse_path(path):
        if isinstance(token, int):
            if not isinstance(current, list) or token >= len(current):
                return None
            current = current[token]
        else:
            if not isinstance(current, dict) or token not in current:
                return None
            current = current[token]
    return current


def _matches(event: Dict[str, Any], conditions: Dict[str, Any]) -> bool:
    return all(get_path(event, path) == expected for path, expected in conditions.items())


def _event_data(lines: Iterable[str], max_bytes: int) -> Iterable[str]:
    data_lines: List[str] = []
    total_bytes = 0
    for raw_line in lines:
        total_bytes += len(raw_line.encode("utf-8"))
        if not raw_line.endswith(("\n", "\r")):
            # httpx.iter_lines() removes delimiters; include one byte so the
            # configured limit remains conservative for streamed responses.
            total_bytes += 1
        if total_bytes > max_bytes:
            raise SSEParseError(f"SSE response exceeded {max_bytes} bytes")
        line = raw_line.rstrip("\r\n")
        if not line:
            if data_lines:
                yield "\n".join(data_lines)
                data_lines = []
            continue
        if line.startswith(":"):
            continue
        field, separator, value = line.partition(":")
        if separator and value.startswith(" "):
            value = value[1:]
        if field == "data":
            data_lines.append(value)
    if data_lines:
        yield "\n".join(data_lines)


def parse_configured_sse(lines: Iterable[str], config: SSEParserConfig) -> Tuple[Dict[str, Any], Optional[Dict[str, Any]], Dict[str, Any]]:
    chunks: List[str] = []
    completed: Optional[str] = None
    fallback_completed: Optional[str] = None
    usage = None
    timing = None
    done = False
    event_count = 0

    for data_text in _event_data(lines, config.max_response_bytes):
        if data_text == "[DONE]":
            if config.accept_done_marker:
                done = True
            continue
        try:
            event = json.loads(data_text)
        except json.JSONDecodeError as exc:
            raise SSEParseError(f"Invalid JSON in SSE data event: {exc.msg}") from exc
        if not isinstance(event, dict):
            continue
        event_count += 1
        if event_count > config.max_events:
            raise SSEParseError(f"SSE response exceeded {config.max_events} events")

        for rule in config.errors:
            if _matches(event, rule.when):
                message = get_path(event, rule.message_path)
                raise SSEParseError(f"SSE error event: {message or 'unknown error'}")

        for rule in config.completed:
            if _matches(event, rule.when):
                text = get_path(event, rule.text_path)
                if text is not None:
                    completed = str(text)
                    break
        if completed is None:
            for rule in config.fallback_completed:
                if _matches(event, rule.when):
                    text = get_path(event, rule.text_path)
                    if text is not None:
                        fallback_completed = str(text)
                        break
        for rule in config.chunks:
            if _matches(event, rule.when):
                text = get_path(event, rule.text_path)
                if text is not None:
                    chunks.append(str(text))
                break

        if any(_matches(event, rule.when) for rule in config.done):
            done = True
            if config.metadata.usage_path:
                usage = get_path(event, config.metadata.usage_path)
            if config.metadata.timing_path:
                timing = get_path(event, config.metadata.timing_path)
            # A configured done event is a protocol-level terminal signal.
            # Stop consuming immediately because some SSE servers keep the
            # HTTP connection open and continue sending heartbeats afterward.
            break

    if config.require_done and not done:
        raise SSEParseError("SSE stream ended before a configured completion event")
    output = completed if completed is not None else fallback_completed
    if output is None:
        output = "".join(chunks)
    if not output:
        raise SSEParseError("SSE response did not contain extractable output")
    metadata = {"sse_event_count": event_count, "sse_completed": done}
    if timing is not None:
        metadata["timing"] = timing
    return {"content": output, "raw_sse": True}, usage, metadata
