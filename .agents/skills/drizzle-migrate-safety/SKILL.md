---
name: drizzle-migrate-safety
description: Safely create, review, apply, or repair tsumugi Drizzle migrations while protecting schema, SQL, snapshot, journal, and database-history consistency. Use for changes to apps/server/src/data/schema.ts or apps/server/drizzle, drizzle-kit generate/migrate operations, migration failures or no-op successes, journal ordering problems, schema drift, and __drizzle_migrations recovery.
---

# Drizzle migration safety

Treat these as one migration contract:

- `apps/server/src/data/schema.ts`
- `apps/server/drizzle/*.sql`
- `apps/server/drizzle/meta/*_snapshot.json`
- `apps/server/drizzle/meta/_journal.json`
- the target database's `drizzle.__drizzle_migrations`

Do not declare success from `drizzle-kit migrate` output alone.

## Establish the boundary

1. Read the repository `AGENTS.md` and inspect `git status --short` before changing anything.
2. Preserve unrelated working-tree changes. Existing untracked migrations may belong to the user; inspect them before generating another migration.
3. Distinguish the requested operation:
   - **Generate/review**: repository-only changes.
   - **Apply**: changes a confirmed database.
   - **Repair**: changes migration history or reconciles drift.
4. Never read `.env*` or print credentials. Accept a caller-provided `DATABASE_URL` or use the documented disposable local database.
5. Require explicit user authorization before applying to a non-disposable database or modifying migration history manually.

## Run static pre-flight checks

Before generating or applying a migration:

1. Parse `_journal.json` as JSON.
2. Verify `idx` values are unique and contiguous in entry order.
3. Verify `when` values are strictly increasing in entry order.
4. Verify every journal `tag` has a matching SQL file.
5. Verify generated snapshots form a valid `id` / `prevId` chain. Treat intentionally hand-written SQL migrations without snapshots as documented exceptions, not silent gaps.
6. Verify new SQL, snapshot, and journal files form a coherent set.
7. Inspect the current schema and relevant diff to understand the intended state change.

Stop if ordering, numbering, tags, or generated artifacts disagree. Do not repair by guessing.

## Generate a migration

Use the repository command. The Drizzle config requires `DATABASE_URL` even though generation should not contact the database:

```bash
DATABASE_URL=postgresql://x:x@localhost:5432/x pnpm -C apps/server db:generate
```

After generation:

1. Inspect every new SQL statement for destructive DDL, table rewrites, unsafe `NOT NULL` changes, missing defaults, index-lock risk, and unintended drops.
2. Confirm the snapshot represents the intended final schema.
3. Re-run all static pre-flight checks.
4. Confirm only the expected migration artifacts were added.
5. Prefer a new follow-up migration over editing an already applied migration. Never rewrite applied history without a reviewed recovery plan.

## Validate locally

Run the smallest relevant checks first:

```bash
pnpm --filter @tsumugi/server typecheck
pnpm --filter @tsumugi/server test
```

When a disposable local PostgreSQL is already available, or the user authorizes starting one, match CI:

```bash
docker compose up -d --build --wait tsumugi-postgres
DATABASE_URL=postgresql://tsumugi:tsumugi_dev@localhost:5433/tsumugi pnpm -C apps/server db:migrate
DATABASE_URL=postgresql://tsumugi:tsumugi_dev@localhost:5433/tsumugi pnpm -C apps/server db:smoke
```

Then re-run `db:migrate` and verify it is a genuine no-op. Inspect `drizzle.__drizzle_migrations` only after confirming the target database. Compare its latest `created_at` with the journal's latest `when` and confirm the expected migration count.

Do not start containers, apply migrations, or access a live database merely to review generated files.

## Handle failures

If generation, migration, or history checks fail, read [references/recovery.md](references/recovery.md) before proposing a repair. Capture evidence first and avoid repeated migration attempts against an unknown partial state.

## Report the result

State separately:

- generated artifacts and intended schema change;
- static journal/snapshot/SQL checks;
- database target, if any;
- commands actually run and their results;
- whether migration history matches the repository;
- checks not run and remaining risk.
