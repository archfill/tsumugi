# ADR-014 runtime evaluation

Use this reference for the accepted Three-layer capture, observation, and memory architecture.
Re-read `docs/ROADMAP.md`, ADR-003, and ADR-014 before making a product decision.

## Evaluation questions

| Area | Evidence | Decision question |
| --- | --- | --- |
| Capture coverage | completed-turn checkpoints, source / project mix, missing or duplicate turns | Does Layer 1 close continuity gaps without uncontrolled noise? |
| Stop promotion | selected Stops, deterministic windows, atomic completion, age and errors | Does one valid Stop produce one Layer 2 observation idempotently? |
| Recall | synthetic / authorized queries, layer, score, provenance | Does observation-first recall preserve relevance and independent memory compatibility? |
| Continuity | bounded SessionStart bridge candidates and resumption outcomes | Does pending-checkpoint injection materially help resumption? |
| Forgetting | capture TTL, sweep results, outdated / archived memory | Does deterministic retention reduce noise without hard delete? |
| Data growth | capture, observation, memory, link, window, database, and index volume | Is growth compatible with retention and observed value? |
| Operations | current attention, issue age, scheduler state, deterministic run history | Can operators explain current failures without raw database inspection? |

Historical fact queues, memory quarantine, provider circuits, and LLM call metrics are not active
ADR-014 quality signals. Report them only as explicitly labelled migration history.

## Observation cadence

1. Capture a timestamped baseline with the same filters intended for later comparisons.
2. Confirm the deployed commit independently; do not infer deployment from ROADMAP wording.
3. Repeat at intervals appropriate to scheduler frequency and traffic.
4. Inspect bounded, sanitized recall and continuity samples after enough real work exists.
5. Keep historical migration values labelled as historical.

## Decision outcomes

- **Continue observation**: the window or sample is too small.
- **Accept current behavior**: capture, recall, continuity, retention, and volume show no material regression.
- **Correct the implementation**: a confirmed mechanism violates ADR-003 / ADR-014 or blocks deterministic work.
- **Re-evaluate ADR-012**: meaningful capture gaps remain after sufficient observation.
- **Insufficient evidence**: access, baseline, sample, or signal is missing.

Do not begin ADR-012 work merely because time elapsed.
