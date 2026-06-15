/**
 * staging/ の JSONL を tsumugi DB に投入する。
 *
 * 設計: ADR-010 (Phase 4 yui 移行戦略) を参照。
 *
 * 接続先: tsumugi 本番 DB (DATABASE_URL 環境変数で指定)。
 *   pve-docker 上の tsumugi-postgres は外部公開してないため SSH tunnel 経由:
 *   ssh -L 5433:tsumugi-postgres:5432 pve-docker
 *   DATABASE_URL=postgresql://tsumugi:***@localhost:5433/tsumugi
 *
 * 冪等性:
 *   - tsumugi ID は `obs_<yui_uuid>` 等の deterministic 形式
 *   - INSERT ... ON CONFLICT (id) DO NOTHING で衝突時 skip
 *   - 再実行で重複しない
 *
 * Embedding:
 *   - tsumugi の embedder (BGE-M3) で再計算
 *   - 32 件 batch で実行 (memory efficient)
 *
 * オプション:
 *   --dry-run         DB に書かず件数だけ表示
 *   --limit N         先頭 N 件のみ投入 (動作確認用)
 *   --skip-embed      embedding を NULL で投入 (後で backfill 想定)
 *   --types o,m,d     投入対象を絞る (observations, memories, decisions)
 */

import process from "node:process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  getEmbedder,
  warmupEmbedder,
} from "../../src/external/embedding/singleton.js";
import { logger } from "../../src/lib/logger.js";

const { Pool } = pg;

const HERE = dirname(fileURLToPath(import.meta.url));
const STAGING = join(HERE, "staging");

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

interface Opts {
  dryRun: boolean;
  limit: number | null;
  skipEmbed: boolean;
  types: Set<"o" | "m" | "d">;
  batchSize: number;
}

function parseArgs(argv: string[]): Opts {
  const opts: Opts = {
    dryRun: false,
    limit: null,
    skipEmbed: false,
    types: new Set(["o", "m", "d"]),
    batchSize: 32,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--skip-embed") opts.skipEmbed = true;
    else if (a === "--limit") opts.limit = Number(argv[++i]);
    else if (a === "--batch") opts.batchSize = Number(argv[++i]);
    else if (a === "--types") {
      const v = (argv[++i] ?? "").split(",").map((s) => s.trim());
      opts.types = new Set(
        v.filter((s): s is "o" | "m" | "d" => /^[omd]$/.test(s)),
      );
    }
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Record types (mirror extract.ts output)
// ---------------------------------------------------------------------------

interface ObsRecord {
  src_id: string;
  src_source: string;
  src_kind: string;
  source: string;
  type: string;
  content: string;
  facts: string[] | null;
  recorded_at: string;
}

interface MemRecord {
  src_id: string;
  kind: string;
  narrative: string;
  importance: number | null;
  created_at: string;
}

interface DecRecord {
  src_id: string;
  content: string;
  status: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

function loadJsonl<T>(name: string): T[] {
  const path = join(STAGING, name);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as T);
}

function loadExclusions(): Set<string> {
  const path = join(STAGING, "exclusions.txt");
  if (!existsSync(path)) return new Set();
  const lines = readFileSync(path, "utf8").split("\n");
  return new Set(
    lines.map((l) => l.trim()).filter((l) => l && !l.startsWith("#")),
  );
}

// ---------------------------------------------------------------------------
// Embedding helpers
// ---------------------------------------------------------------------------

function vectorLiteral(arr: Float32Array | null): string | null {
  if (!arr) return null;
  return `[${Array.from(arr).join(",")}]`;
}

async function embedBatch(texts: string[]): Promise<(Float32Array | null)[]> {
  if (texts.length === 0) return [];
  const embedder = getEmbedder();
  // embedMany handles arrays internally with @xenova/transformers
  return await embedder.embedMany(texts);
}

// ---------------------------------------------------------------------------
// Insert pipelines (one batch at a time)
// ---------------------------------------------------------------------------

async function insertObservations(
  pool: pg.Pool,
  rows: ObsRecord[],
  opts: Opts,
): Promise<{ inserted: number; skipped: number; conflicts: number }> {
  let inserted = 0;
  let conflicts = 0;
  const batchSize = opts.batchSize;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const embeddings = opts.skipEmbed
      ? batch.map(() => null)
      : await embedBatch(batch.map((r) => r.content));

    if (opts.dryRun) {
      inserted += batch.length;
      process.stdout.write(
        `  obs progress: ${i + batch.length}/${rows.length} (dry-run)\r`,
      );
      continue;
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (let j = 0; j < batch.length; j++) {
        const r = batch[j]!;
        const emb = embeddings[j];
        const id = `obs_${r.src_id}`;
        const result = await client.query(
          `INSERT INTO observations
             (id, content, type, source, session_id, project_tag, facts, metadata, embedding, created_at, promoted_at)
           VALUES ($1, $2, $3, $4, NULL, NULL, $5, $6, $7::vector, $8, NULL)
           ON CONFLICT (id) DO NOTHING`,
          [
            id,
            r.content,
            r.type,
            r.source,
            JSON.stringify(r.facts ?? []),
            JSON.stringify({
              yui_src_id: r.src_id,
              yui_src_kind: r.src_kind,
              yui_src_source: r.src_source,
            }),
            vectorLiteral(emb),
            r.recorded_at,
          ],
        );
        if (result.rowCount === 0) conflicts++;
        else inserted++;
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
    process.stdout.write(
      `  obs progress: ${i + batch.length}/${rows.length}\r`,
    );
  }
  process.stdout.write("\n");
  return { inserted, skipped: 0, conflicts };
}

async function insertMemories(
  pool: pg.Pool,
  rows: MemRecord[],
  opts: Opts,
): Promise<{ inserted: number; skipped: number; conflicts: number }> {
  let inserted = 0;
  let conflicts = 0;
  const batchSize = opts.batchSize;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const embeddings = opts.skipEmbed
      ? batch.map(() => null)
      : await embedBatch(batch.map((r) => r.narrative));

    if (opts.dryRun) {
      inserted += batch.length;
      process.stdout.write(
        `  mem progress: ${i + batch.length}/${rows.length} (dry-run)\r`,
      );
      continue;
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (let j = 0; j < batch.length; j++) {
        const r = batch[j]!;
        const emb = embeddings[j];
        const id = `mem_${r.src_id}`;
        const result = await client.query(
          `INSERT INTO memories
             (id, narrative, importance, kind, embedding, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5::vector, $6, $6)
           ON CONFLICT (id) DO NOTHING`,
          [
            id,
            r.narrative,
            r.importance ?? 5.0,
            r.kind,
            vectorLiteral(emb),
            r.created_at,
          ],
        );
        if (result.rowCount === 0) conflicts++;
        else inserted++;
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
    process.stdout.write(
      `  mem progress: ${i + batch.length}/${rows.length}\r`,
    );
  }
  process.stdout.write("\n");
  return { inserted, skipped: 0, conflicts };
}

async function insertDecisions(
  pool: pg.Pool,
  rows: DecRecord[],
  opts: Opts,
): Promise<{ inserted: number; skipped: number; conflicts: number }> {
  let inserted = 0;
  let conflicts = 0;
  if (opts.dryRun) {
    return { inserted: rows.length, skipped: 0, conflicts: 0 };
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const r of rows) {
      const id = `dec_${r.src_id}`;
      // yui の 'active' は tsumugi の 'in_progress' にマップ
      const status = r.status === "active" ? "in_progress" : r.status;
      const result = await client.query(
        `INSERT INTO decisions (id, content, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $4)
         ON CONFLICT (id) DO NOTHING`,
        [id, r.content, status, r.created_at],
      );
      if (result.rowCount === 0) conflicts++;
      else inserted++;
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  return { inserted, skipped: 0, conflicts };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  if (!opts.dryRun) {
    const url = process.env["DATABASE_URL"];
    if (!url) throw new Error("DATABASE_URL is required (or use --dry-run)");
  }

  console.log("opts:", {
    dryRun: opts.dryRun,
    limit: opts.limit ?? "all",
    skipEmbed: opts.skipEmbed,
    types: [...opts.types].join(","),
    batchSize: opts.batchSize,
  });

  const exclusions = loadExclusions();
  console.log(`exclusions: ${exclusions.size} src_ids`);

  // Load
  const obsRaw = opts.types.has("o")
    ? loadJsonl<ObsRecord>("observations.jsonl")
    : [];
  const memRaw = opts.types.has("m")
    ? loadJsonl<MemRecord>("memories.jsonl")
    : [];
  const decRaw = opts.types.has("d")
    ? loadJsonl<DecRecord>("decisions.jsonl")
    : [];

  const obs = obsRaw.filter((r) => !exclusions.has(r.src_id));
  const mem = memRaw.filter((r) => !exclusions.has(r.src_id));
  const dec = decRaw.filter((r) => !exclusions.has(r.src_id));

  const limited = (xs: unknown[]) =>
    opts.limit !== null ? xs.slice(0, opts.limit) : xs;
  const obsFinal = limited(obs) as ObsRecord[];
  const memFinal = limited(mem) as MemRecord[];
  const decFinal = limited(dec) as DecRecord[];

  console.log(
    `to insert: obs ${obsFinal.length} (loaded ${obsRaw.length}, excluded ${obsRaw.length - obs.length}), mem ${memFinal.length}, dec ${decFinal.length}`,
  );

  // Warmup embedder
  if (!opts.skipEmbed && (obsFinal.length > 0 || memFinal.length > 0)) {
    console.log("warming up embedder...");
    warmupEmbedder();
    // Force eager warmup completion before batch processing
    await getEmbedder().embed("warmup ack");
    console.log("  embedder ready");
  }

  // Connect (skip if dry-run)
  const pool = opts.dryRun
    ? (null as unknown as pg.Pool)
    : new Pool({ connectionString: process.env["DATABASE_URL"] });

  try {
    if (opts.types.has("o") && obsFinal.length > 0) {
      console.log(`\nobservations...`);
      const r = await insertObservations(pool, obsFinal, opts);
      console.log(`  inserted ${r.inserted}, conflicts ${r.conflicts}`);
    }
    if (opts.types.has("m") && memFinal.length > 0) {
      console.log(`\nmemories...`);
      const r = await insertMemories(pool, memFinal, opts);
      console.log(`  inserted ${r.inserted}, conflicts ${r.conflicts}`);
    }
    if (opts.types.has("d") && decFinal.length > 0) {
      console.log(`\ndecisions...`);
      const r = await insertDecisions(pool, decFinal, opts);
      console.log(`  inserted ${r.inserted}, conflicts ${r.conflicts}`);
    }
    console.log("\n✓ apply complete");
  } finally {
    if (pool) await pool.end();
  }
}

main().catch((err) => {
  logger.fatal(
    { err: err instanceof Error ? err.message : String(err) },
    "apply failed",
  );
  console.error(err);
  process.exit(1);
});
