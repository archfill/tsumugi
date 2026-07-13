# Runtime evidence map

Use the smallest set of read-only signals that answers the observation question. Verify current response schemas in `packages/shared/src/schema.ts` and instrumentation in `apps/server/src/lib/metrics.ts` before relying on field or metric names.

## Evidence sources

| Source | Use | Important boundary |
| --- | --- | --- |
| `/health` | Process, database, scheduler, and embedder availability | Liveness only; it does not prove promotion or memory quality |
| `/api/admin/overview` | Layer totals, 24-hour activity, state counts, oldest actionable item, queue summaries, attention count, scheduler state | Verify which requested filters the aggregate queries apply; do not assume parity with trace or issue lists |
| `/api/admin/pipeline/traces` and trace detail | Explain capture-to-memory paths and locate stuck stages | Inspect bounded samples; sanitize content and identifiers |
| `/api/admin/operations/issues` | Deferred, quarantined, expired-lease, and partial-run attention items | An issue count needs age and cause distribution |
| `/api/dreaming/runs` | Persisted job status, partial outcomes, errors, and timing | Separate provider cooldown from item failure |
| `/api/scheduler` | Enabled state and registered jobs | Registration does not prove successful execution |
| `/metrics` | Rates, latency, retries, circuit transitions, run outcomes, and data gauges | Counters require interval deltas; gauges require timestamped snapshots |

Use direct PostgreSQL queries only when explicitly authorized and the API or metrics cannot answer the question. Prefer repository semantics over ad hoc assumptions about state columns.

## Current implementation cautions

Verify these against the current source before every material decision:

- layer time filters use different columns: capture uses `captured_at`, observation uses `created_at`, and memory uses `updated_at`;
- memory `created_24h` is therefore 24-hour update activity, not strictly newly created memories;
- overview aggregates do not necessarily apply list-oriented `state` or free-text filters, so do not compare them as the same population without checking the repository query;
- LLM call and retry metrics have no job label, so promotion-specific call attribution may require persisted run evidence;
- circuit metrics identify a provider but do not expose the internal endpoint-plus-credential circuit key;
- database gauges cover observations and memories but not complete capture, window, fact, link, or table-size growth;
- continuity candidates show what could be injected, not whether the injection improved resumption.

## Core signals

### Capture

- layer total and `created_24h`;
- promotion-state distribution;
- oldest actionable capture;
- completed-turn capture coverage by source and project;
- duplicate or missing turn checkpoints when continuity is under review.

Interpret volume together with source mix and retention. More captures can mean better coverage or increased noise.

### Promotion queues

- window and fact counts by state;
- oldest actionable age;
- pending, processing, committing, deferred, completed, and quarantined distribution;
- drain rate across the observation window;
- `stoppedReason` distribution for promotion runs;
- attention items grouped by mechanism rather than error message text alone.

Backlog size without age or drain rate is insufficient. Provider cooldown should not be reported as item poisoning.

### Observation and memory

- observation and memory totals and 24-hour creation;
- promotion-state distribution and oldest actionable observation;
- active, archived, outdated, and quarantined memory counts;
- bounded sample of promoted memories with observation provenance;
- factual precision, duplication, usefulness, and continuity value in the sample.

Do not treat promotion ratio as quality. Pair quantitative flow evidence with a small, explicitly selected qualitative sample.

### LLM resilience

Use interval deltas for:

- `tsumugi_llm_calls_total` by tier, provider, model, and status;
- `tsumugi_llm_retries_total` by tier and reason;
- `tsumugi_llm_circuit_events_total` by provider and event;
- `tsumugi_llm_call_duration_seconds` for latency distribution.

Correlate these with run status, queue age, and quarantine changes. A circuit opening with stable item-failure counts is different from repeated malformed responses for one item.

### Dreaming and scheduler

Use:

- `tsumugi_dreaming_runs_total` by job and status;
- `tsumugi_dreaming_run_duration_seconds` by job;
- persisted dreaming run history;
- scheduler enabled state and job registration.

Separate `success`, `partial`, and failure outcomes. A partial run caused by provider cooldown is operationally different from a completed run with item quarantines.

### Capacity and process health

Use database volume, process metrics, HTTP request count/latency, and embedder status only when they support the question. Report table or database growth as a time series and include the retention or sweep behavior that affects it.

## Comparison rules

- Name the baseline window and current window.
- Use the same filters and definitions in both windows.
- Report absolute values and deltas; include rates when window lengths differ.
- State whether counters reset or the service restarted.
- Avoid fixed alert thresholds unless an ADR, runbook, or configured SLO defines them.
