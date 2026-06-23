#!/usr/bin/env python3
"""SessionStart hook: inject past memory + save_observation rubric.

matcher: startup | clear | compact

On compact, append a recall-recovery nudge prompting the agent to save
unsaved discoveries before context shrinks further (ADR-011 §3.1).

inject only — never creates observations.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _lib import (
    emit_session_start_context,
    fail_open_exit,
    first_text,
    is_configured,
    list_recent_memories,
    list_recent_observations,
    read_hook_input,
    resolve_project_tag,
    search_memory,
    truncate,
)

MEMORY_LIMIT = 8
OBSERVATION_LIMIT = 6
MEMORY_EXCERPT_LEN = 140
OBSERVATION_EXCERPT_LEN = 120


RUBRIC = """\
# tsumugi memory — guidance

Use the past memory above to inform your work. Call `save_observation`
(via MCP) at the following moments:

| Situation                                  | type        | Example                                                |
| ------------------------------------------ | ----------- | ------------------------------------------------------ |
| Discovered a cause / mechanism / insight   | discovery   | "N+1 query at routes.py:42 caused the slowdown"        |
| Completed a task / shipped something       | progress    | "Merged PR #18, deployed to prod"                      |
| Made an architectural / design decision    | decision    | "Adopted inject-only hook design (ADR-011)"            |
| Hit a blocker / found a workaround         | blocker     | "alembic stamp drift caused crash loop, fixed via X"   |
| Session-end retrospective                  | reflection  | "Deleted 1,946 noise obs (32% pollution rate)"         |

Skip short / vague / procedural notes. Keep content to 1-3 sentences.
Put searchable keywords into `facts`. Set `source: "claude-code"` and
include `project_tag` and `session_id` when relevant.

For recall, prefer `search_memory` before guessing. Use the default
project-scoped search first; only pass `filter.project_tag: null` when you
intentionally need cross-project or session-only recall. Inspect
`provenance` on memory hits when source context matters.

If a memory is clearly obsolete, call `mark_memory_outdated` with the memory
id and a concrete reason. This marks it for the next dreaming maintenance
pass; it does not immediately delete it.
"""

COMPACT_NUDGE = """\
## ⚠ Context was just compacted

The previous turn triggered context compaction, so earlier session
details may have been summarized away. Before continuing:

1. Recall any unsaved discoveries / decisions / progress from this
   session that are still in your working memory
2. Call `save_observation` for anything worth preserving before
   continuing further work
3. If you need to look up something from before the compaction, call
   project-scoped `search_memory` rather than guessing

tsumugi does **not** automatically capture compacted content on its own
— this responsibility is intentionally delegated to you (the agent).
"""


def _format_memories(memories: list[dict]) -> list[str]:
    if not memories:
        return []
    lines = ["## Recent memories"]
    for m in memories[:MEMORY_LIMIT]:
        mid = "#" + (m.get("id") or "")[:8]
        kind = m.get("kind") or "?"
        narrative = truncate(m.get("narrative") or "", MEMORY_EXCERPT_LEN)
        importance = m.get("importance")
        imp = f"[imp {importance:.0f}]" if isinstance(importance, (int, float)) else ""
        lines.append(f"- {mid} {imp} ({kind}) {narrative}".replace("  ", " "))
    return lines


def _format_observations(observations: list[dict]) -> list[str]:
    if not observations:
        return []
    lines = ["## Recent observations"]
    for o in observations[:OBSERVATION_LIMIT]:
        oid = "#" + (o.get("id") or "")[:8]
        otype = o.get("type") or "?"
        content = truncate(o.get("content") or "", OBSERVATION_EXCERPT_LEN)
        lines.append(f"- {oid} ({otype}) {content}")
    return lines


def _format_search_hits(hits: list[dict]) -> list[str]:
    """Render search_memory hits as a section. Falls back to nothing if empty."""
    if not hits:
        return []
    lines = ["## Past memory (project-scoped search)"]
    for h in hits[:MEMORY_LIMIT]:
        layer = h.get("layer") or "?"
        hid = "#" + (h.get("id") or "")[:8]
        excerpt = truncate(h.get("excerpt") or "", MEMORY_EXCERPT_LEN)
        lines.append(f"- {hid} ({layer}) {excerpt}")
    return lines


def main() -> None:
    if not is_configured():
        fail_open_exit()

    payload = read_hook_input()
    source = first_text(payload, "source")  # startup | clear | compact
    cwd = first_text(payload, "cwd", "workingDirectory", "workspace")
    session_id = first_text(payload, "session_id", "sessionId").strip()
    project_tag = resolve_project_tag(cwd)

    parts: list[str] = []
    parts.append(f"# tsumugi context — project: {project_tag}")
    if session_id:
        parts.append(f"_session: {session_id}_")

    # Try project-scoped search first; fall back to recent lists if empty.
    search_hits = search_memory(query=project_tag, limit=MEMORY_LIMIT, project_tag=project_tag)
    if search_hits:
        parts.extend(_format_search_hits(search_hits))
    else:
        mem_lines = _format_memories(list_recent_memories(limit=MEMORY_LIMIT))
        obs_lines = _format_observations(
            list_recent_observations(limit=OBSERVATION_LIMIT)
        )
        parts.extend(mem_lines)
        parts.extend(obs_lines)

    parts.append("")
    parts.append(RUBRIC)

    if source == "compact":
        parts.append("")
        parts.append(COMPACT_NUDGE)

    text = "\n".join(p for p in parts if p is not None).strip()
    if not text:
        fail_open_exit()

    emit_session_start_context(text)
    fail_open_exit()


if __name__ == "__main__":
    main()
