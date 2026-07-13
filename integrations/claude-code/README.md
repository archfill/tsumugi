# tsumugi memory — Claude Code plugin

Claude Code 用 tsumugi メモリ統合。inject hook に加え、Layer 1 へ deterministic capture を保存する。
hook は observation を直接作らず LLM も起動しない。観測の primary path は **agent 自身が MCP
tool で呼ぶ**方式を維持し、capture は scheduled dreaming で選別する (ADR-011 / ADR-014)。

Python script は [Codex 版](../codex/README.md) と同じ内容を持つ。

## なぜこの設計か

詳細は [`docs/adr/0011-hook-llm-placement.md`](../../docs/adr/0011-hook-llm-placement.md) 参照。要約:

- **観測作成 hook は採用しない** (yui 統合で実証された Layer 1 32% 汚染を構造的に回避)
- **新規 LLM 呼出を hook から発動しない** (direction-b / ADR-003 整合)
- **agent の既存 LLM セッションに rubric + 検索結果を inject** することで、agent 主導の `save_observation` 呼出を促す
- **inject**: SessionStart / UserPromptSubmit / PreToolUse(Read)
- **capture**: UserPromptSubmit / milestone PostToolUse / Stop checkpoint

## 含まれるもの

### Hook

| Hook               | matcher                   | 役割                                                                           |
| ------------------ | ------------------------- | ------------------------------------------------------------------------------ |
| `SessionStart`     | `startup\|clear\|compact` | 過去 memory、未昇格 continuity checkpoint、save rubric を bounded inject      |
| `UserPromptSubmit` | `*`                       | prompt を Layer 1 capture に保存し、必要時は関連 memory も inject              |
| `PreToolUse`       | `Read`                    | 開いたファイル名で `search_memory` → 関連 memory を inject                     |
| `PostToolUse`      | `Bash`                    | commit / push / merge / release の milestone だけを Layer 1 capture に保存     |
| `Stop`             | `*`                       | completed turn checkpoint と final response を Layer 1 capture に保存          |

いずれも観測 (observation) を**直接作成せず、LLM promotion も起動しない**。

### MCP server (`save_observation` / `search_memory` 等)

plugin に `.mcp.json` を同梱しているため、`/plugin install` 時に **tsumugi MCP server が自動登録**される。エンドポイントは `${TSUMUGI_API_URL}/mcp` (HTTP Streamable transport)。

agent はこれを通じて以下の MCP tool を呼べる:

- `save_observation` — Layer 2 へ観測を保存 (rubric の呼出先)
- `search_memory` — Layer 2 + Layer 3 を hybrid 検索。デフォルトは project-scoped recall
- `mark_memory_outdated` — 古くなった memory を次回 dreaming で archive 候補にする
- `trigger_dreaming` — Layer 2 synthesize を手動起動
- `get_dreaming_status` — dreaming 履歴の取得

### Agent が使う時の基本

- 過去文脈が必要なら、推測する前に `search_memory` を呼ぶ。
- 通常は `filter.project_tag` を指定しない。サーバーが session / project から自動補完し、現在 project に閉じた recall になる。
- 別 project も含めて探す必要がある時だけ `filter: { "project_tag": null }` を渡す。これは project auto-fill の opt-out であり、`type` / `source` / `session_id` など他 filter は維持される。
- memory hit の `provenance` を見て、どの observation 由来かを確認してから判断する。
- 明らかに古い memory を見つけたら `mark_memory_outdated` を呼ぶ。即削除ではなく、次回 dreaming maintenance で archive される。

## インストール

### 推奨: npx 一発インストール

```bash
npx @archfill/tsumugi-cli install
```

対話で tsumugi server URL を聞かれるので入力するだけ。以下を自動で設定:

- marketplace 登録 (`~/.claude/plugins/known_marketplaces.json`)
- plugin install 登録 (`~/.claude/plugins/installed_plugins.json`)
- settings.json の enabledPlugins (`~/.claude/settings.json`)
- credentials (`~/.config/tsumugi/credentials.json`)

非対話オプション:

```bash
npx @archfill/tsumugi-cli install -u https://tsumugi.example.com -y
```

将来サブコマンド (`doctor` / `update` / `uninstall` / `status` 等) を追加できるよう、CLI として汎用化している。詳細は [`@archfill/tsumugi-cli` README](../../apps/cli/README.md) を参照。

### 手動インストール (代替)

`npx` を使いたくない場合:

1. Claude Code で marketplace と plugin を登録

   ```text
   /plugin marketplace add archfill/tsumugi
   /plugin install tsumugi@archfill
   ```

2. tsumugi サーバ接続情報を設定 (どちらか一方)

   ```bash
   # A. 環境変数
   export TSUMUGI_API_URL=https://tsumugi.example.com
   ```

   または

   ```bash
   # B. credentials ファイル
   mkdir -p ~/.config/tsumugi && cat > ~/.config/tsumugi/credentials.json <<EOF
   { "api_url": "https://tsumugi.example.com" }
   EOF
   ```

`TSUMUGI_API_KEY` は tsumugi server が認証を要求する場合のみ設定 (tsumugi はリバースプロキシ側で IP / VPN 制限する設計を前提とした optional 認証)。

### 3. 確認

新しい Claude Code セッションを開始すると、上部に以下のような追加コンテキストが表示される:

```
# tsumugi context — project: git@github.com:archfill/tsumugi.git
## Past memory (project-scoped search)
- #abc12345 (memory) ...
- #def67890 (observation) ...

# tsumugi memory — guidance
| Situation | type | Example |
| ... rubric ... |
```

## 実装メモ

### 依存

`python3` のみ。標準ライブラリの `urllib` でリクエストを発行する。`requests` などの third-party は使わない。

### fail-open

すべての hook は失敗時に `exit 0` を返し、Claude Code は決してブロックされない。tsumugi が落ちていても session は通常通り動く。

### secrets sanitize

`UserPromptSubmit` で prompt を search query に使う前に `SECRETS_RE` で簡易マスキングする (`Authorization`, `Bearer`, `password=`, `eyJ...` JWT 等)。

### timeout

各 hook はデフォルト 2.0 秒で打ち切る。`TSUMUGI_HOOK_TIMEOUT` 環境変数で上書き可能。

## トラブルシュート

### Hook が動いていないように見える

1. `claude` 設定で plugin が enable されているか確認 (`/plugin`)
2. `TSUMUGI_API_URL` が設定されているか確認
3. tsumugi server (`/api/observations` 等) に curl で到達できるか確認
4. デバッグログ:
   ```bash
   export TSUMUGI_DEBUG=1
   ```
   (現状未実装、必要なら実装する)

### inject が context を圧迫する

- `MEMORY_LIMIT` / `OBSERVATION_LIMIT` を `scripts/session_start.py` で調整
- `SEARCH_LIMIT` を各 hook script で調整

### tsumugi に認証を後から追加する場合

`_lib.py` の `_bearer_headers()` が `TSUMUGI_API_KEY` を Bearer として送る。tsumugi server 側で middleware を追加するだけで対応可能。

## 関連

- [ADR-011: Claude Code hook 設計](../../docs/adr/0011-hook-llm-placement.md)
- [ADR-003: thin tool, client LLM delegation](../../docs/adr/0003-thin-tool-client-llm-delegation.md)
- [ADR-010: Phase 4 yui migration strategy](../../docs/adr/0010-phase4-yui-migration-strategy.md)
