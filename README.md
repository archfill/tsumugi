# 紬（Tsumugi）

archfill 製の MCP ベース記憶レイヤー。capture・観測・想起・決定論的保守を担う、自律エージェント向けメモリインフラ。

> **Status: pre-1.0 / single-user / unverified in production.**
> 本リポジトリは作者の個人プロジェクトとして開発中。長期運用・大規模負荷・複数ユーザ環境での検証は未実施。実運用での導入を推奨できる段階ではない。

## コンセプト

- 記憶を「糸」として紡ぐメタファ — completed turn を capture し、canonical observation として検索可能にする
- semantic content の整理は元の作業文脈を持つクライアントへ委譲し、サーバーは自動で意味を書き換えない
- MCP server として **Claude Code / Codex** などの AI クライアントから共通利用

## 設計方針

### Three-layer 構造

- **Layer 1: Capture** — hook event の TTL 付き安全網。既定検索には出さない
- **Layer 2: Observation** — client save または Stop checkpoint 由来の canonical record
- **Layer 3: Memory** — legacy / curated record。自動生成は必須にしない
- provenance で source と派生関係を保持する

### サーバー側 LLM ゼロ

- MCP / REST / scheduled job の全経路で外部 LLM を呼ばない
- クライアント LLM が観測の整形・意味判断を担当する
- Stop の最終応答は再要約せず、決定論的に observation 化する
- server に LLM API key、provider client、fallback 設定は不要

### 検索

- **pg_bigm**（コードシンボル・文字面マッチ）
- **BGE-M3 embedding**（意味・多言語・クロスリンガル）
- **RRF fusion** ランキング

## 構成（monorepo）

```
tsumugi/
├── apps/
│   ├── server/           # MCP server + REST API + deterministic worker (TypeScript)
│   └── ui/               # admin UI (React + Vite + Tailwind + shadcn)
├── packages/
│   └── shared/           # 型 / Zod スキーマ共有
├── compose.yml           # tsumugi-front + tsumugi-server + tsumugi-postgres
├── Dockerfile            # server image (Node + onnxruntime)
├── Dockerfile.postgres   # postgres + pgvector + pg_bigm
├── apps/ui/Dockerfile    # front image (nginx 配信 + /api・/mcp を server に proxy)
├── package.json          # pnpm workspace root
├── pnpm-workspace.yaml
├── mise.toml             # 任意: tool version / task alias
└── flake.nix             # 任意: NixOS devShell
```

## 技術スタック

| 層              | 技術                                                                 |
| --------------- | -------------------------------------------------------------------- |
| Backend         | TypeScript 6 / Node.js 22 / Hono / MCP TS SDK                        |
| ORM             | Drizzle ORM + node-postgres                                          |
| DB              | PostgreSQL 18 + pgvector + pg_bigm                                   |
| Embedding       | BGE-M3 via `@xenova/transformers`（ONNX）                            |
| Semantic curation | 呼び出し元クライアントへ委譲                                      |
| Maintenance     | deterministic promotion / retention / soft archive                    |
| Frontend        | React 19 / Vite 8 / TailwindCSS 4 / shadcn / TanStack Router & Query |
| Package manager | pnpm（workspace）                                                    |
| Task runner     | pnpm scripts（mise は任意）                                          |
| Dev shell       | 任意: Nix flakes（主に NixOS 向け）                                  |
| 配布            | Docker compose                                                       |

## 開発コマンド

要件:

- Node.js 22 以上
- pnpm 11 以上

Node.js / pnpm の導入方法は任意。nvm / fnm / mise / Volta / Nix など、各自の環境に合わせる。

```bash
# 初回セットアップ
pnpm install                  # workspace 全体

# 起動
pnpm dev:server               # MCP server (port 8000)
pnpm dev:ui                   # admin UI (port 5174)

# 品質チェック
pnpm check                    # lint + typecheck + test 全体
pnpm typecheck                # 型チェックのみ
```

### 任意: mise

mise を使う場合は、同じ操作を task として実行できる。

```bash
mise install                  # node 22 + pnpm 11
mise run install
mise run dev-server
mise run dev-ui
mise run check
```

### 任意: NixOS devShell

NixOS では mise が Node を source build する設定になりやすいため、必要に応じて devShell を使える。

```bash
nix develop                   # Nixpkgs の node 22 + pnpm + mise
pnpm install
```

devShell 内では `MISE_DISABLE_TOOLS=node,pnpm` を設定し、mise は task runner としてだけ使える。

## モデル処理

BGE-M3 embedding はローカル ONNX で実行する。これは外部 LLM 呼び出しではない。
要約、fact 抽出、semantic merge、contradiction 判定はサーバーでは実行しない。

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
- サーバーは外部 LLM を呼ばない
- Claude Code 1 つから動作確認

### Phase 2: deterministic worker 実装

- Stop capture → observation promotion、capture sweep、outdated archive を実装
- cron / scheduled trigger で起動
- provenance（capture → observation → legacy / curated memory）の整備
- 旧 LLM job 名は互換 no-op として保持

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

hybrid search と provenance policy を独立に検証するベンチ基盤を `apps/server/eval/` に同梱。

```bash
pnpm --filter @tsumugi/server bench:search
pnpm --filter @tsumugi/server eval:search-provenance-policy
```

- 合成 fixture — 公開・再現可能
- private fixture — local only、raw content を log / artifact へ出さない
- 詳細と運用は [docs/adr/0009-eval-as-migration-validation.md](docs/adr/0009-eval-as-migration-validation.md) 参照

これらは component 単体の正しさを測るもので、end-to-end QA benchmark (LoCoMo / LongMemEval 等) とは別軸。

## セキュリティ

脆弱性報告は [SECURITY.md](./SECURITY.md) を参照。

## ライセンス

Apache License 2.0. 詳細は [LICENSE](./LICENSE) を参照。
