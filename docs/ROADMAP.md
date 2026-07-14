# tsumugi — ROADMAP

- 種別: operational view (ADR ではない、決定ではない)
- 目的: 全 ADR の status と実装優先度を 1 ファイルで俯瞰し、「次に何をするか」を見える化する
- 更新: PR review 経由で随時。新 ADR / 実装完了のたびに反映する

## このドキュメントの位置づけ

| 媒体                          | 役割                                   |
| ----------------------------- | -------------------------------------- |
| [`VISION.md`](./VISION.md)    | 上位の判断軸 (品質駆動、5 軸、原則)    |
| ADR (`docs/adr/`)             | 個別の不変決定                         |
| **ROADMAP.md (このファイル)** | **status の集約 + 優先順位の見える化** |
| `docs/research/`              | 調査メモ、ADR 起案前の素材             |
| tsumugi (memory)              | 試行錯誤・経緯・内省 (= 後ろ向き)      |
| yui task / GitHub Issues      | task 管理 (= 前向き、状態遷移)         |

ROADMAP.md は「**何が決まっていて、次に何をすべきか**」を 1 つにまとめる **operational doc**。
個別決定は ADR、判断軸は VISION、進捗は yui / Issues、と棲み分ける。

## ADR 一覧 (status と実装)

| #   | タイトル                                      | Status   | 実装状況                                               |
| --- | --------------------------------------------- | -------- | ------------------------------------------------------ |
| 001 | Two-layer architecture                        | Accepted | ✅ 実装済み (ADR-014 で Three-layer に拡張予定)        |
| 002 | Hybrid search (pgbigm + pgvector + RRF)       | Accepted | ✅ 実装済み                                            |
| 003 | Thin tool / client LLM delegation             | Accepted | ✅ 実装済み                                            |
| 004 | TypeScript fullstack monorepo                 | Accepted | ✅ 実装済み                                            |
| 005 | PostgreSQL 18 + Drizzle                       | Accepted | ✅ 実装済み                                            |
| 006 | Admin UI operations console                   | Accepted | ✅ 実装済み                                            |
| 007 | LLM provider agnostic                         | Accepted | ✅ 実装済み                                            |
| 008 | LLM resilience layers                         | Accepted | ✅ 実装済み                                            |
| 009 | Eval as migration validation                  | Accepted | ✅ 実装済み                                            |
| 010 | Phase 4 yui migration                         | Accepted | ✅ 実装済み                                            |
| 011 | Hook LLM placement (inject-only)              | Accepted | ✅ 実装済み (ADR-014 で部分撤回予定)                   |
| 012 | Milestone-event save nudge                    | Proposed | ⏳ **未着手** (ADR-014 で必要性低下、補助手段に格下げ) |
| 013 | Recall default filter + provenance + outdated | Accepted | ✅ **実装済み**                                       |
| 014 | Three-layer 化 (capture / obs / mem)          | Proposed | 🚧 Phase 1-5 本番反映済み、Phase 6 継続評価中             |

## 直近の実装優先順位

| 順  | ADR | 工数      | 内容                                                                         | 依存                      |
| --- | --- | --------- | ---------------------------------------------------------------------------- | ------------------------- |
| 1   | 014 | 観察 1-2 週 | Phase 6: 改訂経路の本番観察、昇格率・品質・call 数・continuity・retry/quarantine・DB volume 確認 | Phase 1-5 本番反映済み |
| 2   | 012 | 1 日        | PreToolUse(Bash) milestone save nudge の必要性再評価                  | ADR-014 観察後         |

### 順序の根拠

- **014 → 012**: 013 は完了済み。014 は Phase 1-5 の改訂実装後、本番反映して昇格品質、call 数、continuity、retry/quarantine、volume を見る。012 は 014 後に必要性を再評価して着手判断
- **012 は ADR-014 後**: capture 層が漏れを拾うようになるので nudge の必要性が低下する可能性

## ADR-014 現在地

### 実装済み (本番反映済み、継続評価中)

- Stop を session 終端ではなく completed turn checkpoint として扱い、`turn_id` と final response を deterministic capture する
- hook の同期経路は capture insert のみとし、LLM promotion は呼ばない
- scheduled promotion は session ごとに最大 3 completed turns / 12,000 chars の durable window を作る
- SessionStart は未昇格 Stop checkpoint を bounded inject し、promotion 待ちの continuity を bridge する
- 同一 provider endpoint + credential の LLM 呼出しは job / tier をまたいで直列化する
- capture→observation は window 単位、observation→memory は fact 単位で state / lease / retry / quarantine と transaction 境界を持つ
- Admin UI を Overview / Pipeline / Memories / Operations の運用コンソールへ改訂し、read-only の layer 集計、trace、issues、project / source / state / 期間 filter を追加
- 既存 integration 向け REST contract は維持し、Admin 集計 API は `/api/admin/*` に分離

### 本番 baseline evidence

- 578 captures / 79 sessions / 12 projects
- Stop 58/58 件に `turn_id` と final response があり、1 session あたり最大 18 Stop だった
- pending 24 completed turns は 3-turn / 12,000-char window で 11 LLM calls の見込み。capture 単位の即時処理比で 76.6% 削減と推定

これは payload shape と window 削減仮説の導入前 evidence であり、改訂経路の本番評価ではない。
Phase 6 では実 call 数、昇格品質、continuity の有用性、retry/quarantine、DB volume を確認する。

### 本番評価を受けた改訂

- 本番反映済み: provider endpoint + credential単位のcircuit breaker、attempt / failure分離、
  observation準備失敗のdurable retry、provider cooldownの可視化
- 2026-07-14追加改訂: AUDNのGLM-5.2 thinking出力を8192 tokensへ拡張し、shape errorへ
  生成本文を記録しない
- 2026-07-14追加改訂: retry待ちitemによる全停止を、上限100 facts / 20 windowsの
  bounded backpressureへ変更
- 2026-07-14追加改訂: Operationsからwindow / fact / observationを明示的にretry / restore可能にする

追加改訂の根拠:

- GLM-5.2 MIDは640 success / 18 error。shape error 6件はすべてJSON末尾の`reasoning`欠落だった
- 同一本番データの対照実験で2048は3回中1回`finish_reason=length`、8192は3回すべて`stop`
- outstanding fact 1件で15 pending windowsと14 ready capturesが停止した
- worker能力は50 facts / 30分、平均2.44 facts / observationであり、zero-backlog gateは過剰だった
- capture worker能力は10 windows / 30分であり、window backlogも2 run分の20件を上限とした

## 将来 ADR 候補 (scope 外、品質次第で再考)

VISION.md と ADR-014 §10 の「scope 外」項目を再評価候補として集約:

| 候補                                          | 起源            | 再評価 trigger                                      |
| --------------------------------------------- | --------------- | --------------------------------------------------- |
| L3 Persona 層                                 | ADR-014 §10     | continuity 品質が persona 必要と示したとき          |
| L2 Scenario 層                                | ADR-014 §10     | dreaming synthesize の限界を観測したとき            |
| Mermaid 風 short-term canvas / Working memory | ADR-014 §10     | host (Claude Code) の context 不足を観測            |
| hook-local 同期 L1 抽出 (every N turn)        | ADR-014 §10     | scheduled window では latency 要件を満たせないとき  |
| PreCompact hook (mem0 風)                     | ADR-014 §10     | compact 直前の救済が不十分と観測                    |
| importance decay + access boost (A)           | research doc §4 | recall 品質が ranking 改善で上がると確認            |
| Working memory 層 (D)                         | research doc §4 | host との分担で不足が見えたとき                     |
| provenance graph visualization                | research doc §4 | 運用コンソールの trace list では関係把握が不足したとき |
| RL ベース memory CRUD (F)                     | research doc §4 | hand-tuned forgetting の限界を観測                  |
| multi-user / shared memory                    | VISION          | team / OSS contributor 視点が必要になったとき       |
| timeline-ordered search MCP tool              | VISION 補足     | 時系列 view への明確なニーズが見えたとき            |
| Layer 1 (captures) search API                 | ADR-014 §7      | 過去 session の生 capture を引きたい必要発生時      |

これらは判断軸 = **品質貢献度** (VISION の 5 軸: capture / recall / forgetting / transparency / continuity) で再評価する。

## 完了した実装作業の履歴 (直近)

| 日付       | 内容                                                                   | PR / commit |
| ---------- | ---------------------------------------------------------------------- | ----------- |
| 2026-06-17 | dreaming prompt の when/where/why context preservation 強化            | PR #33      |
| 2026-06-17 | ADR-012 起案 (milestone-event save nudge)                              | PR #34      |
| 2026-06-17 | research doc: agent memory landscape scan (Tencent + X)                | PR #35      |
| 2026-06-17 | ADR-014 起案 (Three-layer 化) + VISION.md                              | PR #36      |
| 2026-06-17 | ADR-013 起案 (search filter + provenance + outdated) + recall 実証追記 | PR #37      |
| 2026-06-28 | ADR-014 Phase 1-5 初期実装 (captures / hooks / promote / sweep)        | local       |
| 2026-07-13 | ADR-014 改訂実装 (turn checkpoint / scheduled window / continuity / durable promotion) | local       |
| 2026-07-13 | ADR-014 本番 baseline 評価 (578 captures / 79 sessions / 12 projects)                  | local       |
| 2026-07-13 | Three-layer Admin UI + read-only operations API 実装                                  | local       |
| 2026-07-13 | 本番 backlog 評価を受けた promotion backpressure / provider circuit / failure 分離     | local       |
| 2026-07-14 | GLM-5.2出力上限、bounded backpressure、Operations retry / restore改訂                  | local       |

## 更新方針

- 新 ADR を作ったら status / 優先順位を更新
- 実装と必要な本番評価が完了したら status を Accepted に、完了履歴に追記
- 将来 ADR 候補が増減したら反映
- VISION.md / ADR-014 §10 と整合性を保つ (= scope 外 項目の解釈ズレを起こさない)

## 関連

- [`VISION.md`](./VISION.md) ← 上位の判断軸
- [`docs/adr/`](./adr/) ← 個別 ADR
- [`docs/research/`](./research/) ← 調査メモ
