# Tsumugi 評価ベンチ ハンドオフ文書

最終更新: 2026-06-14 / 引き継ぎ前進捗: 3/6 bench 稼働 + 共通基盤完成

## 1. 何の作業か

tsumugi の dreaming pipeline 各ジョブ (AUDN / promote / search / contradiction / time-update) と LLM resilience の品質を、合成 fixture + yui 由来 private fixture の双方で測定するためのベンチ基盤を構築している。

「実運用前に既知の型のエッジケースをすべて潰す」のが目的。

設計判断・利用想定は `eval/README.md` を参照。

## 2. 進捗マトリクス

| 項目                                                    | 状態                                       | 場所                                                                  |
| ------------------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------- |
| 共通基盤 (types / runner / report / cli / load-private) | ✅ 完成                                    | `eval/{types,runner,report,cli,load-private}.ts`                      |
| AUDN bench (fixture + runner + 純粋関数抽出)            | ✅ 完成 (87% pass, decisionAccuracy 0.905) | `eval/fixtures/audn.synthetic.ts`, `eval/runners/audn.bench.ts`       |
| Promote bench                                           | ✅ 完成 (100% on non-ambiguous)            | `eval/fixtures/promote.synthetic.ts`, `eval/runners/promote.bench.ts` |
| Search bench (seed + query)                             | ✅ 完成 (Recall@1: 0.875 / MRR: 0.931)     | `eval/fixtures/search.synthetic.ts`, `eval/runners/search.bench.ts`   |
| Contradiction bench: fixture                            | ✅ 完成                                    | `eval/fixtures/contradiction.synthetic.ts`                            |
| Contradiction bench: pure 関数 `detectPairsOnly`        | ✅ 完成                                    | `src/core/dreaming/decision-contradiction.ts`                         |
| Contradiction bench: runner                             | ⬜ **未完**                                | `eval/runners/contradiction.bench.ts` を作る                          |
| Time-update bench: fixture                              | ⬜ **未完**                                | `eval/fixtures/time-update.synthetic.ts` を作る                       |
| Time-update bench: pure 関数抽出                        | ⬜ **未完**                                | `src/core/dreaming/time-update.ts` を refactor                        |
| Time-update bench: runner                               | ⬜ **未完**                                | `eval/runners/time-update.bench.ts` を作る                            |
| Provider resilience の vitest mock test                 | ⬜ **未完**                                | `apps/server/tests/resilience/*.test.ts` を作る (vitest 導入も)       |
| yui DB → fixture 抽出スクリプト                         | ⬜ **未完**                                | `eval/seed-from-yui.ts` を作る                                        |
| 全 bench を CLI に登録 + commit                         | ⬜ **未完**                                | `eval/cli.ts` の REGISTRY 更新、package.json/mise.toml 追加           |

## 3. 確立されたパターン

### 3.1 bench 共通フレームワーク

`runBench()` (`eval/runner.ts`) が骨格。各 bench は次の形:

```ts
import { runBench } from "../runner.js";
import { loadPrivateFixtures } from "../load-private.js";
import { fixtures as syntheticFixtures, ... } from "../fixtures/<name>.synthetic.js";

export async function run<Name>Bench() {
  const privateFixtures = await loadPrivateFixtures<TInput, TExpected>("<name>.private.ts");
  const fixtures = [...syntheticFixtures, ...privateFixtures];
  return runBench<TInput, TExpected, TActual>({
    name: "<name>",
    fixtures,
    concurrency: N,         // LLM 並列度 (DB 副作用なし → 4-6 OK / DB 書き込みあり → 1-2)
    timeoutMs: 60_000,
    run: async (fx) => {    // 1 ケース実行
      const result = await <pure judgement function>(fx.input);
      return { passed: <expected との照合>, actual: <記録用> };
    },
    computeMetrics: (outcomes, allFixtures) => {
      // precision/recall/F1/MRR/recall@k 等を集計
      return { metrics: { ... }, detail: "<confusion matrix 等の追加文字列>" };
    },
  });
}
```

### 3.2 fixture 形式

YAML/JSON ではなく **typed TypeScript** を採用 (依存最小・型安全)。

```ts
import type { FixtureCase } from "../types.js";

export interface <Name>Input { ... }
export interface <Name>Expected { ... }

export const fixtures: FixtureCase<<Name>Input, <Name>Expected>[] = [
  {
    id: "<bench>-<class>-<n>-<lang>-<short-desc>",  // 命名規則
    description: "human readable summary",
    input: { ... },
    expected: { ... },
    tags: ["ambiguous"],  // optional — 集計から除外する印
  },
  ...
];
```

`tags: ["ambiguous"]` を付けると metrics 計算から除外される。境界例に使う。

### 3.3 純粋関数の抽出 (重要)

DB 副作用ありの本番関数 (例: `audnJudge` が `memoryRepo.insert`/`linkRepo.insert` を呼ぶ) はそのまま bench から呼べない。**pure な判定関数**を切り出して bench と本番の両方から呼ぶ:

- AUDN: `audn.ts` に `judgeOnly()` を追加、`audnJudge()` 内部からも `judgeOnly()` を呼ぶように書き換え済み
- Contradiction: `decision-contradiction.ts` に `detectPairsOnly()` を追加済み (`detectDecisionContradictions()` の refactor はあえてしていないので必要なら追加)

**Time-update も同じ手順で `time-update.ts` を refactor すること** (詳細は §4.2)。

### 3.4 private fixture のロード

`eval/fixtures-private/<name>.private.ts` (gitignore 済) があれば動的 import される。なければ無視。

形式は synthetic fixture と同じ。`export const fixtures: FixtureCase<...>[]` のみ。

### 3.5 DB seed/teardown (search bench で確立)

DB 状態に依存する bench は: 起動時に seed → 実行 → finally で wipe。

ID prefix で区別 (例: `mem_evalseed_`)。実 memory には触らない。

```ts
const SEED_ID_PREFIX = "mem_evalseed_";
async function wipeSeedMemories() {
  const r = await db
    .delete(memories)
    .where(like(memories.id, `${SEED_ID_PREFIX}%`));
  return r.rowCount ?? 0;
}
```

### 3.6 env 読み込み

tsx は自動で `.env` を load しない。`--env-file=../../.env` を明示する。package.json で済ませてある:

```json
"bench": "tsx --env-file=../../.env eval/cli.ts",
"bench:<name>": "tsx --env-file=../../.env eval/cli.ts <name>",
```

新規 bench を追加するときは `package.json` script + `mise.toml` task を同じパターンで追加。

### 3.7 CLI 登録

`eval/cli.ts` の `REGISTRY` に追加。引数なしで全 bench、引数で名前指定して個別実行。

```ts
const REGISTRY: Record<string, () => Promise<BenchSummary>> = {
  audn: runAudnBench,
  promote: runPromoteBench,
  search: runSearchBench,
  // ← ここに contradiction / time-update を追加
};
```

## 4. 残作業の詳細

### 4.1 Contradiction bench runner

**fixture と pure 関数は完成済み**。残るのは runner だけ。

- 入力 fixture: `eval/fixtures/contradiction.synthetic.ts`
  - `ContradictionInput = { decisions: { isoDate: string, content: string }[] }`
  - `ContradictionExpected = { pairs: { supersededIndex: number, newIndex: number }[] }`
- 呼ぶ関数: `detectPairsOnly(decisions: DecisionForDetection[])` from `src/core/dreaming/decision-contradiction.ts`
  - 戻り値: `DetectedPair[]` (= `{ supersededIndex, newIndex, reasoning }[]`)

**runner 設計指針**:

- 期待 pair vs 検出 pair を `(supersededIndex, newIndex)` のタプルで Set 化して比較
- precision = |TP| / |detected|, recall = |TP| / |expected|, F1
- 順序非依存。`reasoning` は照合に使わない (人手レビュー用に出力に残す)
- ペアが多い時の「部分的に合ってる」を別メトリクスにしてもいい (jaccard similarity)
- concurrency: LLM 呼び出しだけなので 4 OK
- `cli.ts` の REGISTRY に `contradiction: runContradictionBench` を追加
- `package.json` に `"bench:contradiction": "tsx --env-file=../../.env eval/cli.ts contradiction"`
- `mise.toml` に `[tasks.bench-contradiction]` 追加

**verify**: `mise run -C apps/server bench-contradiction` で全 fixture 通過確認。

### 4.2 Time-update bench

`src/core/dreaming/time-update.ts` を読み、何を pure 化できるか判断する。

予想される本番関数:

```ts
export async function timeAwareMemoryUpdate(opts?: { maxMemories?: number }) {
  // 1. memoryRepo.listLlmEligible で memory を取得
  // 2. LLM に narrative + 現在時刻を渡して time-aware に narrative を更新
  // 3. memoryRepo.update で書き戻し / 失敗時は recordLlmFailure
}
```

**pure 関数として抽出**: 「narrative + 経過時間 → 更新後 narrative」だけを取り出す。例:

```ts
export interface TimeUpdateInput {
  narrative: string;
  createdAtIso: string;
  nowIso: string;
}
export async function timeUpdateOnly(input: TimeUpdateInput): Promise<string> {
  // LLM call only — no DB
}
```

**fixture 設計案** (10-15 ケース):

- 相対表現が現在時刻基準で再計算される
  - 「昨日 release した」 (作成1日前) → 1ヶ月後 nowIso なら 「先月 release した」
  - 「3 日前」 → 経過時間に応じて書き換え
- 絶対日付は変えない: 「2026-01-15 に決定した」 → そのまま
- 完了済みタスク: 「現在実装中」 → 「過去に実装した」
- 永続的事実: 「DB は PostgreSQL」 → 変更不要 (期待 narrative は ほぼ同一)

**評価指標**:

- 期待 narrative との **BGE-M3 cosine 類似度** で類似度 ≥ 0.85 を pass とする
- pure 関数の戻り値を embed して計算
- `getEmbedder()` は search bench でも使っているので再利用

**runner 設計指針**:

- concurrency 4
- pass 判定は cosine 類似度ベースなのでハードな match ではない (許容範囲を許す)
- metrics: avgCosineSimilarity, pass rate (cosine ≥ 0.85)

### 4.3 Provider resilience の vitest mock test

LLM 呼び出しの resilience (Layer 1+2+3) は実 LLM を使わず unit test で検証する。

**事前準備**:

1. `apps/server/package.json` の devDependencies に追加
   - `vitest@^3.2.0` (latest stable)
2. `apps/server/package.json` の scripts を更新
   - `"test": "vitest run"` (現状 `"echo 'no tests yet'"`)
   - `"test:watch": "vitest"`
3. `apps/server/vitest.config.ts` を作成 (最小設定で OK)
4. `apps/server/mise.toml` の `test` タスクは既存 (`pnpm test`) なのでそのまま

**テストファイル設計** (`apps/server/tests/resilience/`):

#### 4.3.1 `openai-compat.test.ts`

- mock `globalThis.fetch`
- 5xx 連続 → retry → 成功 (`LLM_MAX_RETRIES=3` の動作確認)
- 429 + Retry-After → 待機後成功
- empty content (response.choices[0].message.content === "") → 1 回 retry → 諦め → `TransientLlmError` throw
- `content_filter` finish_reason → 即 `PermanentLlmError` throw
- 4xx (400, 401, 403) → 即 `PermanentLlmError` throw
- network error → retry → 成功

#### 4.3.2 `anthropic.test.ts`

- mock `@anthropic-ai/sdk` の Anthropic class
- APIConnectionError → transient retry
- 5xx APIError → transient retry
- 4xx APIError → permanent (即 throw)
- `stop_reason === "max_tokens"` → permanent
- `stop_reason === "refusal"` → permanent

#### 4.3.3 `singleton-fallback.test.ts`

- Layer 3 fallback の動作確認
- primary 連続失敗 → fallback 発動 → 成功
- primary 成功 → fallback 呼ばれない
- 両方失敗 → 結合エラー throw

**verify**: `pnpm test` (もしくは `mise run -C apps/server test`) で全 pass。

### 4.4 yui DB → fixture 抽出スクリプト

**目的**: yui 本番 DB から実 memory / observation / decision を取り出し、`eval/fixtures-private/*.private.ts` として書き出す (gitignore 済)。

**接続情報**:

- `YUI_DATABASE_URL` 環境変数で接続文字列を受け取る
- 例: `postgresql://postgres:***@100.121.182.103:5432/yui`
- password は `infra-configs` リポジトリの ansible vault `yui_pg_password` から取得 (運用者が手で )

**抽出スコープ** (デフォルト):

- memory: 300 件 (`importance` 降順 + 多様な `kind`)
- observation: 500 件 (直近 1-2 週、`type` 多様)
- decision: 150 件 (`in_progress` 優先)
- links: 500 件 (memory ↔ observation の関係)

**出力ファイル**:

- `eval/fixtures-private/audn.private.ts` — observation → memory への昇格判定の正解
- `eval/fixtures-private/promote.private.ts` — observation の skip/keep の実分布
- `eval/fixtures-private/search.private.ts` — 実 memory を seed、実クエリログを再生
- `eval/fixtures-private/contradiction.private.ts` — 実 decision pair
- `eval/fixtures-private/time-update.private.ts` — 古い memory の narrative + created_at

**注意**:

- yui の schema を直接 import せず、必要なカラムだけ raw SQL で抜く (依存少なくする)
- 抽出した fixture は **コミット禁止**。`.gitignore` で除外済
- 期待ラベルは抽出しただけでは作れない (人手レビュー必須)。**スクリプトは "観察データだけ" を抽出し、期待ラベルは TODO コメントで埋める**
- 人手ラベリング前提なので「最初の 1 周は pass rate が低くて当然」「徐々に正解ラベルを揃えていく」と想定する

**verify**: `YUI_DATABASE_URL=... mise run -C apps/server eval-seed` で `eval/fixtures-private/*.private.ts` 5 ファイルが出力される。

### 4.5 commit (最後)

すべて完成したら **local commit のみ** (push 禁止 — CLAUDE.md グローバル方針)。

**コミット分割案** (Conventional Commits):

```
feat(eval): 共通ベンチ基盤 (types / runner / report / cli / load-private)
feat(eval): AUDN 判定ベンチ (fixture + judgeOnly 抽出 + runner)
feat(eval): promote-skip ベンチ
feat(eval): hybrid search ベンチ (seed + teardown)
feat(eval): decision contradiction ベンチ (detectPairsOnly 抽出 + runner)
feat(eval): time-update ベンチ (timeUpdateOnly 抽出 + cosine similarity 評価)
test(resilience): provider resilience の vitest mock テスト
feat(eval): yui DB → private fixture 抽出スクリプト
docs(eval): ハンドオフ + 利用方法
```

タスクごとに 1 コミットでも、関連を束ねて数コミットでも OK (粒度は判断)。

## 5. 動作確認手順

完成後の全 bench 実行:

```bash
mise run -C apps/server bench
# stdout に各 bench の confusion matrix / metrics / 失敗ケース一覧 + overall サマリ
# eval/results/bench-<ISO>.json に JSON 永続化
```

個別:

```bash
mise run -C apps/server bench-audn
mise run -C apps/server bench-promote
mise run -C apps/server bench-search
mise run -C apps/server bench-contradiction
mise run -C apps/server bench-time-update
mise run -C apps/server test  # vitest
```

yui 由来 fixture を引き込んだ運用評価:

```bash
YUI_DATABASE_URL=postgresql://postgres:***@100.121.182.103:5432/yui mise run -C apps/server eval-seed
# eval/fixtures-private/ に 5 ファイル出力
# 人手で expected ラベルを TODO から実値に埋める
mise run -C apps/server bench  # private 含めて再実行
```

## 6. 制約事項 (CLAUDE.md グローバル方針より)

- **push / PR は禁止**。local commit のみ。`git push` を実行してはいけない。
- 破壊的操作 (drop table, rm -rf, force push 等) は明示確認なしに実行しない。
- 既存コードを壊さない (`mise run check` が通る状態を維持)。
- コミットメッセージは Conventional Commits 形式 (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`)。
- 言語: 説明・コミットメッセージは日本語、コード内コメントは英語可。
- 並列実行可能なツール呼び出しは並列で。直列化しない。

## 7. 既知の Gotcha

| 現象                                         | 対策                                                                           |
| -------------------------------------------- | ------------------------------------------------------------------------------ |
| `DATABASE_URL is required` で起動失敗        | `tsx --env-file=../../.env` を script に入れる                                 |
| bench 実行で観察対象の memory に副作用が出る | pure 関数を切り出して bench から呼ぶ                                           |
| LLM 並列度を上げすぎて rate limit            | concurrency 4-6 が目安、429 出るなら下げる                                     |
| seed 由来 memory が次回 bench に残る         | finally で必ず wipe、ID prefix で識別                                          |
| drizzle migrate が静かに失敗                 | journal `when` が単調増加か確認 (`.claude/skills/drizzle-migrate-safety` 参照) |

## 8. 参考: 各 fixture の現状規模

- audn: 23 ケース (ADD 6 / UPDATE 6 / DELETE 5 / NOOP 4 / ambiguous 2)
- promote: 30 ケース (skip 10 / keep 18 / ambiguous 2)
- search: 25 クエリ + 15 seed memory
- contradiction: 15 ケース (supersede 7 / no-supersede 6 / chained 1 / single 1)

time-update は **追加で 10-15 ケース** を想定 (相対表現 / 絶対日付 / 完了済み / 永続的事実)。
