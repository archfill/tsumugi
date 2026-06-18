# tsumugi — VISION

- 種別: vision / mission statement (ADR ではない、決定ではない)
- 目的: ADR 群より上位の判断軸を明文化し、将来の設計判断を一貫させる
- 起点: 2026-06-17、archfill との議論で「品質駆動」の優先順位が確定

## ミッション

個人開発者が AI agent (Claude Code / Codex 等) を使った作業を、**複数プロジェクト・
複数端末・長期間** にわたって記憶し続けるための companion。LLM が毎回 context
初期化される断絶を、agent と人間の作業記憶を繋ぐ外部記憶層で埋める。

ADR や docs に書くまでもない試行錯誤・経緯・気づきを失わないようにし、
**人間の記憶脳に近い continuity** を提供する。

## 想定 user

- Claude Code / Codex 等の LLM agent を日常使う個人開発者
- 1 プロジェクトに閉じず、複数プロジェクト / 複数端末を行き来する
- ADR や docs を書く価値はないが消えると困る "ambient" な作業文脈を残したい

## 5 つの品質軸

tsumugi の価値は以下 5 軸の品質で測る。新 feature の採否はこの 5 軸への貢献度で判断する。

| 軸               | 意味                                                | 現状の実装                                                                       |
| ---------------- | --------------------------------------------------- | -------------------------------------------------------------------------------- |
| **capture**      | 必要なものが残る (意識しなくても)                   | ADR-014 で Three-layer 化 (agent 主導 save + deterministic capture の dual-path) |
| **recall**       | 必要な時に引ける                                    | ADR-013 で auto project_tag filter + hybrid (BM25 + vector + RRF)                |
| **forgetting**   | noise / 古い情報が累積しない                        | ADR-011 inject-only / classifyNoise / dreaming archive / mark_outdated (ADR-013) |
| **transparency** | 何が・どこから残っているか見える、編集可能          | ADR-013 で provenance surface、admin UI (yui 経由)                               |
| **continuity**   | session / project / device を跨いだ作業記憶の連続性 | server-based, project_tag, session_id, cross-project filter (ADR-013)            |

## 設計判断の原則

### 1. 品質貢献度が判断基準

新 feature の採否は「上記 5 軸への貢献度」で決める。流行・差別化・identity 防衛は二次的。
**品質が脅かされたら守備範囲を広げる** (= 競合の良い feature を採用する) ことを許容する。

### 2. 現状の路線は教義ではない、判断の結果

以下は現状の品質に最適化された判断であり、固定された教義ではない:

- **journal/event 路線** (Persona / portrait ではない)
- **agent 主導 save を primary**、deterministic capture を safety net
- **short-term は host (Claude Code) に委ねる** (Mermaid 風 working memory を持たない)
- **個人 user 専用** (multi-user / team 共有は scope 外)

将来 これらが品質の足枷になる兆候があれば、別 ADR で再判断する。

### 3. 他ツールから learn する (借りること自体は健全)

mem0 / Tencent Hy-Memory / claude-mem / Atomic Memory / Letta などの先行例から、
**品質貢献度のある feature** は borrowable parts として常に検討対象。
「Tencent と engine が似てくる」「Persona に寄る」等の identity 摩耗を理由に
**拒否はしない**。

### 4. user 単独でも価値を出す

team / OSS contributor 視点の機能 (公開 review、shared memory、permission 等) は
現状 scope 外。**1 人の個人開発者が 1 人で使って価値が出る** ことを最優先する。
将来 multi-user 化する余地は残しつつ、現状投資はしない。

## ADR / docs との役割分担

tsumugi は ADR の **代替ではなく補完**。

| 媒体                   | 何を残すか                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------- |
| ADR (formal)           | 他者と共有する設計判断 / API 契約 / 不変な architectural decision                           |
| docs (formal)          | 公開され version-controlled な仕様・guide                                                   |
| **tsumugi (informal)** | **ADR にするほどでない試行錯誤・気づき・経緯。LLM context reset を跨ぐ ambient な作業文脈** |

### 採否の判断軸

| 判断軸                             | tsumugi に残す | ADR / docs に残す |
| ---------------------------------- | -------------- | ----------------- |
| 他者が将来 discover する必要がある | ❌             | ✅                |
| 不変な決定 / 公的契約              | ❌             | ✅                |
| 試行錯誤・経緯・内省               | ✅             | ❌                |
| 「思い出せたらラッキー」程度の文脈 | ✅             | ❌                |

tsumugi が成熟すれば ADR の「内向け部分」(個人記憶代わりに書かれていた ADR) は
自然に縮退する可能性はある。ただし「他者と共有する判断」を ADR から外すことはない。

## 競合との立ち位置

差別化は **「multi-agent host (Claude Code + Codex) × 個人 user × journal 路線」**
の 3 軸交差点。3 軸を同時に満たす競合は現状 (2026-06) 存在しない。

ただし **差別化自体は目的ではない**。品質が要求すれば 3 軸の交差点から踏み出すこともあり得る。

詳細は [`docs/research/2026-06-17-agent-memory-landscape.md`](research/2026-06-17-agent-memory-landscape.md) 参照。

## 現時点で scope 外 (将来 quality に必要が見えたら再考)

| 項目                                          | scope 外の理由                                              |
| --------------------------------------------- | ----------------------------------------------------------- |
| multi-user / shared memory                    | 個人 user 専用に集中、team / OSS contributor 視点は現状不要 |
| L3 Persona 層 (Tencent 風)                    | 現状の journal 路線で品質充足                               |
| L2 Scenario 層 (Tencent 風)                   | dreaming synthesize で同等役割                              |
| Mermaid 風 short-term canvas / Working memory | host (Claude Code) の context 管理に委ねる                  |
| UI / 可視化 dashboard                         | yui admin で代用、tsumugi 単体での投資は後                  |
| RL ベース memory CRUD                         | 研究段階、tsumugi の hand-tuned ルールから乖離が大きい      |
| 自動 L1 抽出 trigger (every N turn)           | agent 主導 save が primary、deterministic 一元化はしない    |

これらは「品質貢献度」を judging 基準として、将来 ADR で再評価する余地を残す。

## 関連

- ADR-001 (Two-layer architecture / ADR-014 で Three-layer 化)
- ADR-003 (thin tool / client LLM delegation)
- ADR-011 (inject-only hook + observation 純度)
- ADR-012 (Proposed, milestone-event save nudge)
- ADR-013 (Proposed, search filter + provenance + outdated)
- ADR-014 (Proposed, Three-layer 化 / capture / observation / memory)
- `docs/research/2026-06-17-agent-memory-landscape.md` (競合 landscape 分析)
