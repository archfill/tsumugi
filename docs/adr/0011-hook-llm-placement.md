# ADR-011: Claude Code hook の LLM 配置方針

- 日付: 2026-06-16
- ステータス: Draft (TBD あり、実装着手前に LLM 配置を再決定する)

## コンテキスト

yui の Claude Code hook (`integrations/claude-code/hooks/`) は 4 種類:

| Hook               | 役割                                                    | 生成された obs                                                  |
| ------------------ | ------------------------------------------------------- | --------------------------------------------------------------- |
| `PostToolUse`      | 全 tool 実行を `narrative` で記録                       | `File read:` `Bash:` `File edit:` `Command run:` `apply_patch:` |
| `UserPromptSubmit` | user prompt を `User prompt:` で記録                    | `User prompt:`                                                  |
| `Stop`             | session 終端を transcript summary 付きで記録            | `session ended: <uuid> \| ...`                                  |
| `SessionStart`     | `/context/for-claude-code` 経由で過去 context を inject | (観測ではなく注入)                                              |

このうち最初の 3 つは tsumugi 移行 (Phase 4) の noise 削除作業
(2026-06-16 実施、累計 2,637 obs 削除 = 元 8,202 の 32%) で
**全パターンが Layer 1 汚染源だと実証された**:

- yui hook 設計: **「生データを垂れ流し、backend LLM で要約」**
- 結果: backend LLM 失敗時 / フィルタ漏れの noise が Layer 1 に滞留
- 修正コスト: 累計で約半日分の noise filter 設計 + 削除作業

tsumugi では同じ轍を踏まないために、hook の役割を再設計する。

### tsumugi 既存方針との関係

ADR-003 (`thin-tool-client-llm-delegation`):

> hot path（`save_observation` / `search_memory`）では LLM を呼ばない。
> 観測の整形・構造化はクライアント LLM（呼び出し元エージェント）の責務とする。
> LLM を呼ぶのは dreaming フェーズ（Layer 2 synthesis）のみ。

つまり tsumugi は本来「クライアントが整形済みを送る」設計。
yui hook のように「raw を投げて server が要約」する流れは
ADR-003 と思想が逆向きで、tsumugi 上でやると確実に Layer 1 が
汚染される。

### 設計の論点

「意識せず記憶を保存させる導線」を「Layer 1 汚染ゼロ」と両立させたい。
agent (Claude Code 自身) が能動的に `save_observation` を呼ぶのが
本来の tsumugi 思想だが、それだけだと:

- agent が忘れる / 一貫性がない
- 1 セッションで 0 obs になりがち

そこで Stop hook (= session 終了時) で **1 session = 1 obs** の自動
保存導線を残し、その整形に LLM を使うか・どこの LLM を使うかが論点。

## 決定

### 1. hook の構成: 2 本に削減

| Hook               | 残す/廃止 | 役割                                                       |
| ------------------ | --------- | ---------------------------------------------------------- |
| `PostToolUse`      | **廃止**  | LLM なしで raw narrative を吐くと汚染確定                  |
| `UserPromptSubmit` | **廃止**  | 会話アーカイブは tsumugi の責務外                          |
| `Stop`             | 残す      | transcript を要約して **1 obs** に保存                     |
| `SessionStart`     | 残す      | `search_memory` MCP 呼出で過去 memory を inject (LLM 不要) |

### 2. Stop hook の Layer 1 投入は **agent ではなく hook が直接やる**

agent (= Claude Code 自身) に「Stop 時に save_observation を呼べ」と
指示する案もあるが、agent は Stop イベントを観測できないので不可能。
hook で transcript を読んで投げる構造になる。

### 3. transcript の slim 化は hook 側 (LLM 無し)

transcript JSONL (22MB / 12,000 行 / セッション typical) をそのまま
LLM に投げると context overflow + 秘密情報露出リスクがある。
hook 側で deterministic に slim 化してから LLM に渡す:

- `user.text` の最後 N 件 (= 意図)
- `assistant.text` の最後 N 件 (= 結論)
- `assistant.tool_use` の name 集計 (= 何をやったか)
- `user.tool_result` / `assistant.thinking` は **捨てる** (巨大かつ低価値)
- system / attachment / ai-title 等のメタは **捨てる**
- SECRETS_RE で sanitize (`extract.ts` のパターン流用)

これで 22MB → 10-30KB に圧縮。

### 4. transcript → 1 obs の要約 LLM 配置: **TBD**

クライアント側で LLM 要約する方針までは確定しているが、どの LLM を
どう呼ぶかは確定できなかった。候補と却下理由:

| 案                        | 内容                                                             | 状態                                                                                      |
| ------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| A. anthropic API 直叩き   | hook から `api.anthropic.com` に POST、`claude-haiku-4-5` で要約 | ❌ subscription 不可、**従量課金キー必須**。`direction-b` (Anthropic 従量課金回避) と矛盾 |
| B. z.ai 直叩き            | hook から `api.z.ai` (glm-4.5-air) を呼ぶ                        | ❌ archfill が「ローカルで別途 API キーが必要になる方向は避けたい」と判断                 |
| C. `claude -p` subprocess | Claude Code を headless で起動して要約させる                     | △ subscription 流用可だが startup ~3-5 秒、入れ子セマンティック                           |
| D. ローカル LLM (ollama)  | ollama / LM Studio                                               | △ 端末依存、複数端末で品質差                                                              |
| E. tsumugi backend に集約 | hook は slim transcript を POST、backend LLM で要約              | △ ADR-003 の "client LLM" 原則と思想が逆向きだが、Stop は hot path 外と解釈可能           |

**現時点で確定できる方針**:

- A は除外 (Anthropic 従量課金回避と矛盾)
- B も除外 (端末側で追加 API key 配布を避けたい)
- C / D / E のどれかから選ぶが、実装着手前に判断する

### 5. SessionStart hook の LLM: **不要 (確定)**

MCP `search_memory` を呼んで結果を `additionalContext` で inject するだけ。
LLM 呼出は不要。

## 帰結

### ポジ

- hook 数が 4 → 2 に削減され、自動投入 obs は **1 session = 1 obs** に集約
- yui で起きた Layer 1 汚染 (32%) を構造的に発生させない
- ADR-003 の「クライアント整形済みを送る」原則と矛盾せず
  (Stop は厳密には hot path 外なので "クライアント整形" が必須ではないが、
  実装上クライアント側で整形する選択が筋)

### ネガ / TBD

- **要約 LLM 配置が未定** のため実装着手できない
- agent 主導の「節目で save_observation」運用に頼ると、agent が
  忘れたときに 0 obs / session になる可能性
- yui の `PostToolUse` で取れていた「ファイル編集履歴」「コマンド実行
  履歴」は Layer 1 から消える (検索したい場合は別 layer に置く判断要)

### 中立

- `SessionStart` hook は MCP `search_memory` 呼出だけで完結するため
  yui のような専用 backend endpoint (`/context/for-claude-code`) は不要

## 次のアクション

1. C / D / E の比較を別途行い、LLM 配置を確定
2. 確定後にこの ADR を Accepted に更新し、`integrations/claude-code/hooks/`
   実装に着手
3. それまでは Claude Code は yui の旧 hook を使い続ける (移行は
   Phase 4 cutover と同時 or 後でも可)

## 関連

- ADR-003 (thin tool / client LLM delegation) ← 思想の出処
- ADR-010 (Phase 4 yui 移行) ← hook 切替のタイミング判断
- yui の `integrations/claude-code/hooks/` ← 比較対象、汚染源の実装
- 2026-06-16 のデータクリーンアップ (累計 2,637 obs 削除)
  ← yui hook 設計が Layer 1 汚染した実証データ
