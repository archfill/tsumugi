# ADR-013: search_memory のデフォルト project_tag filter + provenance surface + mark_memory_outdated MCP

- 日付: 2026-06-17
- ステータス: Proposed
- 影響 ADR: なし (ADR-003 と整合、ADR-011 と独立)

## コンテキスト

`docs/research/2026-06-17-agent-memory-landscape.md` の検討結果として、tsumugi
の改善余地を A-F の 6 項目で整理していた。同日午後の **recall 実証テスト** (research
doc §5.1) で前提が大きく変わり、優先順位を更新した。

### 実証テストの要点

「正しく引けるか」を検証するため、当日 save した 18 件の observation を狙った
3 本のピンポイント query を投げた。

- **第 1 ラウンド (filter なし)**: 3/3 失敗。top hit は **他プロジェクト**
  (yui / Lambda / mastermente 等) の無関係 obs。全 query で score 0.015-0.016
  の RRF baseline 域に張り付き
- **第 2 ラウンド (`filter: {project_tag: "tsumugi"}` 追加)**: **3/3 成功**。
  期待 obs が top hit、top-5 全部が当日 tsumugi obs

→ **問題は cross-project corpus pollution、ranking 本体は正常**。
research doc §5.1 で詳細。

### 含意

| 仮説                                         | 実証結果 |
| -------------------------------------------- | -------- |
| ranking 質に問題 → A (importance decay) 必要 | ❌ 否定  |
| cross-project corpus が tsumugi obs を埋没   | ✅ 確認  |
| MCP デフォルトで filter なしが運用上の急所   | ✅ 確認  |
| filter 適用で recall は実用十分              | ✅ 確認  |

### 優先順位 (research doc §5 と同じ、ここに再掲して保全)

| #   | 項目                                          | 推定コスト | 効果                                   | 本 ADR scope |
| --- | --------------------------------------------- | ---------- | -------------------------------------- | ------------ |
| 1   | **G**: auto project_tag filter                | 1 日       | 特大 (filter のみで recall 失敗解消)   | **✅ 含む**  |
| 2   | **B**: provenance を search_memory に surface | 1-2 日     | 大 (透明性・編集可能性の cornerstone)  | **✅ 含む**  |
| 3   | **C**: `mark_memory_outdated` MCP tool        | 1 日       | 中 (agent が忘却を学習する第一歩)      | **✅ 含む**  |
| 4   | A: importance decay + access boost            | 3-5 日     | 低 (§5.1 で必要性否定、観察ポジション) | ❌ scope 外  |
| 5   | D: Working memory 層検討                      | 大         | 不明 (ADR-014 と関連)                  | ❌ scope 外  |
| 6   | E: UI / 可視化                                | 大         | 大 (採用判断要、別 ADR)                | ❌ scope 外  |
| 7   | F: RL ベース memory CRUD                      | 観察       | -                                      | ❌ scope 外  |

本 ADR の合計工数 ≈ 3-4 日。

## 決定

`search_memory` の MCP / REST 入口に以下 3 つの改善を入れる。

### 1. G: auto project_tag filter (search_memory のデフォルト挙動)

#### 現状の問題

- MCP の `search_memory(query)` 呼出で `filter` が省略された場合、サーバーは
  全プロジェクトの observations / memories を horizontal に検索する
- archfill の corpus は複数プロジェクト混在で数千件オーダー → tsumugi obs が埋没

#### 変更

`search_memory` の解決順序を以下に変える:

```ts
function resolveProjectTagFilter(
  filter: SearchFilter | undefined,
  sessionContext: SessionContext,
): SearchFilter {
  // 1. 明示指定があれば最優先
  if (filter?.project_tag !== undefined) return filter;

  // 2. session_id から project_tag を解決 (save_observation 時に保存された値)
  const tag = sessionContext.project_tag;
  if (tag) return { ...filter, project_tag: tag };

  // 3. session に紐付かない呼出は filter なし (現状維持、ただし WARN ログ)
  logger.warn(
    { filter, session: sessionContext },
    "search_memory called without project_tag",
  );
  return filter ?? {};
}
```

明示 `filter: {project_tag: null}` を渡された場合は **project_tag auto-fill の
opt-out** として扱う。これは「project_tag を自動補完しない」という意味であり、
`session_id` / `source` / `type` など同時に指定された他 filter は維持する。

したがって `filter: {project_tag: null, session_id: "..."}` は完全な旧挙動
(全プロジェクト・memory layer 含む horizontal 検索) ではなく、
「project_tag では絞らず、その session の observations を検索する」挙動になる。
完全な horizontal 検索が必要な場合は、agent の通常経路とは別の明示的な
escape hatch (`scope: "all"` 等) として将来設計する。

#### session_id → project_tag 解決

`observations` テーブルに `project_tag` カラムが既に存在 (save_observation 引数)。
同じ session_id の最新 observation から project_tag を引く軽量クエリで解決可能。
キャッシュ層を別途設けるかは実装時判断。

### 2. B: provenance surface + project-aware memory retrieval

#### 現状

`search_memory` レスポンスは `{id, layer, excerpt, score, tags}` のみ。
内部の `links` テーブルに observation → memory の `derived_from` / `supersedes`
等が記録されているが、API レスポンスに含まれない。

また、`memories` テーブルは `source` / `session_id` / `project_tag` カラムを持たない。
そのため Phase 1 の G で `project_tag` auto-fill が入ると、既存の
`hybridSearch` は memory layer を除外する。これは cross-project pollution を
避けるための暫定制約として許容するが、最終形では memory layer も project-aware
に検索できる必要がある。

#### 変更 1: provenance surface

レスポンスに `provenance` フィールドを追加:

```ts
type SearchHit = {
  id: string;
  layer: "observation" | "memory";
  excerpt: string;
  score: number;
  tags: string[];
  provenance: Array<{
    layer: "observation" | "memory";
    id: string;
    relation: "derived_from" | "supersedes" | "related_to";
    created_at: string;
  }>;
};
```

memory レイヤーの hit には derived 元 obs(s) を返す。observation レイヤーの
hit には派生先 memory(s) を返す (link を双方向で walk)。

`created_at` は link 作成時刻ではなく、provenance item として返す
observation / memory entity の `created_at` を表す。現行 `links` schema に
`created_at` は追加しない。

`SearchHit.provenance` は常に返し、provenance が無い hit では `[]` とする。
`include_provenance` のような flag は Phase 2 では導入しない。実装は batch
query で N+1 を避ける。

#### 変更 2: project-aware memory retrieval

`filter.project_tag` が指定または自動補完された場合でも、memory layer を単純に
全除外しない。memory hit の derived 元 observation を `links` 経由で辿り、
derived 元 observation の `project_tag` が filter と一致する memory は検索対象に戻す。

初期実装方針:

- bigm / vector の memory candidate を通常どおり取得
- candidate memory の provenance を `links` で辿る
- derived 元 observation に `project_tag` があれば、filter と一致するものだけを残す
- provenance が無い memory の扱いは conservative に除外する
- memory layer に拡張する filter は `project_tag` のみとする
- `session_id` / `source` / `type` filter は observation-only filter のままとする
- project-aware 判定に使う relation は `derived_from` のみとする
- link direction は既存実装に合わせて `observation -> memory` とし、memory hit では
  incoming links、observation hit では outgoing links を返す
- project-aware memory filter は RRF 前にかけ、response provenance attach は RRF 後
  `limit` trim 後に実行する

これにより Phase 1 の observation recall 改善を維持しつつ、Layer 2 memory も
project 文脈に沿って recall に参加できるようにする。

### 3. C: `mark_memory_outdated` MCP tool 追加

#### 動機

agent が古くなった memory に気付いた時、現状は **何もできない**
(`save_observation` で新しい obs を投げるしか手段がない)。X コミュニティの
「ユーザ編集可能性」要求の文脈で、**agent 自身が記憶を編集する権限**を
最小限の形で導入する。

#### MCP tool spec

```ts
{
  name: "mark_memory_outdated",
  description: "memory を outdated としてマークし、次の dreaming で archive 候補にする",
  parameters: {
    memory_id: { type: "string", required: true },
    reason: { type: "string", required: true, minLength: 10 },
  }
}
```

実装:

- `memories.outdated_at` + `memories.outdated_reason` カラム追加 (migration)
- `mark_memory_outdated` は即 archive せず、active memory に outdated marker だけを付ける
- `time-update` dreaming maintenance pass が outdated marker を archive に反映する
- `decision-contradiction` 連動は decision entity 側の supersede 処理と重なるため、
  Phase 3 では追加しない

agent 視点: 古い情報を見つけたら呼ぶ。**強制 archive ではなく** 「LLM に
要検討フラグを立てる」軽量操作。

## 帰結

### ポジ

- recall の "意識的に呼ばないとデフォルトで壊れている" 状態を解消 (G)
- 透明性・編集可能性のコミュニティ評価軸に直接対応 (B + C)
- ADR-014 (Three-layer 化) と独立に進められる (interface 改善は schema 影響小)
- A (importance decay) を未実装で済ますことで、後続実装の優先度を健全化

### ネガ

- G の "暗黙 default" は API 契約の breaking change ではないが、**旧呼出側の
  挙動が静かに変わる**。バージョンログでアナウンス必要
- B の provenance / project-aware memory retrieval はクエリ追加分のレイテンシ
  (1-2ms 程度の想定、candidate 数に依存)
- C の outdated は dreaming 連動なので、即時の effect は無い (UX 説明要)

### 中立

- A は本 ADR で否定したわけではなく、**現時点で必要性が確認できない** ため
  scope 外。ADR-014 実装後の運用観察で再評価
- D-F は本 ADR と独立、必要時に別 ADR で起案

## 実装フェーズ

| Phase | 内容                                                                  | 工数   |
| ----- | --------------------------------------------------------------------- | ------ |
| 1     | G: auto project_tag filter (MCP `search_memory` + REST handler)       | 1 日   |
| 2     | B: provenance surface + project-aware memory retrieval                | 1-2 日 |
| 3     | C: `mark_memory_outdated` MCP tool + schema migration + dreaming 連動 | 1 日   |
| 4     | smoke / 統合テスト                                                    | 0.5 日 |
| 5     | rubric / docs 更新 (search_memory の正しい呼び方を明文化)             | 0.5 日 |

**合計 ≈ 3-4 日**。実装は別 PR。

2026-06-19 時点で Phase 1-4 は実装済み。Phase 5 の rubric / docs 更新は残作業。

## 関連

- ADR-001 (Two-layer architecture) ← layer 構造の根拠 (ADR-014 で Three-layer 化)
- ADR-003 (thin tool / client LLM delegation) ← search_memory の hot path 性質、本 ADR で LLM 呼出は追加しない
- ADR-011 (hook-llm-placement) ← inject-only 原則、本 ADR とは独立
- ADR-012 (Proposed, milestone-event save nudge) ← 補助手段、本 ADR とは独立
- ADR-014 (Proposed, Three-layer 化) ← 同時並走、本 ADR は ADR-014 と独立に merge 可能
- `docs/research/2026-06-17-agent-memory-landscape.md` §5 / §5.1 ← 本 ADR の起案根拠と recall 実証データ
