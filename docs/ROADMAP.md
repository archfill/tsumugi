# tsumugi — ROADMAP

- 種別: operational view
- 最終更新: 2026-07-26
- 判断軸: [`VISION.md`](./VISION.md) の capture / recall / forgetting / transparency / continuity

実装状況、完了済み移行、次の優先順位はこのファイルだけで管理する。
README は概要と本ファイルへの導線に限定する。意思決定と lifecycle status は
各 ADR だけで管理し、この一覧では status を複製しない。

## ADR 一覧

| # | ADR | 実装状況 |
| --- | --- | --- |
| 001 | [Two-layer architecture](./adr/0001-two-layer-architecture.md) | ADR-014 で Three-layer へ拡張 |
| 002 | [Hybrid search](./adr/0002-hybrid-search-pgbigm-pgvector.md) | 実装済み |
| 003 | [Server-wide zero LLM / client delegation](./adr/0003-thin-tool-client-llm-delegation.md) | 外部 LLM runtime 撤去済み |
| 004 | [TypeScript monorepo](./adr/0004-typescript-fullstack-monorepo.md) | 実装済み |
| 005 | [PostgreSQL 18 + Drizzle](./adr/0005-postgresql18-drizzle.md) | 実装済み |
| 006 | [Admin operations console](./adr/0006-admin-ui-operations-console.md) | deterministic operations に移行 |
| 007 | [LLM provider agnostic](./adr/0007-llm-provider-agnostic.md) | ADR-003 により runtime 撤去 |
| 008 | [LLM resilience layers](./adr/0008-llm-resilience-layers.md) | ADR-003 により runtime 撤去 |
| 009 | [Eval as migration validation](./adr/0009-eval-as-migration-validation.md) | search / migration 評価へ継続利用 |
| 010 | [yui migration](./adr/0010-phase4-yui-migration-strategy.md) | データ移行済み、adapter / cutover / 旧実装撤去は未完了 |
| 011 | [Hook LLM placement](./adr/0011-hook-llm-placement.md) | Layer 1 capture を ADR-014 で追加 |
| 012 | [Milestone save nudge](./adr/0012-save-trigger-nudge.md) | capture 実績を見て再評価 |
| 013 | [Recall filter + provenance + outdated](./adr/0013-recall-default-filter-provenance-outdated.md) | 実装済み |
| 014 | [Three-layer / deterministic promotion](./adr/0014-three-layer-capture-promotion.md) | observation-first 実装済み |

## 現在の構成

### Capture

- hook は raw event を TTL 付き Layer 1 へ deterministic insert する
- Stop は completed turn checkpoint として `turn_id` と sanitized final response を持つ
- hook 同期経路では promotion を待たない
- SessionStart continuity bridge は未昇格 Stop を bounded inject する

### Promotion

- `promote-captures` は Stop 1件を 1 observation へ決定論的に昇格する
- versioned promotion key で再送・再実行を冪等化する
- facts を生成せず、observation / provenance / capture state を atomic commit する
- legacy LLM window は専用 CLI の dry-run / 明示 apply で retire または Stop queue へ移す

### Recall

- observation と legacy / curated memory を BGE-M3 + pg_bigm + RRF で検索する
- 同じ候補 observation から直接派生した memory hit だけを重複抑制する
- standalone / unlinked / curated memory は引き続き検索できる
- provenance、source、project、timestamp、outdated を結果へ付与する

### Maintenance

自動実行するのは `promote-captures`、`sweep-captures`、`archive-outdated` のみ。
旧 `promote-observations`、`synthesize`、`time-update`、`decision-contradiction`、
`reflection` は `removed_server_llm` の副作用なし no-op とする。

## 完了済み移行

- server-side provider client / API key / tier config / fallback / cooldown / retry runtime 撤去
- direct `save_observation` を保存時点で completed とし、fact queue を作らない
- deterministic Stop promotion、migration、atomic integration test
- observation-first search policy と synthetic relevance 比較
- read-only memory quality audit と privacy guard
- reversible archive の plan / apply / restore と本番相当 clone での rollback 検証
- recall、DB / index volume、latency の before / after 評価
- 評価結果に基づき、既存 memory の production bulk archive は不採用
- deploy compose / schedule から LLM secret・job を除去

## 次の優先順位

| 順 | 内容 | 完了条件 |
| --- | --- | --- |
| 1 | ADR-010 cutover 前提の再確認 | zero-LLM / observation-first の現行契約に対して yui の必須 surface を再分類 |
| 2 | yui adapter / cutover | yui が tsumugi を実際に呼び、snapshot rollback と回帰テストを通す |
| 3 | 安定観察 | 日常利用で capture / recall / continuity と yui の非 memory 機能を確認 |
| 4 | yui legacy memory cleanup | 観察完了後に旧 worker、store、schema、依存、設定を撤去 |
| 5 | ADR-012 再評価 | deterministic capture の実績を基に milestone save nudge の要否を決定 |

production の hard delete、類似度だけによる semantic merge、raw private data の CI / Issue
持ち出しは行わない。

## 将来候補

- client-assisted curated memory action
- provenance graph visualization
- timeline-ordered search
- explicit last-recalled metadata
- Layer 1 capture search API
- multi-user / shared memory

新しい自動処理を追加する場合は、意味内容を破壊的に更新しないこと、provenance と rollback を
追跡できること、VISION の5品質軸へ実測で寄与することを採用条件とする。
