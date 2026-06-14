import { ObservationInput } from "@tsumugi/shared";
import { observationRepo } from "../../data/repos/observation.js";
import { getEmbedder } from "../../external/embedding/singleton.js";
import { newId } from "../../lib/id.js";

export interface SaveObservationResult {
  id: string;
}

export async function saveObservation(
  rawInput: unknown,
): Promise<SaveObservationResult> {
  const input = ObservationInput.parse(rawInput);
  const embedding = await getEmbedder().embed(input.content);

  const id = newId("obs");
  await observationRepo.insert({
    id,
    content: input.content,
    type: input.type,
    source: input.source,
    session_id: input.session_id ?? null,
    project_tag: input.project_tag ?? null,
    facts: input.facts ?? null,
    metadata: input.metadata ?? null,
    embedding: Array.from(embedding),
  });

  return { id };
}
