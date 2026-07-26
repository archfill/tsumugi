# tsumugi — ROADMAP

- 種別: operational view
- 最終更新: 2026-07-26
- 判断軸: [`VISION.md`](./VISION.md) の capture / recall / forgetting / transparency / continuity

## ADR 一覧

| # | タイトル | Status | 実装状況 |
| --- | --- | --- | --- |
| 001 | Two-layer architecture | Accepted | ADR-014 で Three-layer へ拡張 |
| 002 | Hybrid search | Accepted | 実装済み |
| 003 | Server-wide zero LLM / client delegation | Accepted | 外部 LLM runtime 撤去済み |
| 004 | TypeScript monorepo | Accepted | 実装済み |
| 005 | PostgreSQL 18 + Drizzle | Accepted | 実装済み |
| 006 | Admin operations console | Accepted | deterministic operations に移行 |
| 007 | LLM provider agnostic | Superseded | ADR-003 により runtime 撤去 |
| 008 | LLM resilience layers | Superseded | ADR-003 により runtime 撤去 |
| 009 | Eval as migration validation | Accepted | search / migration 評価へ継続利用 |
| 010 | yui migration | Accepted | 実装済み |
| 011 | Hook LLM placement | Accepted | Layer 1 capture を ADR-014 で追加 |
| 012 | Milestone save nudge | Proposed | capture 実績を見て再評価 |
| 013 | Recall filter + provenance + outdated | Accepted | 実装済み |
| 014 | Three-layer / deterministic promotion | Accepted | observation-first 実装済み |

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
- deploy compose / schedule から LLM secret・job を除去

## 次の優先順位

| 順 | 内容 | 完了条件 |
| --- | --- | --- |
| 1 | 既存 memory の安全な監査 | reason 別件数、限定レビュー、raw content 非出力 |
| 2 | reversible archive | batch manifest、dry-run、apply、restore を staging clone で検証 |
| 3 | before / after 評価 | recall、DB/index volume、latency が同等以上または差を説明 |
| 4 | production rollout | dry-run と対象件数を提示し、明示承認後に適用 |

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
