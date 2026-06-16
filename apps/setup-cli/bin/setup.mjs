#!/usr/bin/env node
/**
 * @archfill/tsumugi-setup
 *
 * One-command installer for the tsumugi Claude Code plugin.
 *
 * What it does:
 *   1. Prompts for TSUMUGI_API_URL (interactive) or accepts --url flag
 *   2. Clones / updates archfill/tsumugi at the Claude marketplace path
 *   3. Registers the marketplace in ~/.claude/plugins/known_marketplaces.json
 *   4. Registers the plugin in  ~/.claude/plugins/installed_plugins.json
 *   5. Enables the plugin in    ~/.claude/settings.json
 *   6. Writes credentials to    ~/.config/tsumugi/credentials.json
 *
 * Zero npm dependencies — uses only Node built-ins.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { argv, env, exit, stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";

const MARKETPLACE_NAME = "archfill";
const PLUGIN_ID = "tsumugi";
const PLUGIN_VERSION = "0.1.0";
const REPO = "archfill/tsumugi";
const PLUGIN_SOURCE_SUBDIR = "integrations/claude-code";

// ---------------------------------------------------------------------------
// Path helpers (mirror Claude Code internal conventions)
// ---------------------------------------------------------------------------

const claudeDir = () => env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
const pluginsDir = () => join(claudeDir(), "plugins");
const knownMarketplacesPath = () => join(pluginsDir(), "known_marketplaces.json");
const installedPluginsPath = () => join(pluginsDir(), "installed_plugins.json");
const claudeSettingsPath = () => join(claudeDir(), "settings.json");
const marketplaceCloneDir = () =>
  join(pluginsDir(), "marketplaces", MARKETPLACE_NAME);
const pluginSourceDir = () =>
  join(marketplaceCloneDir(), PLUGIN_SOURCE_SUBDIR);
const credentialsPath = () =>
  join(homedir(), ".config", "tsumugi", "credentials.json");

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = argv.slice(2);
  let url;
  let nonInteractive = false;
  let force = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--url" || a === "-u") {
      url = args[++i];
    } else if (a.startsWith("--url=")) {
      url = a.slice("--url=".length);
    } else if (a === "--non-interactive" || a === "-y") {
      nonInteractive = true;
    } else if (a === "--force" || a === "-f") {
      force = true;
    } else if (a === "--help" || a === "-h") {
      printHelp();
      exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      printHelp();
      exit(1);
    }
  }
  return { url, nonInteractive, force };
}

function printHelp() {
  console.log(`tsumugi-setup — Claude Code plugin installer

Usage:
  npx @archfill/tsumugi-setup [options]

Options:
  -u, --url <URL>          tsumugi server URL (e.g. https://tsumugi.archfill.com)
  -y, --non-interactive    Skip prompts (requires --url)
  -f, --force              Re-clone marketplace even if it already exists
  -h, --help               Show this help

Examples:
  npx @archfill/tsumugi-setup
  npx @archfill/tsumugi-setup --url https://tsumugi.archfill.com
  npx @archfill/tsumugi-setup -u https://tsumugi.example.com -y
`);
}

// ---------------------------------------------------------------------------
// I/O helpers
// ---------------------------------------------------------------------------

function readJsonSafe(path, fallback) {
  try {
    if (!existsSync(path)) return fallback;
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(
    tmpdir(),
    `tsumugi-setup-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", "utf-8");
  renameSync(tmp, path);
}

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

function run(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit", ...options });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else
        reject(new Error(`${cmd} ${args.join(" ")} failed with exit ${code}`));
    });
  });
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function normalizeUrl(raw) {
  if (!raw) return null;
  let url = raw.trim();
  if (!url) return null;
  if (!/^https?:\/\//.test(url)) {
    url = "https://" + url;
  }
  url = url.replace(/\/+$/, "");
  try {
    new URL(url);
  } catch {
    return null;
  }
  return url;
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

async function promptUrl(initial) {
  if (initial) {
    const normalized = normalizeUrl(initial);
    if (!normalized) {
      console.error(`Invalid URL: ${initial}`);
      exit(1);
    }
    return normalized;
  }
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    while (true) {
      const answer = await rl.question(
        "tsumugi server URL (e.g. https://tsumugi.archfill.com): ",
      );
      const normalized = normalizeUrl(answer);
      if (normalized) return normalized;
      console.log("  Invalid URL. Please try again.\n");
    }
  } finally {
    rl.close();
  }
}

async function cloneMarketplace(force) {
  const dir = marketplaceCloneDir();
  if (existsSync(dir) && !force) {
    console.log(`✓ marketplace already cloned at ${dir} (skipping clone, will pull)`);
    try {
      await run("git", ["-C", dir, "pull", "--ff-only"]);
    } catch (e) {
      console.warn(
        `  warning: git pull failed (${e.message}). Existing clone left as-is.`,
      );
    }
    return;
  }
  if (existsSync(dir) && force) {
    console.log(`Removing existing clone at ${dir}...`);
    await run("rm", ["-rf", dir]);
  }
  ensureDir(dirname(dir));
  console.log(`Cloning https://github.com/${REPO}.git → ${dir}`);
  await run("git", ["clone", "--depth", "1", `https://github.com/${REPO}.git`, dir]);
}

function registerMarketplace() {
  const known = readJsonSafe(knownMarketplacesPath(), {});
  known[MARKETPLACE_NAME] = {
    source: {
      source: "github",
      repo: REPO,
    },
    installLocation: marketplaceCloneDir(),
    lastUpdated: new Date().toISOString(),
    autoUpdate: true,
  };
  ensureDir(pluginsDir());
  writeJsonAtomic(knownMarketplacesPath(), known);
  console.log(`✓ registered marketplace '${MARKETPLACE_NAME}' in ${knownMarketplacesPath()}`);
}

function registerPlugin() {
  const installed = readJsonSafe(installedPluginsPath(), {});
  if (!installed.version) installed.version = 2;
  if (!installed.plugins) installed.plugins = {};
  const now = new Date().toISOString();
  installed.plugins[`${PLUGIN_ID}@${MARKETPLACE_NAME}`] = [
    {
      scope: "user",
      installPath: pluginSourceDir(),
      version: PLUGIN_VERSION,
      installedAt: now,
      lastUpdated: now,
    },
  ];
  writeJsonAtomic(installedPluginsPath(), installed);
  console.log(`✓ registered plugin '${PLUGIN_ID}@${MARKETPLACE_NAME}' in ${installedPluginsPath()}`);
}

function enablePluginInSettings() {
  const settings = readJsonSafe(claudeSettingsPath(), {});
  if (!settings.enabledPlugins || typeof settings.enabledPlugins !== "object") {
    settings.enabledPlugins = {};
  }
  settings.enabledPlugins[`${PLUGIN_ID}@${MARKETPLACE_NAME}`] = true;
  writeJsonAtomic(claudeSettingsPath(), settings);
  console.log(`✓ enabled plugin in ${claudeSettingsPath()}`);
}

function writeCredentials(url) {
  const existing = readJsonSafe(credentialsPath(), {});
  const merged = { api_key: "", ...existing, api_url: url };
  writeJsonAtomic(credentialsPath(), merged);
  console.log(`✓ wrote credentials to ${credentialsPath()}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs();
  console.log("\ntsumugi setup\n=============");

  if (opts.nonInteractive && !opts.url) {
    console.error("--non-interactive requires --url");
    exit(1);
  }

  const url = await promptUrl(opts.url);
  console.log(`\nUsing tsumugi server: ${url}\n`);

  try {
    await cloneMarketplace(opts.force);
  } catch (e) {
    console.error(`✗ marketplace clone failed: ${e.message}`);
    console.error("  hint: ensure 'git' is on PATH and you can reach github.com");
    exit(1);
  }

  if (!existsSync(pluginSourceDir())) {
    console.error(
      `✗ expected plugin source at ${pluginSourceDir()} but it does not exist`,
    );
    console.error(
      "  the marketplace clone is incomplete. try --force to re-clone.",
    );
    exit(1);
  }

  registerMarketplace();
  registerPlugin();
  enablePluginInSettings();
  writeCredentials(url);

  console.log(`
✓ tsumugi setup complete!

Next:
  1. Restart Claude Code (or close and reopen the project) so the new
     plugin is picked up.
  2. New sessions will inject past memory + a save_observation rubric
     automatically. Use the MCP tools (save_observation, search_memory,
     trigger_dreaming) directly when you want explicit memory writes.

Settings:
  marketplace: ${knownMarketplacesPath()}
  plugin:      ${installedPluginsPath()}
  settings:    ${claudeSettingsPath()}
  credentials: ${credentialsPath()}

For more details see:
  https://github.com/archfill/tsumugi/tree/main/integrations/claude-code
`);
}

main().catch((e) => {
  console.error(`✗ ${e.message}`);
  exit(1);
});
