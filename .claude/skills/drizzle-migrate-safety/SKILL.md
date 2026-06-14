---
name: drizzle-migrate-safety
description: tsumugi の Drizzle migration 操作 (db:generate / db:migrate) を安全に行う。journal の when 順序ずれ・DB の created_at ミスマッチ・手動 SQL 適用による状態 desync を未然に防ぎ、起きた場合の復旧手順を持つ。trigger 例：「migration を作る」「schema を変更」「drizzle generate / migrate」「db migration が壊れた」「__drizzle_migrations の状態がおかしい」
model: sonnet
allowed-tools: Bash, Read, Edit, Write
---

# drizzle-migrate-safety

tsumugi の Drizzle migration 運用で過去に発生した事故と再発防止策を集約したスキル。

## 過去に起きた事故

### 事故1: drizzle-kit migrate が「applied successfully」と言うが実 SQL を適用しない

**現象**:

- `pnpm db:migrate` が exit 0 で「applied successfully」と表示
- DB schema には変更が反映されていない
- `__drizzle_migrations` テーブルにも新しい行が増えていない

**原因**:

- `meta/_journal.json` の `when` 値が**単調増加でない**
- 古い migration の `when` が新しい migration より大きい場合、drizzle が when ソートで処理順を決めると、「上位 N 件は適用済み」と誤判定して新しいものを skip してしまう
- さらに `__drizzle_migrations.created_at` と journal の `when` がズレているとミスマッチ扱い

**修正**:

1. `meta/_journal.json` の `when` 値を時系列順 (idx 順) に揃える
2. 必要なら `__drizzle_migrations.created_at` も journal の `when` と一致させる

### 事故2: 手動で 0004 を編集して migrate したら no-op になった

**現象**:

- `pnpm db:generate` で生成した migration を SQL 編集後、`pnpm db:migrate` が反映しない

**原因**:

- drizzle が生成した SQL のハッシュと、編集後のハッシュが一致しない可能性
- だが本質的な原因は事故1と同じ (journal when 順序)

**対処**:

- 編集後の SQL を `psql` で手動適用 + `__drizzle_migrations` にハッシュを手動 insert
- ただしこれを連発すると状態が壊れていく

## 推奨フロー (新規 migration を作る時)

```bash
# 1. schema.ts を編集

# 2. 既存 journal の when 最大値を確認 (新規 entry が必ずこれより大きくなることを drizzle が保証する)
cat apps/server/drizzle/meta/_journal.json | grep when | sort -n -t: -k2

# 3. 必要なら DATABASE_URL ダミーで generate
DATABASE_URL=postgresql://x:x@localhost:5432/x \
  pnpm -C apps/server db:generate

# 4. 生成された SQL を確認 (人間が読んで意図通りか)
ls apps/server/drizzle/0*_*.sql | tail -1
cat $(ls apps/server/drizzle/0*_*.sql | tail -1)

# 5. 必要に応じて SQL を編集 (index 追加など、ただし注意点は後述)
#    編集する場合は migration を別ファイルにする方が安全 (0006 を手動編集するより 0007 を新規追加)

# 6. 実機 DB に migrate
DATABASE_URL=postgresql://tsumugi:tsumugi_dev@localhost:5433/tsumugi \
  pnpm -C apps/server db:migrate

# 7. 検証: __drizzle_migrations の最新行と journal の最新 entry が一致するか
docker exec tsumugi-postgres psql -U tsumugi -d tsumugi \
  -c "SELECT id, substring(hash, 1, 24) AS hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id;"
```

## 事前チェック (pre-flight)

migration を生成・適用する前に必ず実行する。

```bash
# A) journal の when が単調増加か
cat apps/server/drizzle/meta/_journal.json \
  | python3 -c "
import json, sys
j = json.load(sys.stdin)
whens = [e['when'] for e in j['entries']]
sorted_whens = sorted(whens)
print('monotonic:', whens == sorted_whens)
if whens != sorted_whens:
    print('MISMATCH at:', [(i, j['entries'][i]['tag'], whens[i]) for i in range(len(whens)) if whens[i] != sorted_whens[i]])
"

# B) journal entries 数と __drizzle_migrations 行数が一致するか
docker exec tsumugi-postgres psql -U tsumugi -d tsumugi -tA \
  -c "SELECT count(*) FROM drizzle.__drizzle_migrations;"
# vs
cat apps/server/drizzle/meta/_journal.json | grep -c '"tag"'

# C) ファイルハッシュと DB ハッシュが対応しているか
for f in apps/server/drizzle/*.sql; do
  shasum -a 256 "$f"
done
docker exec tsumugi-postgres psql -U tsumugi -d tsumugi \
  -c "SELECT id, hash FROM drizzle.__drizzle_migrations ORDER BY id;"
```

A) が false なら事故1 のパターンに入っている可能性。修正してから migrate。

## 状態 desync が起きた時の復旧手順

### ケース1: journal の when が単調増加でない

1. `apps/server/drizzle/meta/_journal.json` を編集して `when` 値を時系列に揃える
2. 必要なら `__drizzle_migrations.created_at` も同じ値に UPDATE
3. `pnpm db:migrate` で確認 (exit 0 + no-op になれば OK)

### ケース2: 手動 SQL 適用済みだが drizzle が知らない (hash 未登録)

```bash
# 当該 migration の hash を計算
HASH=$(shasum -a 256 apps/server/drizzle/0XXX_*.sql | awk '{print $1}')
WHEN=$(cat apps/server/drizzle/meta/_journal.json \
  | python3 -c "import json,sys; e=[x for x in json.load(sys.stdin)['entries'] if x['tag'].startswith('0XXX')][0]; print(e['when'])")

# DB に登録 (created_at = journal の when と一致させる)
docker exec tsumugi-postgres psql -U tsumugi -d tsumugi \
  -c "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('$HASH', $WHEN);"
```

### ケース3: DB のスキーマが migration と乖離 (手動で ALTER した等)

最悪のケース。選択肢:

- **A**: 手動 SQL で乖離を修正 (DB を migration の想定状態に合わせる)
- **B**: 当該 migration を idempotent に書き直す (`IF NOT EXISTS` を入れる) + drizzle に hash 登録

### ケース4: drizzle-kit migrate が SQL エラーで失敗する

ANSI escape の spinner で error 文が見えない時があるので、出力を捕まえる:

```bash
DATABASE_URL=... pnpm -C apps/server db:migrate > /tmp/dm.log 2>&1; echo "exit=$?"; sed 's/\x1b\[[0-9;]*[a-zA-Z]//g' /tmp/dm.log
```

それでも見えない場合は drizzle-kit を直接実行:

```bash
DATABASE_URL=... node apps/server/node_modules/drizzle-kit/bin.cjs migrate 2>&1 | cat
```

## 鉄則

1. **`when` を手動で設定しない**: 必ず `db:generate` が `Date.now()` で振った値を使う
2. **migration SQL を編集するなら新しい migration ファイルを追加する方が安全**
3. **手動 SQL 適用後は必ず `__drizzle_migrations` のハッシュを登録**して `created_at = journal の when`
4. **生成後は必ず事前チェック A-C を実行**してから migrate
5. **migrate が「applied successfully」と言っても DB を必ず確認**する (上記事前チェック B / C)

## tsumugi 固有の状態 (2026-06-14 現在)

- 0001_hybrid_search_indexes は手書き migration (drizzle 生成ではない)
- 0004 / 0005 の when 値を 1781500003000 / 1781500004000 に修正済み
- これ以降の migration は drizzle-kit が現在時刻で生成するため自然に単調増加が保たれる見込み
