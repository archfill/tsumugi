#!/usr/bin/env python3
"""PreToolUse(Read) hook: inject file-related past memory.

inject only — never creates observations.

Strategy:
- Extract file_path from the Read tool input
- Skip uninteresting paths (binary, lock files, very deep node_modules, etc.)
- search_memory with basename + parent dir as query
- Inject top hits as additionalContext
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _lib import (
    emit_pre_tool_use_context,
    fail_open_exit,
    first_text,
    is_configured,
    read_hook_input,
    resolve_project_tag,
    search_memory,
    truncate,
)

SEARCH_LIMIT = 3
EXCERPT_LEN = 130

# Skip paths that are uninteresting for memory recall.
_SKIP_SUFFIXES = (
    ".lock",
    ".lockb",
    ".min.js",
    ".min.css",
    ".map",
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".svg",
    ".ico",
    ".webp",
    ".pdf",
    ".zip",
    ".tar",
    ".gz",
    ".bin",
    ".woff",
    ".woff2",
    ".ttf",
    ".eot",
)
_SKIP_PATH_FRAGMENTS = (
    "/node_modules/",
    "/.git/",
    "/dist/",
    "/build/",
    "/.next/",
    "/.cache/",
    "/.venv/",
    "/__pycache__/",
)


def _should_skip(file_path: str) -> bool:
    if not file_path:
        return True
    low = file_path.lower()
    if any(low.endswith(s) for s in _SKIP_SUFFIXES):
        return True
    if any(f in file_path for f in _SKIP_PATH_FRAGMENTS):
        return True
    return False


def _build_query(file_path: str) -> str:
    """basename + immediate parent dir name → search query."""
    basename = os.path.basename(file_path)
    parent = os.path.basename(os.path.dirname(file_path))
    if parent and parent not in (".", "/"):
        return f"{basename} {parent}"
    return basename


def _format_hits(hits: list[dict], file_path: str) -> str:
    if not hits:
        return ""
    lines = [f"## Past memory ({os.path.basename(file_path)})"]
    for h in hits[:SEARCH_LIMIT]:
        layer = h.get("layer") or "?"
        hid = "#" + (h.get("id") or "")[:8]
        excerpt = truncate(h.get("excerpt") or "", EXCERPT_LEN)
        lines.append(f"- {hid} ({layer}) {excerpt}")
    return "\n".join(lines)


def main() -> None:
    if not is_configured():
        fail_open_exit()

    payload = read_hook_input()
    tool_name = first_text(payload, "tool_name", "toolName")
    if tool_name and tool_name != "Read":
        fail_open_exit()

    tool_input = payload.get("tool_input") or payload.get("toolInput") or {}
    if not isinstance(tool_input, dict):
        fail_open_exit()
    file_path = str(tool_input.get("file_path") or "")
    if _should_skip(file_path):
        fail_open_exit()

    cwd = first_text(payload, "cwd", "workingDirectory", "workspace")
    project_tag = resolve_project_tag(cwd)

    query = _build_query(file_path)
    hits = search_memory(query=query, limit=SEARCH_LIMIT, project_tag=project_tag)
    text = _format_hits(hits, file_path)
    if not text:
        fail_open_exit()

    emit_pre_tool_use_context(text)
    fail_open_exit()


if __name__ == "__main__":
    main()
