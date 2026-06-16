#!/usr/bin/env python3
"""UserPromptSubmit hook: detect resume / error patterns → auto-search.

inject only — never creates observations from the prompt itself.

Detection (regex, no LLM):
- Resume: "continue from", "where (did) we leave off", "what were we", etc.
- Error: Traceback / panic / fatal / multiple Error: lines

When detected, call search_memory with the prompt (or extracted error text)
and inject the top hits as additionalContext.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _lib import (
    emit_user_prompt_context,
    fail_open_exit,
    first_text,
    is_configured,
    read_hook_input,
    resolve_project_tag,
    sanitize_secrets,
    search_memory,
    truncate,
)

MIN_PROMPT_LEN = 20
SEARCH_LIMIT = 5
EXCERPT_LEN = 150

RESUME_RE = re.compile(
    r"("
    r"where\s+(did\s+)?(we|i)\s+(leave|left)\s+off"
    r"|continue\s+(from\s+)?(where|last)"
    r"|what\s+(were|are)\s+we\s+(working|doing)"
    r"|pick\s+up\s+where"
    r"|resume\s+(from\s+|where)"
    r"|what'?s\s+the\s+(current|latest)\s+(state|status)"
    r"|catch\s+me\s+up"
    r"|where\s+are\s+we"
    r"|前回|続き|どこまで(やった|進んだ)|最新の(状態|進捗|状況)"
    r")",
    re.IGNORECASE,
)

ERROR_RE = re.compile(
    r"("
    r"Traceback\s*\(most recent call last\)"
    r"|^panic:\s"
    r"|^fatal:\s"
    r"|(Error|Exception|FAIL|FAILED)[:\s].{2,}"
    r"|StackTrace"
    r"|caused by:"
    r")",
    re.IGNORECASE | re.MULTILINE,
)


def _detect_intent(prompt: str) -> str | None:
    """Return 'resume', 'error', or None."""
    if RESUME_RE.search(prompt):
        return "resume"
    if len(ERROR_RE.findall(prompt)) >= 1 and (
        "Traceback" in prompt
        or "panic:" in prompt
        or prompt.lstrip().startswith("fatal:")
        or len(ERROR_RE.findall(prompt)) >= 2
    ):
        return "error"
    return None


def _extract_error_text(prompt: str) -> str:
    """For error queries, prefer the actual error string over the full prompt."""
    for m in ERROR_RE.finditer(prompt):
        line = m.group(0).strip()
        if line:
            return line[:200]
    return prompt[:200]


def _format_hits(hits: list[dict], intent: str) -> str:
    if not hits:
        return ""
    header = {
        "resume": "## Past memory (recall for resume)",
        "error": "## Past memory (matching error patterns)",
    }.get(intent, "## Past memory")
    lines = [header]
    for h in hits[:SEARCH_LIMIT]:
        layer = h.get("layer") or "?"
        hid = "#" + (h.get("id") or "")[:8]
        excerpt = truncate(h.get("excerpt") or "", EXCERPT_LEN)
        lines.append(f"- {hid} ({layer}) {excerpt}")
    lines.append("")
    lines.append(
        "If any of the above is directly relevant, weave it into your reply. "
        "Call `search_memory` for more if needed."
    )
    return "\n".join(lines)


def main() -> None:
    if not is_configured():
        fail_open_exit()

    payload = read_hook_input()
    prompt = first_text(payload, "prompt", "userPrompt", "message")
    if not prompt or len(prompt) < MIN_PROMPT_LEN:
        fail_open_exit()

    cwd = first_text(payload, "cwd", "workingDirectory", "workspace")
    project_tag = resolve_project_tag(cwd)

    intent = _detect_intent(prompt)
    if not intent:
        fail_open_exit()

    if intent == "error":
        query = _extract_error_text(prompt)
    else:
        query = prompt[:400]

    query = sanitize_secrets(query)
    hits = search_memory(query=query, limit=SEARCH_LIMIT, project_tag=project_tag)
    text = _format_hits(hits, intent)
    if not text:
        fail_open_exit()

    emit_user_prompt_context(text)
    fail_open_exit()


if __name__ == "__main__":
    main()
