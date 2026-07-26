# Search evaluation

`search` bench は、合成 fixture と disposable PostgreSQL を使って hybrid
search の precision / recall を測定する。実行には `DATABASE_URL` が必要で、
seed memoryを作成・削除するため本番DBでは実行しない。

```bash
pnpm bench:search
# または
mise run -C apps/server bench-search
```

任意のprivate fixtureはgitignoredの`eval/fixtures-private/search.private.ts`へ
置く。raw query・narrative・検索結果はcommitやIssueへ出さず、共有するのは
Recall@1/5・MRR・latencyなどの集計値だけとする。server LLM用の評価runnerは
廃止済みで、provider API keyは不要。
