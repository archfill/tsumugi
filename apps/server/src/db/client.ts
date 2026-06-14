/**
 * Database client.
 * Uses `pg` Pool wrapped by drizzle-orm.
 */

import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema.js";

const { Pool } = pg;

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error("DATABASE_URL environment variable is required");
}

const pool = new Pool({ connectionString: url });

export const db = drizzle(pool, { schema });
export type DB = typeof db;
