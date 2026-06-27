import { captureRepo } from "../../data/repos/capture.js";
import type { CaptureRow } from "../../data/repos/capture.js";
import { observationRepo } from "../../data/repos/observation.js";
import { getEmbedder } from "../../external/embedding/singleton.js";
import { newId } from "../../lib/id.js";
import { summarizeObservation } from "../observation/summarize.js";
import { audnJudge } from "../dreaming/audn.js";

export interface PromoteCapturesResult {
  total: number;
  promoted: number;
  skipped: number;
  errors: string[];
}

function captureAsObservation(capture: CaptureRow) {
  return {
    id: capture.id,
    content: capture.raw_content,
    type: "other",
    source: capture.source,
    source_layer: "capture",
    session_id: capture.session_id,
    project_tag: capture.project_tag,
    facts: null,
    metadata: {
      capture_id: capture.id,
      hook_event: capture.hook_event,
      tool_name: capture.tool_name,
      captured_at: capture.captured_at.toISOString(),
    },
    embedding: null,
    created_at: capture.captured_at,
    promoted_at: null,
    search_text: capture.raw_content,
  };
}

export async function promoteCaptures(
  maxCaptures = 50,
): Promise<PromoteCapturesResult> {
  const captures = await captureRepo.listUnpromoted(maxCaptures);
  let promoted = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const capture of captures) {
    try {
      const summary = await summarizeObservation(captureAsObservation(capture));
      if (summary.skip) {
        await captureRepo.markSkipped(capture.id, summary.reasoning);
        skipped++;
        continue;
      }

      const observationId = newId("obs");
      const embedding = await getEmbedder().embed(summary.narrative);

      await observationRepo.insert({
        id: observationId,
        content: summary.narrative,
        type: "other",
        source: capture.source,
        source_layer: "capture",
        session_id: capture.session_id,
        project_tag: capture.project_tag,
        facts: summary.facts,
        metadata: {
          capture_id: capture.id,
          hook_event: capture.hook_event,
          tool_name: capture.tool_name,
          promoted_reasoning: summary.reasoning,
        },
        embedding: Array.from(embedding),
      });
      await captureRepo.markPromoted(capture.id, observationId);
      await captureRepo.deletePromoted();

      let hasAudnError = false;
      for (const fact of summary.facts) {
        try {
          await audnJudge({
            newFact: fact,
            sourceObservationId: observationId,
          });
        } catch (err) {
          hasAudnError = true;
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(`audn(capture=${capture.id}): ${msg}`);
        }
      }
      if (hasAudnError) {
        continue;
      }

      await observationRepo.markPromoted(observationId);
      promoted++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`promote(capture=${capture.id}): ${msg}`);
    }
  }

  return {
    total: captures.length,
    promoted,
    skipped,
    errors,
  };
}
