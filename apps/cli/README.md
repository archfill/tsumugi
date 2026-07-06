# @archfill/tsumugi-cli

CLI for the tsumugi memory plugin (Claude Code & Codex). Install, manage, and diagnose your tsumugi setup in one command.

## Quick start

```bash
npx @archfill/tsumugi-cli install
```

Prompts for:

1. Your `tsumugi` server URL (e.g. `https://tsumugi.example.com`)
2. Which platform to install for: Claude Code / Codex / Both

Then registers the marketplace(s), installs the plugin(s), and writes credentials in one go.

After it finishes, restart Claude Code and/or Codex so the new plugin is picked up.

## Commands

### `install` (default)

Registers the marketplace and plugin for the selected platforms and writes credentials. Running `npx @archfill/tsumugi-cli` with no subcommand is equivalent to `install`.

```text
Options:
  -u, --url <URL>           tsumugi server URL (skip prompt)
  -p, --platform <kind>     claude | codex | both
                            (default: prompted; both when --non-interactive)
  -y, --non-interactive     Skip prompts (requires --url)
  -f, --force               Re-clone Claude Code marketplace even if it already exists
  -h, --help                Show help
```

Examples:

```bash
# Interactive (prompts for URL + platform)
npx @archfill/tsumugi-cli install

# Non-interactive (CI / scripts)
npx @archfill/tsumugi-cli install -u https://tsumugi.example.com -y

# Codex only
npx @archfill/tsumugi-cli install --platform=codex -u https://tsumugi.example.com -y

# Force re-clone (Claude Code marketplace clone only)
npx @archfill/tsumugi-cli install -f
```

### `update`

Refreshes installed marketplace/plugin registrations.

- Claude Code: pulls the local marketplace clone and refreshes `known_marketplaces.json` / `installed_plugins.json`.
- Codex: ensures `archfill/tsumugi --ref main` is registered as a Git marketplace, runs `codex plugin marketplace upgrade archfill`, then refreshes `tsumugi@archfill`.

```text
Options:
  -p, --platform <kind>     claude | codex | both
                            (default: both)
  -h, --help                Show help
```

Examples:

```bash
npx @archfill/tsumugi-cli update
npx @archfill/tsumugi-cli update --platform=codex
```

### Planned

- `doctor` — Diagnose the local setup (Claude Code / Codex version, plugin presence, MCP connectivity, credentials file, etc.)
- `uninstall` — Remove the plugin registration and optionally delete the cloned marketplace
- `status` — Show the current installation state

## What `install` writes

| Platform    | Path                                                | Purpose                                                 |
| ----------- | --------------------------------------------------- | ------------------------------------------------------- |
| Claude Code | `~/.claude/plugins/marketplaces/archfill/`          | Cloned `archfill/tsumugi` repo                          |
| Claude Code | `~/.claude/plugins/known_marketplaces.json`         | Registers the `archfill` marketplace                    |
| Claude Code | `~/.claude/plugins/installed_plugins.json`          | Registers the `tsumugi@archfill` plugin                 |
| Claude Code | `~/.claude/settings.json` (`enabledPlugins`, `env`) | Enables the plugin and exports `TSUMUGI_API_URL`        |
| Codex       | (via `codex plugin marketplace add archfill/tsumugi --ref main`) | Registers the Git marketplace with Codex CLI |
| Codex       | (via `codex plugin add tsumugi@archfill`)           | Installs and enables the plugin (sets `enabled = true`) |
| Codex       | `~/.codex/config.toml` (`[mcp_servers.tsumugi]`)    | Registers the tsumugi MCP server with the literal URL and approves `save_observation` / `search_memory` |
| Shared      | `~/.config/tsumugi/credentials.json`                | Stores the tsumugi server URL                           |

All writes are atomic (temp file + rename) and merge with existing values rather than overwriting.

For Codex, the CLI runs `codex plugin marketplace add archfill/tsumugi --ref main` and `codex plugin add tsumugi@archfill` in sequence. This registers a Git marketplace, so future updates can use `codex plugin marketplace upgrade archfill`. If the Codex CLI is not on `PATH`, the CLI prints the two commands you should run after installing Codex.

## Plugin contents

The tsumugi plugin (both platforms) includes:

- Inject hooks (SessionStart / UserPromptSubmit / PreToolUse(Read)) that surface past memory and guide save_observation calls
- Layer 1 capture hooks for durable safety-net capture; Codex also captures PreCompact / PostCompact boundaries
- The tsumugi MCP server (`save_observation`, `search_memory`, `mark_memory_outdated`, `trigger_dreaming`, `get_dreaming_status`) via `.mcp.json`

See [ADR-011](../../docs/adr/0011-hook-llm-placement.md) and [ADR-014](../../docs/adr/0014-three-layer-capture-promotion.md) for the design rationale.

## Manual install (alternative)

If you prefer not to use this CLI, you can install the plugin manually.

### Claude Code

```text
/plugin marketplace add archfill/tsumugi
/plugin install tsumugi@archfill
```

### Codex

```bash
codex plugin marketplace add archfill/tsumugi --ref main
codex plugin add tsumugi@archfill
```

`codex plugin marketplace add` だけだと `[plugins."tsumugi@archfill"]` セクションに `enabled = true` が立たず hook が読み込まれない。`codex plugin add` まで実行して plugin を install する。

Codex plugin 更新:

```bash
codex plugin marketplace upgrade archfill
codex plugin add tsumugi@archfill
```

`[mcp_servers.tsumugi]` を `~/.codex/config.toml` に追記する場合 (CLI が自動でやる内容):

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

`save_observation` は memory 保存の中核なので、信頼済みの tsumugi server に対しては Codex の approval review 対象にしない設定にしている。`mark_memory_outdated` / `trigger_dreaming` は別の副作用を持つため、CLI は自動承認しない。

### Set the tsumugi server URL (both)

```bash
# either env var
export TSUMUGI_API_URL=https://tsumugi.example.com

# or credentials file
mkdir -p ~/.config/tsumugi
cat > ~/.config/tsumugi/credentials.json <<EOF
{ "api_url": "https://tsumugi.example.com" }
EOF
```

## Dependencies

Uses [`@clack/prompts`](https://www.npmjs.com/package/@clack/prompts) for polished interactive prompts and spinners, and [`picocolors`](https://www.npmjs.com/package/picocolors) for terminal coloring. Both are small and well-maintained.

Requires Node.js 18+.

## License

Apache-2.0
