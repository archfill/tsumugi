# ADR-004: TypeScript full-stack monorepo 採用

- 日付: 2026-06-14
- ステータス: Accepted

## コンテキスト

tsumugi は MCP サーバー（バックエンド）と管理 UI（フロントエンド）を含む。
実装言語の選定にあたり、Python・Rust・TypeScript を検討した。

主な要件:

- MCP SDK（`@modelcontextprotocol/sdk`）の利用
- BGE-M3 embedding の CPU 推論
- PostgreSQL アクセス（Drizzle ORM）
- 管理 UI（React）との型共有
- 単一開発者が主体のプロジェクト（学習コスト最小化）

## 決定

**TypeScript（Node.js / ESM）で full-stack monorepo を構築する。**

構成:

- `packages/shared`: Zod スキーマ・型定義（バックエンド・フロントエンド共有）
- `apps/server`: FastAPI 相当の MCP サーバー（Hono + MCP SDK）
- `apps/ui`: React 管理画面（フロントエンド、Phase 3 以降）
- pnpm workspaces でモノレポを管理

パッケージマネージャは **pnpm**（ディスク効率・ワークスペース機能）。
TypeScript は `NodeNext` + `verbatimModuleSyntax`（ESM strict）。

## 代替案と却下理由

**Python**

- 検討: FastAPI + SQLAlchemy は archfill の yui プロジェクトで実績がある。
  `@xenova/transformers` に相当する `sentence-transformers` も成熟している。
- 却下: MCP SDK の Python 版は機能差があり、JS/TS が先行している。
  管理 UI（React）との型共有が TypeScript のほうが自然。
  pnpm monorepo で server/ui/shared を一元管理できる利点が大きい。

**Rust**

- 検討: パフォーマンス・メモリ安全性・バイナリ配布の観点で魅力がある。
  ONNX Runtime + Rust で BGE-M3 推論は技術的に可能。
- 却下（保留）: MCP SDK の Rust バインディングが未成熟。
  開発速度を優先するフェーズでは TypeScript が適切。
  パフォーマンスがボトルネックになった段階で hot path を Rust に切り出す選択肢は残す。

**Python（バックエンド）+ TypeScript（フロントエンド）の分割**

- 却下: 二言語になると型共有ができず、OpenAPI 経由の型生成が必要になる。
  yui では `mise run gen-types` でこれを実現しているが、tsumugi では unnecessary な複雑さ。

## 帰結

- `@tsumugi/shared` パッケージで Zod スキーマを一元管理し、サーバー・UI 両方が参照する
- `ObservationInput` / `SearchInput` / `SearchHit` などの型は shared から import する
- `.js` 拡張子付き import を徹底する（ESM / NodeNext / verbatimModuleSyntax 環境）
- drizzle-kit で migration を管理し、Python の alembic 相当の機能を TypeScript で完結させる
- `@xenova/transformers` で BGE-M3 を Node.js から直接呼ぶ（追加サービス不要）
