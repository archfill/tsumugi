#!/usr/bin/env python3
"""PostToolUse hook: capture milestone Bash commands only."""

from __future__ import annotations

import re
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).parent))
from _lib import fail_open_exit, first_text, is_configured, read_hook_input, save_capture

MILESTONE_RE = re.compile(
    r"^\s*(git\s+commit\b(?!.*\s--amend\b)|git\s+push\b(?!.*\s(--force|-f)\b)|gh\s+pr\s+merge\b|gh\s+release\s+create\b)",
    re.IGNORECASE,
)


def _tool_name(payload: dict[str, Any]) -> str:
    return first_text(payload, "tool_name", "toolName", "name") or first_text(
        payload.get("tool", {}) if isinstance(payload.get("tool"), dict) else {},
        "name",
    )


def _command(payload: dict[str, Any]) -> str:
    direct = first_text(payload, "command")
    if direct:
        return direct
    tool_input = payload.get("tool_input") or payload.get("toolInput") or payload.get("input")
    if isinstance(tool_input, dict):
        return first_text(tool_input, "command", "cmd")
    return ""


def main() -> None:
    if not is_configured():
        fail_open_exit()
    payload = read_hook_input()
    tool_name = _tool_name(payload)
    command = _command(payload)
    if tool_name != "Bash" or not MILESTONE_RE.search(command):
        fail_open_exit()
    save_capture(payload, "PostToolUse", tool_name=tool_name)
    fail_open_exit()


if __name__ == "__main__":
    main()
