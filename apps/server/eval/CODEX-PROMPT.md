# Codex への引き継ぎプロンプト

Codex (もしくは別セッションの Claude) に貼り付けて作業を継続させるためのプロンプト。

下の `--- PROMPT START ---` から `--- PROMPT END ---` までをそのままコピー&ペースト。

長すぎる場合は途中で区切って渡しても良いが、まずは「ハンドオフ文書を読み切ってから着手」してもらう想定。

---

## 補足 (人間向け)

- 作業ディレクトリ: `/Users/chill-rf/git/tsumugi`
- 必須前提: tsumugi の `.env` が `/Users/chill-rf/git/tsumugi/.env` に存在 (1Password Environment 経由でマウント済)
- 必須前提: `LLM_LOW_API_KEY` / `LLM_MID_API_KEY` / `DATABASE_URL` が `.env` に揃っている
- yui DB 抽出を実行するときだけ追加で `YUI_DATABASE_URL` を指定 (本番 password は `infra-configs` の ansible vault `yui_pg_password`)

Codex は MCP / tool 呼び出しに違いがあるので、bash ツールで直接ファイルを編集・実行する想定で書いている。

---

--- PROMPT START ---

# Tsumugi 評価ベンチ完成タスク (Codex 引き継ぎ)

あなたは tsumugi (`/Users/chill-rf/git/tsumugi`) の評価ベンチ基盤を**完成させる**ための実装者です。

## 最初に必ず読むもの

順番に Read:

1. `/Users/chill-rf/git/tsumugi/CLAUDE.md` — プロジェクト固有ルール
2. `/Users/chill-rf/git/tsumugi/apps/server/eval/HANDOFF.md` — 引き継ぎ文書 (これが**ベース**)
3. `/Users/chill-rf/git/tsumugi/apps/server/eval/README.md` — eval/ の目的と全体構成
4. `/Users/chill-rf/git/tsumugi/apps/server/eval/runners/audn.bench.ts` — 既存 bench の参考実装 (LLM ベース)
5. `/Users/chill-rf/git/tsumugi/apps/server/eval/runners/search.bench.ts` — 既存 bench の参考実装 (DB seed/teardown あり)
6. `/Users/chill-rf/git/tsumugi/apps/server/eval/runner.ts` `types.ts` `report.ts` — 共通基盤

これで HANDOFF.md §3 のパターンが具体例で理解できる。

## ゴール

HANDOFF.md §2 マトリクスの「⬜ 未完」を全部 ✅ にする。具体的には:

1. **Contradiction bench runner** を作る (fixture と pure 関数 `detectPairsOnly` は完成済)
2. **Time-update bench** を作る (pure 関数抽出 + fixture + runner)
3. **Provider resilience の vitest mock test** を作る (vitest 導入 + 3 ファイル)
4. **yui DB → fixture 抽出スクリプト** (`eval/seed-from-yui.ts`) を作る
5. 全 bench を `eval/cli.ts` の REGISTRY、`package.json` の scripts、`mise.toml` の tasks に登録
6. すべて完成したら **local commit のみ** (push は絶対禁止) を Conventional Commits 形式で複数コミットに分けて作成

## 絶対に守る制約

- **push / PR は禁止**。`git push` も `gh pr create` も実行しない。local commit だけ。
- **既存ファイルを壊さない**。各タスク完了ごとに `mise run -C apps/server typecheck` を実行して通過確認すること。
- **言語**: 説明・進捗報告・コミットメッセージは日本語、コード内コメントは英語可。
- **コミット形式**: Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`)。
- **環境**: bench 実行は必ず `--env-file=../../.env` を付けて tsx を起動 (HANDOFF.md §3.6 参照)。
- 並列で動かせるツール呼び出しは 1 メッセージで並列実行する。直列化しない。
- DB を伴う bench は HANDOFF.md §3.5 の seed prefix + finally wipe パターンを守る。実 memory に副作用を残さない。

## タスク別の具体的指針

### Task 1: Contradiction bench runner

- 場所: `apps/server/eval/runners/contradiction.bench.ts` (新規)
- 入力: `eval/fixtures/contradiction.synthetic.ts` の `fixtures` (15 ケース)
- 呼ぶ関数: `src/core/dreaming/decision-contradiction.ts` の `detectPairsOnly(decisions)`
- 評価:
  - 期待 pair vs 検出 pair を `(supersededIndex, newIndex)` のタプル Set で比較
  - precision = |TP| / |detected|, recall = |TP| / |expected|, F1
  - 順序非依存
  - ペア数 0 の fixture (no-supersede) で誤検出が 0 なら true negative としてカウント
- concurrency: 4
- 検証: `mise run -C apps/server bench-contradiction` で動作確認

その後、`cli.ts` の REGISTRY、`package.json` の scripts、`mise.toml` の tasks を追加。

### Task 2: Time-update bench

#### 2-a. pure 関数抽出

`src/core/dreaming/time-update.ts` を Read してから、次の方針で refactor:

- 現在の本番関数 `timeAwareMemoryUpdate(opts)` は DB I/O を含む
- 純粋判定部 (narrative + 経過時間 → 更新後 narrative) を `timeUpdateOnly(input)` として export
- 本番関数も `timeUpdateOnly` 経由に書き換え (AUDN の `judgeOnly` と同じパターン)
- 既存の動作を変えない (smoke test が通れば OK)

#### 2-b. fixture

- 場所: `eval/fixtures/time-update.synthetic.ts` (新規)
- 10-15 ケース、以下のバリエーション:
  - 相対表現: 「昨日」「3 日前」「先週」 → nowIso 基準で再計算
  - 絶対日付: 「2026-01-15」 → そのまま残す
  - 完了済みタスク: 現在形 → 過去形
  - 永続的事実: ほぼ変更不要

#### 2-c. runner

- 場所: `eval/runners/time-update.bench.ts` (新規)
- 評価指標: 期待 narrative との **BGE-M3 cosine 類似度** が 0.85 以上で pass
  - `getEmbedder()` を再利用 (`src/external/embedding/singleton.ts`)
  - search.bench.ts と同じ要領で embed → cosine 計算
- metrics: avgCosineSimilarity, pass rate
- concurrency: 4

### Task 3: Provider resilience の vitest mock test

#### 3-a. 依存追加

`apps/server/package.json` の devDependencies に:

```json
"vitest": "^3.2.0",
"@vitest/coverage-v8": "^3.2.0"
```

(latest stable を選ぶ — Web で確認しても良い。3.2 系で動けば OK)

#### 3-b. 設定

- `apps/server/vitest.config.ts` (最小設定: include `tests/**/*.test.ts`、environment `node`)
- `apps/server/package.json` の `"test"` script を `"vitest run"` に変更
- `"test:watch": "vitest"` も追加

#### 3-c. テスト 3 本

詳細は HANDOFF.md §4.3。要点だけ抜粋:

- `apps/server/tests/resilience/openai-compat.test.ts` — fetch を mock、5xx retry / 429 / empty content / content_filter / 4xx / network error
- `apps/server/tests/resilience/anthropic.test.ts` — Anthropic SDK を mock、APIConnectionError / 5xx / 4xx / max_tokens / refusal
- `apps/server/tests/resilience/singleton-fallback.test.ts` — Layer 3 fallback 動作確認

検証: `pnpm test` または `mise run -C apps/server test` で全 pass。

### Task 4: yui DB → fixture 抽出スクリプト

- 場所: `apps/server/eval/seed-from-yui.ts` (新規)
- 環境変数 `YUI_DATABASE_URL` から接続
- raw SQL (`pg.Pool` 直叩き、drizzle 不要) で次を抽出:
  - memory: 300 件 (importance DESC、kind バリエーション)
  - observation: 500 件 (直近 1-2 週、type バリエーション)
  - decision: 150 件 (in_progress 優先)
  - links: 500 件
- 出力ファイル (gitignore 済 — コミットされない):
  - `eval/fixtures-private/audn.private.ts` — observation を `AudnInput` 形式で書き出し
  - `eval/fixtures-private/promote.private.ts` — observation を `PromoteInput` 形式
  - `eval/fixtures-private/search.private.ts` — memory を seed + 観察ログをクエリ化
  - `eval/fixtures-private/contradiction.private.ts` — decision を `ContradictionInput` 形式
  - `eval/fixtures-private/time-update.private.ts` — memory + created_at
- 期待 (`expected:`) は **TODO コメントで埋めて出力** ("// TODO: label by human") — Codex は推測しない
- `package.json` の `"eval:seed"` script は既に作成済 (`tsx --env-file=../../.env eval/seed-from-yui.ts`)
- 動作確認: 接続できる環境で `YUI_DATABASE_URL=... mise run -C apps/server eval-seed`

### Task 5: 最終登録 + commit

- `eval/cli.ts` の REGISTRY に `contradiction` `time-update` を登録
- `package.json` の scripts に `bench:contradiction` `bench:time-update` を追加
- `mise.toml` の tasks に `bench-contradiction` `bench-time-update` を追加
- 全 bench を回して全 pass (もしくは妥当な失敗) を確認
- `mise run -C apps/server typecheck` 通過
- HANDOFF.md §4.5 のコミット分割案で local commit (push 禁止)

## 完了の定義

以下が全部 true:

- [ ] `mise run -C apps/server bench` が全 bench 完走 (LLM のばらつきによる失敗は許容、エラー終了は不可)
- [ ] `mise run -C apps/server test` で vitest 全 pass
- [ ] `mise run -C apps/server typecheck` で型エラーなし
- [ ] `eval/seed-from-yui.ts` が `YUI_DATABASE_URL` 不在時にも明示エラーで終わる (silent crash しない)
- [ ] `git status` で未追跡ファイルが残らない (commit 済または gitignore 済)
- [ ] `git log` に Conventional Commits 形式のコミットが追加されている
- [ ] `git status` の branch は **未 push** のまま (origin に変更が反映されていない)

## 進め方

1. まず HANDOFF.md と既存 bench を全部 Read して全体像を掴む。
2. Task 1 → Task 2 → Task 3 → Task 4 → Task 5 の順で進める (依存順)。
3. 各 Task の最後に typecheck と動作確認。失敗したらその場で修正、次の Task に進まない。
4. 詰まったら、HANDOFF.md §7 「既知の Gotcha」を参照。
5. すべて完成して最終 commit が終わるまでターンを終えない (途中報告は OK)。

不明点があれば質問してから着手して構いません。

--- PROMPT END ---
