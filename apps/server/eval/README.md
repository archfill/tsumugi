# Tsumugi 評価ベンチ

## 目的

dreaming pipeline 各ジョブ (AUDN / promote / search / contradiction / time-update) と LLM resilience の品質を、**合成 fixture + yui 由来 private fixture** の双方で測定する。

実運用前に「既知の型のエッジケース」をすべて潰すための仕組み。

## ディレクトリ

```
eval/
├── README.md              # この文書
├── types.ts               # FixtureCase / BenchOutcome / BenchSummary
├── runner.ts              # bench 共通実行基盤 (case → outcome → summary)
├── report.ts              # 結果の表形式出力 + JSON 永続化
├── load-private.ts        # fixtures-private/ から動的 import (存在しなければ無視)
├── cli.ts                 # `pnpm bench` から呼ばれる entry
├── fixtures/              # 公開 fixture (commit OK)
│   ├── audn.synthetic.ts
│   ├── promote.synthetic.ts
│   ├── search.synthetic.ts
│   ├── contradiction.synthetic.ts
│   └── time-update.synthetic.ts
├── fixtures-private/      # yui 由来 fixture (.gitignore で除外、ローカルのみ)
│   └── *.ts               # seed-from-yui.ts が出力
├── runners/               # 各ジョブのベンチ
│   ├── audn.bench.ts
│   ├── promote.bench.ts
│   ├── search.bench.ts
│   ├── contradiction.bench.ts
│   └── time-update.bench.ts
├── seed-from-yui.ts       # yui DB → fixtures-private/ 抽出スクリプト
└── results/               # 過去ベンチ結果 JSON (.gitignore)
```

## 実行

```bash
# 全ベンチ
mise run -C apps/server bench

# 個別
mise run -C apps/server bench-audn
mise run -C apps/server bench-promote
mise run -C apps/server bench-search
mise run -C apps/server bench-contradiction
mise run -C apps/server bench-time-update

# yui DB からの fixture 抽出（初回 / 定期更新）
YUI_DATABASE_URL=postgresql://postgres:***@... mise run -C apps/server eval-seed
```

## 評価指標

| ベンチ        | 主要メトリクス                                                         |
| ------------- | ---------------------------------------------------------------------- |
| AUDN          | confusion matrix, per-class F1 (ADD/UPDATE/DELETE/NOOP)                |
| promote       | precision, recall (skip vs keep), 誤判定リスト                         |
| search        | top-k recall, MRR                                                      |
| contradiction | precision, recall, 見逃しリスト                                        |
| time-update   | narrative cosine similarity (BGE-M3 self-eval)                         |
| resilience    | vitest pass/fail (mock fetch で 5xx/429/empty/content_filter 等を再現) |

## fixture 追加方針

- **公開 fixture (`fixtures/`)**: tsumugi の機能境界を網羅する合成例。OSS ユーザーが触れる例。
- **private fixture (`fixtures-private/`)**: yui の実運用ログ。**コミット禁止**。本番品質測定の正。

新ケースを追加するときは、まず「期待値（正解ラベル）」が一意に決まるか確認する。曖昧な場合は `tags: ["ambiguous"]` を付けて評価から除外、または別バケットで集計する。
