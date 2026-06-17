# ADR-012: save_observation の trigger 不在を milestone-event nudge で補う

- 日付: 2026-06-17
- ステータス: Proposed

## コンテキスト

ADR-011 (`hook-llm-placement`) の決定で hook は inject-only の 3 本
(`SessionStart` / `UserPromptSubmit` / `PreToolUse(Read)`) に絞り、
**何を save するかは agent の判断に委ねる**設計になった。
ADR-011 §6 / ネガ欄では「agent が rubric を無視 / inject を活用しなかった
session には Layer 1 trace が残らない」リスクを既知の trade-off として
受容し、「常態化したら別 ADR で再判断」と明記している。

本 ADR はその「別 ADR」に該当する。

### 観測された failure mode (2026-06-17)

archfill (本 ADR 起案者) と Claude Code agent の協業 session で、
agent は以下の milestone を踏んだにもかかわらず `save_observation` を
**1 度も呼ばなかった**:

- `summarize.ts` + `audn.ts` の prompt 修正 (discovery 級)
- bench:audn / bench:promote 実行と分析 (progress 級)
- PR #33 作成・merge (decision + progress 級)
- synthesize / reflection を保留する判断 (decision 級)

session 終了時の agent 自己分析で以下の構造的要因が判明:

| #   | 要因                             | 説明                                                                                                                                                                                                |
| --- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | メタ認知タスクに trigger がない  | `Edit` / `Bash` 等は「ユーザ依頼」「次の作業に必要」という起動条件を持つが、`save_observation` は「未来のために記録する」メタ作業で、今の作業を進める上で必要ない → cognitive load 下で後回しになる |
| 2   | rubric は 1 度しか届かない       | SessionStart hook で 1 回 inject される rubric を agent が読み流すと、session 中盤以降は強制力が無い                                                                                                |
| 3   | inject hook 群に save 喚起が無い | `UserPromptSubmit` / `PreToolUse(Read)` は search inject 専用。save を促す signal は session 中に存在しない                                                                                         |
| 4   | 集中の tunneling                 | task chain (edit → bench 待ち → 分析 → PR → merge) にロックされ、各 milestone で「これ記録すべきか」判断する余裕が消える                                                                            |

要因 1 は LLM 一般の性質 (メタ認知行動は外圧無しに維持されない) で
agent 規律のみでは恒常的に解決できない。
要因 2-4 は hook 設計で改善可能。

### 既存案との比較

ADR-011 が将来検討対象とした再評価候補と本案を並べる。

| 案                               | 設計                                                                                                                          | inject-only 原則           | Layer 1 純度リスク                   |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ------------------------------------ |
| **本案: milestone-event nudge**  | 特定 Bash command (`gh pr merge` / `git commit` / `git push` / `gh release create`) の **PreToolUse** で save nudge を inject | ✅ 維持 (inject のみ)      | 低 (agent が判断、hook は保存しない) |
| mem0 方式の薄い PreCompact 保存  | PreCompact で hook が自動 save                                                                                                | ❌ 破る (hook が obs 作る) | 中 (yui の汚染パターン再現リスク)    |
| N メッセージごとの save reminder | カウンタベースで rubric 再 inject                                                                                             | ✅ 維持                    | 低                                   |

mem0 方式は ADR-011 が明示的に否定した「hook 駆動の deterministic 切り抜き」
と構造的に同じ。本案と reminder 案は両方とも inject-only を守る。

本案は milestone-event を trigger に選ぶ点で reminder 案より優位:

- **discrete event** = milestone は本質的に「記録すべき瞬間」と一致する
- reminder のような時間ベースは「特に何も起きてない turn」でも noise を出す
- agent が PR merge / push を実行するときに「直前で save を考えろ」と
  injection されるのは設計上自然

## 決定

### 1. PreToolUse(Bash) hook を 1 本追加

ADR-011 で禁止された PostToolUse / Stop の obs 作成原則は維持しつつ、
**milestone command の PreToolUse でだけ save nudge を inject する**
新 hook を追加する。

```text
[Bash tool 発火直前]
  matcher: "Bash"
  ↓
pre_tool_use_bash.py
  ├─ tool_input.command を読む
  ├─ MILESTONE_PATTERNS に該当するか regex 判定
  │    - "gh pr merge"
  │    - "gh release create"
  │    - "git push" (force/tag を除く通常 push)
  │    - "git commit" (amend を除く新規 commit)
  ├─ 該当しなければ何も出力しない (exit 0)
  └─ 該当すれば下記 nudge を inject

obs 作成: なし (inject のみ)
新規 LLM 呼出: 発動しない
依存: urllib のみ (他 hook と同じ流儀)
失敗時: fail-open (exit 0)
```

inject される nudge (素案、最終実装時に調整):

```markdown
## ⚡ Milestone detected — save before proceed

直前で `<command>` を実行しようとしています。これは典型的な milestone です。
続行前に、この session で得た **未保存の discovery / decision / progress**
を `save_observation` で記録してください。記録すべきものが思いつかなければ
何もせず続行して構いません。

判断基準:

- 原因・仕組みが分かった → type=discovery
- 設計判断をした → type=decision
- 完了した → type=progress
- 詰まった / 解決した → type=blocker

この nudge は milestone command の直前にだけ表示されます (session 中の
一般的な作業中には表示されません)。
```

### 2. trigger 対象の patterns

初期は **保守的に 4 種類のみ**:

| Pattern                         | 想定 milestone             |
| ------------------------------- | -------------------------- | --------- | ----------------------------------- |
| `^gh pr merge`                  | PR マージ                  |
| `^gh release create`            | リリース作成               |
| `^git push(?!\s+(?:--force      | -f                         | --tags))` | 通常 push (force / tag push は除外) |
| `^git commit(?!\s+(?:--amend))` | 新規 commit (amend は除外) |

force-push / amend / tag push は「やり直し」や「補助操作」のことが多く、
milestone とは限らないので除外。運用で他の patterns
(例: `kubectl apply` / `terraform apply` / `flyctl deploy`) を
追加するかは本 ADR 範囲外。

### 3. 既存 3 hook との関係

ADR-011 の inject-only 3 hook はそのまま維持。本 hook は **4 本目**として
並列に動作する。役割分担:

| Hook                        | 目的                                                       |
| --------------------------- | ---------------------------------------------------------- |
| SessionStart                | 過去 memory + rubric を inject (recall + save guidance)    |
| UserPromptSubmit            | resume / error 検出時に search 結果 inject (recall)        |
| PreToolUse(Read)            | file 関連 memory inject (recall)                           |
| **PreToolUse(Bash) (新規)** | **milestone command 直前で save nudge inject (save 喚起)** |

PreToolUse(Read) と PreToolUse(Bash) はどちらも Claude Code 上で並列に
登録可能 (matcher が排他なので衝突しない)。

### 4. Codex 統合

Codex 版にも同等の hook を追加する。Codex の hook event 名 / matcher は
Claude Code と同じ (`PreToolUse` / matcher: `Bash`) なので、script は
`integrations/shared/scripts/pre_tool_use_bash.py` に置けば両 platform で
再利用できる… ことを期待したが、ADR-011 改訂後の現状では shared script は
廃止 (各 platform の `scripts/` に同梱) なので、Claude Code 側と Codex 側に
**同じ script を duplicate** する形になる (v0.1.3 と同じ流儀)。

## 帰結

### ポジ

- agent の cognitive tunneling を構造的に補正できる
- inject-only 原則を維持 (Layer 1 純度は保たれる)
- noise になりにくい (milestone は discrete event)
- 既存 3 hook と排他しない (matcher 衝突なし)
- 失敗時 fail-open (他 hook と同じ)

### ネガ

- agent が nudge を読まず即 merge することは依然可能 (強制力なし)
- milestone command が web UI / IDE 経由で実行された場合は trigger しない
  (例: GitHub web で merge した場合)
- PreToolUse(Bash) の matcher は **全 Bash command** に発火するため、
  script の regex 判定が無駄に走る (cost は無視できる程度)
- nudge 頻度が高すぎると無視されるリスク (運用で patterns を絞り込む必要)

### 中立

- 本 ADR は ADR-011 §6 の「常態化したら別 ADR」を発動した形であり、
  ADR-011 の決定を **否定するものではない**
- inject-only を守る限り、本 hook 追加と
  「mem0 方式の薄い PreCompact 保存」採用は両立しない (前者を選ぶ)
- 1-2 週間運用して効果を評価する。nudge が無視され続ける場合は、
  rubric 強化 / patterns 拡張 / より目立つ formatting を検討

## 関連

- ADR-011 (`hook-llm-placement`) ← inject-only 原則の起点、本 ADR の前提
- ADR-003 (`thin-tool-client-llm-delegation`) ← 新規 LLM 呼出を発動しない原則
- `integrations/claude-code/hooks/hooks.json` ← 既存 3 hook の hooks.json
- `integrations/codex/hooks/hooks.json` ← Codex 側 hooks.json
- 2026-06-17 PR #33 (`fix(dreaming): preserve when/where/why context`) の
  作業 session で観測された save_observation 不在の failure mode (本 ADR の起点)
