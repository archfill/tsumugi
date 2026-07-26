# Runtime evidence map

Use the smallest read-only signal set that answers the question. Verify response schemas in
`packages/shared/src/schema.ts` and metrics in `apps/server/src/lib/metrics.ts` before relying on
field names.

## Evidence sources

| Source | Use | Boundary |
| --- | --- | --- |
| `/health` | Process, database, scheduler, and embedder availability | Liveness only |
| `/api/admin/overview` | Layer totals, activity, current attention, scheduler state | Confirm filter semantics before comparing with lists |
| `/api/admin/pipeline/traces` | Explain capture-to-observation and legacy provenance paths | Inspect bounded sanitized samples |
| `/api/admin/operations/issues` | Current deterministic window failures and outdated memory | Separate current issues from historical fact / LLM rows |
| `/api/dreaming/runs` | Persisted deterministic maintenance outcomes and duration | The endpoint name is retained for compatibility |
| `/api/scheduler` | Enabled state and registered jobs | Registration does not prove execution |
| `/metrics` | HTTP, deterministic run, embedder, observation, and memory signals | Counters need interval deltas |

Use direct PostgreSQL only when explicitly authorized and higher-level evidence is insufficient.

## Current implementation cautions

- capture uses `captured_at`, observation uses `created_at`, and memory activity uses `updated_at`;
- Layer 2 observation is the canonical source; Layer 3 memory is legacy or explicitly curated;
- direct `save_observation` is completed at insert and has no semantic promotion queue;
- only `promote-captures`, `sweep-captures`, and opt-in `archive-outdated` have active effects;
- `promote-observations`, `synthesize`, `time-update`, `decision-contradiction`, `reflection`, and
  `full` return `removed_server_llm` without DB or provider side effects;
- pending observation, fact, memory quarantine, retry, and provider fields are historical unless
  current source proves otherwise;
- metric names beginning with `tsumugi_dreaming_` are retained for dashboard compatibility and
  describe deterministic maintenance runs;
- continuity candidates show what could be injected, not whether injection improved resumption.

## Core signals

### Capture and Stop promotion

- capture volume and source / project mix;
- active Stop checkpoint coverage and duplicate turn evidence;
- deterministic window state, oldest actionable age, attempt count, and failure mechanism;
- promotion throughput and atomic completion evidence;
- TTL sweep volume and retained active windows.

Backlog size without age and drain rate is insufficient. Do not classify a historical provider
failure field as a current cause.

### Observation-first recall

- observation and memory totals and activity over the same interval;
- bounded query samples with `SearchHit` layer / score and provenance links;
- treat `source` / `session_id` / `type` as observation-only request filters;
- treat `project_tag` as applying to observations and memories connected to that project through
  `derived_from` provenance;
- inspect outdated state through the authorized admin evidence source rather than assuming filters
  or outdated state are returned directly on `SearchHit`;
- directly-derived memory suppression when its source observation is also a candidate;
- continued recall of standalone, unlinked, and curated memory;
- Recall@k / MRR against a named synthetic or authorized private baseline.

Do not infer recall quality from row count or promotion throughput alone.

### Forgetting and archive

- capture TTL eligibility and sweep results;
- memory active / outdated / archived counts;
- archive plan, expected count, applied count, and restore count when evaluating a prior approved run;
- database and index volume before and after an approved reversible operation.

Observation is read-only. Do not create, apply, restore, or mutate an archive batch from this skill.

### Scheduler and run history

- registered active jobs and configured cron expressions;
- `tsumugi_dreaming_runs_total` and `tsumugi_dreaming_run_duration_seconds` by active job;
- persisted run status, duration, stopped reason, and sanitized error summary;
- service restart or counter reset within the comparison window.

Removed compatibility jobs returning `removed_server_llm` are not successful semantic work.

### Capacity and process health

Use HTTP latency, process metrics, embedder state, table volume, and index volume only when they
support the question. Report growth as a time series and include retention behavior.

## Comparison rules

- Name baseline and current windows.
- Use identical filters and definitions.
- Report absolute values and deltas; include rates when window lengths differ.
- State counter resets and service restarts.
- Do not invent thresholds when no ADR, runbook, or SLO defines them.
