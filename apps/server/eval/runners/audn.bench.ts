import { judgeOnly } from "../../src/core/dreaming/audn.js";
import {
  fixtures as syntheticFixtures,
  type AudnExpected,
  type AudnInput,
} from "../fixtures/audn.synthetic.js";
import { loadPrivateFixtures } from "../load-private.js";
import { runBench } from "../runner.js";
import type { BenchSummary } from "../types.js";

type Decision = "ADD" | "UPDATE" | "DELETE" | "NOOP";
const DECISIONS: Decision[] = ["ADD", "UPDATE", "DELETE", "NOOP"];

interface AudnActual {
  decision: string;
  targetIndex: number | null;
  reasoning: string;
}

function caseExpectedTarget(expected: AudnExpected): number | null | "any" {
  return expected.targetIndex;
}

export async function runAudnBench(): Promise<BenchSummary> {
  const privateFixtures = await loadPrivateFixtures<AudnInput, AudnExpected>(
    "audn.private.ts",
  );
  const fixtures = [...syntheticFixtures, ...privateFixtures];

  return runBench<AudnInput, AudnExpected, AudnActual>({
    name: "audn",
    fixtures,
    concurrency: 4,
    timeoutMs: 60_000,
    run: async (fx) => {
      const result = await judgeOnly({
        newFact: fx.input.newFact,
        existingMemoryNarratives: fx.input.existingMemoryNarratives,
      });
      const actual: AudnActual = {
        decision: result.decision,
        targetIndex: result.targetIndex,
        reasoning: result.reasoning,
      };
      const decisionMatches = result.decision === fx.expected.decision;
      // targetIndex matters only for UPDATE/DELETE; for ADD/NOOP the runtime
      // ignores target_index, so we don't penalize the LLM for setting it.
      const expectTarget = caseExpectedTarget(fx.expected);
      const targetMatters =
        fx.expected.decision === "UPDATE" || fx.expected.decision === "DELETE";
      const targetMatches =
        !targetMatters ||
        (expectTarget === "any"
          ? result.targetIndex !== null
          : result.targetIndex === expectTarget);
      return {
        passed: decisionMatches && targetMatches,
        actual,
      };
    },
    computeMetrics: (outcomes, allFixtures) => {
      const fxById = new Map(allFixtures.map((f) => [f.id, f]));
      // Confusion matrix excluding ambiguous cases.
      const matrix: Record<string, Record<string, number>> = {};
      for (const a of DECISIONS) {
        matrix[a] = {};
        for (const b of DECISIONS) matrix[a]![b] = 0;
      }
      let included = 0;
      let decisionMatch = 0;
      let targetMatch = 0;
      let targetRelevant = 0;
      for (const o of outcomes) {
        const fx = fxById.get(o.caseId);
        if (!fx) continue;
        if (fx.tags?.includes("ambiguous")) continue;
        if (o.error) continue;
        if (!o.actual) continue;
        included++;
        const actual = o.actual as AudnActual;
        const expDecision = fx.expected.decision;
        const actDecision = actual.decision as Decision;
        if (DECISIONS.includes(actDecision)) {
          matrix[expDecision]![actDecision] =
            (matrix[expDecision]![actDecision] ?? 0) + 1;
        }
        if (actDecision === expDecision) decisionMatch++;
        if (expDecision === "UPDATE" || expDecision === "DELETE") {
          targetRelevant++;
          const expTarget = fx.expected.targetIndex;
          if (
            expTarget === "any"
              ? actual.targetIndex !== null
              : actual.targetIndex === expTarget
          )
            targetMatch++;
        }
      }
      const metrics: Record<string, number> = {
        decisionAccuracy: included === 0 ? 0 : decisionMatch / included,
        targetIndexAccuracy:
          targetRelevant === 0 ? 0 : targetMatch / targetRelevant,
        nonAmbiguousCases: included,
      };
      // Per-class precision/recall/F1.
      for (const cls of DECISIONS) {
        const tp = matrix[cls]![cls] ?? 0;
        const fp = DECISIONS.filter((x) => x !== cls).reduce(
          (a, x) => a + (matrix[x]![cls] ?? 0),
          0,
        );
        const fn = DECISIONS.filter((x) => x !== cls).reduce(
          (a, x) => a + (matrix[cls]![x] ?? 0),
          0,
        );
        const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
        const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
        const f1 =
          precision + recall === 0
            ? 0
            : (2 * precision * recall) / (precision + recall);
        metrics[`f1_${cls}`] = f1;
        metrics[`precision_${cls}`] = precision;
        metrics[`recall_${cls}`] = recall;
      }
      // Render confusion matrix as detail.
      const header = ["exp\\act", ...DECISIONS].join("\t");
      const rows = DECISIONS.map((exp) =>
        [exp, ...DECISIONS.map((act) => matrix[exp]![act] ?? 0)].join("\t"),
      );
      const detail = [
        "confusion matrix (rows = expected, cols = actual, ambiguous excluded):",
        header,
        ...rows,
      ].join("\n");
      return { metrics, detail };
    },
  });
}
