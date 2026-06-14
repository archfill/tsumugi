/**
 * Optional loader for private (yui-derived) fixtures.
 *
 * Private fixtures live under `eval/fixtures-private/` and are .gitignore'd.
 * If the file is missing, return an empty array so the bench still runs on
 * synthetic data alone.
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
