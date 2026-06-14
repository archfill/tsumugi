# ADR-002: pg_bigm + pgvector ハイブリッド検索（RRF fusion）採用

- 日付: 2026-06-14
- ステータス: Accepted

## コンテキスト

AI エージェントの記憶検索では、二種類のクエリが混在する。

1. **キーワード検索**: 「あの bug の ID は何だったか」「yui の auth 変更」など、固有名詞・識別子を含む
2. **意味検索**: 「認証まわりの決定事項を教えて」など、概念的・意味的な問い

前者は全文検索（BM25 / bigram）が強く、後者はベクトル検索が強い。
どちらか一方だけでは精度が落ちる。また、日本語・英語が混在する観測テキストへの対応も必要。

## 決定

**pg_bigm**（PostgreSQL 拡張）でキーワード検索、**pgvector**（cosine distance）でベクトル検索を行い、
両結果を **Reciprocal Rank Fusion (RRF)** で統合する。

- **pg_bigm**: 2-gram ベースの GIN インデックス。`likequery()` + `bigm_similarity()` を使用。
  日本語を含む任意の言語に対応（IKur/MeCab 不要）。
- **pgvector**: `embedding <=> vec`（コサイン距離）でランキング。BGE-M3（dim=1024）のベクトルを格納。
- **RRF**: 各リストの順位から `1/(k + rank)` を合算。デフォルト `k=60`。
  スコアのスケール差に依存せず、安定した fusion が得られる。

実装は `core/search/` 以下に分離:

- `hybrid.ts`: 統合エントリポイント
- `bigm.ts`: pg_bigm クエリ
- `vector.ts`: pgvector クエリ
- `rrf.ts`: RRF 実装（純粋関数）

## 代替案と却下理由

**pg_trgm のみ（trigram 検索）**

- 却下: pg_bigm のほうが日本語 2-gram に最適化されており、日本語混在テキストで優位。
  `pg_bigm 1.2-20250903` が採用 Docker イメージに含まれることを確認済み。

**Elasticsearch / OpenSearch**

- 却下: PostgreSQL で完結する構成を優先。追加インフラを増やさない。
  tsumugi は単一ユーザー・ローカル運用が基本であり、Elasticsearch のオーバーヘッドは不適切。

**全文検索のみ（ベクトルなし）**

- 却下: 意味的類似検索ができないと、表現が異なる観測を取りこぼす。
  BGE-M3 は多言語対応・高品質で、ローカル CPU 推論が現実的。

**BM25 full-text search（`tsvector`）**

- 却下: 日本語には辞書（IKur/MeCab）が必要で、環境依存が増す。
  pg_bigm は辞書不要で同等以上の精度を日本語で出せる。

**クロスエンコーダ reranking**

- 将来検討: 現時点では RRF で十分な精度が得られる想定。
  精度不足が判明した段階で追加する。

## 帰結

- PostgreSQL 単一インスタンスで全検索機能が完結する
- observations / memories の両テーブルに `embedding vector(1024)` カラムを持つ
- `embedding IS NOT NULL` フィルタにより、embedding 未生成行を vector 検索から除外できる
- memories には `source` / `session_id` / `project_tag` カラムがないため、
  それらフィルタが指定された場合は observations のみ検索する（`hybridSearch` 内で制御）
- RRF の `k` 定数は `HybridSearchOptions.rrfK` で調整可能（デフォルト 60）
