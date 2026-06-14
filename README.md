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
| Backend         | TypeScript 6 / Node.js 22 / Hono / MCP TS SDK                        |
| ORM             | Drizzle ORM + node-postgres                                          |
| DB              | PostgreSQL 16 + pgvector + pg_bigm                                   |
| Embedding       | BGE-M3 via `@xenova/transformers`（ONNX）                            |
| LLM             | AI SDK（cold path のみ、Z.ai / DeepSeek / Haiku 等を tier 別）       |
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

## ステータス・ロードマップ

> 「yui から memory モジュールを完全切り出し」を最終ゴールとする。Phase 1〜3 で tsumugi が独立稼働、Phase 4〜5 で yui 側の移行と撤去、Phase 6（任意）で claude-mem 撤去まで。

### Phase 0: 設計確定・scaffold（完了）

- monorepo 構築、依存最新化、typecheck pass

### Phase 1: tsumugi MCP server 最小動作

- Drizzle schema（Observation / Memory / Decision / Link）
- pg_bigm + pgvector hybrid 検索（RRF fusion）
- BGE-M3 embedding ラッパ（@xenova/transformers）
- MCP tool: `save_observation` / `search_memory`
- LLM は呼ばない、hot path のみ
- Claude Code 1 つから動作確認

### Phase 2: dreaming worker 移植

- yui の `cross_session_synthesize` / `time_aware_memory_update` / `audn_judge` / `decision_contradiction_service` / `reflection_service` を流用
- TypeScript で書き直し、yui の Python ロジックを移植
- cron / scheduled trigger で起動
- provenance（Layer 1 ↔ Layer 2）の整備
- LLM tier 設定（LOW: DeepSeek / MID: Haiku 4.5）

### Phase 3: 管理 UI + デプロイ

- React admin UI（観測・記憶一覧、検索、編集、dreaming 履歴、手動実行）
- pve-docker への compose デプロイ
- Tailscale 経由で Mac 2 台 + Codex + yui から接続検証
- 多クライアント横断の動作確認

> ── ここまでで tsumugi が独立サービスとして稼働 ──

### Phase 4: yui 移行（最大の山場・3〜4 週間想定）

- yui バックエンドに tsumugi MCP クライアント実装
- 既存 `apps/backend/src/application/memory_*.py` 等を tsumugi 経由呼び出しに差し替え
- yui の Observation / Memory / Decision テーブルを tsumugi schema にデータ移行
- provenance リンク維持
- feature flag による段階移行 + 検証期間
- 本番カットオーバー + rollback 計画
- 回帰テスト一式

### Phase 5: yui 側クリーンアップ

- yui の memory モジュール削除（`memory_*` / `dreaming_*` / `observation_*` / `audn_*` / `decision_contradiction_*` / `cross_session_synthesize` / `time_aware_memory_update` / `reflection_service` 等）
- DB schema の Observation / Memory / Decision テーブル drop（alembic migration）
- 不要依存削除（sentence-transformers 等、yui 側で不要なら）
- yui の CI / docs 更新

> ── ここで「yui から memory が完全切り出し」 ──

### Phase 6（任意）: claude-mem 撤去

- claude-mem replacement Wave 4 と統合
- `npx claude-mem` 設定を Claude Code から外す
- 自動取得を tsumugi 側 hook に置換

## 関連プロジェクト

- [yui](https://github.com/archfill/yui) — AI マルチエージェントオーケストレーションプラットフォーム。tsumugi 移行前は memory モジュールを内包

## ライセンス

MIT
