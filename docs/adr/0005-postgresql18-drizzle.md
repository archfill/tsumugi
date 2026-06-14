# ADR-005: PostgreSQL 18 + Drizzle ORM 採用

- 日付: 2026-06-14
- ステータス: Accepted

## コンテキスト

tsumugi のデータ永続化には以下の機能が同時に必要:

- ベクトル検索（BGE-M3 の 1024 次元ベクトル、コサイン距離）
- 日本語対応の全文検索（2-gram）
- リレーショナルデータ管理（observations / memories / decisions / links）
- TypeScript からの型安全なクエリ
- migration 管理（schema 変更の履歴追跡）

これらを単一のデータストアで満たせるかどうかが選定基準となった。

## 決定

**PostgreSQL 18**（拡張: pgvector 0.8.2、pg_bigm 1.2-20250903）を採用し、
ORM には **Drizzle ORM 0.45** を使用する。

### PostgreSQL 拡張

- **pgvector 0.8.2**: `vector(1024)` カラム型、`<=>` コサイン距離演算子、HNSW インデックス
- **pg_bigm 1.2-20250903**: 2-gram GIN インデックス、`likequery()` / `bigm_similarity()` 関数

Docker イメージは `pgvector/pgvector:pg18`（pgvector 同梱）をベースに、
pg_bigm をビルドして追加する（`Dockerfile.postgres` 参照）。

### Drizzle ORM 選定理由

- **型安全**: `$inferSelect` / `$inferInsert` で Drizzle schema から TypeScript 型を自動生成
- **SQL に近い**: 複雑なクエリ（RRF fusion など）で `sql` タグが使いやすい
- **migration**: `drizzle-kit generate` + `drizzle-kit migrate` でファイルベース管理
- **pgvector サポート**: `drizzle-orm/pg-core` の `vector()` カラム型が公式対応

## 代替案と却下理由

**SQLite + sqlite-vec**

- 却下: シングルファイルで手軽だが、複数プロセス同時アクセスに制限がある。
  pg_bigm 相当の日本語 2-gram 全文検索がない。
  本番運用（Docker Compose）では PostgreSQL のほうが自然。

**Qdrant / Weaviate（専用ベクトル DB）**

- 却下: 追加サービスが必要になり、インフラが複雑化する。
  リレーショナルデータ（decisions / links）は別途 RDBMS が必要になり、二重管理になる。
  PostgreSQL の pgvector で要件を満たせるため不要。

**Prisma ORM**

- 却下: pgvector の `vector` 型が Prisma では `Unsupported` 扱いで、型安全なクエリが書けない。
  Drizzle は pgvector を一級サポートしている。

**TypeORM**

- 却下: デコレータベースで TypeScript strict モードと相性が悪い。
  Drizzle のほうが ESM / verbatimModuleSyntax 環境でのエコシステムが整っている。

**PostgreSQL 16 / 17**

- 却下: PostgreSQL 18 の `pgvector/pgvector:pg18` イメージが利用可能であり、
  最新版を使わない理由がない。pg_bigm も PG18 対応ビルドが確認できている。

## 帰結

- schema の変更は `data/schema.ts` で行い、`drizzle-kit generate` で migration ファイルを生成する
- `drizzle/` ディレクトリは migration ファイルの置き場。手動編集禁止
- `drizzle.config.ts` の `schema` パスは `./src/data/schema.ts` を指す
- `db` オブジェクト（`data/client.ts`）は直接触らず、`data/repos/<entity>.ts` 経由でアクセスする
- pgvector の `<=>` 演算子（コサイン距離）を使うため、embedding カラムは `NOT NULL` でない行を
  `WHERE embedding IS NOT NULL` でフィルタする
