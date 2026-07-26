import { sql } from "drizzle-orm";
import { db } from "../client.js";
import { ValidationError } from "../../lib/errors.js";

/** Read-only projection for memory-quality auditing. Never expose this shape. */
export interface MemoryAuditRow extends Record<string, unknown> {
  id: string;
  narrative: string;
  kind: string;
  characterCount: number;
  createdAt: Date | string;
  updatedAt: Date | string;
  archived: boolean;
  outdated: boolean;
  quarantined: boolean;
  totalLinkCount: number;
  incomingDerivedObservationLinkCount: number;
  incomingSynthesisLinkCount: number;
  sourceObservationIds: string[];
  sourceObservationTypes: string[];
  sourceNames: string[];
  sourceProjectCount: number;
  sourceSessionCount: number;
  maxDerivedSiblingCount: number;
}

export const memoryAuditRepo = {
  /**
   * Read-only audit query. It intentionally has no mutation methods: callers
   * receive only the minimum narrative field needed for in-process classifiers.
   */
  async listForQualityAudit(limit: number): Promise<MemoryAuditRow[]> {
    const limitPlusOne = limit + 1;
    const result = await db.execute<MemoryAuditRow>(sql`
      WITH memory_links AS (
        SELECT l.to_id AS memory_id, l.from_id, l.to_id, l.relation
        FROM links l
        WHERE l.to_layer = 'memory'

        UNION

        SELECT l.from_id AS memory_id, l.from_id, l.to_id, l.relation
        FROM links l
        WHERE l.from_layer = 'memory'
      ),
      total_links AS (
        SELECT memory_id, COUNT(*)::int AS total_link_count
        FROM memory_links
        GROUP BY memory_id
      ),
      incoming_links AS (
        SELECT
          l.to_id AS memory_id,
          COUNT(*) FILTER (
            WHERE l.from_layer = 'observation' AND l.relation = 'derived_from'
          )::int AS incoming_derived_observation_link_count,
          COUNT(*) FILTER (
            WHERE l.from_layer = 'memory' AND l.relation = 'related_to'
          )::int AS incoming_synthesis_link_count
        FROM links l
        WHERE l.to_layer = 'memory'
        GROUP BY l.to_id
      ),
      observation_sources AS (
        SELECT
          l.to_id AS memory_id,
          array_agg(DISTINCT o.id ORDER BY o.id) AS source_observation_ids,
          array_agg(DISTINCT o.type ORDER BY o.type) AS source_observation_types,
          array_agg(DISTINCT o.source ORDER BY o.source) AS source_names,
          COUNT(DISTINCT o.project_tag)::int AS source_project_count,
          COUNT(DISTINCT o.session_id)::int AS source_session_count,
          MAX(sibling_counts.sibling_count)::int AS max_derived_sibling_count
        FROM links l
        JOIN observations o ON o.id = l.from_id
        JOIN (
          SELECT from_id, COUNT(DISTINCT to_id)::int AS sibling_count
          FROM links
          WHERE from_layer = 'observation'
            AND to_layer = 'memory'
            AND relation = 'derived_from'
          GROUP BY from_id
        ) sibling_counts ON sibling_counts.from_id = o.id
        WHERE l.from_layer = 'observation'
          AND l.to_layer = 'memory'
          AND l.relation = 'derived_from'
        GROUP BY l.to_id
      )
      SELECT
        m.id,
        m.narrative,
        m.kind,
        char_length(m.narrative)::int AS "characterCount",
        m.created_at AS "createdAt",
        m.updated_at AS "updatedAt",
        (m.archived_at IS NOT NULL) AS archived,
        (m.outdated_at IS NOT NULL) AS outdated,
        (m.llm_quarantined_at IS NOT NULL) AS quarantined,
        COALESCE(tl.total_link_count, 0)::int AS "totalLinkCount",
        COALESCE(il.incoming_derived_observation_link_count, 0)::int AS "incomingDerivedObservationLinkCount",
        COALESCE(il.incoming_synthesis_link_count, 0)::int AS "incomingSynthesisLinkCount",
        COALESCE(os.source_observation_ids, ARRAY[]::text[]) AS "sourceObservationIds",
        COALESCE(os.source_observation_types, ARRAY[]::text[]) AS "sourceObservationTypes",
        COALESCE(os.source_names, ARRAY[]::text[]) AS "sourceNames",
        COALESCE(os.source_project_count, 0)::int AS "sourceProjectCount",
        COALESCE(os.source_session_count, 0)::int AS "sourceSessionCount",
        COALESCE(os.max_derived_sibling_count, 0)::int AS "maxDerivedSiblingCount"
      FROM memories m
      LEFT JOIN total_links tl ON tl.memory_id = m.id
      LEFT JOIN incoming_links il ON il.memory_id = m.id
      LEFT JOIN observation_sources os ON os.memory_id = m.id
      ORDER BY m.id ASC
      LIMIT ${limitPlusOne}
    `);
    if (result.rows.length > limit) {
      throw new ValidationError(
        `memory quality audit row limit exceeded (${limit}); rerun with a larger --row-limit`,
      );
    }
    return result.rows;
  },
};
