import assert from "node:assert/strict";
import test from "node:test";
import {
  formatFallbackRate,
  formatRunCount,
  readDreamingRunMetrics,
} from "../src/run-metrics.ts";

test("batch処理メタデータをrun表示用metricsへ変換する", () => {
  const metrics = readDreamingRunMetrics({
    factsSelected: 411,
    factBatchesSelected: 137,
    factBatchFallbacks: 4,
    factsCompleted: 402,
    factsDeferred: 9,
    stoppedReason: "completed",
  });

  assert.deepEqual(metrics, {
    factsSelected: 411,
    factBatchesSelected: 137,
    factBatchFallbacks: 4,
    factsCompleted: 402,
    factsDeferred: 9,
    stoppedReason: "completed",
    fallbackRate: 4 / 137,
  });
  assert.equal(formatFallbackRate(metrics?.fallbackRate ?? null), "2.9%");
  assert.equal(formatRunCount(metrics?.factsCompleted ?? null), "402");
});

test("metadataがないrunではmetrics行を表示しない", () => {
  assert.equal(readDreamingRunMetrics(null), null);
  assert.equal(readDreamingRunMetrics({}), null);
});

test("batch数0ではfallback率を未算出にする", () => {
  const metrics = readDreamingRunMetrics({
    factBatchesSelected: 0,
    factBatchFallbacks: 0,
    stoppedReason: "completed",
  });

  assert.equal(metrics?.fallbackRate, null);
  assert.equal(formatFallbackRate(metrics?.fallbackRate ?? null), "—");
});
