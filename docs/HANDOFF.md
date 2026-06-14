# Tsumugi 引き継ぎドキュメント

> 作成日: 2026-06-14 / **Phase 3 (ローカル検証段階) 完了時点**
>
> このドキュメントは **Codex / Claude Code** など別エージェントが作業を引き継ぐためのスナップショット。AGENTS.md / CLAUDE.md と合わせて読むこと。

## 1. このプロジェクトは何か

**tsumugi**: MCP ベースの記憶レイヤー。Claude Code / Codex などの AI エージェントからの観測を取り込み、ドリーミング (synthesis) で記憶を再編成する。

- リポジトリ: `git@github.com:archfill/tsumugi.git`
- ローカル: `~/git/tsumugi/`
- ライセンス: MIT
- 公開リポジトリ (内部利用システム名は記述しない)

## 2. 最初に読むもの (必読 / 順番)

1. `AGENTS.md` — AI 開発ガイド (Codex 用)、CLAUDE.md と同内容
2. `README.md` — コンセプト・ロードマップ
3. `docs/adr/0001..0007-*.md` — 設計判断の WHY
4. このファイル — 現状と次の作業

> AGENTS.md / CLAUDE.md は**書く場所のルール**と**既存資産**を規定する。ルールに沿わない実装は merge しない。

## 3. 現在の進捗

| Phase                                      | 状態 | 主要コミット          |
| ------------------------------------------ | ---- | --------------------- |
| 0 設計確定・scaffold                       | ✅   | `2b02536` ~ `113ff22` |
| 1 MCP server 最小動作                      | ✅   | `40e54a8` ~ `ce37048` |
| ↳ 5 層 refactor + CLAUDE.md + ADR          | ✅   | `39dc8ac`             |
| ↳ GitHub Actions CI + branch protection    | ✅   | `9a4e910` ~ `647a18b` |
| 2 dreaming worker 実装                     | ✅   | `cb36823` ~ `ca90d6d` |
| **3 管理 UI + デプロイ + 検証** (ローカル) | ✅   | `cae5435` ~ `dfa0eef` |
| ↳ Phase 3 残: pve-docker 本番デプロイ      | ⏸    | —                     |
| 4 内部利用システムの移行                   | ⏸    | —                     |
| 5 内部利用システムのクリーンアップ         | ⏸    | —                     |
| 6 claude-mem 系の置き換え                  | ⏸    | —                     |

### Phase 3 で landed した PR (時系列)

| PR  | 内容                                                                                                 |
| --- | ---------------------------------------------------------------------------------------------------- |
| #1  | feat(phase3): admin UI 6 タブ + promoted_at + StreamableHTTPServerTransport 移行 + CI db integration |
| #2  | fix(runtime): Docker image 本番モード起動可能化 (Alpine→bookworm-slim)                               |
| #3  | feat(search): observations に search_text 生成列追加し pg_bigm GIN を facts も対象に                 |
| #4  | feat(llm): provider 非依存化 (anthropic + openai-compat 切替、ADR-007)                               |
| #5  | chore(compose): tsumugi-server に LLM\_\* env を流入                                                 |
| #6  | chore(summarize): skip 判定 prompt を AI エージェント作業記憶用途に絞る                              |
| #7  | fix(audn): NOOP/DELETE 時の `new_narrative: null` を schema 許容                                     |

## 4. 現在動いているもの

### MCP tools (4 件)

| tool                  | 役割                                   | ファイル                                                      |
| --------------------- | -------------------------------------- | ------------------------------------------------------------- |
| `save_observation`    | 観測保存 (Layer 1)                     | `apps/server/src/interfaces/mcp/tools/save-observation.ts`    |
| `search_memory`       | hybrid 検索 (pg_bigm + pgvector + RRF) | `apps/server/src/interfaces/mcp/tools/search-memory.ts`       |
| `trigger_dreaming`    | dreaming worker 手動起動               | `apps/server/src/interfaces/mcp/tools/trigger-dreaming.ts`    |
| `get_dreaming_status` | 実行履歴取得                           | `apps/server/src/interfaces/mcp/tools/get-dreaming-status.ts` |

MCP transport は `WebStandardStreamableHTTPServerTransport` を使用 (PR #1 で SSE から移行済み)。

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

### LLM (provider 非依存、ADR-007)

| provider        | 実装                            | 想定モデル                                                                                  |
| --------------- | ------------------------------- | ------------------------------------------------------------------------------------------- |
| `anthropic`     | `external/llm/anthropic.ts`     | claude-haiku-4-5 / claude-sonnet-4-6                                                        |
| `openai-compat` | `external/llm/openai-compat.ts` | Z.ai GLM Coding Plan (glm-4.5-air / glm-4.6) / DeepSeek / OpenRouter / Ollama / OpenAI 本家 |

tier 別に env で切替可能 (`LLM_LOW_PROVIDER` / `LLM_MID_PROVIDER`)。
個人運用では Z.ai GLM Coding Plan (subscription で API 料金定額) を default として `.env.example` に反映済み。

### REST endpoints (9 件)

| method   | path                        | 説明                       |
| -------- | --------------------------- | -------------------------- |
| `GET`    | `/health`                   | ヘルスチェック             |
| `GET`    | `/api/observations`         | observation 一覧           |
| `DELETE` | `/api/observations/:id`     | observation 削除           |
| `GET`    | `/api/memories`             | memory 一覧                |
| `PATCH`  | `/api/memories/:id`         | memory 編集 (narrative 等) |
| `POST`   | `/api/memories/:id/archive` | memory archive             |
| `GET`    | `/api/decisions`            | decision 一覧              |
| `GET`    | `/api/links`                | provenance link 一覧       |
| `POST`   | `/api/dreaming/trigger`     | dreaming 手動起動          |
| `GET`    | `/api/dreaming/runs`        | 実行履歴                   |

### 管理 UI (PR #1 で実装)

`apps/ui/` に React + Vite + Tailwind + TanStack Query で実装済み。
6 タブ: Observations / Memories / Decisions / Provenance / Dreaming runs / Settings。

> 設計判断は `docs/adr/0006-admin-ui-operations-console.md` 参照
> (運用卓トーン: 工業的 + 紙台帳、黄/赤アクセント)

### DB スキーマ (PostgreSQL 18)

| テーブル        | 役割                                                                                               |
| --------------- | -------------------------------------------------------------------------------------------------- |
| `observations`  | Layer 1: 生観測 (immutable accumulation)。`promoted_at` で promote 済み判定、`search_text` 生成列  |
| `memories`      | Layer 2: 統合知識 (synthesis, archive 可)。`importance` / `kind` (`general,historical,reflection`) |
| `decisions`     | 決定 + supersede chain (`supersedes_id`, `status: in_progress/superseded`)                         |
| `links`         | provenance グラフ (from_layer / to_layer / relation)                                               |
| `dreaming_runs` | 実行履歴 (job_kind / status / counts / metadata)                                                   |

Extension: `vector` (pgvector 0.8.2), `pg_bigm` (1.2-20250903)
Migration: `apps/server/drizzle/0000..0004_*.sql` (Phase 3 で 0003 promoted_at + 0004 search_text 追加)

## 5. 環境セットアップ手順

### 5.1 依存とビルド

```bash
mise install                # node 22 + pnpm 11.6.0
cd ~/git/tsumugi
pnpm install
```

### 5.2 DB (PostgreSQL 18 + pg_bigm + pgvector)

```bash
docker compose up -d tsumugi-postgres

# Drizzle migration 適用
DATABASE_URL=postgresql://tsumugi:tsumugi_dev@localhost:5433/tsumugi \
  pnpm -C apps/server db:migrate
```

### 5.3 環境変数 (LLM API key)

**1Password Environment で管理する場合 (推奨)**:

1Password アプリで Environment `tsumugi-dev` を作成 (既存) → 以下の変数を登録:

```
DATABASE_URL
PORT=8000
TSUMUGI_PG_PASSWORD=tsumugi_dev
LLM_LOW_PROVIDER=openai-compat
LLM_LOW_MODEL=glm-4.5-air
LLM_LOW_BASE_URL=https://api.z.ai/api/paas/v4
LLM_LOW_API_KEY=<実 key>
LLM_MID_PROVIDER=openai-compat
LLM_MID_MODEL=glm-4.6
LLM_MID_BASE_URL=https://api.z.ai/api/paas/v4
LLM_MID_API_KEY=<実 key>
HF_CACHE=./.cache/huggingface
```

mount path を `/Users/<user>/git/tsumugi/.env` に設定すると FUSE で自動同期。
docker compose は `${LLM_*}` interpolation 経由でコンテナに流入する (`compose.yml` 設定済み)。

**手動 .env で管理する場合**:

```bash
cp .env.example .env
# .env を直接編集 (Z.ai GLM Coding Plan が default、Anthropic に切替も可能)
```

key 未設定でも MCP の `save_observation` / `search_memory` は動作する (BGE-M3 embedding + DB のみ)。dreaming 系は key 必須。

### 5.4 起動

```bash
# 本番モード Docker (推奨、本番想定検証)
docker compose up -d

# 開発モード (tsx watch)
mise run -C apps/server dev-http   # MCP server (port 8000)
mise run -C apps/ui dev            # admin UI (port 5174, /api proxy to 8000)
```

> ⚠️ **port 8000 競合に注意**: dev-http と docker compose を両方同時に動かすと、ホスト 8000 を別プロセスが掴んでいて docker container にリクエストが届かない事故が起きる。`lsof -iTCP:8000 -sTCP:LISTEN` で確認、必要なら kill。

## 6. 動作確認コマンド一覧

```bash
# 型チェック
mise run check                   # = pnpm typecheck 全 workspace

# MCP server / UI 起動
mise run -C apps/server dev-http
mise run -C apps/ui dev

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
mise run -C apps/server llm-smoke

# dreaming 個別実行 (CLI、cron 想定)
mise run -C apps/server dream-promote     # promote-observations のみ
mise run -C apps/server dream-synthesize  # synthesize のみ
mise run -C apps/server dream-time-update
mise run -C apps/server dream-decision
mise run -C apps/server dream-full        # 全部順次
```

### Dreaming job の動作確認 (本番 Docker + Z.ai GLM 経由、Phase 3 で実証済み)

| job                      | tier      | 動作                                                       |
| ------------------------ | --------- | ---------------------------------------------------------- |
| `promote-observations`   | LOW + MID | summarize + AUDN judge で Layer 2 へ                       |
| `synthesize`             | LOW       | 類似 memory (threshold 0.85) をクラスタ統合                |
| `time-update`            | LOW       | aging (importance 減衰 + historical 付与 + 時系列リライト) |
| `decision-contradiction` | MID       | 上書きペア検出 → supersedes_id 設定                        |
| `reflection`             | LOW       | session 単位の lesson / pattern 抽出 (kind='reflection')   |

## 7. Phase 3 残作業と Phase 4 への展望

### Phase 3 残り (本番デプロイ)

| 項目                          | 状態                                           |
| ----------------------------- | ---------------------------------------------- |
| 管理 UI 実装 (6 タブ)         | ✅ PR #1                                       |
| 本番 Docker image 起動可能化  | ✅ PR #2                                       |
| 多クライアント検証 (ローカル) | ✅ Claude Code + Codex の dual-visibility 確認 |
| **pve-docker 本番デプロイ**   | ⏸ infra-configs 側の compose 整備が必要        |
| BGE-M3 warm-up (任意)         | ⏸ 起動時 lazy DL のままでも実用可              |
| logging / monitoring          | ⏸ 必要なら追加                                 |

bun の検証結果: pve-docker (AVX2 なし QEMU CPU) でも **bun 1.3.14 baseline variant は動作確認済み**。ただし Node のまま行くのが無難 (`@xenova/transformers` + onnxruntime-node の互換性安定)。

### Phase 4 着手前の確認事項

1. tsumugi の DB を内部利用システムと共有するか別建てするか
2. 内部利用システム側の memory モジュールを段階移行するか一気に切り替えるか
3. データ移行スクリプトの設計 (既存 memory → tsumugi schema)

## 8. 既知の制約 / 注意

### LLM コスト

provider 非依存になったため tier 別に選べる:

- **Z.ai GLM Coding Plan** (subscription): API 料金が定額化、個人運用に最適
- **Anthropic Claude**: pay-per-token、品質安定
- **DeepSeek**: 安価、reasoning 性能高
- **Ollama**: 完全ローカル、コストゼロ

観測 1 件あたり summarize (LOW) + AUDN judge (MID) で API 呼び出し 2 回。dreaming full で別途 LOW × 3 + MID × 1 が走る。
日 100 観測想定なら Z.ai Coding Plan (月 $3〜) で十分カバー。

### pve-docker (デプロイ先) の制約

- 共有ホスト、ディスク 96GB 単一
- RAM 競合に注意 (内部利用システム / forgejo-runner と同居)
- AVX2 命令は持たない (bun 互換性に注意したい場合は baseline variant を使う)

### 解決済みの過去 issue (参考)

- ✅ MCP SSE deprecated → PR #1 で `WebStandardStreamableHTTPServerTransport` に移行
- ✅ observation 再 promote 問題 → PR #1 で `promoted_at` 列追加
- ✅ コードシンボル検索が embedding 任せ → PR #3 で facts も pg_bigm GIN 対象に
- ✅ Anthropic 専用 → PR #4 で provider 非依存
- ✅ skip 判定がライフログを通す → PR #6 で AI エージェント作業記憶用途に絞った prompt
- ✅ AUDN NOOP schema error → PR #7 で `new_narrative: null` 許容

## 9. ディレクトリ構造 (簡易)

```
tsumugi/
├── AGENTS.md                # Codex 用ガイド (CLAUDE.md と同内容)
├── CLAUDE.md                # Claude Code 用ガイド
├── README.md                # コンセプト・ロードマップ
├── compose.yml              # PG18 + tsumugi-server + LLM_* env interpolation
├── Dockerfile               # multi-stage (UI build → server bundle)
│                            # Base: node:22-bookworm-slim (glibc 必須、Alpine NG)
├── Dockerfile.postgres      # PG18 + pgvector + pg_bigm カスタム
├── docs/
│   ├── HANDOFF.md           # このファイル
│   └── adr/0001..0007-*.md  # 意思決定 (PR #1〜7 と対応)
├── docker/postgres/init/    # 拡張有効化 SQL
├── apps/
│   ├── server/              # MCP server + REST + dreaming worker
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── core/        # ビジネスロジック
│   │   │   │   ├── observation/  (save / summarize)
│   │   │   │   ├── dreaming/     (audn / synthesize / time-update / decision-contradiction / reflection / runner / cli)
│   │   │   │   └── search/       (hybrid / bigm / vector / rrf)
│   │   │   ├── data/        # 永続化
│   │   │   │   ├── schema.ts (5 テーブル + dreaming_runs)
│   │   │   │   ├── client.ts
│   │   │   │   └── repos/   (observation / memory / decision / link / dreaming-run)
│   │   │   ├── external/    # 外部 I/O
│   │   │   │   ├── embedding/  (bge-m3 via @xenova/transformers)
│   │   │   │   └── llm/        (anthropic / openai-compat / singleton)
│   │   │   ├── interfaces/  # 入力アダプタ
│   │   │   │   ├── mcp/     (server / 4 tools / 2 transports)
│   │   │   │   └── rest/    (routes.ts)
│   │   │   └── lib/         # 横断ユーティリティ
│   │   ├── drizzle/         # migration (0000..0004)
│   │   └── package.json
│   └── ui/                  # React 管理 UI (6 タブ実装済み)
└── packages/
    └── shared/              # Zod スキーマ + 型 (dist 出力で本番 resolve)
```

## 10. Codex への引き継ぎフロー (推奨)

1. このファイルを読む
2. `AGENTS.md` を読む
3. `README.md` の Phase 3 / 4 セクションを確認
4. `docs/adr/0001..0007-*.md` で意思決定の背景を理解
5. **Phase 3 残り (pve-docker デプロイ) または Phase 4 (内部システム移行) のどちらに進むか確認**
6. 新規 use case は `core/<domain>/<verb>.ts` 命名で配置
7. DB 列追加は次の migration (0005 以降) として `pnpm db:generate` で生成
8. PR は `feat(...): <内容>` 形式で main にマージ (CI 必須通過)

質問・blocker は **PR description に書く**形で。

## 11. 緊急時の参照

| 状況                                          | 対処                                                                                              |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| typecheck が落ちる                            | `cd ~/git/tsumugi && pnpm typecheck` で原因確認、ESM `.js` 拡張子忘れが多い                       |
| pnpm install で native build 失敗             | `pnpm-workspace.yaml` の `allowBuilds` に追加 (esbuild / protobufjs / sharp は許可済み)           |
| Postgres が起動しない                         | `docker compose logs tsumugi-postgres` 確認、データボリュームは `/var/lib/postgresql` (PG18 規約) |
| pg_bigm が無い                                | `docker compose build --no-cache tsumugi-postgres` で再 build                                     |
| LLM 呼び出しが失敗                            | 1Password Environment の key 設定確認、`mise run -C apps/server llm-smoke` で疎通                 |
| migration が衝突                              | `apps/server/drizzle/meta/_journal.json` を確認                                                   |
| **port 8000 競合**                            | `lsof -iTCP:8000 -sTCP:LISTEN` で占有プロセス確認、kill / docker compose のどちらかに統一         |
| **古い dist で import 解決失敗**              | `rm -rf apps/*/dist packages/*/dist *.tsbuildinfo` してから clean rebuild                         |
| Docker image で onnxruntime native build 失敗 | base image を `node:22-bookworm-slim` (glibc) に。Alpine だと musl 非互換で死ぬ                   |
| Hono が `env_file` 直読みできない             | docker compose の `${LLM_*}` interpolation 経由で渡す                                             |

## 12. 残課題 / 改善余地

1. ⚠️ pve-docker 本番デプロイ (infra-configs 側の compose 整備、Tailscale 経由)
2. 💡 AGENTS.md と CLAUDE.md の同期メカニズム (symlink? lint? — 未定)
3. 💡 LLM tier 設定の動的切替 (現状 env でしか変更できない)
4. 💡 BGE-M3 warm-up を build 時 / 起動時に行うか lazy DL のままにするか判断
5. 💡 CI で実 DB を使った integration test の範囲を広げる (現状 db smoke のみ)
6. 💡 dreaming scheduler (cron-like 自動実行) の追加
7. 💡 observation 自動取得 hook の実装 (Phase 6 想定)

---

引き継ぎ完了。質問は PR / Issue 経由で。
