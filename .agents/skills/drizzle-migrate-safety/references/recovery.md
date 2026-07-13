# Migration recovery reference

Use this reference only after a migration check fails or repository and database state disagree.

## Collect evidence first

Record without exposing credentials:

- `git status --short` and the migration-related diff;
- ordered journal entries: `idx`, `when`, and `tag`;
- SQL filenames and SHA-256 hashes;
- generated snapshot filenames;
- `drizzle.__drizzle_migrations`: `id`, `hash`, and `created_at`;
- actual schema facts relevant to the failed DDL;
- the first meaningful migration error and exit status.

Determine whether the target is disposable local, staging, or production. Do not mutate a non-disposable target during diagnosis.

## Journal ordering or tag mismatch

If no affected migration has been applied anywhere:

1. Prove the files are uncommitted and unapplied.
2. Prefer regenerating a coherent migration set from the intended schema.
3. Re-check contiguous `idx`, strictly increasing `when`, matching tags, and snapshots.

If an affected migration may already be applied, do not change journal timestamps or tags in isolation. Compare every known database history first and prepare a forward-compatible reconciliation plan.

## SQL applied manually but history is missing

Prefer a new forward migration that safely reconciles the actual schema.

Registering an existing SQL hash manually is an exceptional recovery action. Only consider it when all statements are proven to have been applied exactly, the repository SQL hash is known, `created_at` is taken from the matching journal entry, a backup exists, and the user explicitly approves the history write.

Never insert a guessed hash or timestamp.

## Database schema drift

1. Compare the actual schema with the repository's intended state.
2. Identify whether drift came from manual DDL, a partial migration, or a different artifact version.
3. Prefer a new migration that moves all known environments forward.
4. Avoid editing historical SQL that another database may already have applied.

## Migration command exits successfully but does nothing

Treat this as suspicious when the expected schema or history row is absent. Check:

- journal `when` ordering;
- journal entry count versus SQL files;
- database history count and latest `created_at`;
- the artifact version deployed with the migration runner;
- whether the command targeted the expected database.

This repository has previously seen no-op success when journal ordering and database history were desynchronized.

## Migration command fails

Capture the complete output once, stripping ANSI only for readability. Then:

1. identify the first SQL error;
2. determine whether the migration transaction rolled back;
3. inspect for partially applied non-transactional DDL;
4. fix the forward path rather than retrying blindly;
5. rerun against a disposable database before touching a live target.

## Production recovery gate

Before any production history update or corrective DDL, require:

- a backup or verified recovery point;
- exact SQL and expected row/schema changes;
- an impact and rollback statement;
- explicit user approval;
- post-change schema and migration-history verification.

