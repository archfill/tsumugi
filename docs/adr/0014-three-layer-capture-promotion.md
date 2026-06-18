# ADR-014: Three-layer 化 — deterministic capture 層追加と dual-path observation 昇格

- 日付: 2026-06-17
- ステータス: Proposed
- 影響 ADR: ADR-001 (Two-layer → Three-layer に拡張), ADR-003 (dreaming 定義の範囲を明文化),
  ADR-011 (§6 のエスケープバルブ発動、inject-only 原則の適用範囲を Layer 2 以上に限定)

## コンテキスト

ADR-011 で hook を inject-only の 3 本 (`SessionStart` / `UserPromptSubmit` /
`PreToolUse(Read)`) に絞り、**何を save するかは agent の判断に委ねる** 設計を採用した。
ADR-011 §6 / ネガ欄では「agent が rubric を無視 / inject を活用しなかった session には
Layer 1 trace が残らない」リスクを既知 trade-off として明示し、「常態化したら別 ADR で
再判断」と escape valve を残していた。

### 観測された failure mode

ADR-012 起案の根拠となった 2026-06-17 session に加えて、archfill 自身が
「**ユーザーが意識しないと記憶されない**」という構造的急所を本日確認した。これは
**普段遣いとして許容できない** ことが明示的に判明したため、ADR-011 の escape valve
を発動する。

### 既存案との比較

| 案                                        | 内容                                                                                                                 | tsumugi 哲学との整合性                                          | "意識不要" 度          |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ---------------------- |
| **本案: Three-layer 化** (Capture 層追加) | 新 Layer 1 (Capture) を hook deterministic capture、Layer 2 (Observation) を agent + 自動昇格の dual-path 入口にする | ✅ Layer 2 純度は precision-first を維持 / Layer 1 は完全に隔離 | ◎ 完全 (hook で全捕捉) |
| ADR-012 nudge 強化                        | save 喚起 nudge を増やす                                                                                             | ✅                                                              | △ (agent が読む前提)   |
| mem0 方式の薄い PreCompact                | hook が直接 obs を作る                                                                                               | ❌ Layer 2 純度が損なわれる                                     | ◎                      |
| 受容 (ADR-011 §6 のまま)                  | 仕様として運用                                                                                                       | ✅                                                              | ✗                      |

本案は **「Layer 2 純度は守りつつ deterministic capture を Layer 1 に隔離する」**
ことで、ADR-011 の哲学を Layer 2 以上に限定する形で守りながら、capture の漏れを
構造的に解消する。

## 決定

### 1. Three-layer architecture 採用

| Layer       | 名前            | source                                                             | curation        | lifetime  | search           |
| ----------- | --------------- | ------------------------------------------------------------------ | --------------- | --------- | ---------------- |
| **Layer 1** | **capture**     | hook (deterministic)                                               | 無し (生のまま) | TTL 30 日 | デフォルト非公開 |
| **Layer 2** | **observation** | (a) agent が save_observation 直接 / (b) Layer 1 から LLM 抽出昇格 | agent or LLM    | 永続      | ✅               |
| **Layer 3** | **memory**      | dreaming (LLM cluster / synthesize / reflection)                   | LLM             | 永続      | ✅               |

- 既存コード上の `observations` テーブルは **Layer 2 (observation)** のまま
- 既存コード上の `memories` テーブルは **Layer 3 (memory)** のまま
- 新規追加: **`captures` テーブル (Layer 1)**

#### 番号の意味

ADR-001 で「Layer 1 = observation, Layer 2 = memory」と定義されていたが、本 ADR で:

- **Layer 1 = capture (新規)**
- **Layer 2 = observation (現 Layer 1)**
- **Layer 3 = memory (現 Layer 2)**

に renumber する。テーブル名 (`observations` / `memories`) は変更しないため、コードベース
への破壊的変更は無い (Layer 番号は docs / コメントの再番号化のみ)。

### 2. Layer 2 の dual-path entry

Layer 2 (observation) には **2 つの入口** を持たせる:

```
        ┌─── (a) agent 直接 save (MCP save_observation)
        │                                       ← precision-first
Layer 2 ┤                                       ← ADR-011 哲学維持
        │
        └─── (b) Layer 1 → Layer 2 自動昇格    ← deterministic safety net
                  via summarize + AUDN          ← "意識不要"
```

両入口を経由した record は `observations` テーブルに同じ schema で保存される
(区別したい場合は `source_layer` カラムで判定可能、§3 参照)。

### 3. `captures` テーブル schema

```sql
CREATE TABLE captures (
  id           TEXT PRIMARY KEY,              -- "cap_<uuid>"
  session_id   TEXT NOT NULL,
  project_tag  TEXT,
  source       TEXT NOT NULL,                  -- 'claude-code' | 'codex' | ...
  hook_event   TEXT NOT NULL,                  -- 'PostToolUse' | 'Stop' | 'UserPromptSubmit'
  tool_name    TEXT,                           -- 'Bash' | 'Read' | 'Edit' | ... (PostToolUse のとき)
  raw_content  TEXT NOT NULL,                  -- hook が受け取った JSON / text 全文
  captured_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '30 days'),
  promoted_to_obs_id  TEXT REFERENCES observations(id),  -- 昇格済みなら obs_id を持つ
  promoted_at  TIMESTAMPTZ,
  skip_reason  TEXT                             -- summarize が skip 判定したときの理由
);

CREATE INDEX idx_captures_session_captured ON captures (session_id, captured_at DESC);
CREATE INDEX idx_captures_expires ON captures (expires_at);
CREATE INDEX idx_captures_unpromoted ON captures (captured_at)
  WHERE promoted_to_obs_id IS NULL AND skip_reason IS NULL;
```

`observations` 側にも `source_layer` カラムを追加して `'agent' | 'capture'` を区別
(default `'agent'`、既存 record も `'agent'` として扱う)。

### 4. hook 構成の変更

ADR-011 の inject-only 3 hook は **Layer 2 以上の制約**として維持。
Layer 1 capture のために以下を追加:

| Hook                          | 追加役割                                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `UserPromptSubmit`            | **新規 (capture 役割)**: user prompt 全文を `captures` に insert (LLM 呼出無し) + 既存の search inject (両立) |
| `Stop`                        | **新規**: session 終了マーカー + agent final response を `captures` に保存 + 昇格 trigger                     |
| `PostToolUse(milestone のみ)` | **新規**: milestone command (gh pr merge / git commit / git push / gh release create) のみ捕捉                |
| `SessionStart`                | (既存維持) memory + rubric inject                                                                             |
| `PreToolUse(Read)`            | (既存維持) file 関連 memory inject                                                                            |

#### capture 範囲 — turn-level + milestone

**conversation turn 単位**で capture し、milestone command のみ PostToolUse で
追加捕捉する。yui (ADR-011 で実証) の **「全 PostToolUse 捕捉」路線は採用しない**。

| 対象                                                                                                       | 採否    | 理由                                                |
| ---------------------------------------------------------------------------------------------------------- | ------- | --------------------------------------------------- |
| UserPromptSubmit (user prompt 全文)                                                                        | ✅ 捕捉 | turn-level の起点、user の意図が出る                |
| Stop (session 終了 + agent final response)                                                                 | ✅ 捕捉 | turn-level の終点、session 区切り                   |
| PostToolUse: `gh pr merge` / `git commit` (amend 除く) / `git push` (force/tag 除く) / `gh release create` | ✅ 捕捉 | discrete milestone、意味ある区切り (ADR-012 同調)   |
| PostToolUse: 上記以外 (Bash / Read / Edit / Write 等)                                                      | ❌ skip | yui で実証された汚染パターン (2,637 件 noise / 32%) |

理由:

- **yui の 32% 汚染**は tool 単位 全捕捉が主因だった (ADR-011 §1)
- **Tencent Hy-Memory** も同じ結論で turn-level capture (`pipeline.everyNConversations`)
- milestone PostToolUse は ADR-012 の trigger pattern と整合
- 通常の tool 実行は **agent 主導 save (primary path) に任せる**

ADR-011 で禁止された「**raw を observation (旧 Layer 1) に投げる**」は `observations`
テーブルに直接 insert することを指していた。本 ADR では新 `captures` テーブルにのみ
insert されるので、ADR-011 の精神 (= observation 純度) は維持される。

### 5. Layer 1 → Layer 2 昇格パイプライン

既存 dreaming パイプラインに新 step を追加:

```
Layer 1 capture
  ↓ stepPromoteCaptures (新規)
  ↓   ├─ captures.listUnpromoted(maxBatch) で未昇格を取得
  ↓   ├─ 各 capture について:
  ↓   │    ├─ summarizeCapture(capture) で 1 obs 相当に変換 (既存 summarize.ts 拡張)
  ↓   │    ├─ skip 判定なら captures.markSkipped(id, reason)
  ↓   │    └─ keep 判定なら:
  ↓   │         ├─ observations.insert({...}, source_layer='capture')
  ↓   │         ├─ captures.markPromoted(id, new_obs_id)
  ↓   │         └─ 既存 summarize → AUDN → memory パイプラインに乗る
Layer 2 observation (新規昇格 + 既存の agent save 両方を含む)
  ↓ 既存 dreaming (synthesize / reflection / time-update / decision-contradiction)
Layer 3 memory
```

#### 昇格 trigger

- **primary**: Stop hook が触ったら即時に runDreaming({job: 'promote-captures'}) を呼ぶ
- **backup**: cron (1 時間ごと) で未昇格 capture を sweep

#### 既存 summarize.ts の流用

`summarize.ts` は ObservationRow を受け取って facts を抽出する設計だが、
**capture も raw content + source + type 相当の情報を持つ**ので、CaptureRow を
ObservationRow 風に wrap する thin adapter を追加すれば既存ロジックを流用できる。

PR #33 で追加した「when/where/why context preservation」の prompt 強化は、capture
昇格にもそのまま効く (むしろ raw capture からの抽出ではこの強化がより重要)。

### 6. retention sweep

cron で 1 時間ごとに `captures` テーブルを sweep:

```sql
DELETE FROM captures
WHERE expires_at < now();
```

昇格済み capture (`promoted_to_obs_id IS NOT NULL`) は **昇格時点で即削除**できる:

```sql
DELETE FROM captures
WHERE promoted_at IS NOT NULL
  AND promoted_at < now() - interval '7 days';  -- 昇格後 7 日で削除 (debug 用に少し残す)
```

### 7. search 連動

- `search_memory` MCP tool は **Layer 2 / Layer 3 のみ** を hit させる (デフォルト)
- Layer 1 を意図的に検索したい場合のために将来 `search_captures(session_id?, query?)` MCP tool を追加検討する (本 ADR の v1 範囲外、ADR-015 候補)

### 8. ADR-003 (thin tool / client LLM delegation) との関係

ADR-003 の核は **「hot path (`save_observation` / `search_memory`) では LLM を呼ばない」**。
本 ADR の追加に対する影響:

- **`captures` insert は LLM 呼出無し** (hook が raw を直接書く) — hot path 維持
- **`stepPromoteCaptures` は LLM 呼出あり** — ただし dreaming フェーズで動くので
  ADR-003 の「LLM を呼ぶのは dreaming フェーズのみ」と整合
- ADR-003 の文面で「dreaming フェーズ (Layer 2 synthesis)」となっている部分は、
  本 ADR で **「dreaming フェーズ (Layer 1 → Layer 2 抽出、Layer 2 → Layer 3 synthesis、
  time-update、decision-contradiction、reflection)」** に拡張する

### 9. ADR-011 との関係

ADR-011 の「inject-only 3 hook」原則は **Layer 2 (observation) 以上の制約**と再解釈:

- ADR-011 が排除した「hook が observation を作る」(汚染主因) は維持して排除
- 本 ADR の PostToolUse / Stop は **Layer 1 (capture) のみに書く**ので、ADR-011 の
  精神 = observation 純度は守られている
- ADR-011 §6 の「inject hook 3 本でも継続的に漏れるなら別 ADR で再判断」が本 ADR
  に該当する

### 10. 本 ADR の scope 外 (品質課題で必要が見えたら別 ADR で再考)

以下は本 ADR では含めない。**教義として永久拒否ではなく**、現時点の品質ニーズと
scope に合致しないため scope 外。将来 capture / recall / continuity の品質課題で
必要性が見えたら、品質貢献度を judging 基準として別 ADR で再評価する
(判断原則の詳細は [`docs/VISION.md`](../VISION.md) 参照)。

- **L3 Persona 層** (user portrait の自動蒸留): tsumugi は現状 journal/event 路線で
  品質充足、Persona の必要性が見えていない
- **L2 Scenario / scene block 層**: 既存の dreaming synthesize が同等役割を果たしている
- **Mermaid task canvas / short-term offload**: session 内 working memory は host
  (Claude Code) に委ねる棲み分け、現状不足を観測していない
- **自動 L1 抽出 trigger** (Tencent 風 `everyNConversations`): 本 ADR の dual-path
  entry (agent 主導 save primary + capture 昇格 secondary) が同等の役割を果たし、
  agent の judgment 余地を残す
- **PreCompact hook** (mem0 風): ADR-011 で否定した hook 駆動 deterministic obs
  作成と同型、本 ADR の capture 昇格で代替する

## 帰結

### ポジ

- 「ユーザーが意識しないと記憶されない」failure mode を構造的に解消
- agent 直接 save (precision-first) と 自動昇格 (deterministic safety net) の dual-path
  で **両方の良いとこ取り**
- Layer 2 純度は守られる (capture は Layer 1 に隔離、LLM 抽出が AUDN を通って初めて
  Layer 2 に上がる)
- 既存パイプライン (`summarize.ts` / `audn.ts`) を流用、新規追加コードは hook + thin
  adapter + sweep cron の最小増分
- PR #33 の dense-context prompt 強化がそのまま capture 昇格に効く
- Codex 側も Claude Code と同じ hook 構成で同じ振る舞いになる (script を duplicate
  する v0.1.3 流儀を継続)

### ネガ

- **DB volume 増**: PostToolUse 全捕捉で `captures` が膨らむ。30 日 TTL でも 1 week
  ヘビーユーザは数 GB オーダーに到達する可能性。本番運用で監視必要
- **hook 失敗時の挙動**: capture 書き込み失敗が agent の通常動作を阻害してはいけない
  (fail-open 必須)
- **migration**: 既存 `observations` テーブルに `source_layer` カラム追加 (default
  `'agent'` で既存影響なし) と `captures` テーブル新設の Alembic migration が必要
- **昇格パイプラインのコスト**: 全 PostToolUse を LLM で判定するため、summarize の
  LLM call が大幅増 (LOW tier だが requests/min は無視できない)
  - 緩和策: capture を batch にまとめて昇格 (e.g., session ごと + tool ごとに集約)
- **PreCompact のような hook event は廃止のまま** (ADR-011 の判断を維持)
- **Layer 1 検索が公式 API として存在しない** (将来 ADR-015 で検討)

### 中立

- ADR-001 / ADR-003 / ADR-011 の amendment が必要。本 ADR が正式採用された時点で
  該当 ADR の Status を `Amended by ADR-014` に変更する
- ADR-012 (milestone-event save nudge) との関係:
  - 本 ADR で deterministic capture が入ると ADR-012 の「save 喚起 nudge」は **必要性
    が低下** する (capture が漏れを拾うため)
  - ただし完全に不要にはならない (capture は raw を残すだけで、agent 視点の決定理由
    は agent しか書けない場面がある)
  - ADR-012 は Proposed のまま「補助手段」として位置づけ直す
- 1-2 week の実運用後に再評価。capture の昇格率 / Layer 2 への昇格品質 / DB volume
  実績を計測してから ADR Status を Accepted に上げる

## 実装フェーズ

| Phase | 内容                                                                                                               | 工数     |
| ----- | ------------------------------------------------------------------------------------------------------------------ | -------- |
| 1     | `captures` テーブル schema + Drizzle migration + `observations.source_layer` 追加                                  | 1 日     |
| 2     | `captureRepo` (insert / listUnpromoted / markPromoted / markSkipped / sweep)                                       | 1 日     |
| 3     | `pre_tool_use_*.py` / `post_tool_use.py` / `stop.py` の Python hook script (Claude Code + Codex 両方、script 同梱) | 2-3 日   |
| 4     | `stepPromoteCaptures` 追加 + thin capture→observation adapter + dreaming runner 拡張                               | 2 日     |
| 5     | retention sweep cron + Stop hook trigger からの即時昇格                                                            | 1 日     |
| 6     | bench / smoke / 実運用観察 (1-2 week)                                                                              | 観察期間 |

**合計 ~1 sprint (実装 1 週間 + 観察 2 週間)**

## 関連

- ADR-001 (Two-layer architecture) ← 本 ADR で Three-layer に拡張、要 amendment
- ADR-003 (thin tool / client LLM delegation) ← dreaming フェーズの定義を本 ADR で拡張、要 amendment
- ADR-011 (hook-llm-placement) ← inject-only 原則の適用範囲を Layer 2 以上に限定、要 amendment、§6 のエスケープバルブを本 ADR が発動
- ADR-012 (Proposed, milestone-event save nudge) ← 本 ADR の deterministic capture と相補関係
- PR #33 (`fix(dreaming): preserve when/where/why context`) ← capture 昇格パイプラインで活きる prompt 強化
- `docs/research/2026-06-17-agent-memory-landscape.md` ← 本 ADR の起案根拠 (Tencent 等の対比、コミュニティトレンド)
