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
| 014 | Three-layer 化 (capture / obs / mem)          | Proposed | 🚧 Phase 1-5 初期実装済み、Phase 6 観察待ち            |

## 直近の実装優先順位

| 順  | ADR | 工数      | 内容                                                                         | 依存                      |
| --- | --- | --------- | ---------------------------------------------------------------------------- | ------------------------- |
| 1   | 014 | 観察 1-2 週 | Phase 6: bench / smoke / 実運用観察、昇格率・昇格品質・DB volume 確認 | Phase 1-5 初期実装済み |
| 2   | 012 | 1 日        | PreToolUse(Bash) milestone save nudge の必要性再評価                  | ADR-014 観察後         |

### 順序の根拠

- **014 → 012**: 013 は完了済み。014 は Phase 1-5 の初期実装後、実運用観察で昇格品質と volume を見る。012 は 014 後に必要性を再評価して着手判断
- **012 は ADR-014 後**: capture 層が漏れを拾うようになるので nudge の必要性が低下する可能性

## 将来 ADR 候補 (scope 外、品質次第で再考)

VISION.md と ADR-014 §10 の「scope 外」項目を再評価候補として集約:

| 候補                                          | 起源            | 再評価 trigger                                      |
| --------------------------------------------- | --------------- | --------------------------------------------------- |
| L3 Persona 層                                 | ADR-014 §10     | continuity 品質が persona 必要と示したとき          |
| L2 Scenario 層                                | ADR-014 §10     | dreaming synthesize の限界を観測したとき            |
| Mermaid 風 short-term canvas / Working memory | ADR-014 §10     | host (Claude Code) の context 不足を観測            |
| 自動 L1 抽出 trigger (every N turn)           | ADR-014 §10     | agent 主導 save の漏れが capture 経由で補えないとき |
| PreCompact hook (mem0 風)                     | ADR-014 §10     | compact 直前の救済が不十分と観測                    |
| importance decay + access boost (A)           | research doc §4 | recall 品質が ranking 改善で上がると確認            |
| Working memory 層 (D)                         | research doc §4 | host との分担で不足が見えたとき                     |
| UI / 可視化 dashboard (E)                     | research doc §4 | yui admin で不足が見えたとき                        |
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

## 更新方針

- 新 ADR を作ったら status / 優先順位を更新
- 実装が完了したら status を Accepted に、完了履歴に追記
- 将来 ADR 候補が増減したら反映
- VISION.md / ADR-014 §10 と整合性を保つ (= scope 外 項目の解釈ズレを起こさない)

## 関連

- [`VISION.md`](./VISION.md) ← 上位の判断軸
- [`docs/adr/`](./adr/) ← 個別 ADR
- [`docs/research/`](./research/) ← 調査メモ
