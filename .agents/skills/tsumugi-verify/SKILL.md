---
name: tsumugi-verify
description: Select and run evidence-based verification for tsumugi changes across server, shared schemas, Admin UI, CLI, hooks, Drizzle migrations, and eval benches. Use when asked to test, verify, validate, review readiness, check a working tree or PR, confirm CI parity, or determine whether a tsumugi change is safe to commit, push, or deploy.
---

# Verify tsumugi changes

Choose checks from the actual diff. Do not equate command success with complete coverage.

## Establish the change scope

1. Read `AGENTS.md` and `docs/ROADMAP.md` when the change affects product behavior or architecture.
2. Inspect `git status --short`, changed filenames, and the relevant diff.
3. Preserve unrelated user changes and exclude generated or private files from conclusions unless they are part of the requested scope.
4. Classify the change with [references/verification-matrix.md](references/verification-matrix.md).

## Run checks progressively

1. Start with the narrowest targeted test or static check.
2. Run package-level typecheck/test/build for affected packages.
3. Run workspace CI-equivalent checks when the change crosses packages or is being prepared for commit/push/deploy.
4. Add database, browser, smoke, or eval validation only when the change requires it.
5. Use context-preserving output processing for large test, build, diff, or log output. Surface exact failures and summaries instead of raw output.

The primary CI parity commands are:

```bash
pnpm typecheck
pnpm -r build
pnpm -r test
```

Always run `git diff --check` before declaring a code change ready. This command does not inspect untracked files: validate those files directly, or run `git diff --cached --check` only after staging has been explicitly authorized.

## Interpret coverage honestly

- Server `test` runs Vitest.
- UI, shared, and CLI `test` scripts currently report that no tests exist; their success is not automated behavioral coverage.
- Repository `lint` scripts are placeholders and are not a meaningful quality gate.
- Server eval files are outside the ordinary production TypeScript build path. Validate relevant benches at runtime when behavior in search, promotion, or dreaming changes.
- Separate public synthetic fixtures from private fixtures. Never imply private-quality validation if only synthetic fixtures ran.
- A successful mocked repository test does not replace a real PostgreSQL integration check for new SQL.
- Static skill validation does not prove Codex discovery or implicit invocation in the current task. Confirm skill availability in a new task when that behavior is part of the acceptance criteria.

## Respect external-state boundaries

Do not read `.env*`, start long-running services, contact a live LLM, access production, deploy, or mutate a database unless the request authorizes that scope. Report the skipped check and residual risk instead.

For schema or migration work, invoke `$drizzle-migrate-safety` and follow its database gates.

For UI changes, build the UI and, when a runnable environment is available, use browser tooling to inspect the actual page, relevant flows, console errors, and failed network requests.

## Report the result

Lead with one of:

- **Pass**: all checks required for the stated scope passed.
- **Conditional pass**: local checks passed, but named integration/live checks remain.
- **Fail**: a required check failed.
- **Blocked**: a required environment or authorization is unavailable.

Then list:

- scope examined;
- commands/checks that passed;
- failures with the first actionable error;
- checks not run and why;
- remaining risk and the next safe step.

Never say "all tests passed" without naming the test boundary.
