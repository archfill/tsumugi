#!/usr/bin/env python3
"""Stop hook: persist a turn checkpoint without invoking promotion."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _lib import fail_open_exit, is_configured, read_hook_input, save_capture


def main() -> None:
    if not is_configured():
        fail_open_exit()
    payload = read_hook_input()
    save_capture(payload, "Stop")
    fail_open_exit()


if __name__ == "__main__":
    main()
