#!/usr/bin/env node
/**
 * @archfill/tsumugi-cli
 *
 * CLI for the tsumugi memory plugin (Claude Code & Codex).
 *
 * Subcommands:
 *   install  — Register marketplace + plugin, write credentials, enable hooks (default)
 *   doctor   — (planned) Diagnose the local setup
 *   update   — Refresh marketplace/plugin registrations
 *   uninstall — (planned) Remove the plugin
 *
 * Usage:
 *   npx @archfill/tsumugi-cli install
 *   npx @archfill/tsumugi-cli install --platform=both --url https://tsumugi.example.com -y
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { argv, env, exit, stdout } from "node:process";

import * as p from "@clack/prompts";
import pc from "picocolors";

const MARKETPLACE_NAME = "archfill";
const PLUGIN_ID = "tsumugi";
const PLUGIN_VERSION = "0.1.0";
const REPO = "archfill/tsumugi";
const REPO_REF = "main";
const CLAUDE_PLUGIN_SOURCE_SUBDIR = "integrations/claude-code";

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

const claudeDir = () => env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
const claudePluginsDir = () => join(claudeDir(), "plugins");
const knownMarketplacesPath = () =>
  join(claudePluginsDir(), "known_marketplaces.json");
const installedPluginsPath = () =>
  join(claudePluginsDir(), "installed_plugins.json");
const claudeSettingsPath = () => join(claudeDir(), "settings.json");
const claudeMarketplaceCloneDir = () =>
  join(claudePluginsDir(), "marketplaces", MARKETPLACE_NAME);
const claudePluginSourceDir = () =>
  join(claudeMarketplaceCloneDir(), CLAUDE_PLUGIN_SOURCE_SUBDIR);

const codexDir = () => env.CODEX_HOME || join(homedir(), ".codex");
const codexConfigPath = () => join(codexDir(), "config.toml");

const credentialsPath = () =>
  join(homedir(), ".config", "tsumugi", "credentials.json");

// ---------------------------------------------------------------------------
// CLI dispatcher
// ---------------------------------------------------------------------------

const PLATFORM_VALUES = new Set(["claude", "codex", "both"]);

function printRootHelp() {
  console.log(`tsumugi-cli — Claude Code & Codex memory plugin management

Usage:
  npx @archfill/tsumugi-cli <command> [options]
  npx @archfill/tsumugi-cli            # defaults to 'install'

Commands:
  install     Register marketplace + plugin and write credentials
  update      Refresh marketplace/plugin registrations
  help        Show help for a command

Run 'tsumugi-cli <command> --help' for command-specific options.
`);
}

function printInstallHelp() {
  console.log(`tsumugi-cli install — Set up the tsumugi memory plugin

Usage:
  npx @archfill/tsumugi-cli install [options]

Options:
  -u, --url <URL>           tsumugi server URL (e.g. https://tsumugi.example.com)
  -p, --platform <kind>     Target platform: claude | codex | both
                            (default: prompted; both when --non-interactive)
  -y, --non-interactive     Skip prompts (requires --url; --platform optional)
  -f, --force               Re-clone Claude Code marketplace even if it already exists
  -h, --help                Show this help

Examples:
  npx @archfill/tsumugi-cli install
  npx @archfill/tsumugi-cli install --url https://tsumugi.example.com
  npx @archfill/tsumugi-cli install -u https://tsumugi.example.com -p both -y
`);
}

function printUpdateHelp() {
  console.log(`tsumugi-cli update — Refresh installed tsumugi marketplace/plugin

Usage:
  npx @archfill/tsumugi-cli update [options]

Options:
  -p, --platform <kind>     Target platform: claude | codex | both
                            (default: both)
  -h, --help                Show this help

Examples:
  npx @archfill/tsumugi-cli update
  npx @archfill/tsumugi-cli update --platform=codex
`);
}

function parseInstallArgs(rest) {
  let url;
  let platform;
  let nonInteractive = false;
  let force = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--url" || a === "-u") {
      url = rest[++i];
    } else if (a.startsWith("--url=")) {
      url = a.slice("--url=".length);
    } else if (a === "--platform" || a === "-p") {
      platform = rest[++i];
    } else if (a.startsWith("--platform=")) {
      platform = a.slice("--platform=".length);
    } else if (a === "--non-interactive" || a === "-y") {
      nonInteractive = true;
    } else if (a === "--force" || a === "-f") {
      force = true;
    } else if (a === "--help" || a === "-h") {
      printInstallHelp();
      exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      printInstallHelp();
      exit(1);
    }
  }
  if (platform && !PLATFORM_VALUES.has(platform)) {
    console.error(`Invalid --platform: ${platform} (expected: claude, codex, both)`);
    exit(1);
  }
  return { url, platform, nonInteractive, force };
}

function parsePlatformOnlyArgs(rest, commandHelp) {
  let platform;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--platform" || a === "-p") {
      platform = rest[++i];
    } else if (a.startsWith("--platform=")) {
      platform = a.slice("--platform=".length);
    } else if (a === "--help" || a === "-h") {
      commandHelp();
      exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      commandHelp();
      exit(1);
    }
  }
  if (platform && !PLATFORM_VALUES.has(platform)) {
    console.error(`Invalid --platform: ${platform} (expected: claude, codex, both)`);
    exit(1);
  }
  return { platform: platform || "both" };
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

function writeAtomic(path, contents, suffix = "") {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(
    dir,
    `tsumugi-cli-${Date.now()}-${Math.random().toString(36).slice(2)}${suffix}`,
  );
  writeFileSync(tmp, contents, "utf-8");
  renameSync(tmp, path);
}

function writeJsonAtomic(path, value) {
  writeAtomic(path, JSON.stringify(value, null, 2) + "\n", ".json");
}

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

function runAsync(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "pipe", ...options });
    let stderr = "";
    if (child.stderr) child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `${cmd} ${args.join(" ")} failed with exit ${code}${stderr ? "\n" + stderr.trim() : ""}`,
          ),
        );
    });
  });
}

function commandExists(cmd) {
  const which = process.platform === "win32" ? "where" : "which";
  const res = spawnSync(which, [cmd], { stdio: "ignore" });
  return res.status === 0;
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

function validateUrlForPrompt(raw) {
  if (normalizeUrl(raw) == null) return "Please enter a valid http(s) URL";
}

// ---------------------------------------------------------------------------
// Install helpers (Claude Code)
// ---------------------------------------------------------------------------

async function cloneRepo(targetDir, force, taskMessage) {
  if (existsSync(targetDir) && !force) {
    taskMessage?.(`Updating existing clone at ${targetDir}`);
    try {
      await runAsync("git", ["-C", targetDir, "pull", "--ff-only"]);
      return "Updated existing marketplace clone";
    } catch (e) {
      return `Pull failed (${truncate(e.message, 80)}); existing clone kept`;
    }
  }
  if (existsSync(targetDir) && force) {
    taskMessage?.(`Removing existing clone at ${targetDir}`);
    await runAsync("rm", ["-rf", targetDir]);
  }
  ensureDir(dirname(targetDir));
  taskMessage?.(`Cloning ${REPO} → ${targetDir}`);
  await runAsync("git", [
    "clone",
    "--depth",
    "1",
    `https://github.com/${REPO}.git`,
    targetDir,
  ]);
  return "Marketplace cloned";
}

function registerClaudeMarketplace() {
  const known = readJsonSafe(knownMarketplacesPath(), {});
  known[MARKETPLACE_NAME] = {
    source: { source: "github", repo: REPO },
    installLocation: claudeMarketplaceCloneDir(),
    lastUpdated: new Date().toISOString(),
    autoUpdate: true,
  };
  ensureDir(claudePluginsDir());
  writeJsonAtomic(knownMarketplacesPath(), known);
}

function registerClaudePlugin() {
  const installed = readJsonSafe(installedPluginsPath(), {});
  if (!installed.version) installed.version = 2;
  if (!installed.plugins) installed.plugins = {};
  const now = new Date().toISOString();
  installed.plugins[`${PLUGIN_ID}@${MARKETPLACE_NAME}`] = [
    {
      scope: "user",
      installPath: claudePluginSourceDir(),
      version: PLUGIN_VERSION,
      installedAt: now,
      lastUpdated: now,
    },
  ];
  writeJsonAtomic(installedPluginsPath(), installed);
}

function enableClaudePluginInSettings(url) {
  const settings = readJsonSafe(claudeSettingsPath(), {});
  if (!settings.enabledPlugins || typeof settings.enabledPlugins !== "object") {
    settings.enabledPlugins = {};
  }
  settings.enabledPlugins[`${PLUGIN_ID}@${MARKETPLACE_NAME}`] = true;
  // Propagate TSUMUGI_API_URL to Claude Code's process env so the MCP server
  // entry's `${TSUMUGI_API_URL}/mcp` placeholder resolves. Without this, the
  // MCP connection reports "Missing environment variables: TSUMUGI_API_URL".
  if (url) {
    if (!settings.env || typeof settings.env !== "object") settings.env = {};
    settings.env.TSUMUGI_API_URL = url;
  }
  writeJsonAtomic(claudeSettingsPath(), settings);
}

// ---------------------------------------------------------------------------
// Install helpers (Codex)
// ---------------------------------------------------------------------------

function isCodexCliAvailable() {
  return commandExists("codex");
}

function runCodex(args, { allowedErrorPatterns = [] } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("codex", args, { stdio: "pipe" });
    let stderr = "";
    if (child.stderr) child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) return resolve();
      if (allowedErrorPatterns.some((re) => re.test(stderr))) return resolve();
      reject(
        new Error(
          `codex ${args.join(" ")} failed with exit ${code}${stderr ? "\n" + stderr.trim() : ""}`,
        ),
      );
    });
  });
}

async function registerCodexMarketplace() {
  // Register as a Git marketplace so `codex plugin marketplace upgrade archfill`
  // can refresh the snapshot later. Re-running is benign; Codex also migrates
  // an existing local-path marketplace entry for the same name to this source.
  await runCodex(["plugin", "marketplace", "add", REPO, "--ref", REPO_REF], {
    allowedErrorPatterns: [/already added/i, /different source/i],
  });
}

async function installCodexPlugin() {
  // `codex plugin add` is what actually flips
  // `[plugins."tsumugi@archfill"] enabled = true` in config.toml. Without it,
  // the marketplace entry is registered but hooks never load — which is the
  // failure mode reported in the wild for v0.1.1 (PR #30 only configured the
  // marketplace and the standalone MCP server entry).
  await runCodex(
    ["plugin", "add", `${PLUGIN_ID}@${MARKETPLACE_NAME}`],
    {
      allowedErrorPatterns: [
        /already installed/i,
        /already enabled/i,
        /already present/i,
      ],
    },
  );
}

async function upgradeCodexMarketplace() {
  await runCodex(["plugin", "marketplace", "upgrade", MARKETPLACE_NAME]);
}

/**
 * Render a `[mcp_servers.tsumugi]` section as TOML. Mirrors the literal-URL
 * style Codex uses for its built-in HTTP MCP entries (see e.g. mcp_servers.yui).
 */
function renderCodexTsumugiSection(url) {
  return [
    `[mcp_servers.${PLUGIN_ID}]`,
    `url = "${url}/mcp"`,
    `startup_timeout_sec = 20`,
    `tool_timeout_sec = 60`,
    ``,
    `[mcp_servers.${PLUGIN_ID}.tools.save_observation]`,
    `approval_mode = "approve"`,
    ``,
    `[mcp_servers.${PLUGIN_ID}.tools.search_memory]`,
    `approval_mode = "approve"`,
  ].join("\n");
}

/**
 * Idempotently write the Codex tsumugi MCP sections to ~/.codex/config.toml.
 *
 * Codex's config is TOML, not JSON. To avoid a TOML parser dependency while
 * still being safe, we do line-based section editing:
 *
 *   - If the managed `[mcp_servers.tsumugi]` sections already exist, replace
 *     them in place.
 *   - Otherwise append a fresh section at the end of the file.
 *
 * Comments and unrelated sections are preserved.
 */
function configureCodexMcp(url) {
  const path = codexConfigPath();
  const section = renderCodexTsumugiSection(url);
  const managedHeaders = new Set([
    `[mcp_servers.${PLUGIN_ID}]`,
    `[mcp_servers.${PLUGIN_ID}.tools.save_observation]`,
    `[mcp_servers.${PLUGIN_ID}.tools.search_memory]`,
  ]);

  if (!existsSync(path)) {
    ensureDir(dirname(path));
    writeAtomic(path, section + "\n");
    return "created";
  }

  const text = readFileSync(path, "utf-8");
  const lines = text.split("\n");
  const nextLines = [];
  let firstManagedIdx = -1;
  let removedAny = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*\[/.test(line) && managedHeaders.has(line.trim())) {
      removedAny = true;
      if (firstManagedIdx === -1) {
        firstManagedIdx = nextLines.length;
      }
      while (i + 1 < lines.length && !/^\s*\[/.test(lines[i + 1])) {
        i++;
      }
      continue;
    }
    nextLines.push(line);
  }

  if (!removedAny) {
    const sep = text.endsWith("\n") || text.length === 0 ? "" : "\n";
    writeAtomic(path, text + sep + "\n" + section + "\n");
    return "appended";
  }

  while (firstManagedIdx > 0 && nextLines[firstManagedIdx - 1].trim() === "") {
    nextLines.splice(firstManagedIdx - 1, 1);
    firstManagedIdx--;
  }
  while (
    firstManagedIdx < nextLines.length &&
    nextLines[firstManagedIdx].trim() === ""
  ) {
    nextLines.splice(firstManagedIdx, 1);
  }

  const replacement = section.split("\n");
  if (firstManagedIdx > 0) {
    replacement.unshift("");
  }
  if (firstManagedIdx < nextLines.length) {
    replacement.push("");
  }
  nextLines.splice(firstManagedIdx, 0, ...replacement);
  const merged = nextLines.join("\n");
  writeAtomic(path, merged.endsWith("\n") ? merged : merged + "\n");
  return "updated";
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

function writeCredentials(url) {
  const existing = readJsonSafe(credentialsPath(), {});
  const merged = { api_key: "", ...existing, api_url: url };
  writeJsonAtomic(credentialsPath(), merged);
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

function truncate(s, n) {
  if (!s) return s;
  return s.length <= n ? s : s.slice(0, n) + "…";
}

function platformLabel(p) {
  if (p === "claude") return "Claude Code";
  if (p === "codex") return "Codex";
  if (p === "both") return "Claude Code + Codex";
  return p;
}

// ---------------------------------------------------------------------------
// Install command
// ---------------------------------------------------------------------------

async function runInstall(rest) {
  const opts = parseInstallArgs(rest);
  const interactive = !opts.nonInteractive;

  if (opts.nonInteractive && !opts.url) {
    console.error(pc.red("✗ --non-interactive requires --url"));
    exit(1);
  }

  p.intro(pc.bgCyan(pc.black(" tsumugi-cli install ")));

  // ---- URL ----
  let url = opts.url ? normalizeUrl(opts.url) : null;
  if (!url) {
    const answer = await p.text({
      message: "tsumugi server URL",
      placeholder: "https://tsumugi.example.com",
      validate: validateUrlForPrompt,
    });
    if (p.isCancel(answer)) {
      p.cancel("Cancelled");
      exit(0);
    }
    url = normalizeUrl(answer);
  }

  // ---- Platform ----
  let platform = opts.platform;
  if (!platform) {
    if (interactive) {
      const answer = await p.select({
        message: "Install for which platform?",
        options: [
          { value: "claude", label: "Claude Code" },
          { value: "codex", label: "Codex" },
          { value: "both", label: "Both (Claude Code + Codex)", hint: "default" },
        ],
        initialValue: "both",
      });
      if (p.isCancel(answer)) {
        p.cancel("Cancelled");
        exit(0);
      }
      platform = answer;
    } else {
      platform = "both";
    }
  }

  const installClaude = platform === "claude" || platform === "both";
  const installCodex = platform === "codex" || platform === "both";

  // ---- Pre-flight ----
  p.log.info(`Using tsumugi server: ${pc.cyan(url)}`);
  p.log.info(`Installing for: ${pc.cyan(platformLabel(platform))}`);

  if (installCodex && !isCodexCliAvailable()) {
    p.log.warn(
      "codex CLI not found on PATH. Codex marketplace registration will be skipped.",
    );
    p.log.warn(
      `Install Codex first, then re-run: npx @archfill/tsumugi-cli install --platform=codex`,
    );
  }

  // ---- Steps ----
  const tasks = [];

  if (installClaude) {
    tasks.push({
      title: "Cloning marketplace for Claude Code",
      task: async (msg) => {
        return await cloneRepo(claudeMarketplaceCloneDir(), opts.force, msg);
      },
    });
    tasks.push({
      title: "Registering Claude Code marketplace + plugin",
      task: async () => {
        if (!existsSync(claudePluginSourceDir())) {
          throw new Error(
            `expected plugin source at ${claudePluginSourceDir()} but it does not exist`,
          );
        }
        registerClaudeMarketplace();
        registerClaudePlugin();
        enableClaudePluginInSettings(url);
        return "Claude Code plugin registered, enabled, and TSUMUGI_API_URL exported via settings.json env";
      },
    });
  }

  if (installCodex) {
    if (isCodexCliAvailable()) {
      tasks.push({
        title: "Registering Codex Git marketplace",
        task: async () => {
          await registerCodexMarketplace();
          return `Codex marketplace registered via \`codex plugin marketplace add ${REPO} --ref ${REPO_REF}\``;
        },
      });
      tasks.push({
        title: "Installing Codex plugin",
        task: async () => {
          await installCodexPlugin();
          return `Codex plugin ${PLUGIN_ID}@${MARKETPLACE_NAME} installed and enabled via \`codex plugin add\``;
        },
      });
    } else {
      tasks.push({
        title: "Skipping Codex CLI registration (codex not on PATH)",
        task: async () =>
          `Codex marketplace not registered — run \`codex plugin marketplace add ${REPO} --ref ${REPO_REF} && codex plugin add ${PLUGIN_ID}@${MARKETPLACE_NAME}\` after installing Codex`,
      });
    }
    tasks.push({
      title: "Configuring Codex MCP server entry",
      task: async () => {
        const verb = configureCodexMcp(url);
        return `Codex config.toml ${verb} (mcp_servers.${PLUGIN_ID} → ${url}/mcp, save_observation/search_memory approved)`;
      },
    });
  }

  tasks.push({
    title: "Writing credentials",
    task: async () => {
      writeCredentials(url);
      return `Wrote ${credentialsPath()}`;
    },
  });

  try {
    await p.tasks(tasks);
  } catch (e) {
    p.cancel(pc.red(`Install failed: ${e.message}`));
    exit(1);
  }

  p.outro(pc.green("✓ tsumugi-cli install complete"));

  const lines = ["", pc.dim("Next steps:")];
  if (installClaude) {
    lines.push(
      `  ${pc.cyan("Claude Code")}: restart Claude Code so the new plugin and TSUMUGI_API_URL env are picked up.`,
    );
  }
  if (installCodex) {
    lines.push(
      `  ${pc.cyan("Codex")}: restart Codex (or open a fresh session) to pick up the tsumugi MCP server.`,
    );
    lines.push(
      `     ${pc.yellow("⚠")} On the first session, Codex will prompt to ${pc.bold("trust the bundled hooks")} (SessionStart / UserPromptSubmit / PreToolUse). Approve to enable them — until trusted, plugin hooks are skipped silently.`,
    );
    lines.push(
      `     Docs: https://developers.openai.com/codex/hooks#plugin-bundled-hooks`,
    );
  }
  lines.push("");
  lines.push(pc.dim("Settings written:"));
  if (installClaude) {
    lines.push(`  marketplace:   ${knownMarketplacesPath()}`);
    lines.push(`  installed:     ${installedPluginsPath()}`);
    lines.push(
      `  settings:      ${claudeSettingsPath()} (enabledPlugins + env.TSUMUGI_API_URL)`,
    );
  }
  if (installCodex) {
    lines.push(`  codex source:  ${REPO} @ ${REPO_REF}`);
    lines.push(
      `  codex config:  ${codexConfigPath()} (mcp_servers.${PLUGIN_ID})`,
    );
  }
  lines.push(`  credentials:   ${credentialsPath()}`);
  lines.push("");
  lines.push(
    pc.dim("Docs: https://github.com/archfill/tsumugi/tree/main/integrations"),
  );
  stdout.write(lines.join("\n") + "\n");
}

async function runUpdate(rest) {
  const opts = parsePlatformOnlyArgs(rest, printUpdateHelp);
  const platform = opts.platform;
  const updateClaude = platform === "claude" || platform === "both";
  const updateCodex = platform === "codex" || platform === "both";

  p.intro(pc.bgCyan(pc.black(" tsumugi-cli update ")));
  p.log.info(`Updating for: ${pc.cyan(platformLabel(platform))}`);

  const tasks = [];

  if (updateClaude) {
    tasks.push({
      title: "Updating Claude Code marketplace clone",
      task: async (msg) => {
        if (!existsSync(claudeMarketplaceCloneDir())) {
          throw new Error(
            `Claude Code marketplace clone not found at ${claudeMarketplaceCloneDir()}; run install first`,
          );
        }
        return await cloneRepo(claudeMarketplaceCloneDir(), false, msg);
      },
    });
    tasks.push({
      title: "Refreshing Claude Code marketplace + plugin metadata",
      task: async () => {
        if (!existsSync(claudePluginSourceDir())) {
          throw new Error(
            `expected plugin source at ${claudePluginSourceDir()} but it does not exist`,
          );
        }
        registerClaudeMarketplace();
        registerClaudePlugin();
        return "Claude Code marketplace/plugin metadata refreshed";
      },
    });
  }

  if (updateCodex) {
    if (!isCodexCliAvailable()) {
      tasks.push({
        title: "Skipping Codex update (codex not on PATH)",
        task: async () =>
          `Run \`codex plugin marketplace add ${REPO} --ref ${REPO_REF} && codex plugin marketplace upgrade ${MARKETPLACE_NAME} && codex plugin add ${PLUGIN_ID}@${MARKETPLACE_NAME}\` after installing Codex`,
      });
    } else {
      tasks.push({
        title: "Ensuring Codex Git marketplace registration",
        task: async () => {
          await registerCodexMarketplace();
          return `Codex marketplace registered as ${REPO} @ ${REPO_REF}`;
        },
      });
      tasks.push({
        title: "Upgrading Codex marketplace snapshot",
        task: async () => {
          await upgradeCodexMarketplace();
          return `Codex marketplace ${MARKETPLACE_NAME} upgraded`;
        },
      });
      tasks.push({
        title: "Refreshing Codex plugin install",
        task: async () => {
          await installCodexPlugin();
          return `Codex plugin ${PLUGIN_ID}@${MARKETPLACE_NAME} installed/enabled`;
        },
      });
    }
  }

  try {
    await p.tasks(tasks);
  } catch (e) {
    p.cancel(pc.red(`Update failed: ${e.message}`));
    exit(1);
  }

  p.outro(pc.green("✓ tsumugi-cli update complete"));
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

async function main() {
  const args = argv.slice(2);
  const firstArg = args[0];

  if (!firstArg || firstArg.startsWith("-")) {
    if (firstArg === "-h" || firstArg === "--help") {
      printRootHelp();
      exit(0);
    }
    await runInstall(args);
    return;
  }

  const cmd = firstArg;
  const rest = args.slice(1);

  switch (cmd) {
    case "install":
      await runInstall(rest);
      break;
    case "update":
      await runUpdate(rest);
      break;
    case "help":
      if (rest[0] === "install") printInstallHelp();
      else if (rest[0] === "update") printUpdateHelp();
      else printRootHelp();
      break;
    default:
      console.error(`Unknown command: ${cmd}`);
      printRootHelp();
      exit(1);
  }
}

main().catch((e) => {
  console.error(pc.red(`✗ ${e.message}`));
  exit(1);
});
