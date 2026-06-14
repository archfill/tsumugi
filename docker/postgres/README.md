# tsumugi-postgres カスタムイメージ

## なぜカスタムイメージが必要か

tsumugi の hybrid 検索は 2 つの PostgreSQL 拡張を必要とする:

- **pgvector** — ベクトル意味検索（埋め込みベクトルの ANN 検索）
- **pg_bigm** — バイグラムキーワード検索（日本語 / CJK の全文検索）

公式の `pgvector/pgvector:pg16` イメージには pgvector のみ含まれており、
pg_bigm が欠けているため自前 Dockerfile (`Dockerfile.postgres`) で追加している。

## pg_bigm の取得方法

ベースイメージは Debian bookworm 系で PGDG apt リポジトリが設定済みのため、
`postgresql-16-pg-bigm` を apt でインストールするだけで動作する（ソースビルド不要）。

## 拡張の有効化

`init/01-extensions.sql` を `/docker-entrypoint-initdb.d/` にマウントする。
コンテナ初回起動時に PostgreSQL が自動実行し、両拡張が DB に登録される。
