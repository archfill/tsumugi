# tsumugi memory — Codex plugin

Codex 用 tsumugi メモリ統合。Claude Code 版と同じ inject-only 設計 (ADR-011) を Codex の hook イベントモデルに合わせて wiring したもの。Python script 本体は `integrations/shared/scripts/` を再利用するので、Claude Code 版とロジックは完全に一致する。

## なぜこれが必要か

Codex は Claude Code と:

- Hook イベント名は同じ (SessionStart / UserPromptSubmit / PreToolUse / etc.)
- stdin payload の JSON 形式も同じ
- ただし **設定ディレクトリ** (`~/.codex/` vs `~/.claude/`)、**marketplace 形式** (`.agents/plugins/marketplace.json`)、**SessionStart matcher** (`resume` vs `clear`) が異なる

そのため hooks.json と plugin metadata は別に持つ。Python script は共有。

## 含まれるもの

### Hook (3 本、全部 inject-only)

| Hook               | matcher                    | 役割                                                                           |
| ------------------ | -------------------------- | ------------------------------------------------------------------------------ |
| `SessionStart`     | `startup\|resume\|compact` | 過去 memory + save rubric を inject。compact 時は recall-recovery nudge も追加 |
| `UserPromptSubmit` | `*`                        | resume / error pattern を検出 → `search_memory` で関連 memory を inject        |
| `PreToolUse`       | `Read`                     | 開いたファイル名で `search_memory` → 関連 memory を inject                     |

いずれも観測 (observation) を**作成しない**。

### MCP server

`.mcp.json` を同梱しているため、plugin install 時に **tsumugi MCP server が自動登録**される。エンドポイントは `${TSUMUGI_API_URL}/mcp`。

agent は以下の MCP tool を呼べる:

- `save_observation` — Layer 1 へ観測を保存
- `search_memory` — Layer 1 + Layer 2 を hybrid 検索
- `trigger_dreaming` — Layer 2 synthesize を手動起動
- `get_dreaming_status` — dreaming 履歴の取得

## インストール

### 推奨: npx 一発インストール

```bash
npx @archfill/tsumugi-cli install --platform=codex
```

または対話モード:

```bash
npx @archfill/tsumugi-cli install
# → 「Install for which platform?」 で Codex を選択
```

両方同時インストールも可:

```bash
npx @archfill/tsumugi-cli install --platform=both
```

詳細は [`@archfill/tsumugi-cli` README](../../apps/cli/README.md)。

### 手動インストール (代替)

1. このリポを Codex marketplace ディレクトリに clone

   ```bash
   mkdir -p ~/.codex/plugins/marketplaces
   git clone https://github.com/archfill/tsumugi ~/.codex/plugins/marketplaces/archfill
   ```

2. Codex CLI で marketplace を登録

   ```bash
   codex plugin marketplace add ~/.codex/plugins/marketplaces/archfill
   ```

3. tsumugi server URL を設定

   ```bash
   export TSUMUGI_API_URL=https://tsumugi.example.com
   # または
   mkdir -p ~/.config/tsumugi && cat > ~/.config/tsumugi/credentials.json <<EOF
   { "api_url": "https://tsumugi.example.com" }
   EOF
   ```

## 関連

- [ADR-011](../../docs/adr/0011-hook-llm-placement.md) — inject-only 3 hook 設計の根拠
- [`integrations/claude-code/README.md`](../claude-code/README.md) — Claude Code 版 (同じロジック)
- [`integrations/shared/scripts/`](../shared/scripts/) — 共有 Python script
