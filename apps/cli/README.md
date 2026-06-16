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
  -f, --force               Re-clone marketplace even if it already exists
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

# Force re-clone
npx @archfill/tsumugi-cli install -f
```

### Planned

- `doctor` — Diagnose the local setup (Claude Code / Codex version, plugin presence, MCP connectivity, credentials file, etc.)
- `update` — Pull marketplace updates and refresh the installed plugin metadata
- `uninstall` — Remove the plugin registration and optionally delete the cloned marketplace
- `status` — Show the current installation state

## What `install` writes

| Platform    | Path                                         | Purpose                                 |
| ----------- | -------------------------------------------- | --------------------------------------- |
| Claude Code | `~/.claude/plugins/marketplaces/archfill/`   | Cloned `archfill/tsumugi` repo          |
| Claude Code | `~/.claude/plugins/known_marketplaces.json`  | Registers the `archfill` marketplace    |
| Claude Code | `~/.claude/plugins/installed_plugins.json`   | Registers the `tsumugi@archfill` plugin |
| Claude Code | `~/.claude/settings.json` (`enabledPlugins`) | Enables the plugin                      |
| Codex       | `~/.codex/plugins/marketplaces/archfill/`    | Cloned `archfill/tsumugi` repo          |
| Codex       | (via `codex plugin marketplace add`)         | Registers marketplace with Codex CLI    |
| Shared      | `~/.config/tsumugi/credentials.json`         | Stores the tsumugi server URL           |

All writes are atomic (temp file + rename) and merge with existing values rather than overwriting.

For Codex, registration is performed by spawning `codex plugin marketplace add <path>`. If the Codex CLI is not on `PATH`, the marketplace is cloned but registration is skipped with a hint to re-run after installing Codex.

## Plugin contents

The tsumugi plugin (both platforms) includes:

- 3 inject-only hooks (SessionStart / UserPromptSubmit / PreToolUse(Read)) that surface past memory and guide save_observation calls
- The tsumugi MCP server (`save_observation`, `search_memory`, `trigger_dreaming`, `get_dreaming_status`) via `.mcp.json`

See [ADR-011](../../docs/adr/0011-hook-llm-placement.md) for the design rationale.

## Manual install (alternative)

If you prefer not to use this CLI, you can install the plugin manually.

### Claude Code

```text
/plugin marketplace add archfill/tsumugi
/plugin install tsumugi@archfill
```

### Codex

```bash
git clone https://github.com/archfill/tsumugi ~/.codex/plugins/marketplaces/archfill
codex plugin marketplace add ~/.codex/plugins/marketplaces/archfill
```

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
