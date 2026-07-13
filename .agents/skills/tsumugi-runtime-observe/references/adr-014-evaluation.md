# ADR-014 runtime evaluation

Use this reference only when evidence is being collected for the Three-layer capture, observation, and memory rollout. Re-read `docs/ROADMAP.md` and `docs/adr/0014-three-layer-capture-promotion.md` because status and historical baselines can change.

## Evaluation questions

| Area | Evidence | Decision question |
| --- | --- | --- |
| Capture coverage | completed-turn checkpoints, source/project mix, missing or duplicate turn evidence | Does deterministic Layer 1 capture close continuity gaps without uncontrolled noise? |
| Window efficiency | captures per window, actual LLM calls, window completion, backlog age | Does batching reduce calls while keeping the queue draining? |
| Promotion quality | bounded observation and memory samples with provenance | Are promoted facts accurate, useful, non-duplicative, and attributable? |
| Continuity | SessionStart bridge use and bounded sample outcomes | Does pending-checkpoint injection materially help task resumption? |
| Retry and quarantine | deferred/quarantined counts, failure classification, oldest actionable age | Are item failures isolated without converting provider outages into poison items? |
| Provider resilience | calls, retries, circuit transitions, partial runs, queue behavior | Does outage handling stop waste and resume draining after recovery? |
| Data growth | capture, observation, memory, link, window, and fact volume over time | Is growth compatible with retention and sweep behavior? |
| Operations | attention count, issue age, scheduler state, run history | Can operators identify and explain stuck work without raw database inspection? |

## Observation cadence

1. Capture a timestamped baseline with the same filters intended for later comparisons.
2. Confirm the deployed commit or release independently; do not infer current runtime deployment state from roadmap wording alone.
3. Repeat at intervals appropriate to scheduler frequency and traffic; do not call two nearby snapshots a trend.
4. Inspect bounded quality samples after enough work has been promoted.
5. Record provider incidents separately so outage windows do not distort ordinary throughput conclusions.
6. Keep historical values labelled as historical; never present ADR baseline evidence as current runtime state.

## Decision outcomes

Choose one and cite the supporting window:

- **Continue observation**: evidence is directionally useful but the window or sample is too small.
- **Promote the ADR status**: capture coverage, quality, resilience, continuity, and volume have sufficient evidence with no unresolved material regression.
- **Correct the implementation**: a confirmed mechanism violates an accepted invariant or blocks queue drain, quality, or operations.
- **Insufficient evidence**: required runtime access, baseline, sample, or signal is missing.

Do not begin ADR-012 milestone-nudge work merely because time elapsed. Re-evaluate it only after ADR-014 evidence shows whether meaningful capture gaps remain.
