# ADR-014: Three-layer 化 — deterministic capture 層追加と dual-path observation 昇格

- 日付: 2026-06-17
- ステータス: Proposed
- 実装状況: Phase 1-5 改訂実装済み、本番反映後の Phase 6 評価待ち
- 最終更新: 2026-07-14
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

### 本番 baseline evidence (2026-07-13 時点)

改訂設計前の本番 capture を調べた結果、以下を確認した。

- 578 captures / 79 sessions / 12 projects
- Stop capture 58/58 件に `turn_id` と agent final response の両方が含まれていた
- 1 session あたりの Stop は最大 18 件で、Stop は session 終端イベントではなく
  **completed turn の checkpoint** として発火している
- pending capture から 24 completed turns を再構成できた。3 completed turns / 12,000 chars
  の window にまとめると LLM call は 11 回の見込みで、capture 単位の即時処理比で
  **76.6% 削減**と推定される

この evidence は Stop payload の有用性と scheduled window のコスト仮説を支持する
**導入前 baseline / backtest** である。改訂経路の昇格品質、continuity の有用性、retry / quarantine、
DB volume を本番で検証した結果ではなく、それらは Phase 6 に残る。

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
                  via scheduled summarize       ← "意識不要"
```

両入口を経由した record は `observations` テーブルに同じ schema で保存される
(区別したい場合は `source_layer` カラムで判定可能、§3 参照)。

### 3. capture と durable promotion の schema

```sql
CREATE TABLE captures (
  id                    TEXT PRIMARY KEY,       -- "cap_<uuid>"
  session_id            TEXT NOT NULL,
  project_tag           TEXT,
  source                TEXT NOT NULL,
  hook_event            TEXT NOT NULL,
  tool_name             TEXT,
  turn_id               TEXT,
  continuity_content    TEXT,                   -- bounded inject 用 sanitized text
  content_hash          TEXT NOT NULL,
  raw_content           TEXT NOT NULL,
  captured_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at            TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '30 days'),
  promotion_state       TEXT NOT NULL DEFAULT 'ready',
  promotion_window_id   TEXT REFERENCES capture_promotion_windows(id),
  promoted_to_obs_id    TEXT REFERENCES observations(id),
  promoted_at           TIMESTAMPTZ,
  skip_reason           TEXT
);

CREATE UNIQUE INDEX uq_captures_turn_checkpoint
  ON captures (source, session_id, hook_event, turn_id)
  WHERE turn_id IS NOT NULL
    AND hook_event IN ('UserPromptSubmit', 'Stop');

CREATE UNIQUE INDEX uq_captures_turn_content_event
  ON captures (source, session_id, hook_event, turn_id, content_hash)
  WHERE turn_id IS NOT NULL;

CREATE TABLE capture_promotion_windows (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  session_id TEXT NOT NULL,
  project_tag TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  cutoff_at TIMESTAMPTZ NOT NULL,
  capture_count INTEGER NOT NULL,
  raw_chars INTEGER NOT NULL,
  completed_turns INTEGER NOT NULL,
  fallback BOOLEAN NOT NULL,
  input_content TEXT,                          -- terminal / 30日超で消去
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_expires_at TIMESTAMPTZ,
  last_error TEXT,
  observation_id TEXT REFERENCES observations(id)
);

CREATE TABLE capture_observation_links (
  capture_id TEXT NOT NULL,                    -- raw capture TTL 後も provenance ID は保持
  observation_id TEXT NOT NULL REFERENCES observations(id),
  window_id TEXT NOT NULL REFERENCES capture_promotion_windows(id),
  PRIMARY KEY (capture_id, observation_id)
);

CREATE TABLE observation_promotion_facts (
  id TEXT PRIMARY KEY,
  observation_id TEXT NOT NULL REFERENCES observations(id),
  fact_hash TEXT NOT NULL,
  fact TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_expires_at TIMESTAMPTZ,
  last_error TEXT,
  decision TEXT,
  target_memory_id TEXT,
  result_memory_id TEXT,
  reasoning TEXT,
  UNIQUE (observation_id, fact_hash)
);
```

上記は decision に関わる主要列のみを示す。実 schema は timestamps と eligible index も持つ。
`promotion_state` / `status` の値は §5 の durable promotion に従う。

`observations` 側には `source_layer` (`'agent' | 'capture'`) と
`promotion_state` (`'ready' | 'processing' | 'completed' | 'skipped' |
'quarantined' | 'legacy_partial'`) を持たせる。`source_layer` の default は `'agent'` で、既存 record も
`'agent'` として扱う。

### 4. hook 構成の変更

ADR-011 の inject-only 3 hook は **Layer 2 以上の制約**として維持。
Layer 1 capture のために以下を追加:

| Hook                          | 追加役割                                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `UserPromptSubmit`            | **新規 (capture 役割)**: user prompt 全文を `captures` に insert (LLM 呼出無し) + 既存の search inject (両立) |
| `Stop`                        | **新規**: completed turn の checkpoint として `turn_id` + agent final response を `captures` に保存          |
| `PostToolUse(milestone のみ)` | **新規**: milestone command (gh pr merge / git commit / git push / gh release create) のみ捕捉                |
| `PreCompact` / `PostCompact`  | **新規**: Codex 実測に基づき compact 境界の transcript tail / compacted record を `captures` に保存          |
| `SessionStart`                | memory + rubric に加え、未昇格 Stop checkpoint の bounded continuity bridge を inject                         |
| `PreToolUse(Read)`            | (既存維持) file 関連 memory inject                                                                            |

#### capture 範囲 — turn-level + milestone

**conversation turn 単位**で capture し、milestone command のみ PostToolUse で
追加捕捉する。yui (ADR-011 で実証) の **「全 PostToolUse 捕捉」路線は採用しない**。

| 対象                                                                                                       | 採否    | 理由                                                |
| ---------------------------------------------------------------------------------------------------------- | ------- | --------------------------------------------------- |
| UserPromptSubmit (user prompt 全文)                                                                        | ✅ 捕捉 | turn-level の起点、user の意図が出る                |
| Stop (completed turn checkpoint + agent final response)                                                   | ✅ 捕捉 | turn-level の終点。session 終端とはみなさない       |
| PostToolUse: `gh pr merge` / `git commit` (amend 除く) / `git push` (force/tag 除く) / `gh release create` | ✅ 捕捉 | discrete milestone、意味ある区切り (ADR-012 同調)   |
| PreCompact / PostCompact                                                                                   | ✅ 捕捉 | compact 後に追加発話が無い場合の取りこぼし防止       |
| PostToolUse: 上記以外 (Bash / Read / Edit / Write 等)                                                      | ❌ skip | yui で実証された汚染パターン (2,637 件 noise / 32%) |

理由:

- **yui の 32% 汚染**は tool 単位 全捕捉が主因だった (ADR-011 §1)
- **Tencent Hy-Memory** も同じ結論で turn-level capture (`pipeline.everyNConversations`)
- milestone PostToolUse は ADR-012 の trigger pattern と整合
- PreCompact / PostCompact は `observations` に直書きしない。Codex 実測では hook payload
  から `transcript_path` が取れるため、Layer 1 `captures` に compact 境界の raw context
  だけを退避できる。これは ADR-011 で否定した「薄い observation 自動作成」とは別物。
- 通常の tool 実行は **agent 主導 save (primary path) に任せる**
- hook の同期経路では **deterministic capture の insert だけ**を行う。Stop を含む各 hook
  から LLM 昇格を呼ばず、失敗時は fail-open とする
- UserPrompt / Stop は `turn_id` 単位、それ以外は `turn_id + content_hash` 単位で retry 重複を防ぐ

ADR-011 で禁止された「**raw を observation (旧 Layer 1) に投げる**」は `observations`
テーブルに直接 insert することを指していた。本 ADR では新 `captures` テーブルにのみ
insert されるので、ADR-011 の精神 (= observation 純度) は維持される。

### 5. Layer 1 → Layer 2 昇格パイプライン

既存 dreaming パイプラインに scheduled promotion step を追加する。hook の即時経路では
promotion を実行しない。

```
Layer 1 capture (hook は deterministic insert のみ)
  ↓ scheduled stepPromoteCaptures
  ↓   ├─ Stop を含む capture 群を completed turn として再構成
  ↓   ├─ session ごとに最大 3 completed turns / 12,000 chars の window を永続化
  ↓   ├─ window 単位で summarize + skip/keep 判定
  ↓   └─ keep: observation + fact rows + capture links + promotion state を transaction 更新
Layer 2 observation (capture 昇格 + agent 直接 save)
  ↓ scheduled stepPromoteObservations
  ↓   ├─ observation facts を fact-level durable work item にする
  ↓   ├─ 同一 observation の最大 3 facts を 1 call で AUDN 判定
  ↓   └─ memory mutation + provenance link + fact status を transaction 更新
Layer 3 memory
```

#### scheduled capture window

- completed turn は同一 `turn_id` の capture 群に Stop が含まれることで確定する
- window 上限は **3 completed turns / 12,000 chars**。上限を超える前に分割する
- `turn_id` が無い legacy capture は Stop 境界で implicit turn を組み立てる
- Stop が来ない capture は 1 時間経過後に fallback window として扱う
- `promote-captures` の既定 schedule は 30 分ごと (`0,30 * * * *`)
- `promote-observations` はその 5 分後 (`5,35 * * * *`) に実行する
- `sweep-captures` は毎日 02:30 (`30 2 * * *`) に実行し、LLM は呼ばない

#### durable promotion

`capture_promotion_windows` と `observation_promotion_facts` を durable work queue とする。
両段とも `pending / processing / committing / completed / deferred / quarantined` を永続化し、claim lease、
retry、5 回の item 固有失敗時の quarantine、run/failure budget を持つ。`attempt_count` は
lease / fencing、`failure_count` は item 固有失敗と backoff に使い、provider-wide failure は
後者に加算しない。process crash 後も期限切れ lease を再 claim できる。

- capture → observation: window、生成 observation、fact work items、capture↔observation link、
  capture/window 完了状態を transaction で確定する
- observation → memory: **fact ごと**に AUDN を適用し、memory mutation、provenance link、
  fact 完了状態を transaction で確定する。全 fact 完了後に observation を完了扱いにする
- AUDN の judgement だけを同一 observation 内の最大 3 facts で batch 化する。claim、lease、
  retry / quarantine、memory mutation、provenance、完了判定の単位は fact のまま変えない
- batch の schema / item error は claim 済み facts を単件 AUDN で再判定する。同じ memory を
  複数の UPDATE / DELETE が対象にした場合も、同一 snapshot の競合を避けるため単件へ戻す。
  provider-wide failure は全 claim を quarantine 加算なしで defer して run を停止する
- observation promotion は既存のeligible factを先に処理する。retry待ちfactしかない場合も、
  outstanding factが上限100未満なら新規observationをseedする。1 observationをseedした後は、
  そのfact処理へ戻ってから次へ進む
- fact 抽出前の observation 準備失敗は observation 自体に failure count / next attempt / last error を
  永続化し、5 回の item 固有失敗で quarantine する
- capture promotion はdownstream factが上限100以上なら新規windowの作成・claimを行わない。
  factが上限未満でもoutstanding windowが上限20以上なら新規window作成を止める。各上限未満では
  retry待ちitemと独立したwindowを継続し、provider circuit open時はLLM処理前に停止する

これにより、途中失敗後の再実行で同じ範囲を最初から曖昧にやり直すのではなく、未完了の
window / fact から再開できる。

capture と observation の schedule は 5 分ずらすだけでなく、LLM client の入口で同じ
provider endpoint + credential に対する同時実行を 1 に制限する。異なる tier / job が重なっても
provider への並列負荷を増やさず、既存の retry / fallback は admission 後の client 内で維持する。
同じ共有単位には 5〜30 分の circuit breaker を設け、cooldown 後は half-open の単一 probe で
復旧確認する。durable work は circuit preflight 後に claim する。
この admission queue は単一 server process 内の制御であり、複数 replica で運用する場合は
provider 単位の distributed admission を別途追加する。

#### SessionStart continuity bridge

scheduled promotion までの間も continuity を失わないよう、`SessionStart` は同一
`project_tag` の未昇格 Stop checkpoint を取得し、現在 session を除外して bounded inject する。
既定上限は 3 sessions × 3 checkpoints で、inject には sanitized `continuity_content`
(fallback は final response) のみを使い、raw capture 全文は露出しない。これは durable memory
の代替ではなく、Layer 1 から Layer 2 へ昇格するまでの bridge である。
continuity endpoint は hook 用 internal adapter であり、raw capture ではなく sanitized text
のみを返す。既存 REST と同様に private gateway / VPN の内側で公開することを前提とし、
public Internet へ直接公開しない。

#### 既存 summarize.ts の流用

`summarize.ts` は ObservationRow を受け取って facts を抽出する設計だが、
**capture も raw content + source + type 相当の情報を持つ**ので、CaptureRow を
ObservationRow 風に wrap する thin adapter を追加すれば既存ロジックを流用できる。

PR #33 で追加した「when/where/why context preservation」の prompt 強化は、capture
昇格にもそのまま効く (むしろ raw capture からの抽出ではこの強化がより重要)。

### 6. retention sweep

`sweep-captures` job で期限切れの `captures` を sweep する:

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

`capture_promotion_windows.input_content` は completed / skipped / quarantined の terminal state
で消去する。未完了でも capture TTL と同じ 30 日を超えた window は `expired` にして本文を消し、
window metadata と capture↔observation の識別子 provenance だけを残す。
quarantined windowを明示的にrestoreする場合は、retention中の紐付きcaptureから同じwindow本文を
server内で再構成する。windowに記録したcapture件数と全source capture IDをtransaction内で照合し、
一部でもsweep済みまたは紐付け変更済みならrestore不可としてDB状態を変更しない。

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
- **hook-local な同期 L1 抽出** (Tencent 風 `everyNConversations`): backend の scheduled
  window 昇格を採用したため、hook から LLM を直接呼ぶ方式は含めない
- **PreCompact hook から observation 直作成** (mem0 風): ADR-011 で否定した hook 駆動
  deterministic obs 作成と同型。本 ADR では observation 直作成ではなく Layer 1 capture
  に限定する。

## 帰結

### ポジ

- 「ユーザーが意識しないと記憶されない」failure mode を構造的に解消
- agent 直接 save (precision-first) と 自動昇格 (deterministic safety net) の dual-path
  で **両方の良いとこ取り**
- Layer 2 純度は守られる (capture は Layer 1 に隔離し、scheduled summarize の keep 判定後に
  初めて Layer 2 に上げる。抽出 fact は AUDN を通って Layer 3 に昇格する)
- 既存パイプライン (`summarize.ts` / `audn.ts`) を流用しつつ、window / fact-level state で
  crash recovery と provenance を明示できる
- PR #33 の dense-context prompt 強化がそのまま capture 昇格に効く
- Codex 側も Claude Code と同じ hook 構成で同じ振る舞いになる (script を duplicate
  する v0.1.3 流儀を継続)

### ネガ

- **DB volume 増**: 30 日 TTL の capture に加え、window / fact-level の durable state と
  provenance link が増える。本番運用で件数と volume の監視が必要
- **hook 失敗時の挙動**: capture 書き込み失敗が agent の通常動作を阻害してはいけない
  (fail-open 必須)
- **migration**: `captures` / `observations` の列拡張と durable promotion tables / links の
  Drizzle migration が必要。既存 pending は `ready` として durable worker に引き継ぎ、
  AUDN の既存 memory 照合で旧 worker の partial side effect を吸収する
- **昇格パイプラインのコスト**: window summarize と fact-level AUDN の LLM call が増える。
  capture は 3 completed turns / 12,000 chars の window、AUDN は同一 observation の最大
  3 facts の judgement batch で呼出しを抑えるが、実 call 数と品質の両方を Phase 6 で確認する
- **Compact capture の重複リスク**: UserPromptSubmit / Stop capture と同じ発話を含み得る。
  緩和策として transcript 全量ではなく compact 境界の tail / compacted record に限定し、
  Layer 2 への昇格判断は dreaming 側に委ねる。
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

### AUDN batch のローカル gate (2026-07-14)

- synthetic の単件 / batch size 3 比較では、非曖昧 case の decision accuracy と target
  accuracy を維持し、論理 LLM call を 32 → 11 (65.6%減) にした
- private stable-hash sample 10件では単件 / batch とも 8/10 で誤り対象も同一、論理 LLM
  call は 10 → 4 (60%減) だった
- timeout / retry / circuit error は両 batch 評価で 0 件。これはローカル評価であり、
  本番 call 数・latency・fallback 率・昇格品質は Phase 6 の観察対象に残す

| Phase | 内容                                                                                                                    | 状況                                      |
| ----- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| 1     | `captures` + `observations.source_layer` + durable promotion tables / links の schema・migration                         | 実装済み                                  |
| 2     | capture、window、fact-level promotion の repository (state / lease / retry / quarantine / transaction)                  | 実装済み                                  |
| 3     | Claude Code / Codex hook: deterministic capture、Stop turn checkpoint、`turn_id` / continuity payload                    | 実装済み                                  |
| 4     | 3 completed turns / 12,000 chars window による scheduled capture→observation と fact-level observation→memory promotion | 実装済み                                  |
| 5     | SessionStart continuity bridge、scheduler 分離、provider admission / circuit / backpressure、retention sweep job          | 実装済み                                  |
| 6     | bench / smoke / 本番観察 (1-2 week): 昇格率・品質・call 数・retry/quarantine・continuity・DB volume                      | baseline 取得済み、改訂経路の本番評価待ち |

ADR Status は Phase 6 の本番 evidence を確認するまで `Proposed` のままとする。Phase 1-5 の
「実装済み」はコード実装を示し、本番反映済み・品質検証済みを意味しない。

## 関連

- ADR-001 (Two-layer architecture) ← 本 ADR で Three-layer に拡張、要 amendment
- ADR-003 (thin tool / client LLM delegation) ← dreaming フェーズの定義を本 ADR で拡張、要 amendment
- ADR-011 (hook-llm-placement) ← inject-only 原則の適用範囲を Layer 2 以上に限定、要 amendment、§6 のエスケープバルブを本 ADR が発動
- ADR-012 (Proposed, milestone-event save nudge) ← 本 ADR の deterministic capture と相補関係
- PR #33 (`fix(dreaming): preserve when/where/why context`) ← capture 昇格パイプラインで活きる prompt 強化
- `docs/research/2026-06-17-agent-memory-landscape.md` ← 本 ADR の起案根拠 (Tencent 等の対比、コミュニティトレンド)
