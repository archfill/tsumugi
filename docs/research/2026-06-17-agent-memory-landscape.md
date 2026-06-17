# Agent Memory landscape scan — 2026-06-17

- 種別: research note (ADR ではない、決定ではない)
- 目的: tsumugi の今後の ADR (013 以降) 起案前に、業界トレンドと tsumugi の立ち位置を整理する
- 起点: 2026-06-16 公開の Tencent Hy-Memory (TencentDB Agent Memory) + 同時期に X 上で観測された agent memory コミュニティの議論

## 1. Tencent Hy-Memory / TencentDB Agent Memory

### 概要

「Hy-Memory」は Tencent Hunyuan チームの marketing 名、実体は GitHub の `TencentCloud/TencentDB-Agent-Memory` (MIT, TypeScript / npm)。Hunyuan が PR、TencentCloud が repo。同じものを 2 つの呼び名で出している。

- **対象 host**: OpenClaw プラグイン + Hermes Agent (NousResearch) アダプタ
- **公開**: 2026-05、X (@TencentHunyuan) と公式 blog でアナウンス
- **License**: MIT
- **コミュニティ評価**: hot — 2026-05 〜 06 で agent memory 界隈の中心話題

### アーキテクチャ (実体は 2 本柱)

#### 柱 1: Symbolic short-term memory (=「System 1」相当)

- raw tool output (検索結果 / file 内容 / stack trace) を **`refs/*.md` に offload**
- context に残すのは **Mermaid 記法の task canvas** だけ
- 必要時 `node_id` で grep して raw を pull
- Medium の hands-on 記事 [\"The 20K → 3K moment\"](https://medium.com/@meshuggah22/the-20k-3k-moment-testing-tencents-new-agent-memory-framework-e3f12625a90f)
  が報告する「**20K → 3K**」はこの圧縮 (turn 20 で context の 80% が log で埋まる問題への解)

#### 柱 2: 4-tier long-term semantic pyramid (=「System 2」相当)

| Layer               | 内容                              |
| ------------------- | --------------------------------- |
| **L0 Conversation** | 生対話                            |
| **L1 Atom**         | 抽出された atomic fact            |
| **L2 Scenario**     | scene block (Markdown)            |
| **L3 Persona**      | user profile (好み・声・長期目標) |

drill-down 経路が明示されている。例: 日常の preference 質問は L3 → 必要時 L1/L0 に落ちる。

設計哲学: **「圧縮しても evidence path を失わない」**。

### スタック

- **storage**: SQLite + sqlite-vec (default)、TCVDB optional
- **recall**: BM25 + vector + RRF hybrid (← tsumugi の `hybridSearch` と同じ構造)
- **trigger 設定** (デフォルト):
  - `pipeline.everyNConversations: 5` (5 turn ごとに L1 抽出)
  - `pipeline.l1IdleTimeoutSeconds: 600` (10 分 idle で L1)
  - `pipeline.l2MinIntervalSeconds: 900` (15 分以上空けて L2)
  - `persona.triggerEveryN: 50` (50 memory ごとに persona 生成)
- **dedup**: `extraction.enableDedup: true` (L1 vector dedup + conflict detection)
- **gateway security**: API key + CORS allowlist (Hermes Gateway は localhost sidecar デフォルト、auth 有効化 opt-in)

### 公式ベンチ主張 (要塩)

- entries -70%+ / info density +45% / token -35% / update +20% 速 / write 8x faster than Graphiti
- 第三者再現は Medium の hands-on 体感 (20K → 3K) のみ

## 2. X コミュニティの 3 大トレンド

archfill が 2026-06 に X 上で観測した議論を整理。本セクションは X 上の声を凝縮したもので、論文や repo の一次情報ではない。

### 2.1 忘却 (Forgetting) が最大課題

「**覚えることより、忘れることの方が遥かに難しい**」というコンセンサス。

- 古い情報・矛盾事実・低品質 memory が溜まる → 推論質低下 + token コスト増
- よく挙げられるアプローチ:
  - **重要度スコアリング** (recency + usage frequency + task 成功率の合成)
  - **Ebbinghaus 風時間減衰**
  - **consolidation** (要約・統合) + **sleep-time compute** (Letta 等の夜間処理)
  - **エージェント自身に忘却を学習させる** (AgeMem 等の RL アプローチ、AgingBench 論文)

### 2.2 可視化・編集可能性が必須

「AI の記憶はブラックボックスであってはならない」が強コンセンサス。

- **可視性**: 何が・いつ・どこから来たか (provenance)
- **編集可能性**: ユーザが直接編集・削除・prune
- **視覚化**: knowledge graph、ダッシュボード、Obsidian 連携
- 評価が高いプロジェクト例:
  - **Atomic Memory** (ローカル直接編集)
  - **Gigabrain** (typed memory + provenance + graph UI)
  - **Lacuna** (可視ナビゲーション可能な記憶 graph)

→ markdown 突っ込み・純粋 vector DB だけは「不十分」と見なされつつある。

### 2.3 長期運用での bloat / degradation

- **Memory Bloat**: 文脈ウィンドウが埋まりノイズ増 → 推論精度低下
- **Memory Degradation**: 要約欠落、事実陳腐化、類似 memory 混在
- 論文「Your Agents Are Aging Too」(AgingBench) — deploy 後の経時劣化を実証
- 解決方向:
  - **階層型 memory** (Working / Short-term / Long-term の明確分離)
  - **trust score 付きの昇格ルール**
  - **能動的 Memory Manager** (RL で記憶 CRUD を学習)

### まとめ

2025〜2026 現在、「ただ溜め込む」段階から脱却中。**透明性・制御可能性・賢い忘却**が最重要。純粋 vector / シンプル RAG を超えた「**Memory OS / 認知アーキテクチャ**」寄りが評価を集める。

## 3. tsumugi 現状マッピング

| 要求                    | tsumugi に**ある**                                                                                                  | tsumugi に**ない**                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **賢い忘却**            | `classifyNoise` ノイズフィルタ、`memory.archived_at` archive、AUDN DELETE 判定、`decision-contradiction.ts`         | recency × 利用頻度の合成 scoring、Ebbinghaus 時間減衰、retrieval boost、RL ベースの CRUD 学習            |
| **可視化・編集可能性**  | provenance link (obs→mem `derived_from` / `supersedes` / `related_to`)、admin UI (yui 経由)、REST API               | tsumugi 単体の UI、knowledge graph 可視化、ユーザ直接編集 UI、provenance の API surface                  |
| **階層型 & bloat 対策** | 2-layer (obs/mem)、dreaming 4 種 (synthesize / reflection / time-update / decision-contradiction)、inject hook 3 本 | **Working memory 層が無い**、trust score promotion、active memory manager、Mermaid 風 short-term offload |

### 致命傷ではない / すでに勝負所

- **provenance link**: ADR-001 + links テーブルで既に持っている。surface していないだけ
- **consolidation**: dreaming で Letta の "sleep-time compute" 相当を既に実装済
- **noise filter**: PR #17/#21 で強化済 (Layer 1 純度に投資した方針 = ADR-011) は X 上の評価軸と整合

## 4. 抽出した改善余地

### 短期 (ADR-013 候補)

#### A. importance スコアが static で decay しない

tsumugi の `importance` は AUDN ADD 時 5.0 デフォルト、synthesize で max-of-cluster、それ以降不変。**recency × usage frequency × success rate** の合成スコアになっていない。

- 提案: `static_importance + decay(now - last_accessed) + boost(access_count)` に再計算 (検索時 on-the-fly、または `time-update` job で更新)
- schema 変更: `memories.access_count`, `memories.last_accessed_at` カラム追加のみ
- 影響: `hybridSearch` の reranking 軸が 1 本増える

#### B. provenance が surface されていない

links テーブルは持っているが `search_memory` レスポンスに「この memory は obs_xxx + obs_yyy から derived」を含めていない。X 上で評価される Atomic Memory / Gigabrain が訴求するのは **「いつ・どこから来たか」の即時確認**。

- 提案: `search_memory` レスポンスに `provenance: [{layer, id, relation, created_at}]` を含める
- schema 変更不要、surface のみ

#### C. agent から忘却を学習する MCP tool が無い

`save_observation` / `search_memory` はあるが、`mark_memory_outdated` / `archive_memory` / `merge_memories` が無い。X 上の「ユーザ編集可能性」要求には **agent が編集する権限** も含む。

- 提案: `mark_memory_outdated(memory_id, reason)` MCP tool 追加
- dreaming 側で `archived_at` を立てる時の trigger に利用

### 中長期 (大改修)

#### D. Working memory / short-term の明示分離

Tencent の Mermaid task canvas、X コミュニティの「Working / Short-term / Long-term 分離」はこの層。tsumugi の inject hook (SessionStart) は「session 内で長期 memory を呼び戻す」だけで、**session 内で生まれた一時状態を扱う層**が無い。

- ただし Claude Code 側の context 管理と被るので、tsumugi が触るべきか判断微妙
- 観察対象: Hy-Memory の `refs/*.md` + Mermaid canvas が実運用で機能するか

#### E. UI / 可視化

knowledge graph 可視化 / 編集 UI は別 app になる規模。

- 選択肢:
  1. yui の admin で代用
  2. tsumugi 単体で React + d3
  3. Atomic Memory 系の既存ツールに connector を出す
- どれを選ぶかで影響範囲が大幅に変わる

#### F. RL ベース memory CRUD

AgeMem 系 RL アプローチは tsumugi の現在の hand-tuned ルールから大幅乖離。研究段階で固まってないので **観察ポジション** が妥当。

## 5. 優先順位 (起案者所感)

**2026-06-17 事後追記**: 同日午後の recall 実証テスト (§5.1) で、A の前提となる
「ranking 質に問題がある」仮説が **否定** され、代わりに **G (auto project_tag
filter) を新規最優先項目**として追加。優先順位を更新する。

| #   | 項目                                                   | 推定コスト | 効果                                       |
| --- | ------------------------------------------------------ | ---------- | ------------------------------------------ |
| 1   | **G**: auto project_tag filter (新規、§5.1 参照)       | 1 日       | **特大 (recall 失敗が filter のみで解消)** |
| 2   | provenance を `search_memory` レスポンスに surface (B) | 1-2 日     | 大 (コミュニティ評価軸に直接対応)          |
| 3   | `mark_memory_outdated` MCP tool (C)                    | 1 日       | 中 (agent が忘却を学習する第一歩)          |
| 4   | importance decay + access boost (A)                    | 3-5 日     | **低** (§5.1 で必要性否定、observe へ)     |
| 5   | Working memory 層検討 (D)                              | 大         | 不明 (Claude Code との分担次第)            |
| 6   | UI (E)                                                 | 大         | 大 (採用判断要)                            |
| 7   | RL CRUD (F)                                            | 観察       | -                                          |

**G + B + C** を **ADR-013 として 1 本にまとめる**のが現実的 (推定 3-4 日)。
A は当面観察ポジション、D-F は本 doc を根拠に必要時に別 ADR で起案する。

### 5.1 recall 実証テスト (2026-06-17 午後)

「正しく引けるか」を検証するため、今日のセッション中に保存した 14+4 件の
observation を狙った 3 本の ピンポイント query を投げて hit を観測した。

#### 第 1 ラウンド (filter なし)

| query                                           | 期待 obs     | 実際の top hit                                | 結果    |
| ----------------------------------------------- | ------------ | --------------------------------------------- | ------- |
| "bench audn promote 並列 OpenAI 429 rate limit" | obs_4d952550 | obs_c755b1a3 (別 topic: PR #33 merge)         | ❌ 失敗 |
| "save_observation 呼ばなかった failure"         | obs_0b547f6c | DecisionSummaryService キャッシュテスト (yui) | ❌ 失敗 |
| "dreaming summarize AUDN 圧縮 context erosion"  | obs_25453d99 | Phase 11 dreaming consolidation (yui)         | ❌ 失敗 |

全 query で top hit の score = **0.015-0.016** (RRF baseline 域、実質ランダム)。
top hit に **他プロジェクト (yui, Lambda 系, mastermente 等) の obs が surface** していた。

#### 第 2 ラウンド (`filter: {project_tag: "tsumugi"}` を追加)

| query | 期待 obs     | 実際の top hit              | 結果    |
| ----- | ------------ | --------------------------- | ------- |
| 同上  | obs_4d952550 | **obs_4d952550** (期待通り) | ✅ 成功 |
| 同上  | obs_0b547f6c | **obs_0b547f6c** (期待通り) | ✅ 成功 |
| 同上  | obs_25453d99 | **obs_25453d99** (期待通り) | ✅ 成功 |

3/3 で期待 obs が top hit。さらに top-5 すべてが当日 save した tsumugi obs で
埋まる ideal な結果。

#### 解釈

- 問題は **cross-project corpus pollution**。archfill の corpus には複数プロジェクトの
  obs が混在し、tsumugi 単独の最近 obs が大海に埋もれる
- search_memory の **デフォルトが全プロジェクト horizontal** であることが直接の原因
- BM25 / vector / RRF の ranking 本体は **正常動作**。filter 適用後の ranking は実用十分
- 結果として **A (importance decay) の必要性は否定**。代わりに G (auto project_tag
  filter) が 1 日でできる "特大効果" の改善として浮上

#### 含意

「正しく引けるか」への現状の答え:

- filter なしの デフォルト動作 → **NO** (実用に耐えない)
- filter ありの正しい呼び方 → **YES** (期待通り surface する)

つまり **recall そのものは壊れていない**。MCP の呼び出し規約と server 側
default の改善で実用ラインに乗る。これが ADR-013 の主題。

## 6. 直近の tsumugi 自決定との整合性

| 直近 ADR / 変更                                       | 本 doc との関係                                                                     |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------- |
| ADR-011 (`hook-llm-placement`, inject-only 3 hook)    | 「透明性・制御可能性」と整合。hook で raw を投げない方針は X 上の評価軸と一致       |
| ADR-012 (Proposed, milestone-event save nudge)        | 「能動的 Memory Manager」の第一歩。RL ではなく rule-based だが方向性は同じ          |
| PR #33 (dreaming prompt の context preservation 強化) | 「Memory Degradation 対策」と整合。context erosion は X 上で要求された改善軸の 1 つ |

## 関連

- ADR-001 (Two-layer architecture) ← Layer 1/2 設計の根拠
- ADR-003 (thin tool / client LLM delegation) ← hot path で LLM を呼ばない原則
- ADR-011 (hook-llm-placement) ← inject-only 3 hook
- ADR-012 (Proposed, milestone-event save nudge)
- PR #33 (dreaming prompt context preservation)
- [Tencent Hunyuan Launches Hy-Memory (Phemex)](https://phemex.com/news/article/tencent-hunyuan-unveils-hymemory-plugin-for-enhanced-ai-collaboration-86261)
- [Tencent Open-Sources TencentDB Agent Memory (MarkTechPost)](https://www.marktechpost.com/2026/05/23/tencent-open-sources-tencentdb-agent-memory-a-4-tier-local-memory-pipeline-for-ai-agents/)
- [TencentCloud/TencentDB-Agent-Memory (GitHub)](https://github.com/TencentCloud/TencentDB-Agent-Memory)
- [The 20K → 3K moment (Pawel, Medium)](https://medium.com/@meshuggah22/the-20k-3k-moment-testing-tencents-new-agent-memory-framework-e3f12625a90f)
- [Tencent Hy on X: Hy-Memory release announcement](https://x.com/TencentHunyuan/status/2061372535267357029?lang=en)
- AgingBench paper "Your Agents Are Aging Too" (引用は X、一次出典は別途要確認)
- Letta sleep-time compute, AgeMem, Atomic Memory, Gigabrain, Lacuna (各プロジェクト URL は本 doc 範囲外、必要時に追補)
