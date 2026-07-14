# ADR-008: LLM resilience を 3 層で構築する

- 日付: 2026-06-14
- ステータス: Accepted (2026-07-14 改訂)

## コンテキスト

tsumugi の dreaming worker は cold path で複数の LLM 呼び出しを行う。
実機検証で次の障害が観測された:

- Z.ai GLM 経由の time-update 実行中、15 件中 1 件で `OpenAI-compat response had no content` が発生
  (provider 側の transient な empty response)
- 失敗した 1 件は `dreaming_runs.errors[]` に記録されるが、`promoted_at` 等が更新されないため
  次回 dreaming でも同じ memory が候補となり、同じエラーで失敗するループに入る可能性がある
- provider 単独依存だと、その provider のメンテや障害で tsumugi 全体の cold path が止まる

これらは個人運用スケールでも数日〜数週間で必ず顕在化する性質を持つ。

## 決定

LLM 呼び出しの堅牢化を **3 層構造** で実装する。
各層は責務が異なり、独立に動作する。

### Layer 1: Smart client (provider client 内部)

`external/llm/openai-compat.ts` と `external/llm/anthropic.ts` の内部に
transient/permanent 分類 + exponential backoff retry + per-attempt timeout を実装する。

- 共通ユーティリティを `lib/retry.ts` (`withRetry` / `withTimeout`) に切り出す
- error を `TransientLlmError` と `PermanentLlmError` の 2 クラスに分類
  - **transient** (retry 価値あり): 5xx / 429 / network error / empty content with no finish_reason
  - **permanent** (即諦め): content_filter / 4xx (auth, invalid request) / `max_tokens` / refusal
- backoff は 500ms → 1s → 2s → 4s (max 8s)、±30% jitter
- per-attempt timeout は `AbortController` で実装 (default 30s)
- 設定: `LLM_MAX_RETRIES` / `LLM_TIMEOUT_MS`
- OpenAI 互換 provider は `LLM_LOW_TIMEOUT_MS` / `LLM_MID_TIMEOUT_MS` で
  per-attempt timeout を tier 別に上書きできる。thinking を使う tier の長い応答を
  軽量 tier と同じ timeout に押し込めない

### Layer 2: Failure tracking (DB レコード)

`memories` テーブルに per-item の失敗状態を持たせる。

| 列                    | 役割                              |
| --------------------- | --------------------------------- |
| `llm_failure_count`   | 連続失敗カウンタ (成功で 0 reset) |
| `last_llm_failure_at` | 最終 LLM 操作失敗時刻             |
| `llm_quarantined_at`  | 累積失敗が閾値超え → 永久 skip    |

policy:

- **連続 3 回失敗で 24h cooldown** に入る
- **累積 10 回失敗で quarantine** (永久 skip、手動レビュー対象)
- 成功で counter リセット

`memoryRepo` に 3 メソッド追加:

- `listLlmEligible()` : archive 済み / quarantine 済み / cooldown 中を除外して取得
- `recordLlmFailure(id)` : counter 増分 + 閾値超過なら quarantine
- `resetLlmFailures(id)` : 成功時に counter 0、last_failure_at null

time-update / synthesize を `listLlmEligible` 入口に切り替え、各 catch で
`recordLlmFailure`、成功時に `resetLlmFailures` を呼ぶ。

### Layer 3: Provider fallback (tier 単位)

各 tier に **primary + optional fallback** を持てる構造に拡張する。

- `LlmTierConfig { primary, fallback? }` を `lib/config.ts` に追加
- `singleton.withFallback` でラップ:
  - primary が Layer 1 retry を使い切って throw → fallback で 1 回だけ再試行
  - 両方失敗時は両方の error 情報を結合して `ExternalError` を throw
- fallback API key 未設定なら自動的に fallback 無効
- env 例:
  ```
  LLM_LOW_PROVIDER=openai-compat
  LLM_LOW_FALLBACK_PROVIDER=anthropic
  LLM_LOW_FALLBACK_API_KEY=<anthropic key>
  LLM_LOW_FALLBACK_MODEL=claude-haiku-4-5
  ```

これにより Z.ai がメンテ中でも Anthropic Haiku に逃せる。

### 2026-07-13 改訂: Layer 4 provider circuit と item failure の分離

ADR-014 の durable promotion を本番運用した結果、同一 provider の継続障害中も各 run が
新しい fact を先に生成し、既存 backlog を処理できないまま queue を増やす挙動を確認した。
baseline 時点の 366 facts は complete 4 / pending 357 / deferred 5 で、time-update も
provider failure を含む run が約 458 秒継続していた。

当初 §代替案で見送った circuit breaker を、以下の条件で Layer 4 として採用する。

- provider endpoint + credential を共有単位とし、tier / job をまたいで状態を共有する
- provider client の retry budget 消費後に circuit を open する
- cooldown は 5 分から開始し、再失敗ごとに倍増、最大 30 分とする
- cooldown 後は half-open の単一 probe だけを許可し、成功時に閉じる
- durable item の claim 前に preflight し、open 中は `attempt_count` を消費しない
- provider-wide failure は item の `failure_count` と quarantine 判定に加算しない
- `attempt_count` は lease / fencing、`failure_count` は item 固有失敗と backoff に限定する
- observation の fact 抽出失敗も durable backoff / 5 回 quarantine を持ち、同じ入力を
  scheduler ごとに即再試行しない

promotion は既存 fact queue を先に処理する。provider circuit が open の間は新しいLLM処理を
開始しない。providerが利用可能でretry待ちitemしかない場合は、outstanding factが上限100未満、
outstanding windowが上限20未満なら別observation / capture windowを処理する。各上限は既定workerの
2 run分である。これによりprovider障害中の無制限なqueue増加を防ぎつつ、1件のitem固有backoffによる
head-of-line blockingを避ける。

2026-07-14 のGLM-5.2本番評価では、outstanding fact 1件だけで15 pending windowsと14 ready
capturesが停止した。既定worker能力は50 facts / 30分で、1 observationあたり平均2.44 facts
だったため、zero-backlog gateではなく2 run分のbounded backlogを採用した。またAUDNの
thinking応答が既定2048 tokensへ到達し、JSON末尾の`reasoning`だけ欠落する事例を6件確認した。
AUDNは8192 tokensを明示し、`reasoning`は透明性のため必須のまま維持する。

運用上は retry / circuit event metrics、`dreaming_runs.partial`、queue item の
`attempt_count` / `failure_count` を分けて観測する。

## 代替案と却下理由

**何もしない (現状維持)**

- 却下: 数日〜数週間の運用で必ず実害が出ると確信した
- 1 件の永久失敗 memory がコスト無限ループを発生させるリスクが大きい

**Layer 1 だけにする**

- 却下: provider 障害には無力。retry しても provider が止まっていれば全部失敗
- Layer 2 の failure tracking がないと「再試行で結局成功」のループが防げない

**circuit breaker (連続 N 件失敗で provider 自体を一定時間停止)**

- 当初は個人運用スケールでは効果が薄いとして採用を見送った
- ADR-014 本番評価で durable queue の増加と長時間 run を確認したため、2026-07-13 改訂で採用した

**dead letter queue (永久失敗 item を専用テーブルに移す)**

- 採用見送り: `llm_quarantined_at` フラグで十分。後から SQL で `WHERE llm_quarantined_at IS NOT NULL` で抽出すれば dead letter と等価
- 別テーブルにする運用負担を回避

**cost protection (per-run token budget で graceful stop)**

- 採用見送り: dreaming は手動 trigger が主流で暴走リスクは低い
- Phase 6 で scheduler を本格化したら検討する

**multi-provider fallback chain (primary → fallback A → fallback B)**

- 採用見送り: 1 段の fallback で十分。chain にすると config が複雑化
- 必要になったら primary + fallback のペアを差し替える運用で対応

## 帰結

- LLM コスト無限ループ (永久失敗 item の再試行) を構造的に防止
- provider 障害時の自動的な救済経路を確保
- 失敗の原因 (transient vs permanent) が log で識別可能になり、運用判断が容易
- DB 列の追加 (3 列) と migration 1 本の負担
- 既存コードへの侵襲は最小 (use case 側は `listLlmEligible` の差し替えと catch 内 2 行追加のみ)
- pino logger 導入で構造化ログが取れるようになり、Layer 1 の retry イベントが運用上見える

## 関連

- `lib/retry.ts` / `lib/logger.ts` (新規ユーティリティ)
- `external/llm/openai-compat.ts` / `anthropic.ts` (Layer 1 + 分類)
- `data/repos/memory.ts` (`LLM_FAILURE_POLICY` 定数 + 3 メソッド)
- `data/schema.ts` (`memories` に 3 列追加)
- `apps/server/drizzle/0005_dashing_retro_girl.sql` (Layer 2 migration)
- `lib/config.ts` / `external/llm/singleton.ts` (Layer 3 fallback)
- `.env.example` (Layer 1 / 3 の env 設定例)

ADR-003 (hot path LLM ゼロ) と組み合わせて、cold path 側を堅牢化する形。
