import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const testDir = dirname(fileURLToPath(import.meta.url));
const serverRoot = resolve(testDir, "../..");
const repoRoot = resolve(serverRoot, "../..");

function readRepoFile(path: string): string {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

function listRepoFiles(directory: string, extensions: Set<string>): string[] {
  const root = resolve(repoRoot, directory);
  const files: string[] = [];
  const visit = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = resolve(path, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (extensions.has(extname(entry.name))) files.push(relative(repoRoot, child));
    }
  };
  visit(root);
  return files;
}

const historicalAdrs = new Set([
  "0001-two-layer-architecture.md",
  "0007-llm-provider-agnostic.md",
  "0008-llm-resilience-layers.md",
  "0010-phase4-yui-migration-strategy.md",
  "0011-hook-llm-placement.md",
]);

const currentAdrSurfaces = readdirSync(resolve(repoRoot, "docs/adr"))
  .filter((name) => name.endsWith(".md") && !historicalAdrs.has(name))
  .map((name) => `docs/adr/${name}`);

const activeSkillAndRuleSurfaces = [
  ...listRepoFiles(".agents/skills", new Set([".md", ".yaml"])),
  ".codex/rules/tsumugi.rules",
] as const;

const currentContractSurfaces = [
  "README.md",
  "AGENTS.md",
  "CLAUDE.md",
  "docs/VISION.md",
  "docs/ROADMAP.md",
  ...currentAdrSurfaces,
  ...listRepoFiles("apps/server/src", new Set([".ts"])),
  ...listRepoFiles("apps/server/eval/fixtures", new Set([".ts"])),
  ...listRepoFiles("integrations", new Set([".md", ".py", ".ts", ".json"])),
  ...activeSkillAndRuleSurfaces,
] as const;

const staleContractPatterns = [
  /Layer 1 \(observation\)/u,
  /Layer 2 \(memory\)/u,
  /Layer 2 memory/u,
  /Layer 1: observations/u,
  /Layer 2: memories/u,
  /ADR-003: hot path LLM/u,
  /ADR-014:.*\(Proposed\)/u,
  /ADR-013:.*\(Proposed\)/u,
  /dreaming synthesize で同等役割/u,
  /Three-layer に拡張予定/u,
  /ADR-014 で部分撤回予定/u,
  /cold path の LLM provider/u,
  /AUDN judge/u,
  /dreaming pipeline は promote-observations/u,
  /LLM resilience は 3 層構成/u,
  /provider-resilience paths/u,
  /Distinguish provider-wide cooldown/u,
  /provenance、source、project、timestamp、outdated/u,
] as const;

describe("current architecture documentation contract", () => {
  it("uses the current Three-layer numbering and server-wide zero-LLM wording", () => {
    for (const path of currentContractSurfaces) {
      const content = readRepoFile(path);
      for (const pattern of staleContractPatterns) {
        expect(content, `${path} contains stale contract text: ${pattern}`).not.toMatch(pattern);
      }
    }
  });

  it("keeps lifecycle status in ADR files instead of duplicating it in overview documents", () => {
    for (const path of ["README.md", "AGENTS.md", "CLAUDE.md", "docs/VISION.md", "docs/ROADMAP.md"]) {
      expect(readRepoFile(path), `${path} duplicates an ADR lifecycle status`).not.toMatch(
        /ADR-[0-9]{3}[^\n]*(?:Accepted|Proposed|Superseded)/u,
      );
    }
  });

  it("states the current contract positively at its authoritative surfaces", () => {
    expect(readRepoFile("docs/adr/0003-thin-tool-client-llm-delegation.md")).toContain(
      "tsumugi サーバーは、同期経路・scheduled job・手動 job のいずれからも外部 LLM を呼ばない",
    );
    expect(readRepoFile("docs/adr/0014-three-layer-capture-promotion.md")).toContain(
      "Layer 2 の observation を canonical source とする",
    );
    expect(readRepoFile("AGENTS.md")).toContain(
      "serverはMCP / REST / scheduled jobのいずれからも外部LLMを呼ばない",
    );
    const searchMemoryTool = readRepoFile("apps/server/src/interfaces/mcp/tools/search-memory.ts");
    expect(searchMemoryTool).toContain(
      "Layer 2 (observation) と Layer 3 (memory) 両方を横断",
    );
    expect(searchMemoryTool).toContain(
      "observations と provenance の derived_from でその project に関連付いた memory に絞る",
    );
    expect(readRepoFile(".agents/skills/tsumugi-runtime-observe/SKILL.md")).toContain(
      "deterministic capture, Stop promotion, observation-first recall",
    );
  });

  it("does not advertise removed server-LLM scripts in active skills or Codex rules", () => {
    for (const path of activeSkillAndRuleSurfaces) {
      expect(readRepoFile(path), `${path} advertises a removed script`).not.toMatch(
        /(?:llm|summarize|audn|synthesize|time-update|decision-contradiction|reflection):smoke|bench:(?:audn|promote|contradiction|time-update)|dream:(?:synthesize|time-update|decision|full)/u,
      );
    }
  });

  it("marks replaced historical decisions at their source", () => {
    expect(readRepoFile("docs/adr/0001-two-layer-architecture.md")).toContain(
      "ステータス: Superseded by ADR-014",
    );
    expect(readRepoFile("docs/adr/0011-hook-llm-placement.md")).toContain(
      "ステータス: Partially superseded by ADR-014",
    );
  });

  it("imports shared repository guidance into Claude Code without duplicating it", () => {
    const claudeGuide = readRepoFile("CLAUDE.md");
    expect(claudeGuide).toContain("@AGENTS.md");
    expect(claudeGuide).not.toContain("## ディレクトリ構造");
    expect(claudeGuide).not.toContain("## 意思決定の背景");
  });
});
