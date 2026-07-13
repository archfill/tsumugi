"""Shared helpers for tsumugi Codex hooks.

Design principles (ADR-011 / ADR-014):
- urllib only, no external deps
- fail-open: never block Claude Code
- hooks never POST observations directly; deterministic hook capture writes
  only to Layer 1 captures and later dreaming promotes selected entries

Credentials precedence:
  1. TSUMUGI_API_URL / TSUMUGI_API_KEY env vars
  2. ~/.config/tsumugi/credentials.json with {api_url, api_key}
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request
from collections import deque
from pathlib import Path
from typing import Any

DEFAULT_TIMEOUT = 2.0
DEFAULT_CREDENTIALS_PATH = Path.home() / ".config" / "tsumugi" / "credentials.json"
DEFAULT_SOURCE = "codex"
MAX_COMPACT_TRANSCRIPT_RECORDS = 24
MAX_COMPACT_STRING_LEN = 2000
MAX_COMPACT_LIST_ITEMS = 24

_credentials_cache: dict[str, str] | None = None


def _credentials_path() -> Path:
    raw = os.environ.get("TSUMUGI_CREDENTIALS_FILE")
    return Path(raw).expanduser() if raw else DEFAULT_CREDENTIALS_PATH


def _load_credentials_file() -> dict[str, str]:
    """Read credentials JSON. Returns {} on any failure."""
    global _credentials_cache
    if _credentials_cache is not None:
        return _credentials_cache
    path = _credentials_path()
    try:
        if not path.is_file():
            _credentials_cache = {}
            return _credentials_cache
        with path.open(encoding="utf-8") as fp:
            data = json.load(fp)
        if isinstance(data, dict):
            _credentials_cache = {
                str(k): str(v) for k, v in data.items() if isinstance(v, (str, int))
            }
        else:
            _credentials_cache = {}
    except (OSError, json.JSONDecodeError):
        _credentials_cache = {}
    return _credentials_cache


def _env_url() -> str | None:
    return os.environ.get("TSUMUGI_API_URL") or _load_credentials_file().get("api_url")


def _env_key() -> str | None:
    """Optional. tsumugi server may not require auth."""
    return os.environ.get("TSUMUGI_API_KEY") or _load_credentials_file().get("api_key")


def _env_timeout() -> float:
    raw = os.environ.get("TSUMUGI_HOOK_TIMEOUT")
    if not raw:
        return DEFAULT_TIMEOUT
    try:
        return float(raw)
    except ValueError:
        return DEFAULT_TIMEOUT


def is_configured() -> bool:
    """tsumugi is reachable if at least the URL is set."""
    return bool(_env_url())


def read_hook_input() -> dict[str, Any]:
    """Parse JSON from stdin. Returns {} on any failure."""
    if sys.stdin.isatty():
        return {}
    try:
        data = sys.stdin.read()
        if not data:
            return {}
        parsed = json.loads(data)
        return parsed if isinstance(parsed, dict) else {}
    except (json.JSONDecodeError, OSError):
        return {}


def first_text(payload: dict[str, Any], *keys: str) -> str:
    for key in keys:
        value = payload.get(key)
        if value is not None and value != "":
            return str(value)
    return ""


def collect_git_remote(cwd: str | None) -> str | None:
    """git origin URL from cwd. None on failure."""
    if not cwd:
        return None
    try:
        result = subprocess.run(
            ["git", "-C", cwd, "remote", "get-url", "origin"],
            capture_output=True,
            text=True,
            timeout=2,
        )
    except (subprocess.SubprocessError, OSError):
        return None
    if result.returncode != 0:
        return None
    url = (result.stdout or "").strip()
    return url or None


def resolve_project_tag(cwd: str | None) -> str:
    """git origin URL, or cwd basename, or 'unknown'."""
    remote = collect_git_remote(cwd)
    if remote:
        return remote
    if cwd:
        return os.path.basename(os.path.normpath(cwd)) or cwd
    return "unknown"


# Secrets patterns: same as extract.ts SECRETS_RE
_SECRETS_RE = re.compile(
    r"("
    r"postgresql://[^:\s]+:[^@\s]+@"
    r"|mysql://[^:\s]+:[^@\s]+@"
    r"|mongodb(\+srv)?://[^:\s]+:[^@\s]+@"
    r"|password\s*[=:]\s*['\"]?\S+"
    r"|token\s*[=:]\s*['\"]?[\w.\-]+"
    r"|secret\s*[=:]\s*['\"]?\S+"
    r"|Authorization\s*:\s*(Bearer|Basic|Token)\s+[\w.\-+/=]+"
    r"|Bearer\s+[\w.\-]{20,}"
    r"|yui_pg_password"
    r"|secrets\.yml"
    r"|private[_\-]?key"
    r"|\bAPI[_\-]?KEY\b"
    r"|access[_\-]?key"
    r"|\beyJ[\w.\-]{30,}"
    r")",
    re.IGNORECASE,
)


def sanitize_secrets(text: str) -> str:
    """Redact secrets-looking strings. Idempotent."""
    if not text:
        return text
    return _SECRETS_RE.sub("[REDACTED]", text)


def _bearer_headers() -> dict[str, str]:
    """Auth header if API key is set, otherwise empty."""
    key = _env_key()
    if not key:
        return {}
    return {"Authorization": f"Bearer {key}"}


def _request(method: str, path: str, body: Any | None = None) -> Any | None:
    """HTTP request to tsumugi REST API. Returns parsed JSON or None on failure."""
    base = _env_url()
    if not base:
        return None
    url = base.rstrip("/") + path
    payload = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=payload, method=method)
    for k, v in _bearer_headers().items():
        req.add_header(k, v)
    if payload is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=_env_timeout()) as resp:
            raw = resp.read()
            if not raw:
                return {}
            try:
                return json.loads(raw)
            except json.JSONDecodeError:
                return None
    except (urllib.error.URLError, TimeoutError, OSError):
        return None


def search_memory(
    query: str,
    limit: int = 10,
    project_tag: str | None = None,
    type: str | None = None,
    source: str | None = None,
    session_id: str | None = None,
) -> list[dict[str, Any]]:
    """GET /api/search?q=... — hybrid search (pg_bigm + pgvector RRF).

    Returns a list of SearchHit dicts (layer / id / excerpt / score / ...).
    Empty list on error or no hits.
    """
    if not query:
        return []
    from urllib.parse import urlencode

    params: list[tuple[str, str]] = [("q", query), ("limit", str(limit))]
    if project_tag:
        params.append(("project_tag", project_tag))
    if type:
        params.append(("type", type))
    if source:
        params.append(("source", source))
    if session_id:
        params.append(("session_id", session_id))
    data = _request("GET", "/api/search?" + urlencode(params))
    if not isinstance(data, dict):
        return []
    hits = data.get("hits")
    return hits if isinstance(hits, list) else []


def list_recent_memories(limit: int = 10) -> list[dict[str, Any]]:
    """GET /api/memories?limit=N — returns active memories ordered by created_at."""
    data = _request("GET", f"/api/memories?limit={limit}")
    if not isinstance(data, dict):
        return []
    memories = data.get("memories")
    return memories if isinstance(memories, list) else []


def list_recent_observations(
    limit: int = 10, project_tag: str | None = None
) -> list[dict[str, Any]]:
    """GET /api/observations?limit=N. project_tag filter not yet supported by REST."""
    _ = project_tag  # reserved for when REST gains filtering
    data = _request("GET", f"/api/observations?limit={limit}")
    if not isinstance(data, dict):
        return []
    obs = data.get("observations")
    return obs if isinstance(obs, list) else []


def get_capture_continuity(
    project_tag: str,
    exclude_session_id: str | None = None,
    max_sessions: int = 3,
    max_turns_per_session: int = 3,
) -> list[dict[str, Any]]:
    """Return bounded unpromoted checkpoints without exposing raw captures."""
    from urllib.parse import urlencode

    params = [
        ("project_tag", project_tag),
        ("max_sessions", str(max_sessions)),
        ("max_turns_per_session", str(max_turns_per_session)),
    ]
    if exclude_session_id:
        params.append(("exclude_session_id", exclude_session_id))
    data = _request("GET", "/api/captures/continuity?" + urlencode(params))
    if not isinstance(data, dict):
        return []
    sessions = data.get("sessions")
    return sessions if isinstance(sessions, list) else []


def resolve_session_id(payload: dict[str, Any]) -> str:
    return (
        first_text(
            payload,
            "session_id",
            "sessionId",
            "conversation_id",
            "conversationId",
            "transcript_path",
            "transcriptPath",
        )
        or os.environ.get("TSUMUGI_SESSION_ID")
        or "unknown"
    )


def _capture_raw_content(payload: dict[str, Any]) -> str:
    raw = json.dumps(payload, ensure_ascii=False, sort_keys=True)
    return truncate(sanitize_secrets(raw), 20000)


def save_capture(
    payload: dict[str, Any],
    hook_event: str,
    tool_name: str | None = None,
    source: str = DEFAULT_SOURCE,
) -> None:
    """POST a Layer 1 capture. Fail-open; ignores all errors."""
    cwd = first_text(payload, "cwd", "workingDirectory", "workspace")
    body = {
        "session_id": resolve_session_id(payload),
        "project_tag": resolve_project_tag(cwd),
        "source": source,
        "hook_event": hook_event,
        "raw_content": _capture_raw_content(payload),
    }
    turn_id = first_text(payload, "turn_id", "turnId")
    if turn_id:
        body["turn_id"] = turn_id
    continuity_content = ""
    if hook_event == "Stop":
        continuity_content = first_text(
            payload, "last_assistant_message", "lastAssistantMessage"
        )
    elif hook_event == "UserPromptSubmit":
        continuity_content = first_text(payload, "prompt", "userPrompt", "message")
    if continuity_content:
        body["continuity_content"] = truncate(
            sanitize_secrets(continuity_content), 20000
        )
    if tool_name:
        body["tool_name"] = tool_name
    _request("POST", "/api/captures", body)


def _read_jsonl_tail(path: Path, max_records: int) -> list[dict[str, Any]]:
    records: deque[dict[str, Any]] = deque(maxlen=max_records)
    try:
        with path.open(encoding="utf-8") as fp:
            for line in fp:
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(obj, dict):
                    records.append(obj)
    except OSError:
        return []
    return list(records)


def _read_last_compacted_record(path: Path) -> dict[str, Any] | None:
    last: dict[str, Any] | None = None
    try:
        with path.open(encoding="utf-8") as fp:
            for line in fp:
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(obj, dict) and obj.get("type") == "compacted":
                    last = obj
    except OSError:
        return None
    return last


def _scrub_compact_value(value: Any, depth: int = 0) -> Any:
    if depth > 8:
        return "[TRUNCATED_DEPTH]"
    if isinstance(value, str):
        return truncate(sanitize_secrets(value), MAX_COMPACT_STRING_LEN)
    if isinstance(value, (int, float, bool)) or value is None:
        return value
    if isinstance(value, list):
        return [
            _scrub_compact_value(item, depth + 1)
            for item in value[:MAX_COMPACT_LIST_ITEMS]
        ]
    if isinstance(value, dict):
        out: dict[str, Any] = {}
        for key, child in value.items():
            key_str = str(key)
            if key_str in {"encrypted_content", "base64", "image", "screenshot"}:
                out[key_str] = "[REDACTED_NON_TEXT_CONTENT]"
                continue
            out[key_str] = _scrub_compact_value(child, depth + 1)
        return out
    return truncate(sanitize_secrets(str(value)), MAX_COMPACT_STRING_LEN)


def _compact_payload_for_capture(payload: dict[str, Any], hook_event: str) -> dict[str, Any]:
    transcript = first_text(payload, "transcript_path", "transcriptPath")
    transcript_path = Path(transcript).expanduser() if transcript else None
    compact_payload: dict[str, Any] = {
        "cwd": first_text(payload, "cwd", "workingDirectory", "workspace"),
        "session_id": first_text(payload, "session_id", "sessionId"),
        "transcript_path": transcript,
        "hook_payload": _scrub_compact_value(payload),
        "capture_kind": "codex_compaction",
    }
    if not transcript_path or not transcript_path.is_file():
        compact_payload["transcript_available"] = False
        return compact_payload

    compact_payload["transcript_available"] = True
    compact_payload["transcript_path"] = str(transcript_path)
    if hook_event == "PostCompact":
        compact_payload["compacted_record"] = _scrub_compact_value(
            _read_last_compacted_record(transcript_path)
        )
    else:
        compact_payload["transcript_tail"] = _scrub_compact_value(
            _read_jsonl_tail(transcript_path, MAX_COMPACT_TRANSCRIPT_RECORDS)
        )
    return compact_payload


def save_compact_capture(payload: dict[str, Any], hook_event: str) -> None:
    """Capture compact boundary context without writing Layer 2 observations."""
    save_capture(_compact_payload_for_capture(payload, hook_event), hook_event)


def emit_session_start_context(text: str) -> None:
    """Write the SessionStart hook output to stdout."""
    out = {
        "hookSpecificOutput": {
            "hookEventName": "SessionStart",
            "additionalContext": text,
        }
    }
    sys.stdout.write(json.dumps(out))
    sys.stdout.flush()


def emit_user_prompt_context(text: str) -> None:
    """Write the UserPromptSubmit hook output to stdout."""
    out = {
        "hookSpecificOutput": {
            "hookEventName": "UserPromptSubmit",
            "additionalContext": text,
        }
    }
    sys.stdout.write(json.dumps(out))
    sys.stdout.flush()


def emit_pre_tool_use_context(text: str) -> None:
    """Write the PreToolUse hook output to stdout."""
    out = {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "additionalContext": text,
        }
    }
    sys.stdout.write(json.dumps(out))
    sys.stdout.flush()


def fail_open_exit() -> None:
    """Exit 0 unconditionally so Claude Code is never blocked."""
    sys.exit(0)


def truncate(text: str, n: int) -> str:
    if not text:
        return text
    return text if len(text) <= n else text[:n] + "…"
