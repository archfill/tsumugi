# ADR-003: hot path LLM ゼロ — クライアント LLM への観測整形委譲

- 日付: 2026-06-14
- ステータス: Accepted

## コンテキスト

MCP tool (`save_observation`) の呼び出し元は Claude Code / Codex / yui などの AI エージェントである。
エージェントはすでに LLM を持ち、観測内容を自然言語で生成する能力がある。

サーバー側でも LLM を呼び出し「観測を要約・構造化してから保存する」設計が考えられるが、
以下の問題がある:

- **レイテンシ**: LLM 推論は数秒かかる。MCP tool call の応答が遅れる
- **コスト**: 保存のたびに LLM を呼ぶと API コストが線形に増加する
- **冗長性**: 呼び出し元エージェントがすでに整形済みテキストを持っているのに二重処理になる
- **結合**: サーバーが特定 LLM プロバイダに依存し、可搬性が下がる

## 決定

**hot path（`save_observation` / `search_memory`）では LLM を呼ばない。**

観測の整形・構造化はクライアント LLM（呼び出し元エージェント）の責務とする。
サーバーは受け取ったテキストをそのまま保存し、embedding のみをサーバー側で生成する。

具体的には:

- `save_observation` の `content` は呼び出し元が整形済みのテキストを渡す
- `type` / `source` / `facts` などの構造化フィールドも呼び出し元が決定する
- サーバーは Zod で入力を検証し、BGE-M3 でベクトル化して保存するだけ

**LLM を呼ぶのは dreaming フェーズ（Layer 2 synthesis）のみ**。
dreaming は非同期・低頻度で実行されるため、レイテンシ制約がない。

## 代替案と却下理由

**サーバー側で LLM を呼び、観測を自動分類・要約する**

- 却下: hot path のレイテンシが許容できない。
  BGE-M3 embedding だけでも数百ミリ秒かかる環境で、追加の LLM 呼び出しは非現実的。

**エージェント側は raw テキストのみ渡し、サーバーで全構造化**

- 却下: `type` や `facts` の判断には文脈が必要で、文脈を最もよく知るのは呼び出し元エージェント。
  サーバーに文脈がなく、精度が下がる。

**Function calling で LLM に JSON 生成させてサーバーに渡す（現在の設計）**

- 採用: エージェントが `save_observation` を tool call する時点で、引数を JSON として整形する。
  Zod schema が OpenAPI compatible な JSON Schema に変換でき、MCP tool の `inputSchema` として使える。

## 帰結

- `save_observation` の応答時間は embedding 時間（BGE-M3 CPU: ~200ms〜数秒）が支配的
- サーバーに LLM クライアントの設定（API キー等）は不要（dreaming 実装時に追加する）
- クライアントが異なる LLM を使っていても動作する（provider 非依存）
- dreaming フェーズ（Phase 2）では LLM を導入するが、MCP tool のレスポンスには影響しない
