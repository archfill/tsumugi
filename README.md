# 紬（Tsumugi）

archfill 製の MCP ベース記憶レイヤー。観測・記憶・想起・dreaming を担う、自律エージェント向けメモリインフラ。

> **Status: pre-1.0 / single-user / unverified in production.**
> 本リポジトリは作者の個人プロジェクトとして開発中。長期運用・大規模負荷・複数ユーザ環境での検証は未実施。実運用での導入を推奨できる段階ではない。

## コンセプト

- 記憶を「糸」として紡ぐメタファ — 観測（observation）を取り込み、整理・統合して記憶層に紡ぎ込む
- ドリーミング（time-aware update / cross-session synthesize / decision supersede chain / reflection）で記憶を継続的に再編成
- MCP server として **Claude Code / Codex** などの AI クライアントから共通利用

## 設計方針

### 二層構造（synthesis + accumulation の両取り）

- **Layer 1: Observation**（accumulation） — 生観測、immutable、消さない
- **Layer 2: Memory**（synthesis） — dreaming で生成される統合知識、再生成可能
- provenance で Layer 1 ↔ Layer 2 のリンクを保持

### LLM 配置

- **hot path（save / search）**: LLM ゼロ、即応答
- **cold path（dreaming）**: 夜間バッチで集約、コスト透明
- クライアント LLM が観測の整形・解釈を担当（hot path で LLM 呼ばない）

### 検索

- **pg_bigm**（コードシンボル・文字面マッチ）
- **BGE-M3 embedding**（意味・多言語・クロスリンガル）
- **RRF fusion** ランキング

## 構成（monorepo）

```
tsumugi/
├── apps/
│   ├── server/           # MCP server + REST API + dreaming worker (TypeScript)
│   └── ui/               # admin UI (React + Vite + Tailwind + shadcn)
├── packages/
│   └── shared/           # 型 / Zod スキーマ共有
├── compose.yml           # tsumugi-front + tsumugi-server + tsumugi-postgres
├── Dockerfile            # server image (Node + onnxruntime + dreaming worker)
├── Dockerfile.postgres   # postgres + pgvector + pg_bigm
├── apps/ui/Dockerfile    # front image (nginx 配信 + /api・/mcp を server に proxy)
├── package.json          # pnpm workspace root
├── pnpm-workspace.yaml
└── mise.toml             # node + pnpm 宣言
```

## 技術スタック

| 層              | 技術                                                                 |
| --------------- | -------------------------------------------------------------------- |
| Backend         | TypeScript 6 / Node.js 22 / Hono / MCP TS SDK                        |
| ORM             | Drizzle ORM + node-postgres                                          |
| DB              | PostgreSQL 18 + pgvector + pg_bigm                                   |
| Embedding       | BGE-M3 via `@xenova/transformers`（ONNX）                            |
| LLM             | provider 非依存（Anthropic / OpenAI 互換 / Z.ai / Ollama）、tier 別  |
| Resilience      | 3 層 retry + per-item failure tracking + provider fallback           |
| Frontend        | React 19 / Vite 8 / TailwindCSS 4 / shadcn / TanStack Router & Query |
| Package manager | pnpm（workspace）                                                    |
| Task runner     | mise                                                                 |
| 配布            | Docker compose                                                       |

## 開発コマンド

```bash
# 初回セットアップ
mise install                  # node 22 + pnpm 11
pnpm install                  # workspace 全体

# 起動
mise run dev-server           # MCP server (port 8000)
mise run dev-ui               # admin UI (port 5174)

# 品質チェック
mise run check                # lint + typecheck + test 全体
mise run typecheck            # 型チェックのみ
```

## LLM 用途と tier

| tier      | タスク                                                                           | 設定方法                         |
| --------- | -------------------------------------------------------------------------------- | -------------------------------- |
| LOW       | session narrative / decision 要約 / cross-session synthesize / time-aware update | `LLM_LOW_*` env で provider 指定 |
| MID       | AUDN 判定 / decision 矛盾検出                                                    | `LLM_MID_*` env で provider 指定 |
| embedding | BGE-M3（ローカル ONNX）                                                          | —                                |

各 tier の primary が失敗したら `LLM_*_FALLBACK_*` で指定した provider に自動切替される。詳細は `.env.example` 参照。

## クライアント接続

| クライアント | 接続方式                 |
| ------------ | ------------------------ |
| Claude Code  | MCP（stdio or HTTP/SSE） |
| Codex        | MCP（stdio or HTTP/SSE） |
| 他システム   | MCP（HTTP/SSE）          |

複数 PC からの利用はネットワーク到達性のある場所に tsumugi を立ち上げて HTTP/SSE で接続する。

## デプロイ構成

`docker compose up -d` で 3 コンテナが起動する:

```
┌─ host:8000 ─→ tsumugi-front (nginx) ─┬─ /api/*, /mcp, /health → tsumugi-server:8000
                                       └─ /, /assets/*          → React admin UI
                                            tsumugi-server ───→ tsumugi-postgres:5432
```

- 入口は `tsumugi-front` (nginx) 1 ヶ所
- `tsumugi-server` と `tsumugi-postgres` は compose ネットワーク内のみで通信、外部公開しない
- 利用者は `localhost:8000` で UI + API + MCP すべてアクセス可能

### 認証について

**tsumugi 本体に認証機構はない**。public ネットワークに公開する場合は、必ず外側に reverse proxy + 認証層を挟むこと:

- Traefik + BasicAuth middleware
- Caddy + caddy-security
- nginx-proxy + oauth2-proxy
- Cloudflare Access / Tailscale Funnel 等

private network (VPN 内、LAN 内) で使う場合はそのままでも可。

## ステータス・ロードマップ

> Phase 1〜3 で tsumugi が独立サービスとして稼働。Phase 4〜5 は内部利用システムの移行・既存実装の撤去。Phase 6（任意）は既存 memory 系ツールの置き換え。

### Phase 0: 設計確定・scaffold（完了）

- monorepo 構築、依存最新化、typecheck pass

### Phase 1: tsumugi MCP server 最小動作

- Drizzle schema（Observation / Memory / Decision / Link）
- pg_bigm + pgvector hybrid 検索（RRF fusion）
- BGE-M3 embedding ラッパ（@xenova/transformers）
- MCP tool: `save_observation` / `search_memory` / `mark_memory_outdated`
- LLM は呼ばない、hot path のみ
- Claude Code 1 つから動作確認

### Phase 2: dreaming worker 実装

- cross-session synthesize / time-aware memory update / AUDN judge / decision contradiction / reflection を実装
- cron / scheduled trigger で起動
- provenance（Layer 1 ↔ Layer 2）の整備
- LLM tier 設定（LOW / MID）

### Phase 3: 管理 UI + デプロイ

- React admin UI（観測・記憶一覧、検索、編集、dreaming 履歴、手動実行）
- compose デプロイ
- VPN 経由で複数クライアントから接続検証
- 多クライアント横断の動作確認

> ── ここまでで tsumugi が独立サービスとして稼働 ──

### Phase 4: 内部利用システムの移行（最大の山場）

- 内部利用システムに tsumugi MCP クライアント実装
- 既存 memory モジュールを tsumugi 経由呼び出しに差し替え
- 既存テーブルを tsumugi schema にデータ移行（provenance 維持）
- feature flag による段階移行 + 検証期間
- 本番カットオーバー + rollback 計画
- 回帰テスト一式

### Phase 5: 内部利用システムのクリーンアップ

- 内部利用システム側の memory 関連モジュール削除
- DB schema の関連テーブル drop（マイグレーション）
- 不要依存削除
- CI / docs 更新

> ── ここで「内部利用システムから memory が完全切り出し」 ──

### Phase 6（任意）: 既存 memory ツールの置き換え

- 既存 memory 系ツールの設定を外す
- 自動取得を tsumugi 側 hook に置換

## 評価ベンチ

各 dreaming ジョブと hybrid search を独立に検証するベンチ基盤を `apps/server/eval/` に同梱。

```bash
mise run -C apps/server bench           # 全 5 ベンチを順次実行
mise run -C apps/server bench-audn      # 個別
```

- 合成 fixture (132 ケース) — 公開・再現可能
- LLM resilience の vitest unit test (14 ケース)
- 詳細と運用は [docs/adr/0009-eval-as-migration-validation.md](docs/adr/0009-eval-as-migration-validation.md) 参照

これらは component 単体の正しさを測るもので、end-to-end QA benchmark (LoCoMo / LongMemEval 等) とは別軸。

## セキュリティ

脆弱性報告は [SECURITY.md](./SECURITY.md) を参照。

## ライセンス

Apache License 2.0. 詳細は [LICENSE](./LICENSE) を参照。
