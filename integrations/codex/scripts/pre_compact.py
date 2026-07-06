#!/usr/bin/env python3
"""PreCompact hook: capture transcript tail before Codex compacts context."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _lib import fail_open_exit, is_configured, read_hook_input, save_compact_capture


def main() -> None:
    if not is_configured():
        fail_open_exit()
    payload = read_hook_input()
    save_compact_capture(payload, "PreCompact")
    fail_open_exit()


if __name__ == "__main__":
    main()
