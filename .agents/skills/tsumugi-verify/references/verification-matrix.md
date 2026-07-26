# Tsumugi verification matrix

Select all rows touched by the change. Begin with targeted checks, then expand to workspace CI parity when preparing a deliverable.

| Change area | Minimum checks | Additional evidence |
| --- | --- | --- |
| Documentation / ADR only | `git diff --check`; inspect links and status consistency | Compare `VISION.md`, `ROADMAP.md`, and affected ADR when priorities or decisions change |
| `packages/shared` schema/types | shared typecheck/build; server typecheck; UI build | Exercise parse/response behavior in affected server tests |
| Server core/data/external/interfaces/lib | targeted Vitest file; server typecheck; full server test | Run relevant smoke or integration check if mocks cannot cover the changed boundary |
| Drizzle schema/migrations | `$drizzle-migrate-safety`; server typecheck/test | CI-style disposable PostgreSQL migrate + database smoke |
| Admin UI | UI build | Browser page/flow, console errors, and failed network requests; note that UI tests do not exist |
| CLI | CLI typecheck | `pnpm -C apps/cli pack:dry` for packaging/release changes; inspect tarball contents |
| Claude/Codex integration scripts | inspect hook/plugin manifests and changed scripts | Run the narrowest safe local hook probe; verify installed runtime separately when claiming installation behavior |
| Search behavior | targeted search tests; server test/typecheck | `bench:search` when fixture/runtime dependencies are available |
| Stop capture promotion | targeted capture promotion / idempotency tests; server test/typecheck | disposable PostgreSQL integration when repository mocks cannot prove atomicity |
| Deterministic maintenance / compatibility jobs | targeted scheduler, archive, or removed-job no-op tests; server test/typecheck | disposable DB for mutation paths; confirm removed semantic jobs have no side effects |
| Cross-package or release-ready change | `pnpm typecheck`; `pnpm -r build`; `pnpm -r test`; `git diff --check` | DB integration, browser QA, packaging, or live smoke according to rows above |

## Targeted server commands

Use Vitest paths that match the change before the full suite, for example:

```bash
pnpm -C apps/server test -- tests/observation/promote.test.ts
pnpm -C apps/server test -- tests/resilience/singleton-fallback.test.ts
pnpm --filter @tsumugi/server test
pnpm --filter @tsumugi/server typecheck
```

Do not invent a targeted test path. Confirm it exists first.

## Database integration parity

The GitHub CI database job performs:

```bash
docker compose up -d --build --wait tsumugi-postgres
DATABASE_URL=postgresql://tsumugi:tsumugi_dev@localhost:5433/tsumugi pnpm -C apps/server db:migrate
DATABASE_URL=postgresql://tsumugi:tsumugi_dev@localhost:5433/tsumugi pnpm -C apps/server db:smoke
```

Use this only for the disposable local Compose database. Do not reuse these credentials or commands for a remote target.

## Eval boundary

Available focused commands include:

```bash
pnpm -C apps/server bench:search
pnpm -C apps/server eval:search-provenance-policy:dev
pnpm -C apps/server memory:audit:dev
```

`bench:search` and `memory:audit:dev` may load private DB configuration. Do not read or expose `.env`, and run them only when the task authorizes the target and scope. `eval:search-provenance-policy:dev` is the synthetic in-process policy check.

Report fixture classes and case counts with the result. Treat missing private fixtures as an explicit coverage gap, not a pass.
