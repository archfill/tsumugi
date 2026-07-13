/**
 * Prometheus metrics registry and instrumentation helpers.
 *
 * Exposes:
 *   - default Node.js process metrics (CPU, heap, event-loop lag, etc.)
 *   - HTTP request counters / histograms
 *   - LLM call counters / histograms
 *   - Dreaming run counters / histograms
 *   - Embedder call counters / histograms
 *   - Memory/observation gauges populated lazily on scrape
 *
 * `/metrics` route exposes `registry.metrics()` in Prometheus text format.
 */

import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from "prom-client";

export const registry = new Registry();
registry.setDefaultLabels({ app: "tsumugi" });
collectDefaultMetrics({ register: registry });

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

export const httpRequestsTotal = new Counter({
  name: "tsumugi_http_requests_total",
  help: "Total number of HTTP requests by route, method, and status code.",
  labelNames: ["route", "method", "status"] as const,
  registers: [registry],
});

export const httpRequestDurationSeconds = new Histogram({
  name: "tsumugi_http_request_duration_seconds",
  help: "HTTP request duration in seconds by route and method.",
  labelNames: ["route", "method"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

// ---------------------------------------------------------------------------
// LLM
// ---------------------------------------------------------------------------

export const llmCallsTotal = new Counter({
  name: "tsumugi_llm_calls_total",
  help: "Total number of LLM calls by tier, provider, model, and status.",
  labelNames: ["tier", "provider", "model", "status"] as const,
  registers: [registry],
});

export const llmCallDurationSeconds = new Histogram({
  name: "tsumugi_llm_call_duration_seconds",
  help: "LLM call duration in seconds by tier, provider, and model.",
  labelNames: ["tier", "provider", "model"] as const,
  buckets: [0.5, 1, 2, 5, 10, 20, 30, 60, 120],
  registers: [registry],
});

export const llmRetriesTotal = new Counter({
  name: "tsumugi_llm_retries_total",
  help: "Total number of LLM retry attempts by tier and reason.",
  labelNames: ["tier", "reason"] as const,
  registers: [registry],
});

export const llmCircuitEventsTotal = new Counter({
  name: "tsumugi_llm_circuit_events_total",
  help: "Total number of provider circuit breaker state transitions.",
  labelNames: ["provider", "event"] as const,
  registers: [registry],
});

// ---------------------------------------------------------------------------
// Dreaming
// ---------------------------------------------------------------------------

export const dreamingRunsTotal = new Counter({
  name: "tsumugi_dreaming_runs_total",
  help: "Total number of dreaming runs by job and status.",
  labelNames: ["job", "status"] as const,
  registers: [registry],
});

export const dreamingRunDurationSeconds = new Histogram({
  name: "tsumugi_dreaming_run_duration_seconds",
  help: "Dreaming run duration in seconds by job.",
  labelNames: ["job"] as const,
  buckets: [1, 5, 10, 30, 60, 120, 300, 600, 1200],
  registers: [registry],
});

// ---------------------------------------------------------------------------
// Embedder
// ---------------------------------------------------------------------------

export const embedderCallsTotal = new Counter({
  name: "tsumugi_embedder_calls_total",
  help: "Total number of embedder operations by operation and status.",
  labelNames: ["operation", "status"] as const,
  registers: [registry],
});

export const embedderCallDurationSeconds = new Histogram({
  name: "tsumugi_embedder_call_duration_seconds",
  help: "Embedder operation duration in seconds by operation.",
  labelNames: ["operation"] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

export const embedderWarmedUp = new Gauge({
  name: "tsumugi_embedder_warmed_up",
  help: "1 when BGE-M3 model has completed warm-up, 0 otherwise.",
  registers: [registry],
});
embedderWarmedUp.set(0);

// ---------------------------------------------------------------------------
// Data layer (lazily populated on scrape via collect callbacks)
// ---------------------------------------------------------------------------

export const observationsTotal = new Gauge({
  name: "tsumugi_observations_total",
  help: "Total number of non-archived observations.",
  registers: [registry],
});

export const observationsPending = new Gauge({
  name: "tsumugi_observations_pending",
  help: "Number of observations not yet summarized (promoted_at IS NULL).",
  registers: [registry],
});

export const memoriesTotal = new Gauge({
  name: "tsumugi_memories_total",
  help: "Total number of memories by kind (active only).",
  labelNames: ["kind"] as const,
  registers: [registry],
});

export const memoriesQuarantined = new Gauge({
  name: "tsumugi_memories_quarantined",
  help: "Number of memories quarantined due to repeated LLM failures.",
  registers: [registry],
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Time a promise-returning function and record duration + status. */
export async function timeIt<T>(
  histogram: Histogram<string>,
  counter: Counter<string>,
  labels: Record<string, string>,
  fn: () => Promise<T>,
): Promise<T> {
  const start = process.hrtime.bigint();
  let status: "success" | "error" = "success";
  try {
    return await fn();
  } catch (err) {
    status = "error";
    throw err;
  } finally {
    const seconds = Number(process.hrtime.bigint() - start) / 1e9;
    histogram.observe(labels, seconds);
    counter.inc({ ...labels, status });
  }
}
