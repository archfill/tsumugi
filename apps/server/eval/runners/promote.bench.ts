import type { ObservationRow } from "../../src/data/repos/observation.js";
import { summarizeObservation } from "../../src/core/observation/summarize.js";
import {
  fixtures as syntheticFixtures,
  type PromoteExpected,
  type PromoteInput,
} from "../fixtures/promote.synthetic.js";
import { loadPrivateFixtures } from "../load-private.js";
import { runBench } from "../runner.js";
import type { BenchSummary } from "../types.js";

interface PromoteActual {
  skip: boolean;
  narrative: string;
  reasoning: string;
}

function buildObservation(caseId: string, input: PromoteInput): ObservationRow {
  return {
    id: `obs_bench_${caseId}`,
    content: input.content,
    type: input.type,
    source: input.source,
    session_id: null,
    project_tag: null,
    facts: null,
    metadata: null,
    embedding: null,
    created_at: new Date(0),
    promoted_at: null,
    search_text: input.content,
  } as ObservationRow;
}

export async function runPromoteBench(): Promise<BenchSummary> {
  const privateFixtures = await loadPrivateFixtures<
    PromoteInput,
    PromoteExpected
  >("promote.private.ts");
  const fixtures = [...syntheticFixtures, ...privateFixtures];

  return runBench<PromoteInput, PromoteExpected, PromoteActual>({
    name: "promote",
    fixtures,
    concurrency: 6,
    timeoutMs: 60_000,
    run: async (fx) => {
      const obs = buildObservation(fx.id, fx.input);
      const result = await summarizeObservation(obs);
      const actual: PromoteActual = {
        skip: result.skip,
        narrative: result.narrative,
        reasoning: result.reasoning,
      };
      return {
        passed: result.skip === fx.expected.skip,
        actual,
      };
    },
    computeMetrics: (outcomes, allFixtures) => {
      const fxById = new Map(allFixtures.map((f) => [f.id, f]));
      // True/false positive/negative for "skip = true" as positive class.
      let tp = 0,
        fp = 0,
        tn = 0,
        fn = 0;
      let included = 0;
      for (const o of outcomes) {
        const fx = fxById.get(o.caseId);
        if (!fx) continue;
        if (fx.tags?.includes("ambiguous")) continue;
        if (o.error) continue;
        if (!o.actual) continue;
        included++;
        const actual = (o.actual as PromoteActual).skip;
        const expected = fx.expected.skip;
        if (expected && actual) tp++;
        else if (expected && !actual) fn++;
        else if (!expected && actual) fp++;
        else tn++;
      }
      const accuracy = included === 0 ? 0 : (tp + tn) / included;
      const skipPrecision = tp + fp === 0 ? 0 : tp / (tp + fp);
      const skipRecall = tp + fn === 0 ? 0 : tp / (tp + fn);
      const skipF1 =
        skipPrecision + skipRecall === 0
          ? 0
          : (2 * skipPrecision * skipRecall) / (skipPrecision + skipRecall);
      const keepPrecision = tn + fn === 0 ? 0 : tn / (tn + fn);
      const keepRecall = tn + fp === 0 ? 0 : tn / (tn + fp);
      const keepF1 =
        keepPrecision + keepRecall === 0
          ? 0
          : (2 * keepPrecision * keepRecall) / (keepPrecision + keepRecall);
      const detail = [
        "confusion matrix (ambiguous excluded):",
        `         act_skip  act_keep`,
        `exp_skip  ${String(tp).padStart(7)}  ${String(fn).padStart(7)}`,
        `exp_keep  ${String(fp).padStart(7)}  ${String(tn).padStart(7)}`,
        "",
        "→ false positive (keep が誤って skip された): " +
          (fp === 0
            ? "none"
            : outcomes
                .filter((o) => {
                  const fx = fxById.get(o.caseId);
                  return (
                    fx &&
                    !fx.tags?.includes("ambiguous") &&
                    !fx.expected.skip &&
                    (o.actual as PromoteActual | null)?.skip === true
                  );
                })
                .map((o) => `\n    - ${o.caseId}: ${o.description ?? ""}`)
                .join("")),
        "→ false negative (skip が誤って keep された): " +
          (fn === 0
            ? "none"
            : outcomes
                .filter((o) => {
                  const fx = fxById.get(o.caseId);
                  return (
                    fx &&
                    !fx.tags?.includes("ambiguous") &&
                    fx.expected.skip &&
                    (o.actual as PromoteActual | null)?.skip === false
                  );
                })
                .map((o) => `\n    - ${o.caseId}: ${o.description ?? ""}`)
                .join("")),
      ].join("\n");
      return {
        metrics: {
          accuracy,
          skipF1,
          skipPrecision,
          skipRecall,
          keepF1,
          keepPrecision,
          keepRecall,
          nonAmbiguousCases: included,
        },
        detail,
      };
    },
  });
}
