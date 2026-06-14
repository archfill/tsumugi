import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BenchSummary } from "./types.js";

function pad(s: string, w: number) {
  if (s.length >= w) return s;
  return s + " ".repeat(w - s.length);
}

function fmtPct(n: number) {
  return `${(n * 100).toFixed(1)}%`;
}

function fmtMs(n: number) {
  if (n < 1000) return `${Math.round(n)}ms`;
  return `${(n / 1000).toFixed(2)}s`;
}

export function renderSummary(summary: BenchSummary): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(`=== ${summary.name} ===`);
  lines.push(
    `total: ${summary.totalCases}  pass: ${summary.passed}  fail: ${summary.failed}  error: ${summary.errored}  passRate: ${fmtPct(summary.passRate)}  duration: ${fmtMs(summary.totalDurationMs)} (avg ${fmtMs(summary.avgDurationMs)}/case)`,
  );

  if (summary.metrics && Object.keys(summary.metrics).length > 0) {
    lines.push("");
    lines.push("metrics:");
    for (const [k, v] of Object.entries(summary.metrics)) {
      const formatted = Math.abs(v) <= 1 ? v.toFixed(3) : v.toFixed(2);
      lines.push(`  ${pad(k, 28)} ${formatted}`);
    }
  }

  const failed = summary.outcomes.filter((o) => !o.passed);
  if (failed.length > 0) {
    lines.push("");
    lines.push(`failed cases (${failed.length}):`);
    for (const o of failed) {
      const label = o.description ? `${o.caseId} — ${o.description}` : o.caseId;
      const reason = o.error ? ` [ERROR: ${o.error}]` : "";
      lines.push(`  ✗ ${label}${reason}`);
    }
  }

  if (summary.detail) {
    lines.push("");
    lines.push(summary.detail);
  }

  return lines.join("\n");
}

export function renderAll(summaries: BenchSummary[]): string {
  return summaries.map(renderSummary).join("\n");
}

export interface OverallReport {
  timestamp: string;
  totalCases: number;
  passed: number;
  failed: number;
  errored: number;
  passRate: number;
  totalDurationMs: number;
  summaries: BenchSummary[];
}

export function buildOverall(
  summaries: BenchSummary[],
  timestamp: string,
): OverallReport {
  const total = summaries.reduce((a, s) => a + s.totalCases, 0);
  const passed = summaries.reduce((a, s) => a + s.passed, 0);
  const failed = summaries.reduce((a, s) => a + s.failed, 0);
  const errored = summaries.reduce((a, s) => a + s.errored, 0);
  const duration = summaries.reduce((a, s) => a + s.totalDurationMs, 0);
  return {
    timestamp,
    totalCases: total,
    passed,
    failed,
    errored,
    passRate: total === 0 ? 0 : passed / total,
    totalDurationMs: duration,
    summaries,
  };
}

export async function saveReport(
  report: OverallReport,
  outDir: string,
): Promise<string> {
  await mkdir(outDir, { recursive: true });
  const safeTs = report.timestamp.replace(/[:.]/g, "-");
  const path = join(outDir, `bench-${safeTs}.json`);
  await writeFile(path, JSON.stringify(report, null, 2));
  return path;
}

export function renderOverall(report: OverallReport): string {
  return [
    "",
    "=== overall ===",
    `total: ${report.totalCases}  pass: ${report.passed}  fail: ${report.failed}  error: ${report.errored}  passRate: ${fmtPct(report.passRate)}  duration: ${fmtMs(report.totalDurationMs)}`,
  ].join("\n");
}
