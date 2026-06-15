/**
 * Lazily populate DB-derived Prometheus gauges on each /metrics scrape.
 *
 * Called from the `/metrics` route handler before serializing the registry.
 * Uses a single multi-CTE query to minimize round-trips.
 */

import { sql } from "drizzle-orm";
import { db } from "./client.js";
import { logger } from "../lib/logger.js";
import {
  memoriesQuarantined,
  memoriesTotal,
  observationsPending,
  observationsTotal,
} from "../lib/metrics.js";

interface CountsRow extends Record<string, unknown> {
  observations_total: string | number;
  observations_pending: string | number;
  memories_quarantined: string | number;
}

interface MemoryKindRow extends Record<string, unknown> {
  kind: string;
  n: string | number;
}

export async function collectDbGauges(): Promise<void> {
  try {
    const counts = await db.execute<CountsRow>(sql`
      SELECT
        (SELECT COUNT(*) FROM observations) AS observations_total,
        (SELECT COUNT(*) FROM observations WHERE promoted_at IS NULL) AS observations_pending,
        (SELECT COUNT(*) FROM memories WHERE llm_quarantined_at IS NOT NULL) AS memories_quarantined
    `);
    const row = counts.rows[0];
    if (row) {
      observationsTotal.set(Number(row.observations_total));
      observationsPending.set(Number(row.observations_pending));
      memoriesQuarantined.set(Number(row.memories_quarantined));
    }

    const byKind = await db.execute<MemoryKindRow>(sql`
      SELECT kind, COUNT(*) AS n
      FROM memories
      WHERE archived_at IS NULL
      GROUP BY kind
    `);
    memoriesTotal.reset();
    for (const r of byKind.rows) {
      memoriesTotal.set({ kind: String(r.kind) }, Number(r.n));
    }
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "metrics: DB gauge collect failed",
    );
  }
}
