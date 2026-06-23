# tsumugi — AI 開発ガイド（必読）

> 新規実装の前に必ず最初に読むこと。書く場所と再利用ルールを規定する。

## ディレクトリ構造（書く場所のルール）

| 層            | 役割                     | 何を書く                          |
| ------------- | ------------------------ | --------------------------------- |
| `core/`       | ビジネスロジック（純粋） | use case、検索アルゴリズム        |
| `data/`       | 永続化                   | Drizzle schema、repository        |
| `external/`   | 外部 I/O                 | embedding、LLM クライアント       |
| `interfaces/` | 入力アダプタ             | MCP tool、REST handler、transport |
| `lib/`        | 横断ユーティリティ       | id、errors、config                |

依存方向: `interfaces → core → (data, external) → lib`

逆方向の import 禁止（lib は循環依存禁止）。

```
apps/server/src/
├── index.ts                       # entrypoint
├── core/                          # 純粋ビジネスロジック
│   ├── observation/
│   │   └── save.ts                # saveObservation use case
│   └── search/                    # 検索系（hybrid/bigm/vector/rrf）
│       ├── hybrid.ts
│       ├── bigm.ts
│       ├── vector.ts
│       ├── rrf.ts
│       └── smoke.ts
├── data/                          # 永続化層
│   ├── client.ts                  # pg Pool + drizzle
│   ├── schema.ts                  # Drizzle 4 テーブル
│   └── repos/
│       └── observation.ts         # observation の CRUD ラッパ
├── external/                      # 外部 I/O 層
│   └── embedding/
│       ├── bge.ts                 # createBgeEmbedder()
│       ├── singleton.ts           # getEmbedder()
│       └── smoke.ts
├── interfaces/                    # 入力アダプタ層
│   ├── mcp/
│   │   ├── server.ts
│   │   ├── transport-stdio.ts
│   │   ├── transport-http.ts
│   │   ├── smoke.ts
│   │   └── tools/
│   │       ├── save-observation.ts
│   │       └── search-memory.ts
│   └── rest/
│       └── routes.ts
└── lib/                           # 横断ユーティリティ
    ├── id.ts
    ├── errors.ts
    └── config.ts
```

## 既存資産（再実装禁止）

### ID 生成

`lib/id.ts` の `newId(prefix)` を必ず使う。

```ts
import { newId } from "../lib/id.js";
const id = newId("obs");
```

### DB アクセス

`data/repos/<entity>.ts` 経由で行う。`db` を直接触らない（schema 定義 / migration ファイル以外）。

```ts
import { observationRepo } from "../../data/repos/observation.js";
await observationRepo.insert(row);
```

### Embedder

`external/embedding/singleton.ts` の `getEmbedder()`。

```ts
import { getEmbedder } from "../../external/embedding/singleton.js";
const embedding = await getEmbedder().embed(text);
```

### 検索

`core/search/hybrid.ts` の `hybridSearch()`。bigm/vector を直接呼ばない。

```ts
import { hybridSearch } from "../../core/search/hybrid.js";
const hits = await hybridSearch(input);
```

### 設定

`lib/config.ts` の `loadConfig()`。`process.env` 直接読み禁止。

### エラー

`lib/errors.ts` の `TsumugiError` 派生を使う。`new Error()` しない。

```ts
import { ValidationError, ExternalError } from "../../lib/errors.js";
throw new ValidationError("content is required");
```

## 採用パターン

### Use case の形

- ファイル: `core/<domain>/<verb>.ts`（例: `core/observation/save.ts`）
- 入口で Zod parse、出力は型付きオブジェクト
- repo / external を直接 import で呼ぶ（DI コンテナ不要）
- 副作用は use case 内で完結

### Repository の形

- ファイル: `data/repos/<entity>.ts`
- `export const xxxRepo = { method1, method2 }` で集約
- Drizzle の `$inferSelect` / `$inferInsert` で型を取り出す

### Interface 層（MCP / REST）

- 受信 → use case 呼び出し → レスポンス整形のみ
- ビジネスロジックを置かない

### エラー処理

- core / data / external 内では throw
- interfaces 層で catch して MCP / HTTP に変換
- 通常の制御フローでは Result 型不要

### Zod スキーマ

- `packages/shared/src/schema.ts` に集約
- use case 内で `z.object({...})` をその場で書かない

## ファイル命名

- use case: `<verb>.ts`（save.ts, search.ts, synthesize.ts）
- repo: `<entity>.ts`（observation.ts, memory.ts）
- ヘルパ: 役割名（id.ts, errors.ts, config.ts）

## 強制（CI で守る）

- `pnpm typecheck` 全 workspace pass
- 命名・配置違反は PR レビューで指摘

## 意思決定の背景

ドキュメント階層:

| 媒体                                 | 役割                                                                |
| ------------------------------------ | ------------------------------------------------------------------- |
| [`docs/VISION.md`](docs/VISION.md)   | 上位の判断軸 (品質駆動、5 軸、原則、scope 外)                       |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | **全 ADR の status と実装優先順位の俯瞰**。「次に何をするか」はここ |
| `docs/adr/`                          | 個別の不変決定 (ADR)                                                |
| `docs/research/`                     | 調査メモ、ADR 起案前の素材                                          |

設計判断に影響しそうな実装をする前は、**`VISION.md` の 5 品質軸** (capture / recall /
forgetting / transparency / continuity) を判断基準として参照する。

主要 ADR (全一覧は `ROADMAP.md` 参照):

- ADR-001: 二層構造 (ADR-014 で Three-layer に拡張予定)
- ADR-002: pg_bigm + pgvector hybrid 検索
- ADR-003: hot path LLM ゼロ (クライアント LLM 委譲)
- ADR-011: Hook は inject-only (ADR-014 で部分撤回予定)
- ADR-013: search_memory default filter + provenance + outdated (Accepted)
- ADR-014: Three-layer 化 (capture / observation / memory) (Proposed)

## エージェント向けチェックリスト

新規実装前に：

- [ ] 上記「既存資産」を再実装していないか確認した
- [ ] 書く場所が「ディレクトリ構造のルール」と一致している
- [ ] 命名規則に従っている
- [ ] エラーは TsumugiError 派生か
- [ ] Zod スキーマは packages/shared を参照している

これに沿わない PR は merge しない。
