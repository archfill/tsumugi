import { describe, expect, it } from "vitest";
import {
  buildMemoryQualityReport,
  classifyMemoryQuality,
  normalizeMemoryNarrative,
  unicodeCodePointCount,
} from "../../src/core/memory/quality-audit.js";
import { parseMemoryQualityAuditArgs } from "../../src/interfaces/cli/memory-quality-audit.js";

const RAW_SENTINEL = "PRIVATE_RAW_MEMORY_SENTINEL_DO_NOT_SERIALIZE";

function row(overrides: Partial<{ id: string; narrative: string; kind: string; totalLinkCount: number; incomingDerivedObservationLinkCount: number; incomingSynthesisLinkCount: number; archived: boolean; outdated: boolean; quarantined: boolean; createdAt: Date; sourceObservationIds: string[]; sourceObservationTypes: string[]; sourceNames: string[]; sourceProjectCount: number; sourceSessionCount: number; maxDerivedSiblingCount: number }> = {}) {
  const narrative = overrides.narrative ?? "short summary";
  return {
    id: overrides.id ?? "mem_1",
    narrative,
    kind: overrides.kind ?? "general",
    characterCount: narrative.length,
    createdAt: overrides.createdAt ?? new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    archived: overrides.archived ?? false,
    outdated: overrides.outdated ?? false,
    quarantined: overrides.quarantined ?? false,
    totalLinkCount: overrides.totalLinkCount ?? 0,
    incomingDerivedObservationLinkCount:
      overrides.incomingDerivedObservationLinkCount ?? 0,
    incomingSynthesisLinkCount: overrides.incomingSynthesisLinkCount ?? 0,
    sourceObservationIds: overrides.sourceObservationIds ?? [],
    sourceObservationTypes: overrides.sourceObservationTypes ?? [],
    sourceNames: overrides.sourceNames ?? [],
    sourceProjectCount: overrides.sourceProjectCount ?? 0,
    sourceSessionCount: overrides.sourceSessionCount ?? 0,
    maxDerivedSiblingCount: overrides.maxDerivedSiblingCount ?? 0,
  };
}

describe("memory quality audit classifier", () => {
  it("thin_proxyの境界と具体的識別子・why例外を固定する", () => {
    expect(classifyMemoryQuality({ narrative: "short summary", totalLinkCount: 1 })).toContain("thin_proxy");
    expect(classifyMemoryQuality({ narrative: "short summary because it is durable", totalLinkCount: 1 })).not.toContain("thin_proxy");
    expect(classifyMemoryQuality({ narrative: "set cache_key", totalLinkCount: 1 })).not.toContain("thin_proxy");
  });

  it("thin_proxyはUnicode code point境界でemojiを数える", () => {
    expect(unicodeCodePointCount("😀")).toBe(1);
    expect(classifyMemoryQuality({ narrative: "😀".repeat(99), totalLinkCount: 1 })).toContain("thin_proxy");
    expect(classifyMemoryQuality({ narrative: "😀".repeat(100), totalLinkCount: 1 })).not.toContain("thin_proxy");
  });

  it("exact duplicate normalizationは空白と大文字小文字を正規化する", () => {
    expect(normalizeMemoryNarrative("  Same\nMemory ")).toBe("same memory");
    const report = buildMemoryQualityReport([
      row({ id: "mem_a", narrative: "Same Memory" }),
      row({ id: "mem_b", narrative: " same\n memory " }),
    ]);
    expect(report.exactDuplicates).toEqual({ groupCount: 1, rowCount: 2, archiveableRowCount: 1 });
    expect(report.reasonCounts.exact_duplicate).toBe(2);
  });

  it("aggregateは重複reasonとprovenance/stateを別々に数える", () => {
    const report = buildMemoryQualityReport([
      row({ id: "mem_a", narrative: "User: hello", incomingDerivedObservationLinkCount: 1, totalLinkCount: 1 }),
      row({ id: "mem_b", narrative: "stable decision because evidence", incomingSynthesisLinkCount: 1, totalLinkCount: 1, archived: true, outdated: true, quarantined: true }),
    ]);
    expect(report.provenance).toMatchObject({ observation_derived: 1, synthesized: 1 });
    expect(report.states).toEqual({ active: 1, archived: 1, outdated: 1, quarantined: 1 });
    expect(report.reasonCounts.interaction_metadata).toBe(1);
    expect(report.reasonCounts.unlinked_orphan_provenance).toBe(0);
  });

  it("provenanceはcurrent memoryへのincoming linkだけで判定する", () => {
    const report = buildMemoryQualityReport([
      row({ id: "mem_observation", incomingDerivedObservationLinkCount: 1, totalLinkCount: 1 }),
      row({ id: "mem_synthesized", incomingSynthesisLinkCount: 1, totalLinkCount: 1 }),
      row({ id: "mem_other", totalLinkCount: 1 }),
      // An outgoing source-memory link is not causal synthesized provenance,
      // but remains an attached link and is therefore linked_other.
      row({ id: "mem_outgoing_source", totalLinkCount: 1 }),
      row({ id: "mem_unlinked", totalLinkCount: 0 }),
    ]);
    expect(report.provenance).toEqual({
      observation_derived: 1,
      synthesized: 1,
      linked_other: 2,
      unlinked: 1,
    });
    expect(report.reasonCounts.unlinked_orphan_provenance).toBe(1);
  });

  it("candidate sampleを上限100かつ要求limitへboundedする", () => {
    const rows = Array.from({ length: 150 }, (_, index) =>
      row({ id: `mem_${index}`, narrative: `short ${index}` }),
    );
    expect(buildMemoryQualityReport(rows, { includeCandidates: true, candidateLimit: 3 }).candidates).toHaveLength(3);
    expect(buildMemoryQualityReport(rows, { includeCandidates: true, candidateLimit: 999 }).candidates).toHaveLength(100);
  });

  it("fragment、age、source attributionと保護条件をcontent非出力で集計する", () => {
    const report = buildMemoryQualityReport([
      row({
        id: "mem_decision",
        narrative: "Decision: keep rollback because verification passed",
        kind: "decision",
        totalLinkCount: 3,
        maxDerivedSiblingCount: 2,
        sourceObservationIds: ["obs_1"],
        sourceObservationTypes: ["decision"],
        sourceNames: ["codex"],
        sourceProjectCount: 1,
        sourceSessionCount: 1,
        createdAt: new Date("2024-01-01T00:00:00Z"),
      }),
    ], { includeCandidates: true, now: new Date("2026-01-01T00:00:00Z") });
    expect(report.reasonCounts.fragment_cluster).toBe(1);
    expect(report.reasonCounts.aged_record).toBe(1);
    expect(report.protectionCounts.decision_kind).toBe(1);
    expect(report.sourceAttribution).toEqual({ sourceNames: { codex: 1 }, rowsWithProject: 1, rowsWithSession: 1 });
    expect(report.candidates[0]).toMatchObject({ id: "mem_decision", sourceObservationIds: ["obs_1"] });
  });

  it("serialized reportにraw narrativeまたはcontent hashを含めない", () => {
    const serialized = JSON.stringify(
      buildMemoryQualityReport([
        row({ id: "mem_private", narrative: RAW_SENTINEL }),
      ], { includeCandidates: true }),
    );
    expect(serialized).not.toContain(RAW_SENTINEL);
    expect(serialized).not.toContain("contentHash");
    expect(serialized).toContain("mem_private");
  });

  it("CLI optionを検証しunknown optionを拒否する", () => {
    expect(parseMemoryQualityAuditArgs(["--include-candidates", "--sample-limit", "20", "--row-limit", "50000"])).toEqual({ includeCandidates: true, candidateLimit: 20, rowLimit: 50000, thinMaxCharactersExclusive: 100, agedDaysInclusive: 365, nearDuplicateMinScore: 0.88 });
    expect(() => parseMemoryQualityAuditArgs(["--sample-limit", "101"])).toThrow();
    expect(() => parseMemoryQualityAuditArgs(["--row-limit", "100001"])).toThrow();
    expect(() => parseMemoryQualityAuditArgs(["--unknown"])).toThrow();
  });
});
