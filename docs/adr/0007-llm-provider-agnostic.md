# ADR-007: LLM は provider 非依存にする (OpenAI 互換 + Anthropic)

- 日付: 2026-06-14
- ステータス: Accepted (ADR-003 を補強)

## コンテキスト

ADR-003 で「hot path は LLM ゼロ、cold path (dreaming) のみ LLM を呼ぶ」を決めた
時点では、想定 provider を Claude 系に絞っていた (Haiku 4.5 / Sonnet 4.6)。

実運用に入って下記の事情が表面化:

- 利用者が **Z.ai GLM Coding Plan** など subscription 型 LLM を契約しており、
  単独で Anthropic API key を追加するのは二重コスト感がある
- ローカル LLM (Ollama) や DeepSeek / OpenRouter 等の安価な代替に切り替えたい
  ケースもありうる
- tsumugi 自体が特定 provider に縛られると、Phase 5 以降の OSS 化や
  他環境への移植で障害になる

## 決定

LLM 呼び出しを **provider 非依存** にする。

### 実装

`external/llm/` に以下の 2 種類のクライアントを置く:

| provider        | 実装ファイル       | 対象                                                                       |
| --------------- | ------------------ | -------------------------------------------------------------------------- |
| `anthropic`     | `anthropic.ts`     | Claude (`@anthropic-ai/sdk` 経由)                                          |
| `openai-compat` | `openai-compat.ts` | OpenAI 互換 API 全般 (Z.ai / DeepSeek / OpenRouter / Ollama / OpenAI 本家) |

切替は tier 別の env で行う:

```
LLM_LOW_PROVIDER=openai-compat
LLM_LOW_API_KEY=...
LLM_LOW_MODEL=glm-5.2
LLM_LOW_BASE_URL=https://api.z.ai/api/coding/paas/v4
LLM_LOW_THINKING=disabled
```

`singleton.ts` の `getLlm(tier)` が provider に応じて factory を切り替える。

### tier 選定の指針

cold path で要求される質はタスクで違うため、tier ごとに provider/model と
reasoning budget を分けてよい。tier はモデルの強弱だけでなく実行 profile を表すため、
複数 tier が同じモデルを使ってもよい:

- **LOW** (summarize / narrative / 軽い分類): glm-4.5-air, claude-haiku-4-5,
  deepseek-chat 等の軽量モデル
- **MID** (AUDN 判定 / decision 矛盾検出 等の意味判定): glm-4.6, claude-sonnet-4-6,
  deepseek-reasoner 等の reasoning 強めモデル

### 2026-07-14 改訂: GLM Coding Plan profile

GLM Coding Plan では GLM-5.2 に統一し、thinking budget で tier を分ける:

Z.ai 固有の `thinking` / `reasoning_effort` は
`LLM_*_OPENAI_DIALECT=zai` を明示した場合だけ送信する。dialect 未指定または
`generic` の OpenAI 互換 provider には固有 field を送らない。

| tier | model     | thinking   | reasoning effort | timeout      |
| ---- | --------- | ---------- | ---------------- | ------------ |
| LOW  | `glm-5.2` | `disabled` | -                | 30 秒を基準  |
| MID  | `glm-5.2` | `enabled`  | `high`           | 90 秒を基準  |

- GLM 固有の設定は env から `openai-compat` client へ渡し、未指定の provider の
  request body は変えない
- `LLM_<TIER>_TIMEOUT_MS` を `LLM_TIMEOUT_MS` より優先する
- HIGH は実際の call site がないため追加せず、必要になった時点で
  `glm-5.2` + `reasoning_effort=max` を検討する
- 従量課金 API や他 provider では、費用・速度に応じて tier ごとに異なるモデルを
  選ぶ従来方針を維持する

## 代替案と却下理由

**litellm 等の抽象化ライブラリ採用**

- 却下: 依存追加と TS への移植コストが見合わない。OpenAI 互換 API は
  fetch 直叩きで十分カバーできる。

**Anthropic 専用のまま**

- 却下: 利用者にとって追加契約コストが発生し、OSS 化の障害になる。

**provider ごとに別の `LlmClient` を実装する形を維持**

- 採用: ただし大半の provider は OpenAI 互換 API を喋るため、
  `openai-compat` クライアント 1 つでほとんどを賄える。
  Anthropic だけ独自 API なので別途維持する。

## 帰結

- 既存の `@anthropic-ai/sdk` 依存は残るが、必須ではなくなる
- 新規 provider 追加は base URL と model 指定の 2 行で済む
- LLM コスト管理は subscription 型 (GLM Coding Plan 等) との相性が改善
- 同一モデルでも thinking / timeout を tier ごとに設定できる
- tsumugi の OSS 化準備 (provider 中立) が一段進む
