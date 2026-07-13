---
name: tsumugi-runtime-observe
description: Collect and interpret read-only runtime evidence for the tsumugi capture, observation, memory, promotion, dreaming, and provider-resilience paths. Use when monitoring production or staging health, comparing runtime trends, investigating backlog or quarantine growth, evaluating continuity and promotion quality, or preparing evidence for an ADR or ROADMAP status decision. Do not use for code-change verification, database mutation, deployment, or incident remediation.
---

# Observe the tsumugi runtime

Gather evidence without changing runtime state. Separate observed facts, interpretation, and unverified hypotheses.

## Establish the observation contract

1. Identify the environment, project scope, time window, and decision the evidence should support.
2. Require explicit authorization before contacting production or any private runtime.
3. If access is not authorized or unavailable, produce a read-only query plan instead of guessing.
4. Read `docs/ROADMAP.md` and the relevant ADR only when the observation supports a product decision.

## Select evidence

Read [references/metrics.md](references/metrics.md) and select only signals relevant to the question.

For ADR-014 rollout evaluation, also read [references/adr-014-evaluation.md](references/adr-014-evaluation.md). Treat it as an initial use case, not the permanent boundary of this skill.

Prefer evidence in this order:

1. Read-only Admin REST responses and pipeline traces.
2. Prometheus metrics over a defined interval.
3. Scheduler state and persisted dreaming run history.
4. Sanitized logs for exact failure mechanisms.
5. Read-only PostgreSQL queries only when explicitly authorized and higher-level evidence is insufficient.

Do not read `.env*`, credentials, tokens, private endpoint configuration, or raw sensitive capture content.

## Collect and normalize

1. Record the collection timestamp, time window, filters, and source for every result.
2. Compare counters and queue sizes across at least two timestamps when claiming a trend.
3. Record which filters and timestamp columns each source actually applies. Do not assume related endpoints use identical populations.
4. Use aggregate data first. Inspect individual traces only to explain an aggregate anomaly or sample quality.
5. Sanitize user content, prompts, memory narratives, error payloads, and identifiers before reporting.
6. Record missing signals and failed queries as coverage gaps, not healthy results.

## Interpret cautiously

- Do not equate `/health` success with pipeline quality.
- Do not infer promotion quality from throughput alone; inspect a bounded sample with provenance.
- Distinguish provider-wide cooldown from item-specific retry or quarantine.
- Distinguish backlog size from backlog age and drain rate.
- Treat a single snapshot as current state, not a trend.
- Compare against a named baseline or previous window; do not invent thresholds when no SLO exists.

## Safety boundaries

Remain read-only. Do not:

- trigger dreaming, promotion, retry, sweep, or backfill jobs;
- archive, mark outdated, quarantine, unquarantine, or rewrite data;
- run migrations, deploy, restart services, or change scheduler state;
- call an external LLM or seed an eval dataset;
- broaden access from aggregate evidence to raw private content without explicit authorization.

If remediation is requested, finish the observation report first and hand the confirmed mechanism to the appropriate implementation or incident workflow.

## Report

Lead with one status:

- **Stable**: the selected signals are within the named baseline and no material degradation is evidenced.
- **Degraded**: evidence shows a material regression or stuck path.
- **Insufficient evidence**: the required source, interval, baseline, or authorization is missing.

Then report:

1. environment, window, scope, and filters;
2. evidence by capture, promotion, memory, provider, and scheduler as applicable;
3. trend or baseline comparison;
4. bounded quality samples and provenance when used;
5. confirmed concerns, hypotheses, and coverage gaps in separate sections;
6. the product decision supported by the evidence and the next read-only check.

Do not claim system-wide health when only one project, source, endpoint, or snapshot was checked.
