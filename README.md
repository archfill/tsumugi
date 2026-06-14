# 紬（Tsumugi）

archfill 製の MCP ベース記憶レイヤー。観測・記憶・想起・dreaming を担う、自律エージェント向けメモリインフラ。

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
├── compose.yml           # tsumugi-server + tsumugi-postgres
├── Dockerfile            # multi-stage (UI build → server bundle)
├── package.json          # pnpm workspace root
├── pnpm-workspace.yaml
└── mise.toml             # node + pnpm 宣言
```

## 技術スタック

| 層              | 技術                                                                 |
| --------------- | -------------------------------------------------------------------- |
| Backend         | TypeScript 6 / Node.js 22 / Hono / MCP TS SDK                        |
| ORM             | Drizzle ORM + node-postgres                                          |
| DB              | PostgreSQL 16 + pgvector + pg_bigm                                   |
| Embedding       | BGE-M3 via `@xenova/transformers`（ONNX）                            |
| LLM             | AI SDK（cold path のみ、Claude 系を tier 別で利用）                  |
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

| tier      | タスク                                                                           | 想定モデル        |
| --------- | -------------------------------------------------------------------------------- | ----------------- |
| LOW       | session narrative / decision 要約 / cross-session synthesize / time-aware update | Claude Haiku 4.5  |
| MID       | AUDN 判定 / decision 矛盾検出                                                    | Claude Sonnet 4.6 |
| embedding | BGE-M3（ローカル ONNX）                                                          | —                 |

## クライアント接続

| クライアント | 接続方式                 |
| ------------ | ------------------------ |
| Claude Code  | MCP（stdio or HTTP/SSE） |
| Codex        | MCP（stdio or HTTP/SSE） |
| 他システム   | MCP（HTTP/SSE）          |

複数 PC からの利用はネットワーク到達性のある場所に tsumugi を立ち上げて HTTP/SSE で接続する。

## ステータス・ロードマップ

> Phase 1〜3 で tsumugi が独立サービスとして稼働。Phase 4〜5 は内部利用システムの移行・既存実装の撤去で、Phase 6（任意）は claude-mem 系の置き換え。

### Phase 0: 設計確定・scaffold（完了）

- monorepo 構築、依存最新化、typecheck pass

### Phase 1: tsumugi MCP server 最小動作

- Drizzle schema（Observation / Memory / Decision / Link）
- pg_bigm + pgvector hybrid 検索（RRF fusion）
- BGE-M3 embedding ラッパ（@xenova/transformers）
- MCP tool: `save_observation` / `search_memory`
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

### Phase 6（任意）: claude-mem 系の置き換え

- 既存の claude-mem 設定を外す
- 自動取得を tsumugi 側 hook に置換

## ライセンス

MIT
