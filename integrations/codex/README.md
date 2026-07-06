# tsumugi memory — Codex plugin

Codex 用 tsumugi メモリ統合。Claude Code 版と同じ inject-only 設計 (ADR-011) を Codex の hook イベントモデルに合わせて wiring したもの。Python script は Codex / Claude Code で同じ内容を持つ。

## なぜこれが必要か

Codex は Claude Code と:

- Hook イベント名は同じ (SessionStart / UserPromptSubmit / PreToolUse / etc.)
- stdin payload の JSON 形式も同じ
- ただし **設定ディレクトリ** (`~/.codex/` vs `~/.claude/`)、**marketplace 形式** (`.agents/plugins/marketplace.json`)、**SessionStart matcher** (`resume` vs `clear`) が異なる

そのため hooks.json と plugin metadata は別に持つ。Python script は共有。

## 含まれるもの

### Hook

| Hook               | matcher                    | 役割                                                                           |
| ------------------ | -------------------------- | ------------------------------------------------------------------------------ |
| `SessionStart`     | `startup\|resume\|compact` | 過去 memory + save rubric を inject。compact 時は recall-recovery nudge も追加 |
| `UserPromptSubmit` | `*`                        | prompt を Layer 1 capture に保存。resume / error pattern では関連 memory も inject |
| `PreToolUse`       | `Read`                     | 開いたファイル名で `search_memory` → 関連 memory を inject                     |
| `PostToolUse`      | `Bash`                     | commit / push / merge / release の milestone command だけを Layer 1 capture に保存 |
| `PreCompact`       | `manual\|auto`             | compact 直前の transcript tail を Layer 1 capture に保存                        |
| `PostCompact`      | `manual\|auto`             | compact 後の transcript compacted record を Layer 1 capture に保存し、capture promotion を best-effort trigger |
| `Stop`             | `*`                        | session 終端 payload を Layer 1 capture に保存し、capture promotion を best-effort trigger |

hook は観測 (observation) を**直接作成しない**。自動保存は Layer 1 `captures` に限定し、後段の dreaming が必要なものだけ Layer 2 observation へ昇格する。

`SessionStart(compact)` は圧縮後に agent へ保存判断を促す inject、`PreCompact` / `PostCompact`
は圧縮境界の raw context を Layer 1 に退避する capture で、責務が異なる。

### MCP server

`.mcp.json` を同梱しているため、plugin install 時に **tsumugi MCP server が自動登録**される。エンドポイントは `${TSUMUGI_API_URL}/mcp`。

agent は以下の MCP tool を呼べる:

- `save_observation` — Layer 1 へ観測を保存
- `search_memory` — Layer 1 + Layer 2 を hybrid 検索。デフォルトは project-scoped recall
- `mark_memory_outdated` — 古くなった memory を次回 dreaming で archive 候補にする
- `trigger_dreaming` — Layer 2 synthesize を手動起動
- `get_dreaming_status` — dreaming 履歴の取得

### Agent が使う時の基本

- 過去文脈が必要なら、推測する前に `search_memory` を呼ぶ。
- `save_observation` は repo / session の内容を tsumugi server に永続化する外部送信。repo 固有の設計判断、debugging finding、設定事実、workflow、完了作業、既知の罠は保存対象として扱う。
- 保存時は止めるよりも、secret / credential / token / private key / 個人情報 / private endpoint / customer/user data / sensitive file content を除去・一般化し、短い要約として残す。生ログ、長いコード片、prompt 全文、command output 全文、private value の正確な値は保存しない。
- sensitive な正確値がないと意味が保てない場合は、保存せずにユーザーへ確認する。
- `save_observation` が approval review で拒否された場合、同じ保存を再試行したり別経路で迂回したりしない。保存したい内容を説明し、ユーザーの明示承認を得てから改めて呼ぶ。
- 通常は `filter.project_tag` を指定しない。サーバーが session / project から自動補完し、現在 project に閉じた recall になる。
- 別 project も含めて探す必要がある時だけ `filter: { "project_tag": null }` を渡す。これは project auto-fill の opt-out であり、`type` / `source` / `session_id` など他 filter は維持される。
- memory hit の `provenance` を見て、どの observation 由来かを確認してから判断する。
- 明らかに古い memory を見つけたら `mark_memory_outdated` を呼ぶ。即削除ではなく、次回 dreaming maintenance で archive される。

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

### ⚠ Codex の hook trust 承認

Codex は plugin-bundled hooks (bundled `hooks/hooks.json` の hook 群) を **手動 trust 承認後**にしか実行しません。install 直後の初回 session で SessionStart / UserPromptSubmit / PreToolUse(Read) / capture hooks の trust プロンプトが順次出るので、それぞれ approve してください。

trust 承認後の状態は `~/.codex/config.toml` の以下のセクションで確認できます。

```toml
[hooks.state."tsumugi@archfill:hooks/hooks.json:session_start:0:0"]
trusted_hash = "sha256:..."
```

参照: [OpenAI Codex Hooks: Plugin-bundled hooks](https://developers.openai.com/codex/hooks#plugin-bundled-hooks)

### 手動インストール (代替)

1. Codex CLI で Git marketplace 登録 + plugin install

   ```bash
   codex plugin marketplace add archfill/tsumugi --ref main
   codex plugin add tsumugi@archfill
   ```

   `codex plugin marketplace add` だけだと `[plugins."tsumugi@archfill"]` セクションに `enabled = true` が立たず hook が読み込まれない。`codex plugin add` まで実行して初めて plugin が有効化される。

2. 更新

   ```bash
   codex plugin marketplace upgrade archfill
   codex plugin add tsumugi@archfill
   ```

3. tsumugi MCP server を `~/.codex/config.toml` に追加 (任意・推奨)

   ```toml
   [mcp_servers.tsumugi]
   url = "https://tsumugi.example.com/mcp"
   startup_timeout_sec = 20
   tool_timeout_sec = 60

   [mcp_servers.tsumugi.tools.save_observation]
   approval_mode = "approve"

   [mcp_servers.tsumugi.tools.search_memory]
   approval_mode = "approve"
   ```

   `save_observation` / `search_memory` を `approve` にしておくと、信頼済みの tsumugi server への保存・検索が Codex の approval review 対象にならない。`mark_memory_outdated` / `trigger_dreaming` は別の副作用を持つため、必要になるまで `prompt` のままにする。

   `npx @archfill/tsumugi-cli install` を使えばこの追記は自動で行われる。

4. tsumugi server URL を credentials ファイルにも保存 (hook script が使う)

   ```bash
   mkdir -p ~/.config/tsumugi && cat > ~/.config/tsumugi/credentials.json <<EOF
   { "api_url": "https://tsumugi.example.com" }
   EOF
   ```

## 関連

- [ADR-011](../../docs/adr/0011-hook-llm-placement.md) — inject-only 3 hook 設計の根拠
- [`integrations/claude-code/README.md`](../claude-code/README.md) — Claude Code 版 (同じロジック)
- [`scripts/`](./scripts/) — Codex hook script
