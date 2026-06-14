/**
 * Shared types for tsumugi evaluation benches.
 */

export interface FixtureCase<TInput, TExpected> {
  id: string;
  description?: string;
  input: TInput;
  expected: TExpected;
  tags?: string[];
}

export interface BenchOutcome<TActual> {
  caseId: string;
  description?: string;
  passed: boolean;
  actual: TActual | null;
  error?: string;
  durationMs: number;
  tags?: string[];
}

export interface BenchSummary {
  name: string;
  totalCases: number;
  passed: number;
  failed: number;
  errored: number;
  passRate: number;
  totalDurationMs: number;
  avgDurationMs: number;
  outcomes: BenchOutcome<unknown>[];
  /** Bench-specific aggregate metrics (F1, MRR, recall, etc.). */
  metrics?: Record<string, number>;
  /** Free-form text rendered after the table (e.g. confusion matrix). */
  detail?: string;
}
