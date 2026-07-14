import type { JudgeOnlyResult } from "../../src/core/dreaming/audn.js";
import type {
  AudnExpected,
  AudnInput,
} from "../fixtures/audn.synthetic.js";
import type { BenchOutcome, FixtureCase } from "../types.js";

type Decision = "ADD" | "UPDATE" | "DELETE" | "NOOP";
const DECISIONS: Decision[] = ["ADD", "UPDATE", "DELETE", "NOOP"];

export interface AudnActual {
  decision: string;
  targetIndex: number | null;
  reasoning: string;
}

export function evaluateAudnResult(
  expected: AudnExpected,
  result: JudgeOnlyResult,
): { passed: boolean; actual: AudnActual } {
  const actual: AudnActual = {
    decision: result.decision,
    targetIndex: result.targetIndex,
    reasoning: result.reasoning,
  };
  const decisionMatches = result.decision === expected.decision;
  const targetMatters =
    expected.decision === "UPDATE" || expected.decision === "DELETE";
  const targetMatches =
    !targetMatters ||
    (expected.targetIndex === "any"
      ? result.targetIndex !== null
      : result.targetIndex === expected.targetIndex);
  return { passed: decisionMatches && targetMatches, actual };
}

export function computeAudnMetrics(
  outcomes: BenchOutcome<AudnActual>[],
  fixtures: FixtureCase<AudnInput, AudnExpected>[],
): { metrics: Record<string, number>; detail: string } {
  const fixturesById = new Map(fixtures.map((fixture) => [fixture.id, fixture]));
  const matrix: Record<string, Record<string, number>> = {};
  for (const expected of DECISIONS) {
    matrix[expected] = {};
    for (const actual of DECISIONS) matrix[expected]![actual] = 0;
  }

  let included = 0;
  let decisionMatch = 0;
  let targetMatch = 0;
  let targetRelevant = 0;
  for (const outcome of outcomes) {
    const fixture = fixturesById.get(outcome.caseId);
    if (!fixture || fixture.tags?.includes("ambiguous")) continue;
    if (outcome.error || !outcome.actual) continue;
    included++;
    const actual = outcome.actual;
    const expectedDecision = fixture.expected.decision;
    const actualDecision = actual.decision as Decision;
    if (DECISIONS.includes(actualDecision)) {
      matrix[expectedDecision]![actualDecision] =
        (matrix[expectedDecision]![actualDecision] ?? 0) + 1;
    }
    if (actualDecision === expectedDecision) decisionMatch++;
    if (expectedDecision === "UPDATE" || expectedDecision === "DELETE") {
      targetRelevant++;
      const expectedTarget = fixture.expected.targetIndex;
      if (
        expectedTarget === "any"
          ? actual.targetIndex !== null
          : actual.targetIndex === expectedTarget
      ) {
        targetMatch++;
      }
    }
  }

  const metrics: Record<string, number> = {
    decisionAccuracy: included === 0 ? 0 : decisionMatch / included,
    targetIndexAccuracy:
      targetRelevant === 0 ? 0 : targetMatch / targetRelevant,
    nonAmbiguousCases: included,
  };
  for (const decision of DECISIONS) {
    const tp = matrix[decision]![decision] ?? 0;
    const fp = DECISIONS.filter((other) => other !== decision).reduce(
      (total, other) => total + (matrix[other]![decision] ?? 0),
      0,
    );
    const fn = DECISIONS.filter((other) => other !== decision).reduce(
      (total, other) => total + (matrix[decision]![other] ?? 0),
      0,
    );
    const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
    const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
    metrics[`f1_${decision}`] =
      precision + recall === 0
        ? 0
        : (2 * precision * recall) / (precision + recall);
    metrics[`precision_${decision}`] = precision;
    metrics[`recall_${decision}`] = recall;
  }

  const header = ["exp\\act", ...DECISIONS].join("\t");
  const rows = DECISIONS.map((expected) =>
    [
      expected,
      ...DECISIONS.map((actual) => matrix[expected]![actual] ?? 0),
    ].join("\t"),
  );
  return {
    metrics,
    detail: [
      "confusion matrix (rows = expected, cols = actual, ambiguous excluded):",
      header,
      ...rows,
    ].join("\n"),
  };
}
