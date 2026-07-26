import type { MemoryAuditRow } from "../../data/repos/memory-audit.js";

export const MEMORY_QUALITY_REASON_CODES = [
  "thin_proxy",
  "context_poor",
  "interaction_metadata",
  "unlinked_orphan_provenance",
  "exact_duplicate",
  "near_duplicate_candidate",
  "fragment_cluster",
  "aged_record",
] as const;
export type MemoryQualityReasonCode =
  (typeof MEMORY_QUALITY_REASON_CODES)[number];

export const MEMORY_PROTECTION_CODES = [
  "decision_kind",
  "source_decision_or_blocker",
  "rationale_or_verification",
  "high_link_count",
] as const;
export type MemoryProtectionCode = (typeof MEMORY_PROTECTION_CODES)[number];

export interface MemoryQualityCandidate {
  id: string;
  reasonCodes: MemoryQualityReasonCode[];
  protectionCodes: MemoryProtectionCode[];
  canonicalMemoryId?: string;
  sourceObservationIds: string[];
  ageDays: number;
  linkCount: number;
}

export interface MemoryQualityReport {
  schemaVersion: 2;
  readOnly: true;
  generatedAt: string;
  disclaimer: string;
  thresholds: {
    thinMaxCharactersExclusive: number;
    agedDaysInclusive: number;
    nearDuplicateMinScore: number;
  };
  totalMemories: number;
  states: Record<"active" | "archived" | "outdated" | "quarantined", number>;
  provenance: Record<
    "observation_derived" | "synthesized" | "linked_other" | "unlinked",
    number
  >;
  sourceAttribution: {
    sourceNames: Record<string, number>;
    rowsWithProject: number;
    rowsWithSession: number;
  };
  lengths: {
    buckets: Record<"lt_100" | "100_to_299" | "300_to_999" | "ge_1000", number>;
    medianCharacters: number | null;
  };
  ages: {
    buckets: Record<"lt_30d" | "30_to_179d" | "180_to_364d" | "ge_365d", number>;
  };
  links: { averagePerMemory: number };
  reasonCounts: Record<MemoryQualityReasonCode, number>;
  protectionCounts: Record<MemoryProtectionCode, number>;
  exactDuplicates: { groupCount: number; rowCount: number; archiveableRowCount: number };
  nearDuplicates: { groupCount: number; rowCount: number };
  fragmentClusters: { rowCount: number };
  candidates: MemoryQualityCandidate[];
  candidateLimit: number;
  rowLimit: number;
  unsupported: string[];
  futureWork: string[];
}

export interface MemoryQualityAuditOptions {
  includeCandidates?: boolean;
  candidateLimit?: number;
  rowLimit?: number;
  thinMaxCharactersExclusive?: number;
  agedDaysInclusive?: number;
  nearDuplicateMinScore?: number;
  now?: Date;
}

const WHY_PATTERN = /\b(because|since|therefore|why|due to|root cause|verified|verification)\b|ため|ので|理由|なぜ|根拠|原因|検証/iu;
const INTERACTION_METADATA_PATTERN = /^(user|assistant|system|tool)\s*:|\b(session_id|turn_id|tool_name)\b|<\/?(?:user|assistant|tool)>/iu;
const CONCRETE_IDENTIFIER_PATTERN = /`[^`]+`|\b[A-Za-z_][A-Za-z0-9_]*_[A-Za-z0-9_]+\b|\b[A-Za-z][A-Za-z0-9]*\d+[A-Za-z0-9]*\b|\/[\w./-]+/u;
const PROTECTED_NARRATIVE_PATTERN = /\b(decision|blocker|root cause|verified|verification|regression|rollback)\b|決定|判断|阻害|原因|検証|回帰|復旧|ロールバック/iu;

export function normalizeMemoryNarrative(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
}

function isSingleSentence(value: string): boolean {
  return value
    .split(/[.!?。！？]+/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean).length <= 1;
}

export function unicodeCodePointCount(value: string): number {
  return Array.from(value).length;
}

export function classifyMemoryQuality(input: {
  narrative: string;
  totalLinkCount: number;
  duplicateCount?: number;
  nearDuplicateCount?: number;
  maxDerivedSiblingCount?: number;
  ageDays?: number;
  thinMaxCharactersExclusive?: number;
  agedDaysInclusive?: number;
}): MemoryQualityReasonCode[] {
  const normalized = normalizeMemoryNarrative(input.narrative);
  const hasWhy = WHY_PATTERN.test(normalized);
  const hasConcreteIdentifier = CONCRETE_IDENTIFIER_PATTERN.test(normalized);
  const reasons: MemoryQualityReasonCode[] = [];
  const thinMax = input.thinMaxCharactersExclusive ?? 100;

  if (
    unicodeCodePointCount(normalized) < thinMax &&
    isSingleSentence(normalized) &&
    !hasWhy &&
    !hasConcreteIdentifier
  ) {
    reasons.push("thin_proxy");
  }
  if (!hasWhy && !hasConcreteIdentifier) reasons.push("context_poor");
  if (INTERACTION_METADATA_PATTERN.test(normalized)) reasons.push("interaction_metadata");
  if (input.totalLinkCount === 0) reasons.push("unlinked_orphan_provenance");
  if ((input.duplicateCount ?? 1) > 1) reasons.push("exact_duplicate");
  if ((input.nearDuplicateCount ?? 1) > 1) reasons.push("near_duplicate_candidate");
  if ((input.maxDerivedSiblingCount ?? 0) > 1) reasons.push("fragment_cluster");
  if ((input.ageDays ?? 0) >= (input.agedDaysInclusive ?? 365)) reasons.push("aged_record");
  return reasons;
}

export function classifyMemoryProtection(row: MemoryAuditRow): MemoryProtectionCode[] {
  const codes: MemoryProtectionCode[] = [];
  if (row.kind.toLocaleLowerCase("en-US") === "decision") codes.push("decision_kind");
  if (row.sourceObservationTypes.some((type) => type === "decision" || type === "blocker")) {
    codes.push("source_decision_or_blocker");
  }
  if (WHY_PATTERN.test(row.narrative) || PROTECTED_NARRATIVE_PATTERN.test(row.narrative)) {
    codes.push("rationale_or_verification");
  }
  if (row.totalLinkCount >= 3) codes.push("high_link_count");
  return codes;
}

function provenanceOf(row: MemoryAuditRow): keyof MemoryQualityReport["provenance"] {
  if (row.incomingDerivedObservationLinkCount > 0) return "observation_derived";
  if (row.incomingSynthesisLinkCount > 0) return "synthesized";
  if (row.totalLinkCount > 0) return "linked_other";
  return "unlinked";
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
}

function timestamp(value: Date | string): number {
  const result = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(result) ? result : 0;
}

function ageDays(createdAt: Date | string, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - timestamp(createdAt)) / 86_400_000));
}

function trigrams(value: string): Set<string> {
  const compact = Array.from(normalizeMemoryNarrative(value).replace(/[^\p{L}\p{N}]+/gu, ""));
  const result = new Set<string>();
  for (let index = 0; index <= compact.length - 3; index++) {
    result.add(compact.slice(index, index + 3).join(""));
  }
  return result;
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const value of left) if (right.has(value)) intersection++;
  return intersection / (left.size + right.size - intersection);
}

function buildNearDuplicateCounts(
  rows: MemoryAuditRow[],
  minimumScore: number,
): { counts: Map<string, number>; groupCount: number } {
  const buckets = new Map<string, MemoryAuditRow[]>();
  for (const row of rows) {
    const normalized = normalizeMemoryNarrative(row.narrative).replace(/[^\p{L}\p{N}]+/gu, "");
    if (normalized.length < 20) continue;
    const key = `${Array.from(normalized).slice(0, 6).join("")}:${Math.floor(normalized.length / 40)}`;
    const bucket = buckets.get(key) ?? [];
    if (bucket.length < 200) bucket.push(row);
    buckets.set(key, bucket);
  }
  const adjacency = new Map<string, Set<string>>();
  for (const bucket of buckets.values()) {
    const signatures = bucket.map((row) => ({ row, grams: trigrams(row.narrative) }));
    for (let left = 0; left < signatures.length; left++) {
      for (let right = left + 1; right < signatures.length; right++) {
        const a = signatures[left]!;
        const b = signatures[right]!;
        if (normalizeMemoryNarrative(a.row.narrative) === normalizeMemoryNarrative(b.row.narrative)) continue;
        if (jaccard(a.grams, b.grams) < minimumScore) continue;
        const leftSet = adjacency.get(a.row.id) ?? new Set<string>();
        const rightSet = adjacency.get(b.row.id) ?? new Set<string>();
        leftSet.add(b.row.id);
        rightSet.add(a.row.id);
        adjacency.set(a.row.id, leftSet);
        adjacency.set(b.row.id, rightSet);
      }
    }
  }
  const counts = new Map<string, number>();
  const visited = new Set<string>();
  let groupCount = 0;
  for (const id of adjacency.keys()) {
    if (visited.has(id)) continue;
    groupCount++;
    const component: string[] = [];
    const stack = [id];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (visited.has(current)) continue;
      visited.add(current);
      component.push(current);
      for (const next of adjacency.get(current) ?? []) stack.push(next);
    }
    for (const member of component) counts.set(member, component.length);
  }
  return { counts, groupCount };
}

export function buildMemoryQualityReport(
  rows: MemoryAuditRow[],
  options: MemoryQualityAuditOptions = {},
): MemoryQualityReport {
  const candidateLimit = Math.min(Math.max(options.candidateLimit ?? 20, 1), 100);
  const rowLimit = options.rowLimit ?? 20_000;
  const thinMaxCharactersExclusive = options.thinMaxCharactersExclusive ?? 100;
  const agedDaysInclusive = options.agedDaysInclusive ?? 365;
  const nearDuplicateMinScore = options.nearDuplicateMinScore ?? 0.88;
  const now = options.now ?? new Date();
  const duplicateGroups = new Map<string, MemoryAuditRow[]>();
  for (const row of rows) {
    const normalized = normalizeMemoryNarrative(row.narrative);
    duplicateGroups.set(normalized, [...(duplicateGroups.get(normalized) ?? []), row]);
  }
  const canonicalById = new Map<string, string>();
  for (const group of duplicateGroups.values()) {
    if (group.length <= 1) continue;
    const sorted = [...group].sort((a, b) => timestamp(a.createdAt) - timestamp(b.createdAt) || a.id.localeCompare(b.id));
    for (const row of sorted) canonicalById.set(row.id, sorted[0]!.id);
  }
  const nearDuplicateResult = buildNearDuplicateCounts(rows, nearDuplicateMinScore);
  const nearDuplicateCounts = nearDuplicateResult.counts;

  const report: MemoryQualityReport = {
    schemaVersion: 2,
    readOnly: true,
    generatedAt: now.toISOString(),
    disclaimer: "Read-only review signals only. Shortness, age, similarity, and fragmentation never authorize automatic semantic deletion.",
    thresholds: { thinMaxCharactersExclusive, agedDaysInclusive, nearDuplicateMinScore },
    totalMemories: rows.length,
    states: { active: 0, archived: 0, outdated: 0, quarantined: 0 },
    provenance: { observation_derived: 0, synthesized: 0, linked_other: 0, unlinked: 0 },
    sourceAttribution: { sourceNames: {}, rowsWithProject: 0, rowsWithSession: 0 },
    lengths: {
      buckets: { lt_100: 0, "100_to_299": 0, "300_to_999": 0, ge_1000: 0 },
      medianCharacters: median(rows.map((row) => row.characterCount)),
    },
    ages: { buckets: { lt_30d: 0, "30_to_179d": 0, "180_to_364d": 0, ge_365d: 0 } },
    links: { averagePerMemory: rows.length === 0 ? 0 : rows.reduce((sum, row) => sum + row.totalLinkCount, 0) / rows.length },
    reasonCounts: Object.fromEntries(MEMORY_QUALITY_REASON_CODES.map((reason) => [reason, 0])) as MemoryQualityReport["reasonCounts"],
    protectionCounts: Object.fromEntries(MEMORY_PROTECTION_CODES.map((reason) => [reason, 0])) as MemoryQualityReport["protectionCounts"],
    exactDuplicates: { groupCount: 0, rowCount: 0, archiveableRowCount: 0 },
    nearDuplicates: { groupCount: nearDuplicateResult.groupCount, rowCount: nearDuplicateCounts.size },
    fragmentClusters: { rowCount: 0 },
    candidates: [],
    candidateLimit,
    rowLimit,
    unsupported: ["The schema has no last-recalled timestamp or access counter; age is creation age, not evidence of disuse."],
    futureWork: ["Near-duplicate and fragment signals require bounded human or client-assisted review; they are never auto-merged."],
  };

  for (const group of duplicateGroups.values()) {
    if (group.length > 1) {
      report.exactDuplicates.groupCount++;
      report.exactDuplicates.rowCount += group.length;
      report.exactDuplicates.archiveableRowCount += group.filter((row) => !row.archived).length - (group.some((row) => !row.archived) ? 1 : 0);
    }
  }
  for (const row of rows) {
    if (row.archived) report.states.archived++; else report.states.active++;
    if (row.outdated) report.states.outdated++;
    if (row.quarantined) report.states.quarantined++;
    report.provenance[provenanceOf(row)]++;
    if (row.sourceProjectCount > 0) report.sourceAttribution.rowsWithProject++;
    if (row.sourceSessionCount > 0) report.sourceAttribution.rowsWithSession++;
    for (const source of row.sourceNames) report.sourceAttribution.sourceNames[source] = (report.sourceAttribution.sourceNames[source] ?? 0) + 1;

    if (row.characterCount < 100) report.lengths.buckets.lt_100++;
    else if (row.characterCount < 300) report.lengths.buckets["100_to_299"]++;
    else if (row.characterCount < 1000) report.lengths.buckets["300_to_999"]++;
    else report.lengths.buckets.ge_1000++;

    const days = ageDays(row.createdAt, now);
    if (days < 30) report.ages.buckets.lt_30d++;
    else if (days < 180) report.ages.buckets["30_to_179d"]++;
    else if (days < 365) report.ages.buckets["180_to_364d"]++;
    else report.ages.buckets.ge_365d++;

    const reasons = classifyMemoryQuality({
      narrative: row.narrative,
      totalLinkCount: row.totalLinkCount,
      duplicateCount: duplicateGroups.get(normalizeMemoryNarrative(row.narrative))?.length,
      nearDuplicateCount: nearDuplicateCounts.get(row.id),
      maxDerivedSiblingCount: row.maxDerivedSiblingCount,
      ageDays: days,
      thinMaxCharactersExclusive,
      agedDaysInclusive,
    });
    const protectionCodes = classifyMemoryProtection(row);
    for (const reason of reasons) report.reasonCounts[reason]++;
    for (const code of protectionCodes) report.protectionCounts[code]++;
    if (reasons.includes("fragment_cluster")) report.fragmentClusters.rowCount++;
    if (options.includeCandidates && reasons.length > 0 && report.candidates.length < candidateLimit) {
      const canonicalMemoryId = canonicalById.get(row.id);
      report.candidates.push({
        id: row.id,
        reasonCodes: reasons,
        protectionCodes,
        ...(canonicalMemoryId === undefined ? {} : { canonicalMemoryId }),
        sourceObservationIds: row.sourceObservationIds.slice(0, 10),
        ageDays: days,
        linkCount: row.totalLinkCount,
      });
    }
  }
  return report;
}
