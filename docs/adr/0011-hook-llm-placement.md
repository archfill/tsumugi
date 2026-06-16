# ADR-011: Claude Code hook 設計 — 新規 LLM 呼出を発動せず、agent の既存セッションを augment する

- 日付: 2026-06-16
- ステータス: Accepted

## コンテキスト

yui の Claude Code hook (`integrations/claude-code/hooks/`) は 4 種類:

| Hook               | 役割                                                | 生成された obs                                                  |
| ------------------ | --------------------------------------------------- | --------------------------------------------------------------- | ---- |
| `PostToolUse`      | 全 tool 実行を `narrative` で記録                   | `File read:` `Bash:` `File edit:` `Command run:` `apply_patch:` |
| `UserPromptSubmit` | user prompt を `User prompt:` で記録                | `User prompt:`                                                  |
| `Stop`             | session 終端を transcript summary 付きで記録        | `session ended: <uuid>                                          | ...` |
| `SessionStart`     | `/context/for-claude-code` で過去 context を inject | (観測ではなく注入)                                              |

このうち最初の 3 つは tsumugi 移行 (Phase 4) の noise 削除作業
(2026-06-16 実施、累計 2,637 obs 削除 = 元 8,202 の 32%) で
**全パターンが Layer 1 汚染源だと実証された**:

| 汚染源                                 | 削除件数 | 直接原因                                         |
| -------------------------------------- | -------- | ------------------------------------------------ |
| `PostToolUse` の Bash                  | 2,087    | 1 session で大量に投げた                         |
| `PostToolUse` の Read                  | 679      | 同上                                             |
| `PostToolUse` の Edit/Write            | 587      | 同上                                             |
| `Stop` の `session ended: <uuid>` のみ | 150      | narrative が空のまま投げた                       |
| `Stop` の narrative 付き               | 75       | 内容自体は意味あったが議事録的内容で検索価値低い |
| `UserPromptSubmit`                     | 29       | 全 prompt を無条件で投げた                       |

汚染の本質は **「1 session で大量に投げた」** と
**「narrative 空でも投げた」** に加えて、より根本的には
**「hook 側が意図を持たない obs を作った」** にある。

### 他システムの hook 設計

設計判断の参考として mem0 と claude-mem の Claude Code 統合を確認した。

| 観点                    | yui                     | mem0                            | claude-mem                                |
| ----------------------- | ----------------------- | ------------------------------- | ----------------------------------------- |
| Hook 数                 | 4                       | 6                               | 6                                         |
| PostToolUse で obs 投入 | ✅ 全部 (汚染主因)      | ❌ telemetry のみ               | ✅ 全部、ただし SDK が skip 判定          |
| UserPromptSubmit        | obs 投入                | rubric inject + auto search     | session-init のみ                         |
| Stop で要約             | hook 軽量 + backend LLM | server-side LLM (`infer: True`) | client-side SDK で要約                    |
| LLM 呼出の発動          | yui backend が呼ぶ      | mem0 SaaS server が呼ぶ         | hook が SDK 経由で client LLM 呼ぶ        |
| LLM 認証                | yui backend の z.ai     | mem0 SaaS の自前                | Claude subscription OAuth (keychain 読出) |
| 主な政策依存            | yui 自体                | mem0 SaaS                       | **Anthropic 政策**                        |

### Anthropic Agent SDK 認証の不確実性 (2026-06-16 時点)

claude-mem 方式 (SDK + OAuth) を検討したが、Anthropic の公式
ドキュメント (`support.claude.com/en/articles/15036540`) で以下が判明:

- 2026-05-14 アナウンス: 6/15 から Agent SDK / `claude -p` / 3rd party app の
  usage を subscription usage limit から **分離し、別 monthly credit pool に
  移行**する予定だった
- 2026-06-15 update: **施行をポーズ**。「For now, nothing has changed」
  「working to update the plan」と明記
- 現在: 一旦 subscription で動くが、将来再変更が **ほぼ確実**

→ claude-mem 方式 (案 F)、および `claude -p` subprocess 方式 (案 C) は
両方とも **Anthropic の billing 政策に直接依存**しており、
direction-b (Anthropic 政策の影響を最小化する) の精神と相容れない。

### tsumugi 既存方針との関係

ADR-003 (`thin-tool-client-llm-delegation`):

> hot path（`save_observation` / `search_memory`）では LLM を呼ばない。
> 観測の整形・構造化はクライアント LLM（呼び出し元エージェント）の責務とする。
> LLM を呼ぶのは dreaming フェーズ（Layer 2 synthesis）のみ。

tsumugi は本来「クライアントが整形済みを送る」設計。
yui hook のように「raw を投げて server が要約」する流れは
ADR-003 と思想が逆向きで、tsumugi 上でやると確実に Layer 1 が
汚染される。

### LLM 呼出の正確な分類

設計を議論する際、「LLM を呼ぶ / 呼ばない」の二値で分類すると
正確さを欠く。実態は以下の 4 パターンに分かれる。

| パターン                                | 例                             | hook の役割                                                                |
| --------------------------------------- | ------------------------------ | -------------------------------------------------------------------------- |
| 1. **外部 LLM 呼出を発動 (Invoke)**     | yui / mem0 / claude-mem        | hook が独立した LLM call を発動する                                        |
| 2. **agent コンテキスト拡張 (Augment)** | tsumugi 本決定                 | hook が **agent の既存セッションに inject**、agent の LLM が通常処理で消化 |
| 3. **agent 主導の tool call**           | tsumugi MCP `save_observation` | agent 自身が判断して MCP tool を呼ぶ                                       |
| 4. **ローカル LLM**                     | ollama 等                      | 端末プロセスで別 LLM を起動                                                |

tsumugi が選ぶべきは 2 + 3 の組み合わせ。
「LLM 不要」ではなく **「新規 LLM 呼出を発動しない」** が正確な表現。

agent の LLM (Claude Code 自身) は当然 LLM 処理を行うが、
それは subscription 内で **既に支払い済みの計算**である。hook が
独立した LLM call を出すと、別 billing / 認証 / 政策の議論が
そのつど発生する。tsumugi はその新規発動を避ける。

## 決定

### 1. hook は inject-only の 3 本のみ

obs を **作成する hook は全廃**。inject だけを行う 3 本に絞る。
これにより Layer 1 純度を保ちつつ recall を補強する。

| Hook                                                | 採否     | 理由                                                                                                                                         |
| --------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `SessionStart` (`matcher: startup\|clear\|compact`) | **採用** | 過去 memory + rubric を agent に inject。compact 時は加えて「未保存知見を救え」nudge を inject                                               |
| `UserPromptSubmit`                                  | **採用** | resume / error pattern を検出し、`search_memory` 結果を inject。recall 補強の中核 (mem0 方式を採用)                                          |
| `PreToolUse` (`matcher: Read`)                      | **採用** | 開かれたファイルに関連する過去 memory を inject。ファイル単位の context 補強 (mem0 / claude-mem 方式を採用)                                  |
| `PostToolUse`                                       | 廃止     | yui の汚染主因 (削除 3,353 件)。tsumugi は新規 LLM 呼出を発動しないので claude-mem の「SDK skip 判定」も再現できない                         |
| `Stop`                                              | 廃止     | hook 駆動の deterministic 切り抜きは品質が低い (検索価値薄)。yui の `session ended: <uuid>` 汚染パターンと構造的に同じ                       |
| `PreCompact`                                        | 廃止     | mem0 自身が「fallback / noise prone / 90 日 expire」と認めている薄い保存。SessionStart の `compact` matcher と nudge inject で実質代替できる |
| `PreToolUse` (`Write\|Edit\|MultiEdit`)             | 廃止     | tsumugi はファイルベースの設定/状態を持たない (DB のみ) ので block 対象がない                                                                |
| `PreToolUse` (`mcp__tsumugi__*`)                    | 廃止     | MCP schema validation で必須項目を強制可能、hook 補完は過剰                                                                                  |

### 2. SessionStart hook の挙動

```text
[Claude Code session 開始 / /clear / auto-compaction 後]
  matcher: startup | clear | compact
  ↓
session_start.py
  ├─ 識別子確定 (session_id / project_tag = git origin URL or cwd)
  ├─ MCP search_memory({query: project_tag, limit: 10}) 呼出
  │    └─ tsumugi server は hot path で LLM 呼ばない (ADR-003 準拠)
  ├─ 結果を markdown 整形
  │    ├─ ## Memories — 重要度上位
  │    ├─ ## Decisions — Layer 3 (decisions テーブルから別途取得しても可、将来検討)
  │    └─ ## Recent observations — 直近の reflection / decision
  ├─ rubric を末尾に追加 (§3)
  ├─ matcher が "compact" の場合は recall-recovery nudge を追加 inject (§3.1)
  └─ stdout: {hookSpecificOutput: {hookEventName: "SessionStart",
                                   additionalContext: <markdown>}}

新規 LLM 呼出: 発動しない
失敗時: fail-open (exit 0、何も inject しない)
依存: urllib のみ (yui hook と同じ流儀)
```

`matcher: startup|clear|compact` により、Claude Code の `/clear` や
auto-compaction 後にも再 inject される (claude-mem を参考にした挙動)。
mem0 が `PreCompact` で実現していた「context が消える前の救済」は
compact matcher + recall-recovery nudge (§3.1) でカバーする。

### 3. agent への rubric inject (通常時)

SessionStart の `additionalContext` 末尾に以下のような rubric を
inject する。本文は最終実装時に調整する。

```markdown
# tsumugi memory — guidance

上の記憶を踏まえて作業してください。
session 中、以下のタイミングで `save_observation` を呼んでください:

| 状況                           | type       | 例                                                   |
| ------------------------------ | ---------- | ---------------------------------------------------- |
| 原因・仕組みが分かった         | discovery  | "N+1 query が routes.py:42 で発生"                   |
| タスクが完了した               | progress   | "PR #18 マージ完了、本番反映済み"                    |
| 設計判断をした                 | decision   | "OAuth トークン認証は採用しない (ADR-011)"           |
| 詰まった / 解決待ち / 解決した | blocker    | "alembic stamp ズレで crash loop、手動 stamp で復旧" |
| 振り返り                       | reflection | "今日 1946 件の noise obs を削除、汚染率 32%"        |

短い・曖昧・手順だけのものは保存しない。
content は 1-3 文。facts に検索キーワードを残す。
```

#### 3.1 compact 時の追加 inject (recall recovery nudge)

`matcher = compact` で fire したときは、上記 rubric に加えて
以下の nudge を inject する。

```markdown
## ⚠ Context was just compacted

直前のターンで context compaction が走り、session 前半の詳細が
失われた可能性があります。続行する前に:

1. このセッションでまだ思い出せる **未保存の discovery / decision /
   progress** を振り返ってください
2. 救えるものがあれば、続行前に `save_observation` を呼んで残してください
3. 検索したい過去 memory があれば `search_memory` を呼んでください

これは tsumugi では **hook 側で自動保存しない**ため、recall は
agent (あなた) の振り返りに委ねられています。
```

agent が compact 直後に持つ「summarize された残り context」を活用して
未保存知見を救済する trigger。hook 側で deterministic 保存をしない
代わりに、agent に責任を渡す設計。

### 4. UserPromptSubmit hook (resume / error pattern 検出)

mem0 方式を inject-only に縮小した形で採用。obs は **作成しない**。

```text
[user prompt 発火]
  matcher: "*"
  ↓
user_prompt_submit.py
  ├─ prompt の長さ < 20 → skip (相槌・確認は対象外)
  ├─ resume パターン検出 (regex)
  │    "続き|continue|前回|where (did )?(we|I) (leave|left) off|
  │     pick up where|catch me up|where are we"
  │    → search_memory({query: prompt, limit: 5}) → 結果 inject
  ├─ error パターン検出
  │    "Traceback|^fatal: |panic:|(Error:|Exception:|FAIL:){2,}"
  │    → search_memory({query: error_text, limit: 5}) → 結果 inject
  └─ どちらも該当しなければ何も出力しない (exit 0)

obs 作成: なし (inject のみ)
新規 LLM 呼出: 発動しない
依存: urllib のみ
```

「prompt そのものを obs にする」ことは **絶対にやらない**
(yui の `User prompt:` 29 件削除した汚染パターン)。
あくまで「過去 memory 検索結果を agent に追加 inject する」用途。

### 5. PreToolUse(Read) hook (file 関連 memory inject)

mem0 / claude-mem の file-context inject を採用。obs は **作成しない**。

```text
[Read tool 発火直前]
  matcher: "Read"
  ↓
pre_tool_use_read.py
  ├─ tool_input から file_path を抽出
  ├─ file_path が tsumugi のメモリ関連ファイル等の例外なら skip
  ├─ search_memory({query: <file の basename / 主要 path 要素>, limit: 3})
  │   呼出
  ├─ 結果が空 → 何も出力しない
  └─ 結果がある → "## 過去メモ (<file_path>)" として inject

obs 作成: なし (inject のみ)
新規 LLM 呼出: 発動しない
依存: urllib のみ
```

agent が同じファイルを過去にどう扱ったかを参照可能にする。
ファイル単位の recall を補強する。

### 6. agent が rubric を無視した session の扱い

3 つの inject hook を全部入れても、最終的に「**何を save するか**」は
agent の判断。agent が一切呼ばなければ Layer 1 に痕跡は残らない。
これは設計上の **意図**であって不具合ではない。

- 「意識せず最低 1 件残す」ような hook 駆動の保険を入れると、結局
  yui と同じ汚染パターンになる (deterministic 切り抜きの品質では検索価値低)
- inject hook で agent への「材料」を増やすことで、agent が save 判断
  しやすい状況を作る (= recall の構造的補強)
- それでも漏れる場面が常態化したら、別 ADR で
  「mem0 方式の薄い PreCompact 保存 + expiration_date による寿命管理」
  を再判断する

### 7. 採用しない LLM 配置案の整理

将来「新規 LLM 呼出を hook に持たせたい」という議論が再燃した場合の
参照用に、本 ADR 検討時点での選択肢評価を残す。

| 案                                                     | 内容                                      | 現時点の評価                                                                |
| ------------------------------------------------------ | ----------------------------------------- | --------------------------------------------------------------------------- |
| A. Anthropic API key 直叩き                            | hook → `api.anthropic.com` (haiku)        | ❌ 従量課金 (direction-b と矛盾)                                            |
| B. z.ai 直叩き                                         | hook → `api.z.ai` (glm-4.5-air)           | ❌ 端末側に API key 配布が必要                                              |
| C. `claude -p` subprocess                              | Claude Code を headless 起動              | ❌ Anthropic の Agent SDK 政策再変更の影響を直接受ける                      |
| D. ローカル LLM (ollama 等)                            | 端末ローカル model                        | 🟡 認証不要・直接の政策依存なしだが端末品質差・運用負担                     |
| E. tsumugi backend に集約                              | hook → 新 endpoint → backend LLM (z.ai)   | 🟡 server-side LLM (ADR-003 と思想差)、ただし Stop は hot path 外と解釈可能 |
| F. Claude Agent SDK + OAuth keychain (claude-mem 方式) | SDK 経由で subscription OAuth で LLM 呼出 | ❌ Anthropic の Agent SDK billing 政策が pause 状態、将来変更ほぼ確実       |

A / B / C / F は本 ADR では除外。D / E は将来「Augment + agent tool call」
だけでは不足と判明した場合の再検討候補とする。

## 帰結

### ポジ

- 観測作成 hook ゼロ。yui で起きた Layer 1 汚染 (32%) を構造的に発生させない
- inject-only 3 本で recall を構造的に補強 (SessionStart / UserPromptSubmit /
  PreToolUse(Read) + compact 時の recovery nudge)
- ADR-003 と完全整合 (server も hook も新規 LLM call を発動しない)
- Anthropic の billing 政策 (Agent SDK の分離計画) と独立
- 端末側に追加 credentials / バイナリ / モデルが不要
- tsumugi backend の改変が不要
- direction-b (Anthropic 政策影響を最小化) と完全整合

### ネガ

- agent が rubric を無視 / inject を活用しなかった session には Layer 1
  trace が残らない
  - 緩和策: rubric と nudge を継続的に改善する。inject hook 3 本でも
    継続的に漏れるなら別 ADR で「mem0 方式の薄い PreCompact 保存 +
    expiration_date」を再判断
- yui の `PostToolUse` で取れていた「ファイル編集履歴 / コマンド実行履歴」は
  Layer 1 から消える
  - 必要なら git log / shell history / Claude Code transcript で代替
- 全 hook の inject 合計は agent 既存セッションの input token を消費する
  (Augment パターンの代償)
  - 規模感: SessionStart で memory list + rubric ~500 tokens、
    UserPromptSubmit / PreToolUse(Read) は hit したときのみ追加 ~300-500 tokens
  - 100 turn の長いセッションで合計 ~50,000 input tokens 増
    (Sonnet 換算で約 $0.15)
  - これは subscription 内で支払い済みの計算であり、新規 LLM 呼出のような
    別 billing / 認証議論を発生させない
- recall の理論最大値には届かない
  - mem0 / claude-mem は raw を全部投げて LLM で選別するため理論的には
    高 recall
  - tsumugi は precision-first を選択。recall は agent + inject の質に依存
  - 「raw を残してリカバリ可能」vs「最初から純度を守る」のトレードオフで
    後者を選んだ

### 中立

- 「LLM を使わない」ではなく「**新規 LLM 呼出を発動しない**」が
  正確な表現。agent の LLM は当然 inject 内容を処理する
- tsumugi 固有のアイデンティティは「agent の既存 LLM 処理を最大限活用する。
  hook は判断材料の inject に限定する」
- 本 ADR は実装後に **archfill が 1-2 週間運用して評価**する前提。
  recall 不足が常態化したら inject hook の rubric 強化、N メッセージごとの
  save reminder 追加、最終的には薄い PreCompact 保存追加などを別 ADR で
  判断する

## 関連

- ADR-001 (Two-layer architecture) ← Layer 1 純度の根拠
- ADR-003 (thin tool / client LLM delegation) ← Augment + agent tool call の根拠
- ADR-010 (Phase 4 yui 移行) ← hook 切替のタイミング判断
- yui の `integrations/claude-code/hooks/` ← 汚染源の実装、比較対象
- mem0 の `integrations/mem0-plugin/hooks/hooks.json` ← UserPromptSubmit
  rubric / PreToolUse(Read) file context inject / PreCompact fallback の
  参考 (3 つのうち inject-only な前 2 つを採用、PreCompact は方針相違で不採用)
- claude-mem の `plugin/hooks/hooks.json` ← SessionStart の compact matcher と
  OAuth keychain 方式の参考 (前者は採用、後者は Anthropic 政策不確実で不採用)
- 2026-06-16 のデータクリーンアップ (累計 2,637 obs 削除)
  ← yui hook 設計が Layer 1 汚染した実証データ
- Anthropic 公式 (`support.claude.com/en/articles/15036540`)
  ← Agent SDK billing 政策の現状 (pause)
- `apps/server/scripts/yui-migration/extract.ts` ← SECRETS_RE / noise 判定の流用元
