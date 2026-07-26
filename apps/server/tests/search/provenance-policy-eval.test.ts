import { describe, expect, it } from "vitest";
import { evaluateProvenancePolicy } from "../../src/core/search/provenance-policy-eval.js";

describe("provenance policy synthetic eval", () => {
  it("improves canonical observation recall while preserving standalone and memory-only cases", () => {
    const result = evaluateProvenancePolicy();
    expect(result.after.recallAt1).toBeGreaterThan(result.baseline.recallAt1);
    expect(result.after.mrr).toBeGreaterThan(result.baseline.mrr);
    expect(result.after.recallAt5).toBe(result.baseline.recallAt5);
    expect(result.after.averageReturnedCount).toBe(result.baseline.averageReturnedCount);
    expect(result.after.linkedSuppressedCount).toBe(2);
  });
});
