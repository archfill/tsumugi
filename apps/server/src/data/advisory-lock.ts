import { logger } from "../lib/logger.js";
import { pool } from "./client.js";

export async function withPgAdvisoryLock<T>(
  lockName: string,
  onLocked: () => Promise<T>,
  onBusy: () => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let locked = false;

  try {
    const result = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked",
      [lockName],
    );
    locked = Boolean(result.rows[0]?.locked);
    if (!locked) {
      return await onBusy();
    }

    return await onLocked();
  } finally {
    if (locked) {
      try {
        await client.query(
          "SELECT pg_advisory_unlock(hashtextextended($1, 0))",
          [lockName],
        );
      } catch (err) {
        logger.warn(
          { lockName, err: err instanceof Error ? err.message : String(err) },
          "failed to release advisory lock",
        );
      }
    }
    client.release();
  }
}
