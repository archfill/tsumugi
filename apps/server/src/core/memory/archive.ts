import { newId } from "../../lib/id.js";
import { ValidationError } from "../../lib/errors.js";
import { memoryArchiveRepo } from "../../data/repos/memory-archive.js";

const MAX_ARCHIVE_CANDIDATES = 10_000;

export async function previewExactDuplicateArchive(limit = MAX_ARCHIVE_CANDIDATES) {
  const candidates = await memoryArchiveRepo.listExactDuplicateCandidates(limit);
  return {
    readOnly: true as const,
    reason: "exact_duplicate" as const,
    candidateCount: candidates.length,
    candidates,
  };
}

export async function createExactDuplicateArchivePlan(limit = MAX_ARCHIVE_CANDIDATES) {
  const preview = await previewExactDuplicateArchive(limit);
  if (preview.candidateCount === 0) {
    throw new ValidationError("no active exact duplicate candidates found");
  }
  const batchId = newId("mar");
  await memoryArchiveRepo.createPlan({
    id: batchId,
    reason: "exact_duplicate",
    criteria: {
      schemaVersion: 1,
      normalization: "trim + whitespace collapse + case fold",
      canonical: "oldest active created_at then id",
      semanticMerge: false,
    },
    candidates: preview.candidates,
  });
  return { batchId, reason: preview.reason, candidateCount: preview.candidateCount };
}

export async function createReviewedMetadataArchivePlan(ids: string[]) {
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length === 0 || uniqueIds.length > MAX_ARCHIVE_CANDIDATES) {
    throw new ValidationError(`reviewed candidate count must be between 1 and ${MAX_ARCHIVE_CANDIDATES}`);
  }
  const candidates = await memoryArchiveRepo.listReviewedActiveCandidates(uniqueIds);
  const batchId = newId("mar");
  await memoryArchiveRepo.createPlan({
    id: batchId,
    reason: "reviewed_metadata_noise",
    criteria: {
      schemaVersion: 1,
      selection: "explicit reviewed memory ids",
      semanticMerge: false,
      contentStoredInManifest: false,
    },
    candidates,
  });
  return { batchId, reason: "reviewed_metadata_noise" as const, candidateCount: candidates.length };
}

export async function applyMemoryArchivePlan(batchId: string, expectedCount: number) {
  const archivedCount = await memoryArchiveRepo.applyPlan(batchId, expectedCount);
  return { batchId, status: "applied" as const, archivedCount };
}

export async function restoreMemoryArchiveBatch(batchId: string, expectedCount: number) {
  const restoredCount = await memoryArchiveRepo.restoreBatch(batchId, expectedCount);
  return { batchId, status: "restored" as const, restoredCount };
}
