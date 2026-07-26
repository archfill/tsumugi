# Memory quality audit and reversible archive

This workflow classifies legacy memory without exporting narrative, facts, embeddings, project tags, or session
values. It never treats length, age, similarity, or fragmentation as a deletion rule.

## Read-only audit

```bash
pnpm --filter @tsumugi/server memory:audit
pnpm --filter @tsumugi/server memory:audit -- --include-candidates --sample-limit 20
pnpm --filter @tsumugi/server memory:audit -- --row-limit 50000 \
  --thin-max-chars 100 --aged-days 365 --near-duplicate-score 0.88
```

The command emits one JSON document and performs `SELECT` only. The default row limit is 20,000, the hard
maximum is 100,000, and candidate output is opt-in and bounded to 100. A candidate contains IDs, reason codes,
protection codes, age, link count, and bounded source-observation IDs; it never contains narrative or a content
hash. Source/project/session are reported as aggregate presence counts, not private values.

Reason codes:

- `thin_proxy`: below the configured Unicode character threshold, one sentence, no rationale, no concrete identifier
- `context_poor`: no rationale and no concrete identifier
- `interaction_metadata`: transcript or interaction marker
- `unlinked_orphan_provenance`: no incoming or outgoing provenance link
- `exact_duplicate`: normalized narrative is identical
- `near_duplicate_candidate`: deterministic trigram similarity candidate; review only
- `fragment_cluster`: the same source observation has multiple derived memories
- `aged_record`: older than the configured creation-age threshold; never evidence of disuse

Protection codes prevent bulk semantic cleanup from being proposed without review:

- `decision_kind`
- `source_decision_or_blocker`
- `rationale_or_verification`
- `high_link_count`

The schema has no last-recalled timestamp or access counter. `aged_record` therefore reports creation age only.

## Bounded local review

1. Run the aggregate report and select one reason code.
2. Run candidate output with a small sample limit.
3. Inspect the source observation and candidate memory only in a local, access-controlled DB session or Admin UI.
4. Record false-positive tendencies as aggregate counts. Never copy raw content into CI logs, fixtures, Issues, or PRs.
5. Protect decisions, blockers, root causes, verification results, and rollback knowledge.

For reviewed metadata noise, place only approved memory IDs in a local file, one `mem_...` ID per line. Do not
commit this file.

## Reversible archive

Preview exact duplicates without mutation:

```bash
pnpm --filter @tsumugi/server memory:archive -- preview-exact-duplicates
```

Mutation requires an explicit environment gate. Planning stores only a batch manifest and the previous archive
state. It does not store narrative.

```bash
TSUMUGI_ALLOW_MEMORY_ARCHIVE_MUTATION=true \
  pnpm --filter @tsumugi/server memory:archive -- plan-exact-duplicates

TSUMUGI_ALLOW_MEMORY_ARCHIVE_MUTATION=true \
  pnpm --filter @tsumugi/server memory:archive -- plan-reviewed-metadata \
  --ids-file /private/local/reviewed-memory-ids.txt
```

Apply requires the exact candidate count returned by the plan. Any state drift rolls back the transaction.

```bash
TSUMUGI_ALLOW_MEMORY_ARCHIVE_MUTATION=true \
  pnpm --filter @tsumugi/server memory:archive -- apply \
  --batch-id mar_... --confirm-count N
```

Restore uses the same batch and a compare-and-set against its applied timestamp. Rows changed after apply are not
silently overwritten.

```bash
TSUMUGI_ALLOW_MEMORY_ARCHIVE_MUTATION=true \
  pnpm --filter @tsumugi/server memory:archive -- restore \
  --batch-id mar_... --confirm-count N
```

Exact duplicate archiving keeps the oldest active row as canonical and archives only later active copies.
Near-duplicate and fragment candidates are never auto-merged. Production apply requires a backup, staging-clone
apply/restore verification, before/after relevance and volume results, and separate approval with the exact count.
