import { dreamingRunRepo } from "../../data/repos/dreaming-run.js";

/**
 * Archive memories explicitly marked outdated by an agent.
 *
 * This is deterministic maintenance and invokes no LLM. It soft-deletes by
 * setting archived_at; an application-level restore path is not yet provided.
 * The caller records the affected IDs for manual operator audit.
 */
export async function archiveOutdatedMemories(
  runId: string,
  maxMemories = 500,
): Promise<{ archivedOutdated: number; memoryIds: string[] }> {
  return await dreamingRunRepo.archiveOutdatedAndMarkCompleted(
    runId,
    maxMemories,
  );
}
