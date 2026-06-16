# @archfill/tsumugi-setup

One-command installer for the tsumugi Claude Code plugin.

## Usage

```bash
npx @archfill/tsumugi-setup
```

Prompts for your `tsumugi` server URL (e.g. `https://tsumugi.archfill.com`), then:

1. Clones `archfill/tsumugi` to `~/.claude/plugins/marketplaces/archfill/`
2. Registers the marketplace in `~/.claude/plugins/known_marketplaces.json`
3. Registers the plugin in `~/.claude/plugins/installed_plugins.json`
4. Enables the plugin in `~/.claude/settings.json`
5. Writes `~/.config/tsumugi/credentials.json` with the URL

After running, restart Claude Code so the plugin is picked up.

## Options

```text
-u, --url <URL>          tsumugi server URL (skip prompt)
-y, --non-interactive    Skip prompts (requires --url)
-f, --force              Re-clone marketplace even if it already exists
-h, --help               Show help
```

## Examples

Interactive:

```bash
npx @archfill/tsumugi-setup
```

Non-interactive (CI / scripts):

```bash
npx @archfill/tsumugi-setup -u https://tsumugi.archfill.com -y
```

Force re-clone:

```bash
npx @archfill/tsumugi-setup -f
```

## What it installs

The tsumugi plugin includes:

- 3 inject-only hooks (SessionStart / UserPromptSubmit / PreToolUse(Read)) that surface past memory and guide save_observation calls
- The tsumugi MCP server (`save_observation`, `search_memory`, `trigger_dreaming`, `get_dreaming_status`) via `.mcp.json`

See [ADR-011](../../docs/adr/0011-hook-llm-placement.md) for the design rationale.

## Manual install (alternative)

If you prefer not to use npx, you can install the plugin manually via Claude Code commands:

```text
/plugin marketplace add archfill/tsumugi
/plugin install tsumugi@archfill
```

Then set the API URL:

```bash
# either env var
export TSUMUGI_API_URL=https://tsumugi.archfill.com

# or credentials file
mkdir -p ~/.config/tsumugi
cat > ~/.config/tsumugi/credentials.json <<EOF
{ "api_url": "https://tsumugi.archfill.com" }
EOF
```

## Zero dependencies

The installer is a single `bin/setup.mjs` file using only Node built-ins (`fs`, `path`, `readline`, `child_process`, `os`). No `node_modules`, no `package-lock.json` weight.

Requires Node.js 18+.

## License

Apache-2.0
