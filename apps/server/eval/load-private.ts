/**
 * Optional loader for private search fixtures.
 *
 * Private fixtures live under `eval/fixtures-private/` and are gitignored. If
 * a file is absent, the bench continues with public synthetic data only.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { FixtureCase } from "./types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PRIVATE_DIR = join(HERE, "fixtures-private");

export async function loadPrivateFixtures<TInput, TExpected>(
  filename: string,
): Promise<FixtureCase<TInput, TExpected>[]> {
  const path = join(PRIVATE_DIR, filename);
  if (!existsSync(path)) return [];
  const mod = (await import(pathToFileURL(path).href)) as {
    fixtures?: FixtureCase<TInput, TExpected>[];
  };
  return mod.fixtures ?? [];
}
