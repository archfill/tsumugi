import { sql, type SQL } from "drizzle-orm";
import type {
  AdminFilterOptions,
  AdminLayerSummary,
  AdminOperationIssue,
  AdminOverview,
  AdminPipelineTrace,
  AdminPipelineTraceDetail,
  AdminQueueSummary,
  AdminTraceEdge,
  AdminTraceNode,
  ClientSource,
} from "@tsumugi/shared";
import { db } from "../client.js";

export interface AdminScope {
  project?: string;
  source?: ClientSource;
  state?: string;
  from?: Date;
  to?: Date;
  query?: string;
}

export interface AdminPageScope extends AdminScope {
  cursor?: string;
  limit: number;
}

interface CursorValue {
  at: string;
  id: string;
}

interface CountRow {
  [key: string]: unknown;
  state: string;
  count: number | string;
}

interface SummaryRow {
  [key: string]: unknown;
  total: number | string;
  created_24h: number | string;
  oldest_actionable_at: Date | string | null;
}

function where(conditions: SQL[]): SQL {
  return conditions.length > 0
    ? sql`WHERE ${sql.join(conditions, sql` AND `)}`
    : sql``;
}

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toNumber(value: number | string | null | undefined): number {
  return Number(value ?? 0);
}

function stateRecord(rows: CountRow[]): Record<string, number> {
  return Object.fromEntries(
    rows.map((row) => [row.state, toNumber(row.count)]),
  );
}

export function encodeAdminCursor(value: CursorValue): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function decodeAdminCursor(value?: string): CursorValue | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Partial<CursorValue>;
    if (typeof parsed.at !== "string" || typeof parsed.id !== "string") {
      return undefined;
    }
    if (Number.isNaN(Date.parse(parsed.at))) return undefined;
    return { at: parsed.at, id: parsed.id };
  } catch {
    return undefined;
  }
}

function captureScope(scope: AdminScope): SQL[] {
  const conditions: SQL[] = [];
  if (scope.project) conditions.push(sql`c.project_tag = ${scope.project}`);
  if (scope.source) conditions.push(sql`c.source = ${scope.source}`);
  if (scope.from) conditions.push(sql`c.captured_at >= ${scope.from}`);
  if (scope.to) conditions.push(sql`c.captured_at <= ${scope.to}`);
  return conditions;
}

function observationScope(scope: AdminScope): SQL[] {
  const conditions: SQL[] = [];
  if (scope.project) conditions.push(sql`o.project_tag = ${scope.project}`);
  if (scope.source) conditions.push(sql`o.source = ${scope.source}`);
  if (scope.from) conditions.push(sql`o.created_at >= ${scope.from}`);
  if (scope.to) conditions.push(sql`o.created_at <= ${scope.to}`);
  return conditions;
}

function windowScope(scope: AdminScope): SQL[] {
  const conditions: SQL[] = [];
  if (scope.project) conditions.push(sql`w.project_tag = ${scope.project}`);
  if (scope.source) conditions.push(sql`w.source = ${scope.source}`);
  if (scope.from) conditions.push(sql`w.created_at >= ${scope.from}`);
  if (scope.to) conditions.push(sql`w.created_at <= ${scope.to}`);
  return conditions;
}

function factScope(scope: AdminScope): SQL[] {
  return observationScope(scope);
}

function memoryScope(scope: AdminScope): SQL[] {
  const conditions: SQL[] = [];
  if (scope.project) conditions.push(sql`o.project_tag = ${scope.project}`);
  if (scope.source) conditions.push(sql`o.source = ${scope.source}`);
  if (scope.from) conditions.push(sql`m.updated_at >= ${scope.from}`);
  if (scope.to) conditions.push(sql`m.updated_at <= ${scope.to}`);
  return conditions;
}

function dreamingRunAttentionScope(scope: AdminScope): SQL[] {
  if (scope.project || scope.source) return [sql`false`];
  const conditions: SQL[] = [];
  if (scope.from) conditions.push(sql`started_at >= ${scope.from}`);
  if (scope.to) conditions.push(sql`started_at <= ${scope.to}`);
  return conditions;
}

async function captureSummary(scope: AdminScope): Promise<AdminLayerSummary> {
  const filters = captureScope(scope);
  const [summaryResult, statesResult] = await Promise.all([
    db.execute<SummaryRow>(sql`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE c.captured_at >= now() - interval '24 hours')::int AS created_24h,
        MIN(c.captured_at) FILTER (WHERE c.promotion_state IN ('ready', 'windowed')) AS oldest_actionable_at
      FROM captures c
      ${where(filters)}
    `),
    db.execute<CountRow>(sql`
      SELECT c.promotion_state AS state, COUNT(*)::int AS count
      FROM captures c
      ${where(filters)}
      GROUP BY c.promotion_state
    `),
  ]);
  const row = summaryResult.rows[0];
  return {
    layer: "capture",
    total: toNumber(row?.total),
    created_24h: toNumber(row?.created_24h),
    states: stateRecord(statesResult.rows),
    oldest_actionable_at: iso(row?.oldest_actionable_at),
  };
}

async function observationSummary(
  scope: AdminScope,
): Promise<AdminLayerSummary> {
  const filters = observationScope(scope);
  const [summaryResult, statesResult] = await Promise.all([
    db.execute<SummaryRow>(sql`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE o.created_at >= now() - interval '24 hours')::int AS created_24h,
        MIN(o.created_at) FILTER (
          WHERE o.promotion_state = 'processing'
             OR (
               o.promotion_state = 'ready'
               AND o.promotion_next_attempt_at <= now()
             )
        ) AS oldest_actionable_at
      FROM observations o
      ${where(filters)}
    `),
    db.execute<CountRow>(sql`
      SELECT o.promotion_state AS state, COUNT(*)::int AS count
      FROM observations o
      ${where(filters)}
      GROUP BY o.promotion_state
    `),
  ]);
  const row = summaryResult.rows[0];
  return {
    layer: "observation",
    total: toNumber(row?.total),
    created_24h: toNumber(row?.created_24h),
    states: stateRecord(statesResult.rows),
    oldest_actionable_at: iso(row?.oldest_actionable_at),
  };
}

async function memorySummary(scope: AdminScope): Promise<AdminLayerSummary> {
  const filters = memoryScope(scope);
  const from = sql`
    FROM memories m
    LEFT JOIN links l
      ON l.to_id = m.id
     AND l.to_layer = 'memory'
     AND l.from_layer = 'observation'
    LEFT JOIN observations o ON o.id = l.from_id
  `;
  const state = sql`
    CASE
      WHEN m.archived_at IS NOT NULL THEN 'archived'
      WHEN m.outdated_at IS NOT NULL THEN 'outdated'
      WHEN m.llm_quarantined_at IS NOT NULL THEN 'quarantined'
      ELSE 'active'
    END
  `;
  const [summaryResult, statesResult] = await Promise.all([
    db.execute<SummaryRow>(sql`
      SELECT
        COUNT(DISTINCT m.id)::int AS total,
        COUNT(DISTINCT m.id) FILTER (WHERE m.updated_at >= now() - interval '24 hours')::int AS created_24h,
        MIN(m.updated_at) FILTER (
          WHERE m.outdated_at IS NOT NULL OR m.llm_quarantined_at IS NOT NULL
        ) AS oldest_actionable_at
      ${from}
      ${where(filters)}
    `),
    db.execute<CountRow>(sql`
      SELECT scoped.state, COUNT(*)::int AS count
      FROM (
        SELECT DISTINCT m.id, ${state} AS state
        ${from}
        ${where(filters)}
      ) scoped
      GROUP BY scoped.state
    `),
  ]);
  const row = summaryResult.rows[0];
  return {
    layer: "memory",
    total: toNumber(row?.total),
    created_24h: toNumber(row?.created_24h),
    states: stateRecord(statesResult.rows),
    oldest_actionable_at: iso(row?.oldest_actionable_at),
  };
}

async function queueSummary(
  stage: "window" | "fact",
  scope: AdminScope,
): Promise<AdminQueueSummary> {
  const isWindow = stage === "window";
  const filters = isWindow ? windowScope(scope) : factScope(scope);
  const table = isWindow
    ? sql`capture_promotion_windows w`
    : sql`observation_promotion_facts f JOIN observations o ON o.id = f.observation_id`;
  const state = isWindow ? sql`w.status` : sql`f.status`;
  const createdAt = isWindow ? sql`w.created_at` : sql`f.created_at`;
  const [summaryResult, statesResult] = await Promise.all([
    db.execute<{ total: number | string; oldest_actionable_at: Date | string | null }>(sql`
      SELECT
        COUNT(*)::int AS total,
        MIN(${createdAt}) FILTER (
          WHERE ${state} IN ('pending', 'processing', 'committing', 'deferred')
        ) AS oldest_actionable_at
      FROM ${table}
      ${where(filters)}
    `),
    db.execute<CountRow>(sql`
      SELECT ${state} AS state, COUNT(*)::int AS count
      FROM ${table}
      ${where(filters)}
      GROUP BY ${state}
    `),
  ]);
  return {
    stage,
    total: toNumber(summaryResult.rows[0]?.total),
    states: stateRecord(statesResult.rows),
    oldest_actionable_at: iso(summaryResult.rows[0]?.oldest_actionable_at),
  };
}

async function countAttention(scope: AdminScope): Promise<number> {
  const [windows, facts, observations, memories, runs] = await Promise.all([
    db.execute<{ count: number | string }>(sql`
      SELECT COUNT(*)::int AS count FROM capture_promotion_windows w
      ${where([
        ...windowScope(scope),
        sql`(
          w.status IN ('quarantined', 'deferred')
          OR (w.status IN ('processing', 'committing') AND w.lease_expires_at < now())
        )`,
      ])}
    `),
    db.execute<{ count: number | string }>(sql`
      SELECT COUNT(*)::int AS count
      FROM observation_promotion_facts f
      JOIN observations o ON o.id = f.observation_id
      ${where([
        ...factScope(scope),
        sql`(
          f.status IN ('quarantined', 'deferred')
          OR (f.status IN ('processing', 'committing') AND f.lease_expires_at < now())
        )`,
      ])}
    `),
    db.execute<{ count: number | string }>(sql`
      SELECT COUNT(*)::int AS count FROM observations o
      ${where([
        ...observationScope(scope),
        sql`(
          o.promotion_state IN ('quarantined', 'legacy_partial')
          OR (
            o.promotion_state = 'ready'
            AND o.promotion_failure_count > 0
          )
        )`,
      ])}
    `),
    db.execute<{ count: number | string }>(sql`
      SELECT COUNT(DISTINCT m.id)::int AS count
      FROM memories m
      LEFT JOIN links l
        ON l.to_id = m.id
       AND l.to_layer = 'memory'
       AND l.from_layer = 'observation'
      LEFT JOIN observations o ON o.id = l.from_id
      ${where([
        ...memoryScope(scope),
        sql`m.archived_at IS NULL`,
        sql`(m.outdated_at IS NOT NULL OR m.llm_quarantined_at IS NOT NULL)`,
      ])}
    `),
    db.execute<{ count: number | string }>(sql`
      SELECT COUNT(*)::int AS count FROM dreaming_runs
      ${where([
        ...dreamingRunAttentionScope(scope),
        sql`(
          status IN ('failed', 'partial')
          OR (status = 'running' AND started_at < now() - interval '2 hours')
        )`,
      ])}
    `),
  ]);
  return [windows, facts, observations, memories, runs].reduce(
    (sum, result) => sum + toNumber(result.rows[0]?.count),
    0,
  );
}

async function getFilterOptions(): Promise<AdminFilterOptions> {
  const [projectsResult, sourcesResult] = await Promise.all([
    db.execute<{ value: string }>(sql`
      SELECT DISTINCT value
      FROM (
        SELECT project_tag AS value FROM captures
        UNION
        SELECT project_tag AS value FROM observations
      ) values
      WHERE value IS NOT NULL AND value <> ''
      ORDER BY value
    `),
    db.execute<{ value: ClientSource }>(sql`
      SELECT DISTINCT value
      FROM (
        SELECT source AS value FROM captures
        UNION
        SELECT source AS value FROM observations
      ) values
      ORDER BY value
    `),
  ]);
  return {
    projects: projectsResult.rows.map((row) => row.value),
    sources: sourcesResult.rows.map((row) => row.value),
    states: {
      pipeline: [
        "pending",
        "ready",
        "processing",
        "committing",
        "completed",
        "promoted",
        "skipped",
        "deferred",
        "quarantined",
        "expired",
        "legacy_partial",
      ],
      memories: ["active", "outdated", "quarantined", "archived"],
      operations: [
        "deferred",
        "quarantined",
        "stale",
        "outdated",
        "failed",
        "partial",
        "legacy_partial",
      ],
    },
  };
}

async function getOverview(scope: AdminScope): Promise<Omit<AdminOverview, "scheduler">> {
  const [captures, observations, memories, windows, facts, attentionCount] =
    await Promise.all([
      captureSummary(scope),
      observationSummary(scope),
      memorySummary(scope),
      queueSummary("window", scope),
      queueSummary("fact", scope),
      countAttention(scope),
    ]);
  return {
    generated_at: new Date().toISOString(),
    layers: [captures, observations, memories],
    queues: [windows, facts],
    attention_count: attentionCount,
  };
}

interface AdminMemoryRow extends Record<string, unknown> {
  id: string;
  narrative: string;
  importance: number;
  kind: string;
  created_at: Date | string;
  updated_at: Date | string;
  archived_at: Date | string | null;
  outdated_at: Date | string | null;
  outdated_reason: string | null;
  llm_failure_count: number;
  last_llm_failure_at: Date | string | null;
  llm_quarantined_at: Date | string | null;
  project_tags: string[] | null;
  sources: string[] | null;
}

async function listMemories(
  scope: AdminScope,
  limit: number,
  offset: number,
): Promise<{ memories: Record<string, unknown>[]; total: number }> {
  const conditions = memoryScope(scope);
  const memoryState = sql`
    CASE
      WHEN m.archived_at IS NOT NULL THEN 'archived'
      WHEN m.outdated_at IS NOT NULL THEN 'outdated'
      WHEN m.llm_quarantined_at IS NOT NULL THEN 'quarantined'
      ELSE 'active'
    END
  `;
  if (scope.state) {
    conditions.push(sql`${memoryState} = ${scope.state}`);
  } else {
    conditions.push(sql`m.archived_at IS NULL`);
  }
  if (scope.query) {
    const pattern = `%${scope.query}%`;
    conditions.push(sql`(
      m.id ILIKE ${pattern}
      OR m.narrative ILIKE ${pattern}
      OR m.kind ILIKE ${pattern}
    )`);
  }
  const from = sql`
    FROM memories m
    LEFT JOIN links l
      ON l.to_id = m.id
     AND l.to_layer = 'memory'
     AND l.from_layer = 'observation'
    LEFT JOIN observations o ON o.id = l.from_id
  `;
  const [rowsResult, countResult] = await Promise.all([
    db.execute<AdminMemoryRow>(sql`
      SELECT
        m.id,
        m.narrative,
        m.importance,
        m.kind,
        m.created_at,
        m.updated_at,
        m.archived_at,
        m.outdated_at,
        m.outdated_reason,
        m.llm_failure_count,
        m.last_llm_failure_at,
        m.llm_quarantined_at,
        ARRAY_REMOVE(ARRAY_AGG(DISTINCT o.project_tag), NULL) AS project_tags,
        ARRAY_REMOVE(ARRAY_AGG(DISTINCT o.source), NULL) AS sources
      ${from}
      ${where(conditions)}
      GROUP BY m.id
      ORDER BY m.updated_at DESC, m.id DESC
      LIMIT ${limit}
      OFFSET ${offset}
    `),
    db.execute<{ count: number | string }>(sql`
      SELECT COUNT(DISTINCT m.id)::int AS count
      ${from}
      ${where(conditions)}
    `),
  ]);
  return {
    memories: rowsResult.rows.map((row) => ({
      ...row,
      created_at: iso(row.created_at),
      updated_at: iso(row.updated_at),
      archived_at: iso(row.archived_at),
      outdated_at: iso(row.outdated_at),
      last_llm_failure_at: iso(row.last_llm_failure_at),
      llm_quarantined_at: iso(row.llm_quarantined_at),
      project_tags: row.project_tags ?? [],
      sources: row.sources ?? [],
    })),
    total: toNumber(countResult.rows[0]?.count),
  };
}

interface TraceRow {
  [key: string]: unknown;
  id: string;
  stage: "window" | "observation";
  path: "capture" | "direct";
  project_tag: string | null;
  source: ClientSource;
  session_id: string | null;
  state: string;
  sort_at: Date | string;
  capture_count: number | string;
  completed_turns: number | string;
  observation_id: string | null;
  observation_state: string | null;
  fact_count: number | string;
  completed_fact_count: number | string;
  memory_count: number | string;
  summary: string | null;
  last_error: string | null;
}

function mapTrace(row: TraceRow): AdminPipelineTrace {
  return {
    ...row,
    sort_at: iso(row.sort_at) ?? new Date(0).toISOString(),
    capture_count: toNumber(row.capture_count),
    completed_turns: toNumber(row.completed_turns),
    fact_count: toNumber(row.fact_count),
    completed_fact_count: toNumber(row.completed_fact_count),
    memory_count: toNumber(row.memory_count),
  };
}

async function listPipelineTraces(scope: AdminPageScope): Promise<{
  traces: AdminPipelineTrace[];
  next_cursor: string | null;
}> {
  const cursor = decodeAdminCursor(scope.cursor);
  const conditions: SQL[] = [];
  if (scope.project) conditions.push(sql`traces.project_tag = ${scope.project}`);
  if (scope.source) conditions.push(sql`traces.source = ${scope.source}`);
  if (scope.state) conditions.push(sql`traces.state = ${scope.state}`);
  if (scope.from) conditions.push(sql`traces.sort_at >= ${scope.from}`);
  if (scope.to) conditions.push(sql`traces.sort_at <= ${scope.to}`);
  if (scope.query) {
    const pattern = `%${scope.query}%`;
    conditions.push(sql`(
      traces.id ILIKE ${pattern}
      OR traces.session_id ILIKE ${pattern}
      OR traces.project_tag ILIKE ${pattern}
      OR traces.summary ILIKE ${pattern}
    )`);
  }
  if (cursor) {
    conditions.push(
      sql`(traces.sort_at, traces.id) < (${new Date(cursor.at)}, ${cursor.id})`,
    );
  }

  const result = await db.execute<TraceRow>(sql`
    WITH traces AS (
      SELECT
        w.id,
        'window'::text AS stage,
        'capture'::text AS path,
        w.project_tag,
        w.source,
        w.session_id,
        w.status AS state,
        w.created_at AS sort_at,
        w.capture_count,
        w.completed_turns,
        o.id AS observation_id,
        o.promotion_state AS observation_state,
        (SELECT COUNT(*) FROM observation_promotion_facts f WHERE f.observation_id = o.id)::int AS fact_count,
        (SELECT COUNT(*) FROM observation_promotion_facts f WHERE f.observation_id = o.id AND f.status = 'completed')::int AS completed_fact_count,
        (
          SELECT COUNT(*)
          FROM (
            SELECT f.result_memory_id AS id
            FROM observation_promotion_facts f
            WHERE f.observation_id = o.id
              AND f.result_memory_id IS NOT NULL
            UNION
            SELECT l.to_id AS id
            FROM links l
            WHERE l.from_id = o.id
              AND l.from_layer = 'observation'
              AND l.to_layer = 'memory'
          ) memory_ids
        )::int AS memory_count,
        LEFT(o.content, 280) AS summary,
        w.last_error
      FROM capture_promotion_windows w
      LEFT JOIN observations o ON o.id = w.observation_id

      UNION ALL

      SELECT
        o.id,
        'observation'::text AS stage,
        'direct'::text AS path,
        o.project_tag,
        o.source,
        o.session_id,
        o.promotion_state AS state,
        o.created_at AS sort_at,
        0::int AS capture_count,
        0::int AS completed_turns,
        o.id AS observation_id,
        o.promotion_state AS observation_state,
        (SELECT COUNT(*) FROM observation_promotion_facts f WHERE f.observation_id = o.id)::int AS fact_count,
        (SELECT COUNT(*) FROM observation_promotion_facts f WHERE f.observation_id = o.id AND f.status = 'completed')::int AS completed_fact_count,
        (
          SELECT COUNT(DISTINCT l.to_id)
          FROM links l
          WHERE l.from_id = o.id
            AND l.from_layer = 'observation'
            AND l.to_layer = 'memory'
        )::int AS memory_count,
        LEFT(o.content, 280) AS summary,
        NULL::text AS last_error
      FROM observations o
      WHERE o.source_layer = 'agent'
    )
    SELECT * FROM traces
    ${where(conditions)}
    ORDER BY traces.sort_at DESC, traces.id DESC
    LIMIT ${scope.limit + 1}
  `);

  const hasNext = result.rows.length > scope.limit;
  const rows = result.rows.slice(0, scope.limit).map(mapTrace);
  const last = rows.at(-1);
  return {
    traces: rows,
    next_cursor:
      hasNext && last
        ? encodeAdminCursor({ at: last.sort_at, id: last.id })
        : null,
  };
}

interface NodeRow {
  [key: string]: unknown;
  id: string;
  kind: AdminTraceNode["kind"];
  state: string;
  occurred_at: Date | string;
  summary: string | null;
  metadata: Record<string, unknown> | null;
}

function mapNode(row: NodeRow): AdminTraceNode {
  return {
    ...row,
    occurred_at: iso(row.occurred_at) ?? new Date(0).toISOString(),
    metadata: row.metadata ?? {},
  };
}

async function getPipelineTrace(
  id: string,
): Promise<AdminPipelineTraceDetail | null> {
  const isWindow = id.startsWith("win_");
  const observationResult = isWindow
    ? await db.execute<{ id: string }>(sql`
        SELECT observation_id AS id
        FROM capture_promotion_windows
        WHERE id = ${id} AND observation_id IS NOT NULL
        LIMIT 1
      `)
    : await db.execute<{ id: string }>(sql`
        SELECT id FROM observations WHERE id = ${id} LIMIT 1
      `);
  const observationId = observationResult.rows[0]?.id ?? null;

  if (isWindow) {
    const exists = await db.execute<{ exists: boolean }>(sql`
      SELECT EXISTS(SELECT 1 FROM capture_promotion_windows WHERE id = ${id}) AS exists
    `);
    if (!exists.rows[0]?.exists) return null;
  } else if (!observationId) {
    return null;
  }

  const nodes: AdminTraceNode[] = [];
  const edges: AdminTraceEdge[] = [];

  if (isWindow) {
    const [windowResult, capturesResult] = await Promise.all([
      db.execute<NodeRow>(sql`
        SELECT
          w.id,
          'window'::text AS kind,
          w.status AS state,
          w.created_at AS occurred_at,
          CONCAT(w.capture_count, ' captures / ', w.completed_turns, ' completed turns') AS summary,
          jsonb_build_object(
            'raw_chars', w.raw_chars,
            'fallback', w.fallback,
            'attempt_count', w.attempt_count,
            'failure_count', w.failure_count,
            'next_attempt_at', w.next_attempt_at,
            'lease_expires_at', w.lease_expires_at,
            'last_error', w.last_error,
            'completed_at', w.completed_at
          ) AS metadata
        FROM capture_promotion_windows w
        WHERE w.id = ${id}
      `),
      db.execute<NodeRow>(sql`
        SELECT
          c.id,
          'capture'::text AS kind,
          c.promotion_state AS state,
          c.captured_at AS occurred_at,
          LEFT(COALESCE(c.continuity_content, c.raw_content), 500) AS summary,
          jsonb_build_object(
            'hook_event', c.hook_event,
            'tool_name', c.tool_name,
            'turn_id', c.turn_id,
            'expires_at', c.expires_at,
            'skip_reason', c.skip_reason
          ) AS metadata
        FROM captures c
        WHERE c.promotion_window_id = ${id}
        ORDER BY c.captured_at ASC
      `),
    ]);
    nodes.push(...windowResult.rows.map(mapNode));
    nodes.push(...capturesResult.rows.map(mapNode));
    edges.push(
      ...capturesResult.rows.map((capture) => ({
        from_id: capture.id,
        to_id: id,
        relation: "batched_into",
      })),
    );
  }

  if (observationId) {
    const [observationNode, factsResult, linksResult] = await Promise.all([
      db.execute<NodeRow>(sql`
        SELECT
          o.id,
          'observation'::text AS kind,
          o.promotion_state AS state,
          o.created_at AS occurred_at,
          o.content AS summary,
          jsonb_build_object(
            'type', o.type,
            'source', o.source,
            'source_layer', o.source_layer,
            'session_id', o.session_id,
            'project_tag', o.project_tag,
            'facts', o.facts,
            'promotion_failure_count', o.promotion_failure_count,
            'promotion_next_attempt_at', o.promotion_next_attempt_at,
            'promotion_last_failure_at', o.promotion_last_failure_at,
            'promotion_last_error', o.promotion_last_error,
            'promoted_at', o.promoted_at
          ) AS metadata
        FROM observations o
        WHERE o.id = ${observationId}
      `),
      db.execute<NodeRow>(sql`
        SELECT
          f.id,
          'fact'::text AS kind,
          f.status AS state,
          f.created_at AS occurred_at,
          f.fact AS summary,
          jsonb_build_object(
            'ordinal', f.ordinal,
            'attempt_count', f.attempt_count,
            'failure_count', f.failure_count,
            'next_attempt_at', f.next_attempt_at,
            'lease_expires_at', f.lease_expires_at,
            'last_error', f.last_error,
            'decision', f.decision,
            'target_memory_id', f.target_memory_id,
            'result_memory_id', f.result_memory_id,
            'reasoning', f.reasoning,
            'completed_at', f.completed_at
          ) AS metadata
        FROM observation_promotion_facts f
        WHERE f.observation_id = ${observationId}
        ORDER BY f.ordinal ASC
      `),
      db.execute<{ from_id: string; to_id: string; relation: string }>(sql`
        SELECT from_id, to_id, relation
        FROM links
        WHERE from_id = ${observationId} OR to_id = ${observationId}
      `),
    ]);
    nodes.push(...observationNode.rows.map(mapNode));
    nodes.push(...factsResult.rows.map(mapNode));
    if (isWindow) {
      edges.push({ from_id: id, to_id: observationId, relation: "promoted_to" });
    }
    edges.push(
      ...factsResult.rows.map((fact) => ({
        from_id: observationId,
        to_id: fact.id,
        relation: "contains_fact",
      })),
    );
    edges.push(...linksResult.rows);

    const memoryIds = new Set<string>();
    for (const fact of factsResult.rows) {
      const resultId = fact.metadata?.result_memory_id;
      if (typeof resultId === "string") memoryIds.add(resultId);
      const targetId = fact.metadata?.target_memory_id;
      if (typeof targetId === "string") memoryIds.add(targetId);
    }
    for (const link of linksResult.rows) {
      if (link.to_id.startsWith("mem_")) memoryIds.add(link.to_id);
      if (link.from_id.startsWith("mem_")) memoryIds.add(link.from_id);
    }

    if (memoryIds.size > 0) {
      const ids = [...memoryIds];
      const memoryResult = await db.execute<NodeRow>(sql`
        SELECT
          m.id,
          'memory'::text AS kind,
          CASE
            WHEN m.archived_at IS NOT NULL THEN 'archived'
            WHEN m.outdated_at IS NOT NULL THEN 'outdated'
            WHEN m.llm_quarantined_at IS NOT NULL THEN 'quarantined'
            ELSE 'active'
          END AS state,
          m.updated_at AS occurred_at,
          m.narrative AS summary,
          jsonb_build_object(
            'kind', m.kind,
            'importance', m.importance,
            'outdated_reason', m.outdated_reason,
            'llm_failure_count', m.llm_failure_count,
            'archived_at', m.archived_at
          ) AS metadata
        FROM memories m
        WHERE m.id IN (${sql.join(ids.map((memoryId) => sql`${memoryId}`), sql`, `)})
      `);
      nodes.push(...memoryResult.rows.map(mapNode));
      for (const fact of factsResult.rows) {
        const resultId = fact.metadata?.result_memory_id;
        if (typeof resultId === "string") {
          edges.push({ from_id: fact.id, to_id: resultId, relation: "resulted_in" });
        }
      }
    }
  }

  return { id, path: isWindow ? "capture" : "direct", nodes, edges };
}

interface IssueRow {
  [key: string]: unknown;
  id: string;
  kind: AdminOperationIssue["kind"];
  state: string;
  project_tag: string | null;
  source: string | null;
  occurred_at: Date | string;
  attempt_count: number | string;
  failure_count: number | string;
  summary: string | null;
  last_error: string | null;
}

function mapIssue(row: IssueRow): AdminOperationIssue {
  return {
    ...row,
    occurred_at: iso(row.occurred_at) ?? new Date(0).toISOString(),
    attempt_count: toNumber(row.attempt_count),
    failure_count: toNumber(row.failure_count),
  };
}

async function listOperationIssues(scope: AdminPageScope): Promise<{
  issues: AdminOperationIssue[];
  next_cursor: string | null;
}> {
  const cursor = decodeAdminCursor(scope.cursor);
  const conditions: SQL[] = [];
  if (scope.project) conditions.push(sql`issues.project_tag = ${scope.project}`);
  if (scope.source) conditions.push(sql`issues.source = ${scope.source}`);
  if (scope.state) conditions.push(sql`issues.state = ${scope.state}`);
  if (scope.from) conditions.push(sql`issues.occurred_at >= ${scope.from}`);
  if (scope.to) conditions.push(sql`issues.occurred_at <= ${scope.to}`);
  if (scope.query) {
    const pattern = `%${scope.query}%`;
    conditions.push(sql`(
      issues.id ILIKE ${pattern}
      OR issues.project_tag ILIKE ${pattern}
      OR issues.summary ILIKE ${pattern}
      OR issues.last_error ILIKE ${pattern}
    )`);
  }
  if (cursor) {
    conditions.push(
      sql`(issues.occurred_at, issues.id) < (${new Date(cursor.at)}, ${cursor.id})`,
    );
  }

  const result = await db.execute<IssueRow>(sql`
    WITH issues AS (
      SELECT
        w.id,
        'window'::text AS kind,
        CASE
          WHEN w.status IN ('processing', 'committing') AND w.lease_expires_at < now() THEN 'stale'
          ELSE w.status
        END AS state,
        w.project_tag,
        w.source,
        w.updated_at AS occurred_at,
        w.attempt_count,
        w.failure_count,
        CONCAT(w.capture_count, ' captures / ', w.completed_turns, ' completed turns') AS summary,
        w.last_error
      FROM capture_promotion_windows w
      WHERE w.status IN ('deferred', 'quarantined')
         OR (w.status IN ('processing', 'committing') AND w.lease_expires_at < now())

      UNION ALL

      SELECT
        f.id,
        'fact'::text AS kind,
        CASE
          WHEN f.status IN ('processing', 'committing') AND f.lease_expires_at < now() THEN 'stale'
          ELSE f.status
        END AS state,
        o.project_tag,
        o.source,
        f.updated_at AS occurred_at,
        f.attempt_count,
        f.failure_count,
        LEFT(f.fact, 280) AS summary,
        f.last_error
      FROM observation_promotion_facts f
      JOIN observations o ON o.id = f.observation_id
      WHERE f.status IN ('deferred', 'quarantined')
         OR (f.status IN ('processing', 'committing') AND f.lease_expires_at < now())

      UNION ALL

      SELECT
        o.id,
        'observation'::text AS kind,
        CASE
          WHEN o.promotion_state = 'ready' AND o.promotion_failure_count > 0
            THEN 'deferred'
          ELSE o.promotion_state
        END AS state,
        o.project_tag,
        o.source,
        COALESCE(o.promotion_last_failure_at, o.created_at) AS occurred_at,
        0::int AS attempt_count,
        o.promotion_failure_count AS failure_count,
        LEFT(o.content, 280) AS summary,
        o.promotion_last_error AS last_error
      FROM observations o
      WHERE o.promotion_state IN ('quarantined', 'legacy_partial')
         OR (o.promotion_state = 'ready' AND o.promotion_failure_count > 0)

      UNION ALL

      SELECT
        m.id,
        'memory'::text AS kind,
        CASE
          WHEN m.outdated_at IS NOT NULL THEN 'outdated'
          ELSE 'quarantined'
        END AS state,
        provenance.project_tag,
        provenance.source,
        COALESCE(m.outdated_at, m.llm_quarantined_at, m.updated_at) AS occurred_at,
        m.llm_failure_count AS attempt_count,
        m.llm_failure_count AS failure_count,
        LEFT(m.narrative, 280) AS summary,
        m.outdated_reason AS last_error
      FROM memories m
      LEFT JOIN LATERAL (
        SELECT o.project_tag, o.source
        FROM links l
        JOIN observations o ON o.id = l.from_id
        WHERE l.to_id = m.id
          AND l.from_layer = 'observation'
          AND l.to_layer = 'memory'
        ORDER BY o.created_at DESC
        LIMIT 1
      ) provenance ON true
      WHERE m.archived_at IS NULL
        AND (m.outdated_at IS NOT NULL OR m.llm_quarantined_at IS NOT NULL)

      UNION ALL

      SELECT
        r.id,
        'dreaming_run'::text AS kind,
        CASE
          WHEN r.status = 'running' AND r.started_at < now() - interval '2 hours' THEN 'stale'
          ELSE r.status
        END AS state,
        NULL::text AS project_tag,
        NULL::text AS source,
        r.started_at AS occurred_at,
        0::int AS attempt_count,
        0::int AS failure_count,
        r.job_kind AS summary,
        r.error_message AS last_error
      FROM dreaming_runs r
      WHERE r.status IN ('failed', 'partial')
         OR (r.status = 'running' AND r.started_at < now() - interval '2 hours')
    )
    SELECT * FROM issues
    ${where(conditions)}
    ORDER BY issues.occurred_at DESC, issues.id DESC
    LIMIT ${scope.limit + 1}
  `);
  const hasNext = result.rows.length > scope.limit;
  const rows = result.rows.slice(0, scope.limit).map(mapIssue);
  const last = rows.at(-1);
  return {
    issues: rows,
    next_cursor:
      hasNext && last
        ? encodeAdminCursor({ at: last.occurred_at, id: last.id })
        : null,
  };
}

export const adminRepo = {
  getFilterOptions,
  getOverview,
  listMemories,
  listPipelineTraces,
  getPipelineTrace,
  listOperationIssues,
};
