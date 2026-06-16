# ADR-011: Claude Code hook の役割と LLM 配置方針

- 日付: 2026-06-16
- ステータス: Accepted (Phase 1 = LLM 無しで実装。LLM 追加は将来の別 ADR)

## コンテキスト

yui の Claude Code hook (`integrations/claude-code/hooks/`) は 4 種類:

| Hook               | 役割                                                    | 生成された obs                                                  |
| ------------------ | ------------------------------------------------------- | --------------------------------------------------------------- | ---- |
| `PostToolUse`      | 全 tool 実行を `narrative` で記録                       | `File read:` `Bash:` `File edit:` `Command run:` `apply_patch:` |
| `UserPromptSubmit` | user prompt を `User prompt:` で記録                    | `User prompt:`                                                  |
| `Stop`             | session 終端を transcript summary 付きで記録            | `session ended: <uuid>                                          | ...` |
| `SessionStart`     | `/context/for-claude-code` 経由で過去 context を inject | (観測ではなく注入)                                              |

このうち最初の 3 つは tsumugi 移行 (Phase 4) の noise 削除作業
(2026-06-16 実施、累計 2,637 obs 削除 = 元 8,202 の 32%) で
**全パターンが Layer 1 汚染源だと実証された**:

| 汚染源                                 | 削除件数 | 直接原因                                               |
| -------------------------------------- | -------- | ------------------------------------------------------ |
| `PostToolUse` の Bash                  | 2,087    | 1 session で大量に投げた                               |
| `PostToolUse` の Read                  | 679      | 同上                                                   |
| `PostToolUse` の Edit/Write            | 587      | 同上                                                   |
| `Stop` の `session ended: <uuid>` のみ | 150      | narrative が空のまま投げた                             |
| `Stop` の narrative 付き               | 75       | (内容自体は意味あったが既に存在意義が低い議事録的内容) |
| `UserPromptSubmit`                     | 29       | 全 prompt を無条件で投げた                             |

汚染の本質は **「1 session で大量に投げた」** と
**「narrative 空でも投げた」** の 2 点であり、
narrative の **質** (= LLM 要約の有無) は主因ではない。

### tsumugi 既存方針との関係

ADR-003 (`thin-tool-client-llm-delegation`):

> hot path（`save_observation` / `search_memory`）では LLM を呼ばない。
> 観測の整形・構造化はクライアント LLM（呼び出し元エージェント）の責務とする。
> LLM を呼ぶのは dreaming フェーズ（Layer 2 synthesis）のみ。

tsumugi は本来「クライアントが整形済みを送る」設計。
yui hook のように「raw を投げて server が要約」する流れは
ADR-003 と思想が逆向きで、tsumugi 上でやると確実に Layer 1 が
汚染される。

### 目的の再定義

「意識せず記憶を保存させる導線」を「Layer 1 汚染ゼロ」と両立させたい。
要件を分解すると:

| 要件                         | LLM 必要？                                   |
| ---------------------------- | -------------------------------------------- |
| 1 session = 1 obs (汚染ゼロ) | 不要 (hook の発火ルールで達成)               |
| 「意識せず」保存される       | 不要 (Stop hook の自動発火で達成)            |
| transcript → content         | 代替可 (最後の `assistant.text` を切り抜き)  |
| type 判定 (6 種)             | 推奨だが `reflection` 固定でも実用上問題なし |
| importance 算出              | 不要 (固定値 5 で十分)                       |
| facts 抽出                   | 不要 (tool count 等の機械抽出で代替)         |

LLM は質を上げる「贅沢」だが、要件達成には **必須ではない**。

## 決定

### 1. hook の構成: 4 → 2 に削減

| Hook               | 残す/廃止 | 役割                                                                                                     |
| ------------------ | --------- | -------------------------------------------------------------------------------------------------------- |
| `PostToolUse`      | **廃止**  | 大量投入 = Layer 1 汚染の主因。tsumugi 思想で「節目で agent 自身が `save_observation` を呼ぶ」設計に統一 |
| `UserPromptSubmit` | **廃止**  | 会話アーカイブは tsumugi の責務外                                                                        |
| `Stop`             | 残す      | 1 session = 1 obs を自動保存。narrative 空なら投げない                                                   |
| `SessionStart`     | 残す      | MCP `search_memory` を呼んで過去 memory を `additionalContext` で inject (LLM 不要)                      |

### 2. Stop hook の実装方針: Phase 1 は LLM 無し

```text
[Claude Code session 終了]
  ↓ Stop hook
[transcript JSONL]
  ↓ hook 側で deterministic に slim 抽出
  ├─ 最後の user.text 数件
  ├─ 最後の assistant.text 数件 ← content の素材
  ├─ tool_use の name 集計 ← facts の素材
  └─ user.tool_result / assistant.thinking は捨てる
  ↓ SECRETS_RE で sanitize
  ↓ POST /api/observations
{
  content: <最後の assistant.text を 1000 字以内に切り抜き>,
  type: "reflection",           ← 固定
  source: "claude-code",
  session_id: <session UUID>,
  project_tag: <git origin URL or cwd>,
  facts: ["tools_used: Bash×6 Read×3 ..."],
  importance: 5                  ← 固定
}
```

実装ガード:

- 最後の `assistant.text` が空 → 投げない (yui の 150 件 noise の原因)
- transcript が読めない → 投げない (fail-open)
- POST が失敗しても Claude Code は blocked にしない (fail-open, ADR-003 と同じ)
- SECRETS_RE は `apps/server/scripts/yui-migration/extract.ts` のパターン流用

### 3. SessionStart hook の実装方針: MCP `search_memory` を呼ぶだけ

```text
[Claude Code session 開始]
  ↓ SessionStart hook
[MCP search_memory] {query, project_tag, limit=10}
  ↓ 整形 (markdown)
  ↓ stdout に hookSpecificOutput JSON を吐く
[additionalContext として agent に inject]
```

yui の `/context/for-claude-code` のような専用 backend endpoint は不要。
tsumugi の MCP transport が既に動いており、Python の `mcp` SDK
(or urllib + JSON-RPC 手書き) で接続できる。

LLM 呼出は無い (search 結果をそのまま並べるだけ)。

### 4. LLM の追加は将来の別 ADR で判断

Phase 1 を一定期間 (1-2 週間) 使ってみて、以下の不満が出たら別 ADR を立てて追加判断:

- `content` が「切り抜き」で文脈が伝わらない
- 全部 `reflection` 固定で type による検索区別ができない
- `importance` 固定で重要度ランキングが効かない

その時の選択肢 (現時点で評価済み):

| 案                        | 内容                                                             | 留意点                                                                          |
| ------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| A. anthropic 直叩き       | hook から `api.anthropic.com` に POST、`claude-haiku-4-5` で要約 | ❌ 従量課金キー必須、`direction-b` (Anthropic 従量課金回避) と矛盾              |
| B. z.ai 直叩き            | hook から `api.z.ai` (glm-4.5-air) を呼ぶ                        | ❌ 端末側で別 API key 配布が必要、archfill が回避方針                           |
| C. `claude -p` subprocess | Claude Code を headless で起動して要約させる                     | △ subscription 流用可だが startup ~3-5 秒、入れ子セマンティック                 |
| D. ローカル LLM (ollama)  | ollama / LM Studio                                               | △ 端末依存、複数端末で品質差                                                    |
| E. tsumugi backend に集約 | hook は slim transcript を POST、backend LLM で要約              | △ ADR-003 の "client LLM" 原則と思想が逆向きだが、Stop は hot path 外と解釈可能 |

A / B は除外確定。C / D / E から選ぶ判断を、Phase 1 の運用結果を見てから行う。

## 帰結

### ポジ

- hook 数が 4 → 2、自動投入 obs は **1 session = 1 obs** に集約
- yui で起きた Layer 1 汚染 (32%) を構造的に発生させない
- ADR-003 と矛盾せず (Stop hook 内では LLM 呼ばない、`save_observation` は文字列受け取って embedding するだけ)
- 端末側に追加 API key / subprocess / 別プロセスを必要としない
- `direction-b` (Anthropic 従量課金回避) と完全に独立
- 実装着手可能、判断保留事項なし

### ネガ

- `content` は「最後の assistant.text 切り抜き」のため、要約と比べると
  文脈が薄い (例: 中盤の議論で確定した結論が落ちる)
- `type` が `reflection` 一律になり、検索時の type による絞り込みが効かない
- `importance` 固定で、本当に重要なセッションも 5 のままで順位付けされない
- agent (Claude Code 自身) が能動的に `save_observation` を呼ばない限り、
  「discovery / decision / progress / blocker」型の obs は Layer 1 に入らない
  - 緩和策: Claude Code 側に「節目で `save_observation` を呼べ」と skill / system prompt で指示する別運用

### 中立

- yui の `PostToolUse` で取れていた「ファイル編集履歴」「コマンド実行履歴」は
  Layer 1 から消える。検索したい場合は別 layer (git log / shell history /
  Claude Code transcript) に置く判断要

## 関連

- ADR-003 (thin tool / client LLM delegation) ← 思想の出処
- ADR-010 (Phase 4 yui 移行) ← hook 切替のタイミング判断
- yui の `integrations/claude-code/hooks/` ← 比較対象、汚染源の実装
- 2026-06-16 のデータクリーンアップ (累計 2,637 obs 削除)
  ← yui hook 設計が Layer 1 汚染した実証データ
- `apps/server/scripts/yui-migration/extract.ts` ← SECRETS_RE / noise 判定の流用元
