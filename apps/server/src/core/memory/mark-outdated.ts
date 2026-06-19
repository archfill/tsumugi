import { MarkMemoryOutdatedInput } from "@tsumugi/shared";
import { memoryRepo } from "../../data/repos/memory.js";
import { NotFoundError } from "../../lib/errors.js";

export interface MarkMemoryOutdatedResult {
  memory_id: string;
  outdated: true;
}

export async function markMemoryOutdated(
  rawInput: unknown,
): Promise<MarkMemoryOutdatedResult> {
  const input = MarkMemoryOutdatedInput.parse(rawInput);
  const memory = await memoryRepo.findById(input.memory_id);
  if (!memory || memory.archived_at) {
    throw new NotFoundError(`memory not found: ${input.memory_id}`);
  }

  await memoryRepo.markOutdated(input.memory_id, input.reason);
  return { memory_id: input.memory_id, outdated: true };
}
