import { describe, expect, it } from "vitest";
import {
  sampleAudnFixturesByDecision,
  type AudnFixture,
} from "../../eval/runners/audn.fixtures.js";

function fixture(id: string, decision: AudnFixture["expected"]["decision"]): AudnFixture {
  return {
    id,
    description: id,
    input: { newFact: id, existingMemoryNarratives: ["existing"] },
    expected: { decision, targetIndex: null },
  };
}

describe("sampleAudnFixturesByDecision", () => {
  it("decisionごとに固定件数を決定的に抽出する", () => {
    const fixtures = [
      fixture("add-1", "ADD"),
      fixture("add-2", "ADD"),
      fixture("update-1", "UPDATE"),
      fixture("update-2", "UPDATE"),
      fixture("delete-1", "DELETE"),
      fixture("delete-2", "DELETE"),
      fixture("noop-1", "NOOP"),
      fixture("noop-2", "NOOP"),
    ];

    const first = sampleAudnFixturesByDecision(fixtures, 1);
    const second = sampleAudnFixturesByDecision([...fixtures].reverse(), 1);

    expect(first).toEqual(second);
    expect(first.map((item) => item.expected.decision)).toEqual([
      "ADD",
      "UPDATE",
      "DELETE",
      "NOOP",
    ]);
  });

  it("不正なsample sizeを拒否する", () => {
    expect(() => sampleAudnFixturesByDecision([], -1)).toThrow(
      "AUDN fixture sample size must be a non-negative integer",
    );
  });
});
