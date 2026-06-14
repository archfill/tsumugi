# Tsumugi 引き継ぎドキュメント

> 作成日: 2026-06-14 / Phase 2 完了時点
>
> このドキュメントは **Codex** など別エージェントが作業を引き継ぐためのスナップショット。AGENTS.md / CLAUDE.md と合わせて読むこと。

## 1. このプロジェクトは何か

**tsumugi**: MCP ベースの記憶レイヤー。Claude Code / Codex などの AI エージェントからの観測を取り込み、ドリーミング (synthesis) で記憶を再編成する。

- リポジトリ: `git@github.com:archfill/tsumugi.git`
- ローカル: `~/git/tsumugi/`
- ライセンス: MIT
- 公開リポジトリ (内部利用システム名は記述しない)

## 2. 最初に読むもの (必読 / 順番)

1. `AGENTS.md` — AI 開発ガイド (Codex 用)、CLAUDE.md と同内容
2. `README.md` — コンセプト・ロードマップ
3. `docs/adr/0001..0005-*.md` — 設計判断の WHY
4. このファイル — 現状と次の作業

> AGENTS.md / CLAUDE.md は**書く場所のルール**と**既存資産**を規定する。ルールに沿わない実装は merge しない。

## 3. 現在の進捗

| Phase                                   | 状態             | 主要コミット          |
| --------------------------------------- | ---------------- | --------------------- |
| 0 設計確定・scaffold                    | ✅               | `2b02536` ~ `113ff22` |
| 1 MCP server 最小動作                   | ✅               | `40e54a8` ~ `ce37048` |
| ↳ 5 層 refactor + CLAUDE.md + ADR       | ✅               | `39dc8ac`             |
| ↳ GitHub Actions CI + branch protection | ✅               | `9a4e910` ~ `647a18b` |
| **2 dreaming worker 実装**              | ✅               | `cb36823` ~ `ca90d6d` |
| 3 管理 UI + デプロイ + 検証             | ⏸ **次フェーズ** | —                     |
| 4 内部利用システムの移行                | ⏸                | —                     |
| 5 内部利用システムのクリーンアップ      | ⏸                | —                     |
| 6 claude-mem 系の置き換え               | ⏸                | —                     |

## 4. 現在動いているもの

### MCP tools (4 件)

| tool                  | 役割                                   | ファイル                                                      |
| --------------------- | -------------------------------------- | ------------------------------------------------------------- |
| `save_observation`    | 観測保存 (Layer 1)                     | `apps/server/src/interfaces/mcp/tools/save-observation.ts`    |
| `search_memory`       | hybrid 検索 (pg_bigm + pgvector + RRF) | `apps/server/src/interfaces/mcp/tools/search-memory.ts`       |
| `trigger_dreaming`    | dreaming worker 手動起動               | `apps/server/src/interfaces/mcp/tools/trigger-dreaming.ts`    |
| `get_dreaming_status` | 実行履歴取得                           | `apps/server/src/interfaces/mcp/tools/get-dreaming-status.ts` |

### Use cases (8 件、`core/` 配下)

| use case                       | tier | ファイル                                  |
| ------------------------------ | ---- | ----------------------------------------- |
| save observation               | —    | `core/observation/save.ts`                |
| summarize observation          | LOW  | `core/observation/summarize.ts`           |
| AUDN judge                     | MID  | `core/dreaming/audn.ts`                   |
| cross-session synthesize       | LOW  | `core/dreaming/synthesize.ts`             |
| time-aware memory update       | LOW  | `core/dreaming/time-update.ts`            |
| decision contradiction         | MID  | `core/dreaming/decision-contradiction.ts` |
| reflection                     | LOW  | `core/dreaming/reflection.ts`             |
| dreaming runner (orchestrator) | —    | `core/dreaming/runner.ts`                 |

LOW tier = Claude Haiku 4.5, MID tier = Claude Sonnet 4.6 (default、env で上書き可)。

### REST endpoints

| method | path                    | 説明               |
| ------ | ----------------------- | ------------------ |
| `GET`  | `/health`               | ヘルスチェック     |
| `POST` | `/api/dreaming/trigger` | dreaming 手動起動  |
| `GET`  | `/api/dreaming/runs`    | 実行履歴           |
| `GET`  | `/api/observations`     | (Phase 3 で本実装) |
| `GET`  | `/api/memories`         | (Phase 3 で本実装) |

### DB スキーマ (PostgreSQL 18)

| テーブル        | 役割                                             |
| --------------- | ------------------------------------------------ |
| `observations`  | Layer 1: 生観測 (immutable accumulation)         |
| `memories`      | Layer 2: 統合知識 (synthesis, archive 可)        |
| `decisions`     | 決定 + supersede chain                           |
| `links`         | provenance グラフ (from → to + relation)         |
| `dreaming_runs` | 実行履歴 (job_kind / status / counts / metadata) |

Extension: `vector` (pgvector 0.8.2), `pg_bigm` (1.2-20250903)
Migration: `apps/server/drizzle/0000..0002_*.sql`

## 5. 環境セットアップ手順

```bash
# 必要な前提
mise install                # node 22 + pnpm 11.6.0

# Workspace 依存解決
cd ~/git/tsumugi
pnpm install

# DB (PostgreSQL 18 + pg_bigm + pgvector) 起動
docker compose up -d tsumugi-postgres

# Drizzle migration 適用
DATABASE_URL=postgresql://tsumugi:tsumugi_dev@localhost:5433/tsumugi \
  pnpm -C apps/server db:migrate

# 環境変数
cp .env.example .env
# .env に LLM_LOW_API_KEY, LLM_MID_API_KEY を設定
# (Anthropic API key 推奨。設定なしでも MCP の save/search は動作する)
```

## 6. 動作確認コマンド一覧

```bash
# 型チェック
mise run check                   # = pnpm typecheck 全 workspace

# MCP server 起動
mise run -C apps/server dev:http   # HTTP/SSE モード (port 8000)
mise run -C apps/server dev:stdio  # stdio モード

# UI (placeholder のみ)
mise run -C apps/ui dev          # Vite dev server (port 5174)

# 個別 smoke (DB / API key 必要)
mise run -C apps/server search-smoke
mise run -C apps/server mcp-smoke
mise run -C apps/server summarize-smoke
mise run -C apps/server audn-smoke
mise run -C apps/server synthesize-smoke
mise run -C apps/server time-update-smoke
mise run -C apps/server decision-contradiction-smoke
mise run -C apps/server reflection-smoke
mise run -C apps/server dreaming-smoke   # runner full の E2E

# dreaming 個別実行 (CLI、cron 想定)
mise run -C apps/server dream-promote     # promote-observations のみ
mise run -C apps/server dream-synthesize  # synthesize のみ
mise run -C apps/server dream-full        # 全部順次
```

## 7. 次フェーズ (Phase 3) の作業内容

README.md の Phase 3 セクションに沿う。

### 7.1 管理 UI 実装

現状 `apps/ui/` は React + Vite + Tailwind + shadcn の placeholder (App.tsx に文字が出るだけ)。
これを本格的な管理画面に成長させる。

必要な画面：

| 画面          | 内容                                         |
| ------------- | -------------------------------------------- |
| Observations  | Layer 1 一覧、検索、フィルタ、削除           |
| Memories      | Layer 2 一覧、検索、編集、archive            |
| Decisions     | supersede chain ビューア                     |
| Provenance    | observation ↔ memory ↔ decision のグラフ表示 |
| Dreaming runs | 実行履歴 + 手動 trigger ボタン               |
| Settings      | LLM tier 設定、cron schedule 表示            |

API:

- `/api/observations`, `/api/memories`, `/api/decisions`, `/api/links` のフル CRUD を `interfaces/rest/routes.ts` に実装
- 既存 use case は流用、新規追加分は `core/<entity>/` に配置

UI ライブラリ:

- shadcn コンポーネント (yui-frontend 慣習を踏襲)
- TanStack Router でルーティング、TanStack Query で API キャッシュ
- 状態管理は Query + URL params 基本

### 7.2 デプロイ整備

- pve-docker 上で稼働するように compose / Dockerfile を整える
- 既存の `compose.yml` / `Dockerfile` は雛形のみ、本番運用向けに整備:
  - Multi-stage build の最適化
  - BGE-M3 モデルの事前 DL (warm-up) を build 時に実施するか、起動時 lazy 維持か判断
  - logging / monitoring の整備 (Phase 3 範囲内)
- pve-docker の RAM 制約に注意 ([[pve-docker-shared-host]])

bun の検証結果: pve-docker (AVX2 なし QEMU CPU) でも **bun 1.3.14 baseline variant は動作確認済み**。Phase 3 デプロイ前に Node のまま行くか bun に切り替えるか判断する。Node のままが無難。

### 7.3 多クライアント検証

- Claude Code / Codex / 他の MCP クライアントから接続できるか確認
- HTTP/SSE モードでの並行接続テスト
- 複数 PC から VPN 経由で接続したときの挙動

### 7.4 Phase 3 前にやっておくべき改善

(Phase 2 で発覚した課題)

1. **`observation.promoted_at` 列の追加**
   - 現状 `observationRepo.listPending` は単に最新順を返すため、同じ observation を何度も promote しようとする
   - 列を追加して `promoted_at IS NULL` でフィルタする
   - migration 0003 を新規作成
   - `core/dreaming/runner.ts` の promote step で完了時に `promoted_at` を埋める

2. **MCP transport の更新 (任意)**
   - `interfaces/mcp/transport-http.ts` は `SSEServerTransport` を使用
   - SDK 1.29 では deprecated 扱い、`StreamableHTTPServerTransport` への移行を推奨
   - 動作はするが将来動かなくなる可能性

3. **CI に test job 追加 (任意)**
   - 現状 CI は typecheck + build + test (= echo) のみ
   - 各 smoke を CI で動かすには DB / LLM API key が要る
   - GitHub Actions Services で Postgres を立てて、最低限の整合性チェックは可能
   - LLM 系は smoke を skip するパターンで OK

## 8. 既知の制約 / 注意

### LLM コスト

- 観測 1 件あたり summarize (LOW) + AUDN judge (MID) で API 呼び出し 2 回
- dreaming full で別途 LOW × 3 + MID × 1 が走る
- 個人運用想定 (日 100 観測程度) で月 $5〜10 想定
- API key 未設定時は smoke が skip するため動作チェックは可能

### 既知の deprecated

- `@modelcontextprotocol/sdk` の `SSEServerTransport` は将来 v2 で削除予定
- 移行先: `StreamableHTTPServerTransport`

### pve-docker (デプロイ先) の制約

- 共有ホスト、ディスク 96GB 単一
- RAM 競合に注意 (yui / forgejo-runner と同居)
- AVX2 命令は持たない (bun 互換性に注意したい場合は baseline variant を使う)

## 9. ディレクトリ構造 (簡易)

```
tsumugi/
├── AGENTS.md                # Codex 用ガイド (CLAUDE.md と同内容)
├── CLAUDE.md                # Claude Code 用ガイド
├── README.md                # コンセプト・ロードマップ
├── compose.yml              # PG18 + tsumugi-server
├── Dockerfile               # multi-stage (UI build → server bundle)
├── Dockerfile.postgres      # PG18 + pgvector + pg_bigm カスタム
├── docs/
│   ├── HANDOFF.md           # このファイル
│   └── adr/0001..0005-*.md  # 意思決定
├── docker/postgres/init/    # 拡張有効化 SQL
├── apps/
│   ├── server/              # MCP server + REST + dreaming worker
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── core/        # ビジネスロジック
│   │   │   │   ├── observation/
│   │   │   │   ├── dreaming/
│   │   │   │   └── search/
│   │   │   ├── data/        # 永続化
│   │   │   │   ├── schema.ts
│   │   │   │   ├── client.ts
│   │   │   │   └── repos/
│   │   │   ├── external/    # 外部 I/O
│   │   │   │   ├── embedding/
│   │   │   │   └── llm/
│   │   │   ├── interfaces/  # 入力アダプタ
│   │   │   │   ├── mcp/
│   │   │   │   └── rest/
│   │   │   └── lib/         # 横断ユーティリティ
│   │   ├── drizzle/         # migration
│   │   └── package.json
│   └── ui/                  # React 管理 UI (placeholder)
└── packages/
    └── shared/              # Zod スキーマ + 型
```

## 10. Codex への引き継ぎフロー (推奨)

1. このファイルを読む
2. `AGENTS.md` を読む
3. `README.md` の Phase 3 セクションを確認
4. `docs/adr/0001..0005-*.md` で意思決定の背景を理解
5. 7.4 の improvements を片付けてから 7.1 の UI 実装に入る
6. UI 実装は `apps/ui/` 配下で完結、API は `apps/server/src/interfaces/rest/routes.ts` を拡張
7. 新規 use case は `core/<domain>/<verb>.ts` 命名で配置
8. DB 列追加は migration 0003 として `pnpm db:generate` で生成
9. PR は `feat(phase3): <内容>` 形式で main にマージ (CI 必須通過)

質問・blocker は **README.md の Phase 3 ToDo を再分割して PR description に書く**形で。

## 11. 緊急時の参照

| 状況                              | 対処                                                                                              |
| --------------------------------- | ------------------------------------------------------------------------------------------------- |
| typecheck が落ちる                | `cd ~/git/tsumugi && pnpm typecheck` で原因確認、ESM `.js` 拡張子忘れが多い                       |
| pnpm install で native build 失敗 | `pnpm-workspace.yaml` の allowBuilds に追加 (esbuild / protobufjs / sharp は許可済み)             |
| Postgres が起動しない             | `docker compose logs tsumugi-postgres` 確認、データボリュームは `/var/lib/postgresql` (PG18 規約) |
| pg_bigm が無い                    | `docker compose build --no-cache tsumugi-postgres` で再 build                                     |
| LLM 呼び出しが失敗                | `.env` の `LLM_*_API_KEY` を確認、`mise run -C apps/server llm-smoke` で疎通確認                  |
| migration が衝突                  | `apps/server/drizzle/meta/_journal.json` を確認                                                   |

## 12. Phase 2 で出た残課題 (再掲・優先順)

1. ⚠️ `observation.promoted_at` 列追加 (Phase 3 着手前に推奨)
2. ⚠️ MCP transport の `StreamableHTTPServerTransport` 移行 (任意、いつかは必要)
3. ⚠️ CI で実 DB を使った integration test 追加 (任意)
4. 💡 AGENTS.md と CLAUDE.md の同期メカニズム (symlink? lint? — 未定)
5. 💡 LLM tier 設定の動的切替 (現状 env でしか変更できない)

---

引き継ぎ完了。質問は PR / Issue 経由で。
