# 紬（Tsumugi）

archfill 製の MCP ベース記憶レイヤー。yui の対として、観測・記憶・想起・dreaming を担う。

## コンセプト

- **yui（結）が会話を結ぶ** → **tsumugi（紬）が記憶を紡ぐ**
- 観測（observation）を糸として取り込み、記憶層に紡ぎ込む
- ドリーミング（time-aware update / cross-session synthesize / decision supersede chain / reflection）で記憶を継続的に再編成
- MCP server として **Claude Code / Codex / yui** から共通利用

## 設計方針

### 二層構造（synthesis + accumulation の両取り）

- **Layer 1: Observation**（accumulation） — 生観測、immutable、消さない
- **Layer 2: Memory**（synthesis） — dreaming で生成される統合知識、再生成可能
- provenance で Layer 1 ↔ Layer 2 のリンクを保持

### LLM 配置

- **hot path（save / search）**: LLM ゼロ、即応答
- **cold path（dreaming）**: 夜間バッチで集約、コスト透明
- クライアント LLM（Claude Code / Codex / yui）が観測の整形・解釈を担当

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
| Backend         | TypeScript 5.9 / Node.js 22 / Hono / MCP TS SDK                      |
| ORM             | Drizzle ORM + node-postgres                                          |
| DB              | PostgreSQL 16 + pgvector + pg_bigm                                   |
| Embedding       | BGE-M3 via `@xenova/transformers`（ONNX）                            |
| LLM             | AI SDK（cold path のみ、Z.ai / DeepSeek / Haiku 等を tier 別）       |
| Frontend        | React 19 / Vite 6 / TailwindCSS 4 / shadcn / TanStack Router & Query |
| Package manager | pnpm（workspace）                                                    |
| Task runner     | mise                                                                 |
| 配布            | Docker compose                                                       |

## 開発コマンド

```bash
# 初回セットアップ
mise install                  # node 22 + pnpm 10
pnpm install                  # workspace 全体

# 起動
mise run dev-server           # MCP server (port 8000)
mise run dev-ui               # admin UI (port 5174)

# 品質チェック
mise run check                # lint + typecheck + test 全体
mise run typecheck            # 型チェックのみ
```

## LLM 用途と tier

| tier      | タスク                                                                           | 想定モデル              |
| --------- | -------------------------------------------------------------------------------- | ----------------------- |
| LOW       | session narrative / decision 要約 / cross-session synthesize / time-aware update | DeepSeek V3 / Haiku 4.5 |
| MID       | AUDN 判定 / decision 矛盾検出                                                    | Haiku 4.5 / GLM-5.1     |
| embedding | BGE-M3（ローカル ONNX）                                                          | —                       |

## クライアント接続

| クライアント     | 接続方式                 |
| ---------------- | ------------------------ |
| Claude Code      | MCP（stdio or HTTP/SSE） |
| Codex            | MCP（stdio or HTTP/SSE） |
| yui バックエンド | MCP（HTTP/SSE）          |

複数 PC は Tailscale 経由で同一 tsumugi インスタンスに接続。

## ステータス

**Phase 0**: 設計確定・scaffold 完了（現在）

**Phase 1**: MCP server で `save_observation` / `search_memory` の最小動作（LLM 無し、hybrid 検索のみ）

**Phase 2**: dreaming worker 移植（yui の cross_session_synthesize / time_aware_memory_update / audn_judge を流用）

**Phase 3**: 管理 UI 整備、pve-docker デプロイ、複数クライアント検証

## ライセンス

MIT
