import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const testDir = dirname(fileURLToPath(import.meta.url));
const serverRoot = resolve(testDir, "../..");
const repoRoot = resolve(serverRoot, "../..");

describe("server-wide zero LLM boundary", () => {
  it("has no provider client module or SDK dependency", () => {
    const providerDirectory = resolve(serverRoot, "src/external/llm");
    const providerFiles = existsSync(providerDirectory)
      ? readdirSync(providerDirectory).filter((name) => name.endsWith(".ts"))
      : [];
    expect(providerFiles).toEqual([]);
    const packageJson = JSON.parse(readFileSync(resolve(serverRoot, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(packageJson.dependencies?.["@anthropic-ai/sdk"]).toBeUndefined();
    expect(packageJson.dependencies?.["openai"]).toBeUndefined();
  });

  it("does not expose an LLM key or provider configuration", () => {
    for (const path of [
      resolve(serverRoot, "src/lib/config.ts"),
      resolve(repoRoot, ".env.example"),
      resolve(repoRoot, "compose.yml"),
    ]) {
      const content = readFileSync(path, "utf8");
      expect(content).not.toMatch(/(?:LLM_(?:LOW|MID|ENABLED|MAX_RETRIES|TIMEOUT)|ANTHROPIC_API_KEY|OPENAI_API_KEY)/u);
    }
  });
});
