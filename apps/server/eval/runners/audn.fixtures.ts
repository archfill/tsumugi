import {
  fixtures as syntheticFixtures,
  type AudnExpected,
  type AudnInput,
} from "../fixtures/audn.synthetic.js";
import { loadPrivateFixtures } from "../load-private.js";
import type { FixtureCase } from "../types.js";

export type AudnFixture = FixtureCase<AudnInput, AudnExpected>;
export type { AudnExpected, AudnInput };

export interface AudnFixtureLoadOptions {
  includeSynthetic?: boolean;
  includePrivate?: boolean;
  privatePerDecision?: number;
}

const DECISIONS: AudnExpected["decision"][] = [
  "ADD",
  "UPDATE",
  "DELETE",
  "NOOP",
];

function stableHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function sampleAudnFixturesByDecision(
  fixtures: AudnFixture[],
  perDecision: number,
): AudnFixture[] {
  if (!Number.isInteger(perDecision) || perDecision < 0) {
    throw new Error("AUDN fixture sample size must be a non-negative integer");
  }
  return DECISIONS.flatMap((decision) =>
    fixtures
      .filter((fixture) => fixture.expected.decision === decision)
      .sort(
        (left, right) =>
          stableHash(left.id) - stableHash(right.id) ||
          left.id.localeCompare(right.id),
      )
      .slice(0, perDecision),
  );
}

export async function loadAudnFixtures(
  options: AudnFixtureLoadOptions = {},
): Promise<AudnFixture[]> {
  const synthetic =
    options.includeSynthetic === false ? [] : syntheticFixtures;
  let privateFixtures =
    options.includePrivate === false
      ? []
      : await loadPrivateFixtures<AudnInput, AudnExpected>("audn.private.ts");
  if (options.privatePerDecision !== undefined) {
    privateFixtures = sampleAudnFixturesByDecision(
      privateFixtures,
      options.privatePerDecision,
    );
  }
  return [...synthetic, ...privateFixtures];
}
