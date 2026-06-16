# @archfill/tsumugi-cli

CLI for the tsumugi Claude Code plugin. Install, manage, and diagnose your tsumugi setup in one command.

## Quick start

```bash
npx @archfill/tsumugi-cli install
```

Prompts for your `tsumugi` server URL (e.g. `https://tsumugi.example.com`), then registers the marketplace, installs the plugin, and writes credentials in one go.

After it finishes, restart Claude Code so the plugin is picked up.

## Commands

### `install` (default)

Registers the marketplace, installs the plugin, and writes credentials. Running `npx @archfill/tsumugi-cli` with no subcommand is equivalent to `install`.

```text
Options:
  -u, --url <URL>          tsumugi server URL (skip prompt)
  -y, --non-interactive    Skip prompts (requires --url)
  -f, --force              Re-clone marketplace even if it already exists
  -h, --help               Show help
```

Examples:

```bash
# Interactive
npx @archfill/tsumugi-cli install

# Non-interactive (CI / scripts)
npx @archfill/tsumugi-cli install -u https://tsumugi.example.com -y

# Force re-clone
npx @archfill/tsumugi-cli install -f
```

### Planned

- `doctor` — Diagnose the local setup (Claude Code version, plugin presence, MCP connectivity, credentials file, etc.)
- `update` — Pull marketplace updates and refresh the installed plugin metadata
- `uninstall` — Remove the plugin registration and optionally delete the cloned marketplace
- `status` — Show the current installation state

## What `install` writes

| Path                                         | Purpose                                 |
| -------------------------------------------- | --------------------------------------- |
| `~/.claude/plugins/marketplaces/archfill/`   | Cloned `archfill/tsumugi` repo          |
| `~/.claude/plugins/known_marketplaces.json`  | Registers the `archfill` marketplace    |
| `~/.claude/plugins/installed_plugins.json`   | Registers the `tsumugi@archfill` plugin |
| `~/.claude/settings.json` (`enabledPlugins`) | Enables the plugin                      |
| `~/.config/tsumugi/credentials.json`         | Stores the tsumugi server URL           |

All writes are atomic (temp file + rename) and merge with existing values rather than overwriting.

## Plugin contents

The tsumugi Claude Code plugin includes:

- 3 inject-only hooks (SessionStart / UserPromptSubmit / PreToolUse(Read)) that surface past memory and guide save_observation calls
- The tsumugi MCP server (`save_observation`, `search_memory`, `trigger_dreaming`, `get_dreaming_status`) via `.mcp.json`

See [ADR-011](../../docs/adr/0011-hook-llm-placement.md) for the design rationale.

## Manual install (alternative)

If you prefer not to use this CLI, you can install the plugin manually via Claude Code commands:

```text
/plugin marketplace add archfill/tsumugi
/plugin install tsumugi@archfill
```

Then set the API URL:

```bash
# either env var
export TSUMUGI_API_URL=https://tsumugi.example.com

# or credentials file
mkdir -p ~/.config/tsumugi
cat > ~/.config/tsumugi/credentials.json <<EOF
{ "api_url": "https://tsumugi.example.com" }
EOF
```

## Zero dependencies

The CLI is a single `bin/cli.mjs` file using only Node built-ins (`fs`, `path`, `readline`, `child_process`, `os`). No `node_modules`, no `package-lock.json` weight.

Requires Node.js 18+.

## License

Apache-2.0
