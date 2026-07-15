/**
 * Cross-Session Synthesize Use Case — Phase 2 Wave 3A.
 *
 * Clusters similar memories using cosine similarity on stored embeddings,
 * then uses a LOW-tier LLM (Claude Haiku 4.5) to re-package each cluster
 * into a single synthesised narrative. Source memories are archived, and
 * provenance links are created.
 *
 * Usage:
 *   const result = await synthesizeMemories({ threshold: 0.85, maxMemories: 500 });
 */

import { getLlm } from "../../external/llm/index.js";
import { assertLlmAvailable } from "../../external/llm/singleton.js";
import { getEmbedder } from "../../external/embedding/singleton.js";
import { memoryRepo } from "../../data/repos/memory.js";
import { linkRepo } from "../../data/repos/link.js";
import { dreamingRunRepo } from "../../data/repos/dreaming-run.js";
import { newId } from "../../lib/id.js";
import { cosineSimilarity } from "../../lib/math.js";
import {
  ProviderUnavailableError,
  ValidationError,
} from "../../lib/errors.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SynthesizeResult {
  runId: string;
  clustersFound: number;
  memoriesArchived: number;
  newMemoriesCreated: number;
  stoppedReason: "completed" | "provider_cooldown" | "shutdown_requested";
  errors: string[];
}

export interface SynthesizeOptions {
  /** Cosine similarity threshold for clustering (default 0.85). */
  threshold?: number;
  /** Maximum number of memories to load (default 500). */
  maxMemories?: number;
  /** Maximum number of clusters to synthesise per run (default 20). */
  maxClusters?: number;
  /** Cooperative shutdown signal checked before each cluster. */
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// LLM prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are the Cross-Session Synthesizer.
Re-package a cluster of same-subject memory narratives into a single, concise
1-3 sentence narrative. Lose no fact that the cluster preserved.

## Output language
Write narrative and reasoning in the same natural language as the inputs.
Preserve code symbols / identifiers / English product names verbatim.

## Output JSON
{
  "narrative": "merged 1-3 sentence narrative",
  "importance": <number between 0 and 10>,
  "reasoning": "short rationale"
}`;

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface LlmSynthesisResponse {
  narrative: string;
  importance: number;
  reasoning: string;
}

function isLlmSynthesisResponse(v: unknown): v is LlmSynthesisResponse {
  if (typeof v !== "object" || v === null) return false;
  const obj = v as Record<string, unknown>;
  return (
    typeof obj["narrative"] === "string" &&
    typeof obj["importance"] === "number" &&
    typeof obj["reasoning"] === "string"
  );
}

interface MemoryWithEmbedding {
  id: string;
  narrative: string;
  importance: number;
  embedding: number[];
}

// ---------------------------------------------------------------------------
// Clustering
// ---------------------------------------------------------------------------

/**
 * Greedy threshold-based clustering.
 * Each memory becomes a seed; any unclustered memory with cos-sim >= threshold
 * is added to the same cluster. Returns only clusters with >= 2 members.
 */
function clusterMemories(
  memories: MemoryWithEmbedding[],
  threshold: number,
): MemoryWithEmbedding[][] {
  const clustered = new Set<number>();
  const clusters: MemoryWithEmbedding[][] = [];

  for (let i = 0; i < memories.length; i++) {
    if (clustered.has(i)) continue;

    const seed = memories[i]!;
    const cluster: MemoryWithEmbedding[] = [seed];
    clustered.add(i);

    for (let j = i + 1; j < memories.length; j++) {
      if (clustered.has(j)) continue;
      const sim = cosineSimilarity(seed.embedding, memories[j]!.embedding);
      if (sim >= threshold) {
        cluster.push(memories[j]!);
        clustered.add(j);
      }
    }

    if (cluster.length >= 2) {
      clusters.push(cluster);
    }
  }

  return clusters;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Synthesise similar memories across sessions.
 *
 * 1. Load active memories with embeddings.
 * 2. Cluster by cosine similarity.
 * 3. For each cluster, call LOW-tier LLM to produce a synthesised narrative.
 * 4. Insert new synthesised memory, archive members, add provenance links.
 * 5. Record dreaming_run history.
 */
export async function synthesizeMemories(
  opts: SynthesizeOptions = {},
): Promise<SynthesizeResult> {
  const {
    threshold = 0.85,
    maxMemories = 500,
    maxClusters = 20,
    signal,
  } = opts;

  const runId = newId("drun");
  const errors: string[] = [];
  let memoriesArchived = 0;
  let newMemoriesCreated = 0;
  let stoppedReason: SynthesizeResult["stoppedReason"] = "completed";

  // Record run start.
  await dreamingRunRepo.insert({
    id: runId,
    job_kind: "synthesize",
    status: "pending",
    input_count: 0,
    output_count: 0,
  });

  try {
    await dreamingRunRepo.markRunning(runId);

    // 1. Load LLM-eligible memories (skip quarantined / in cooldown).
    const allMemories = await memoryRepo.listLlmEligible(maxMemories);

    // 2. Filter to those with valid embeddings.
    const memoriesWithEmbedding: MemoryWithEmbedding[] = allMemories
      .filter((m) => {
        const emb = m.embedding;
        return (
          emb !== null &&
          emb !== undefined &&
          Array.isArray(emb) &&
          (emb as unknown[]).length > 0
        );
      })
      .map((m) => ({
        id: m.id,
        narrative: m.narrative,
        importance: m.importance,
        embedding: m.embedding as number[],
      }));

    // Update input_count.
    await dreamingRunRepo.update(runId, {
      input_count: memoriesWithEmbedding.length,
    });

    // 3. Cluster.
    const clusters = clusterMemories(memoriesWithEmbedding, threshold);
    const clustersToProcess = clusters.slice(0, maxClusters);

    const clustersFound = clustersToProcess.length;

    const llm = getLlm("low");
    const embedder = getEmbedder();

    // 4. Process each cluster.
    for (const cluster of clustersToProcess) {
      if (signal?.aborted) {
        stoppedReason = "shutdown_requested";
        break;
      }
      try {
        assertLlmAvailable("low");
        // 4a. Build user prompt.
        const userPrompt = `Cluster to merge (same-subject memories):\n${cluster
          .map((m, i) => `[${i}] (importance=${m.importance}) ${m.narrative}`)
          .join("\n")}\n\nReturn a single merged narrative.`;

        // 4b. Call LOW-tier LLM.
        const raw = await llm.completeJson<unknown>({
          system: SYSTEM_PROMPT,
          user: userPrompt,
          jsonResponse: true,
          temperature: 0.0,
        });

        if (!isLlmSynthesisResponse(raw)) {
          throw new ValidationError(
            `Synthesize LLM returned unexpected shape: ${JSON.stringify(raw)}`,
          );
        }

        const { narrative, importance } = raw;

        // 4c. Generate embedding for the new narrative.
        const embedding = Array.from(await embedder.embed(narrative));

        // Compute importance as max of cluster members.
        const maxImportance = Math.max(
          importance,
          ...cluster.map((m) => m.importance),
        );

        // 4d. Insert new synthesised memory.
        const newMemId = newId("mem");
        await memoryRepo.insert({
          id: newMemId,
          narrative,
          importance: maxImportance,
          kind: "general",
          embedding,
        });
        newMemoriesCreated++;

        // 4e. Archive members and add provenance links.
        for (const member of cluster) {
          await linkRepo.insert({
            from_id: member.id,
            to_id: newMemId,
            from_layer: "memory",
            to_layer: "memory",
            relation: "related_to",
          });
          await memoryRepo.archive(member.id);
          memoriesArchived++;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (err instanceof ProviderUnavailableError) {
          stoppedReason = "provider_cooldown";
          errors.push(`provider: ${msg}`);
          break;
        }
        // Layer 2 failure tracking: record failure on each cluster member.
        for (const member of cluster) {
          await memoryRepo.recordLlmFailure(member.id);
        }
        errors.push(`cluster(${cluster.map((m) => m.id).join(",")}): ${msg}`);
      }
    }

    if (errors.length > 0 || stoppedReason === "shutdown_requested") {
      await dreamingRunRepo.markPartial(
        runId,
        newMemoriesCreated,
        errors.join("\n") || "synthesize stopped: shutdown_requested",
        { errors, stoppedReason },
      );
    } else {
      await dreamingRunRepo.markCompleted(runId, newMemoriesCreated, {
        stoppedReason,
      });
    }

    return {
      runId,
      clustersFound,
      memoriesArchived,
      newMemoriesCreated,
      stoppedReason,
      errors,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await dreamingRunRepo.markFailed(runId, msg);
    throw err;
  }
}
