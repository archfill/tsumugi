/**
 * Programmatic Drizzle migration runner.
 *
 * Invoked at server startup so production deployments self-apply schema
 * without a separate `drizzle-kit migrate` step (drizzle-kit is a dev
 * dependency and is not installed in the prod image).
 *
 * Idempotent: the drizzle `__drizzle_migrations` table tracks applied
 * versions and skips them on re-run.
 */

import process from "node:process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { logger } from "../lib/logger.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// dev:  apps/server/src/data → ../../drizzle  = apps/server/drizzle
// prod: apps/server/dist/data → ../../drizzle = apps/server/drizzle
const MIGRATIONS_FOLDER = resolve(HERE, "../../drizzle");

export async function runMigrations(): Promise<void> {
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for migrations");
  }

  const pool = new Pool({ connectionString: databaseUrl });
  const db = drizzle(pool);

  const started = Date.now();
  try {
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    logger.info(
      { folder: MIGRATIONS_FOLDER, durationMs: Date.now() - started },
      "migrations applied",
    );
  } finally {
    await pool.end();
  }
}
