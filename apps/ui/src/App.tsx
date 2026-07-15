import { useEffect, useMemo, useState } from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type {
  AdminDreamingRunPage,
  AdminFilterOptions,
  AdminOperationIssue,
  AdminOperationIssuePage,
  AdminOverview,
  AdminPipelineTrace,
  AdminPipelineTraceDetail,
  AdminPipelineTracePage,
} from "@tsumugi/shared";
import { api, queryString } from "./api.js";
import {
  formatFallbackRate,
  formatRunCount,
  readDreamingRunMetrics,
} from "./run-metrics.js";

type ViewId = "overview" | "pipeline" | "memories" | "operations";
type MemoryMode = "memories" | "decisions";

interface Filters {
  project: string;
  source: string;
  state: string;
  from: string;
  to: string;
  query: string;
}

interface MemoryRecord {
  id: string;
  narrative: string;
  importance: number;
  kind: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  outdated_at: string | null;
  outdated_reason: string | null;
  llm_failure_count: number;
  llm_quarantined_at: string | null;
  project_tags?: string[];
  sources?: string[];
}

interface DecisionRecord {
  id: string;
  content: string;
  status: string;
  supersedes_id: string | null;
  created_at: string;
  updated_at: string;
}

interface SchedulerResponse {
  enabled: boolean;
  jobs: Array<{ job: string; cronExpr: string }>;
}

const views: Array<{
  id: ViewId;
  mark: string;
  label: string;
  description: string;
}> = [
  {
    id: "overview",
    mark: "01",
    label: "Overview",
    description: "Three-layerの現在地",
  },
  {
    id: "pipeline",
    mark: "02",
    label: "Pipeline",
    description: "昇格経路とprovenance",
  },
  {
    id: "memories",
    mark: "03",
    label: "Memories",
    description: "残った知識と判断",
  },
  {
    id: "operations",
    mark: "04",
    label: "Operations",
    description: "滞留・失敗・schedule",
  },
];

const emptyFilters: Filters = {
  project: "",
  source: "",
  state: "",
  from: "",
  to: "",
  query: "",
};

function viewFrom(value: string | null): ViewId {
  return views.some((view) => view.id === value)
    ? (value as ViewId)
    : "overview";
}

function initialLocation(): {
  view: ViewId;
  filters: Filters;
  memoryMode: MemoryMode;
} {
  const params = new URLSearchParams(window.location.search);
  return {
    view: viewFrom(params.get("view")),
    memoryMode: params.get("mode") === "decisions" ? "decisions" : "memories",
    filters: {
      project: params.get("project") ?? "",
      source: params.get("source") ?? "",
      state: params.get("state") ?? "",
      from: params.get("from") ?? "",
      to: params.get("to") ?? "",
      query: params.get("q") ?? "",
    },
  };
}

function isoBoundary(value: string, end = false): string | undefined {
  if (!value) return undefined;
  const time = end ? "T23:59:59.999" : "T00:00:00.000";
  return new Date(`${value}${time}`).toISOString();
}

function scopeParams(filters: Filters) {
  return {
    project: filters.project || undefined,
    source: filters.source || undefined,
    state: filters.state || undefined,
    from: isoBoundary(filters.from),
    to: isoBoundary(filters.to, true),
    q: filters.query.trim() || undefined,
  };
}

function formatTime(value: string | null | undefined): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("ja-JP", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function stateTone(state: string): string {
  if (["quarantined", "failed", "stale", "legacy_partial"].includes(state)) {
    return "critical";
  }
  if (
    ["deferred", "outdated", "partial", "processing", "committing"].includes(
      state,
    )
  ) {
    return "warning";
  }
  if (["completed", "promoted", "active"].includes(state)) return "healthy";
  return "neutral";
}

function StatePill({ state }: { state: string }) {
  return <span className={`state-pill ${stateTone(state)}`}>{state}</span>;
}

function ErrorPanel({ error }: { error: unknown }) {
  return (
    <div className="message error-message" role="alert">
      <strong>Data could not be loaded.</strong>
      <span>{error instanceof Error ? error.message : String(error)}</span>
    </div>
  );
}

function LoadingPanel() {
  return <div className="message">Reading the current ledger…</div>;
}

function FilterBar({
  filters,
  onChange,
  options,
  states,
}: {
  filters: Filters;
  onChange: (next: Filters) => void;
  options?: AdminFilterOptions;
  states: string[];
}) {
  const update = (key: keyof Filters, value: string) =>
    onChange({ ...filters, [key]: value });

  return (
    <section className="filter-bar" aria-label="表示範囲">
      <label className="filter-search">
        <span>Search</span>
        <input
          value={filters.query}
          onChange={(event) => update("query", event.target.value)}
          placeholder="id, content, project…"
        />
      </label>
      <label>
        <span>Project</span>
        <select
          value={filters.project}
          onChange={(event) => update("project", event.target.value)}
        >
          <option value="">All projects</option>
          {options?.projects.map((project) => (
            <option key={project} value={project}>
              {project}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>Source</span>
        <select
          value={filters.source}
          onChange={(event) => update("source", event.target.value)}
        >
          <option value="">All sources</option>
          {options?.sources.map((source) => (
            <option key={source} value={source}>
              {source}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>State</span>
        <select
          value={filters.state}
          disabled={states.length === 0}
          onChange={(event) => update("state", event.target.value)}
        >
          <option value="">All states</option>
          {states.map((state) => (
            <option key={state} value={state}>
              {state}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>From</span>
        <input
          type="date"
          value={filters.from}
          onChange={(event) => update("from", event.target.value)}
        />
      </label>
      <label>
        <span>To</span>
        <input
          type="date"
          value={filters.to}
          onChange={(event) => update("to", event.target.value)}
        />
      </label>
      <button
        type="button"
        className="quiet-button"
        onClick={() => onChange(emptyFilters)}
        disabled={Object.values(filters).every((value) => value === "")}
      >
        Clear
      </button>
    </section>
  );
}

function OverviewView({ filters }: { filters: Filters }) {
  const overview = useQuery({
    queryKey: ["admin-overview", filters],
    queryFn: () =>
      api<AdminOverview>(`/admin/overview${queryString(scopeParams(filters))}`),
  });

  if (overview.isLoading) return <LoadingPanel />;
  if (overview.error) return <ErrorPanel error={overview.error} />;
  if (!overview.data) return null;

  const layerByName = Object.fromEntries(
    overview.data.layers.map((layer) => [layer.layer, layer]),
  );
  const stages = [
    { key: "capture", label: "Capture", note: "deterministic intake" },
    { key: "observation", label: "Observation", note: "durable facts" },
    { key: "memory", label: "Memory", note: "recalled knowledge" },
  ] as const;

  return (
    <div className="view-stack">
      <section className="loom-rail" aria-label="Three-layer pipeline summary">
        {stages.map((stage, index) => {
          const layer = layerByName[stage.key];
          return (
            <div className="loom-stage-wrap" key={stage.key}>
              <article className="loom-stage">
                <div className="stage-heading">
                  <span className="stage-index">L{index + 1}</span>
                  <div>
                    <h3>{stage.label}</h3>
                    <p>{stage.note}</p>
                  </div>
                </div>
                <strong>{layer?.total.toLocaleString() ?? 0}</strong>
                <div className="stage-meta">
                  <span>+{layer?.created_24h.toLocaleString() ?? 0} / 24h</span>
                  <span>oldest {formatTime(layer?.oldest_actionable_at)}</span>
                </div>
                <div className="state-line">
                  {Object.entries(layer?.states ?? {}).map(([state, count]) => (
                    <span key={state}>
                      {state} <b>{count.toLocaleString()}</b>
                    </span>
                  ))}
                </div>
              </article>
              {index < stages.length - 1 && (
                <div className="loom-connector" aria-hidden="true">
                  <span />
                  <i />
                  <span />
                </div>
              )}
            </div>
          );
        })}
      </section>

      <section className="overview-grid">
        <article className="ledger-panel attention-panel">
          <header className="panel-heading">
            <div>
              <p className="eyebrow">Now</p>
              <h3>Actionable attention</h3>
            </div>
            <strong>{overview.data.attention_count.toLocaleString()}</strong>
          </header>
          <p>
            現在retryまたはreviewが必要なquarantine、期限到来済みdefer、stale
            lease、outdatedの合計です。
          </p>
          <div className="history-count">
            <span>History</span>
            <strong>{overview.data.history_issue_count.toLocaleString()}</strong>
            <small>global failed / partial runs retained for audit</small>
          </div>
        </article>

        <article className="ledger-panel">
          <header className="panel-heading">
            <div>
              <p className="eyebrow">Durable work</p>
              <h3>Promotion queues</h3>
            </div>
          </header>
          <div className="queue-list">
            {overview.data.queues.map((queue) => (
              <div key={queue.stage}>
                <strong>{queue.stage}</strong>
                <span>{queue.total.toLocaleString()} total</span>
                <span>oldest {formatTime(queue.oldest_actionable_at)}</span>
                <div className="state-line compact">
                  {Object.entries(queue.states).map(([state, count]) => (
                    <span key={state}>
                      {state} <b>{count.toLocaleString()}</b>
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </article>

        <article className="ledger-panel scheduler-panel">
          <header className="panel-heading">
            <div>
              <p className="eyebrow">Scheduler</p>
              <h3>{overview.data.scheduler.enabled ? "6-job clock" : "Disabled"}</h3>
            </div>
          </header>
          <div className="schedule-list">
            {overview.data.scheduler.jobs.map((job) => (
              <div key={job.job}>
                <span>{job.job}</span>
                <code>{job.cronExpr}</code>
              </div>
            ))}
          </div>
        </article>
      </section>
    </div>
  );
}

function PipelineDetail({
  traceId,
  onClose,
}: {
  traceId: string;
  onClose: () => void;
}) {
  const detail = useQuery({
    queryKey: ["pipeline-trace", traceId],
    queryFn: () =>
      api<AdminPipelineTraceDetail>(`/admin/pipeline/traces/${traceId}`),
  });

  return (
    <aside className="detail-drawer pipeline-detail" aria-label="Pipeline trace detail">
      <header className="drawer-heading">
        <div>
          <p className="eyebrow">Trace</p>
          <h3>{traceId}</h3>
        </div>
        <button type="button" className="quiet-button" onClick={onClose}>
          Close
        </button>
      </header>
      {detail.isLoading && <LoadingPanel />}
      {detail.error && <ErrorPanel error={detail.error} />}
      {detail.data && (
        <div className="trace-nodes">
          {detail.data.nodes.map((node) => (
            <article className="trace-node" key={node.id}>
              <header>
                <span className="node-kind">{node.kind}</span>
                <StatePill state={node.state} />
                <time>{formatTime(node.occurred_at)}</time>
              </header>
              <code>{node.id}</code>
              {node.summary && <p>{node.summary}</p>}
              <dl>
                {Object.entries(node.metadata)
                  .filter(([, value]) => value !== null && value !== undefined)
                  .map(([key, value]) => (
                    <div key={key}>
                      <dt>{key}</dt>
                      <dd>
                        {typeof value === "string"
                          ? value
                          : JSON.stringify(value)}
                      </dd>
                    </div>
                  ))}
              </dl>
            </article>
          ))}
          {detail.data.edges.length > 0 && (
            <section className="edge-list">
              <h4>Provenance edges</h4>
              {detail.data.edges.map((edge, index) => (
                <p key={`${edge.from_id}-${edge.to_id}-${edge.relation}-${index}`}>
                  <code>{edge.from_id}</code>
                  <span>{edge.relation}</span>
                  <code>{edge.to_id}</code>
                </p>
              ))}
            </section>
          )}
        </div>
      )}
    </aside>
  );
}

function PipelineView({ filters }: { filters: Filters }) {
  const [selected, setSelected] = useState<string | null>(null);
  const traces = useInfiniteQuery({
    queryKey: ["pipeline-traces", filters],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api<AdminPipelineTracePage>(
        `/admin/pipeline/traces${queryString({
          ...scopeParams(filters),
          cursor: pageParam,
          limit: 50,
        })}`,
      ),
    getNextPageParam: (page) => page.next_cursor ?? undefined,
  });
  const rows = traces.data?.pages.flatMap((page) => page.traces) ?? [];

  return (
    <div className={selected ? "master-detail has-detail" : "master-detail"}>
      <section className="ledger-panel table-panel">
        <header className="panel-heading">
          <div>
            <p className="eyebrow">Promotion traces</p>
            <h3>{rows.length.toLocaleString()} loaded</h3>
          </div>
          <button type="button" onClick={() => void traces.refetch()}>
            Refresh
          </button>
        </header>
        {traces.isLoading && <LoadingPanel />}
        {traces.error && <ErrorPanel error={traces.error} />}
        <div className="trace-table" role="list">
          {rows.map((trace: AdminPipelineTrace) => (
            <button
              type="button"
              className={selected === trace.id ? "trace-row selected" : "trace-row"}
              key={trace.id}
              onClick={() => setSelected(trace.id)}
            >
              <span className="trace-time">{formatTime(trace.sort_at)}</span>
              <span className="trace-path">{trace.path}</span>
              <span className="trace-main">
                <code>{trace.id}</code>
                <b>{trace.project_tag ?? "untagged"}</b>
                <small>
                  {trace.source} · {trace.session_id ?? "no session"}
                </small>
                {trace.summary && <span>{trace.summary}</span>}
              </span>
              <span className="trace-counts">
                <span>C {trace.capture_count}</span>
                <span>F {trace.completed_fact_count}/{trace.fact_count}</span>
                <span>M {trace.memory_count}</span>
              </span>
              <StatePill state={trace.state} />
            </button>
          ))}
        </div>
        {traces.hasNextPage && (
          <button
            type="button"
            className="load-more"
            disabled={traces.isFetchingNextPage}
            onClick={() => void traces.fetchNextPage()}
          >
            {traces.isFetchingNextPage ? "Loading…" : "Load next 50"}
          </button>
        )}
      </section>
      {selected && (
        <PipelineDetail traceId={selected} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}

function MemoryDetail({
  memory,
  onClose,
}: {
  memory: MemoryRecord;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [narrative, setNarrative] = useState(memory.narrative);
  const [kind, setKind] = useState(memory.kind);
  const [importance, setImportance] = useState(String(memory.importance));

  useEffect(() => {
    setNarrative(memory.narrative);
    setKind(memory.kind);
    setImportance(String(memory.importance));
  }, [memory]);

  const updateMemory = useMutation({
    mutationFn: () =>
      api<{ ok: true }>(`/memories/${memory.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          narrative,
          kind,
          importance: Number(importance),
        }),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["memories"] });
    },
  });
  const archiveMemory = useMutation({
    mutationFn: () =>
      api<{ ok: true }>(`/memories/${memory.id}/archive`, { method: "POST" }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["memories"] });
      onClose();
    },
  });

  return (
    <aside className="detail-drawer memory-detail" aria-label="Memory detail">
      <header className="drawer-heading">
        <div>
          <p className="eyebrow">Memory</p>
          <h3>{memory.id}</h3>
        </div>
        <button type="button" className="quiet-button" onClick={onClose}>
          Close
        </button>
      </header>
      <div className="memory-state-line">
        <StatePill
          state={
            memory.archived_at
              ? "archived"
              : memory.outdated_at
                ? "outdated"
                : memory.llm_quarantined_at
                  ? "quarantined"
                  : "active"
          }
        />
        <span>updated {formatTime(memory.updated_at)}</span>
      </div>
      <label>
        <span>Narrative</span>
        <textarea value={narrative} onChange={(event) => setNarrative(event.target.value)} />
      </label>
      <div className="form-pair">
        <label>
          <span>Kind</span>
          <input value={kind} onChange={(event) => setKind(event.target.value)} />
        </label>
        <label>
          <span>Importance</span>
          <input
            type="number"
            min="0"
            max="10"
            step="0.5"
            value={importance}
            onChange={(event) => setImportance(event.target.value)}
          />
        </label>
      </div>
      <dl className="memory-provenance">
        <div>
          <dt>Projects</dt>
          <dd>{memory.project_tags?.join(", ") || "—"}</dd>
        </div>
        <div>
          <dt>Sources</dt>
          <dd>{memory.sources?.join(", ") || "—"}</dd>
        </div>
        {memory.outdated_reason && (
          <div>
            <dt>Outdated reason</dt>
            <dd>{memory.outdated_reason}</dd>
          </div>
        )}
      </dl>
      {(updateMemory.error || archiveMemory.error) && (
        <ErrorPanel error={updateMemory.error ?? archiveMemory.error} />
      )}
      <footer className="drawer-actions">
        <button
          type="button"
          disabled={updateMemory.isPending || narrative.trim() === ""}
          onClick={() => updateMemory.mutate()}
        >
          {updateMemory.isPending ? "Saving…" : "Save changes"}
        </button>
        {!memory.archived_at && (
          <button
            type="button"
            className="danger-button"
            disabled={archiveMemory.isPending}
            onClick={() => {
              if (confirm(`Archive memory ${memory.id}?`)) archiveMemory.mutate();
            }}
          >
            Archive
          </button>
        )}
      </footer>
    </aside>
  );
}

function MemoriesView({
  filters,
  mode,
  onModeChange,
}: {
  filters: Filters;
  mode: MemoryMode;
  onModeChange: (mode: MemoryMode) => void;
}) {
  const [selected, setSelected] = useState<MemoryRecord | null>(null);
  const memories = useInfiniteQuery({
    queryKey: ["memories", filters],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      api<{ memories: MemoryRecord[]; total: number }>(
        `/memories${queryString({
          ...scopeParams(filters),
          limit: 100,
          offset: pageParam,
        })}`,
      ),
    getNextPageParam: (page, pages) => {
      const loaded = pages.reduce((sum, current) => sum + current.memories.length, 0);
      return loaded < page.total ? loaded : undefined;
    },
  });
  const decisions = useQuery({
    queryKey: ["decisions"],
    queryFn: () => api<{ decisions: DecisionRecord[]; total: number }>("/decisions?limit=500"),
    enabled: mode === "decisions",
  });
  const memoryRows = memories.data?.pages.flatMap((page) => page.memories) ?? [];
  const memoryTotal = memories.data?.pages[0]?.total ?? 0;
  const decisionRows = useMemo(() => {
    const query = filters.query.trim().toLowerCase();
    return (decisions.data?.decisions ?? []).filter((decision) => {
      if (filters.state && decision.status !== filters.state) return false;
      if (filters.from && decision.updated_at < isoBoundary(filters.from)!) return false;
      if (filters.to && decision.updated_at > isoBoundary(filters.to, true)!) return false;
      return !query || `${decision.id} ${decision.content}`.toLowerCase().includes(query);
    });
  }, [decisions.data, filters]);

  return (
    <div className={selected ? "master-detail has-detail" : "master-detail"}>
      <section className="ledger-panel table-panel">
        <header className="panel-heading memory-heading">
          <div>
            <p className="eyebrow">Knowledge ledger</p>
            <h3>
              {mode === "memories"
                ? `${memoryRows.length.toLocaleString()} / ${memoryTotal.toLocaleString()}`
                : `${decisionRows.length.toLocaleString()} decisions`}
            </h3>
          </div>
          <div className="segmented" aria-label="Memory views">
            <button
              type="button"
              className={mode === "memories" ? "active" : ""}
              onClick={() => onModeChange("memories")}
            >
              Memories
            </button>
            <button
              type="button"
              className={mode === "decisions" ? "active" : ""}
              onClick={() => onModeChange("decisions")}
            >
              Decisions
            </button>
          </div>
        </header>
        {mode === "memories" && (
          <>
            {memories.isLoading && <LoadingPanel />}
            {memories.error && <ErrorPanel error={memories.error} />}
            <div className="memory-table" role="list">
              {memoryRows.map((memory) => {
                const state = memory.archived_at
                  ? "archived"
                  : memory.outdated_at
                    ? "outdated"
                    : memory.llm_quarantined_at
                      ? "quarantined"
                      : "active";
                return (
                  <button
                    type="button"
                    className={selected?.id === memory.id ? "memory-row selected" : "memory-row"}
                    key={memory.id}
                    onClick={() => setSelected(memory)}
                  >
                    <time>{formatTime(memory.updated_at)}</time>
                    <span className="memory-main">
                      <b>{memory.narrative}</b>
                      <code>{memory.id}</code>
                      <small>
                        {memory.project_tags?.join(", ") || "no provenance project"}
                      </small>
                    </span>
                    <span>{memory.kind}</span>
                    <span className="importance">{memory.importance.toFixed(1)}</span>
                    <StatePill state={state} />
                  </button>
                );
              })}
            </div>
            {memories.hasNextPage && (
              <button
                type="button"
                className="load-more"
                disabled={memories.isFetchingNextPage}
                onClick={() => void memories.fetchNextPage()}
              >
                {memories.isFetchingNextPage ? "Loading…" : "Load next 100"}
              </button>
            )}
          </>
        )}
        {mode === "decisions" && (
          <>
            {decisions.isLoading && <LoadingPanel />}
            {decisions.error && <ErrorPanel error={decisions.error} />}
            <div className="decision-table">
              {decisionRows.map((decision) => (
                <article key={decision.id}>
                  <time>{formatTime(decision.updated_at)}</time>
                  <p>{decision.content}</p>
                  <code>{decision.id}</code>
                  <StatePill state={decision.status} />
                  {decision.supersedes_id && (
                    <small>supersedes {decision.supersedes_id}</small>
                  )}
                </article>
              ))}
            </div>
          </>
        )}
      </section>
      {selected && <MemoryDetail memory={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function OperationsView({ filters }: { filters: Filters }) {
  const queryClient = useQueryClient();
  const overview = useQuery({
    queryKey: ["admin-overview", filters],
    queryFn: () =>
      api<AdminOverview>(`/admin/overview${queryString(scopeParams(filters))}`),
  });
  const issues = useInfiniteQuery({
    queryKey: ["operation-issues", filters],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api<AdminOperationIssuePage>(
        `/admin/operations/issues${queryString({
          ...scopeParams(filters),
          cursor: pageParam,
          limit: 50,
        })}`,
      ),
    getNextPageParam: (page) => page.next_cursor ?? undefined,
  });
  const runs = useQuery({
    queryKey: ["dreaming-runs"],
    queryFn: () => api<AdminDreamingRunPage>("/dreaming/runs?limit=50"),
  });
  const scheduler = useQuery({
    queryKey: ["scheduler"],
    queryFn: () => api<SchedulerResponse>("/scheduler"),
  });
  const retryIssue = useMutation({
    mutationFn: (issue: AdminOperationIssue) =>
      api<{ ok: true }>(
        `/admin/operations/issues/${encodeURIComponent(issue.kind)}/${encodeURIComponent(issue.id)}/retry`,
        { method: "POST" },
      ),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["operation-issues"] }),
        queryClient.invalidateQueries({ queryKey: ["admin-overview"] }),
        queryClient.invalidateQueries({ queryKey: ["pipeline-traces"] }),
      ]);
    },
  });
  const issueRows = issues.data?.pages.flatMap((page) => page.issues) ?? [];

  return (
    <div className="operations-grid">
      <section className="ledger-panel issue-panel">
        <header className="panel-heading">
          <div>
            <p className="eyebrow">Current attention</p>
            <h3>
              {overview.data?.attention_count.toLocaleString() ?? "—"} actionable
            </h3>
            <small>{issueRows.length.toLocaleString()} loaded</small>
          </div>
          <button type="button" onClick={() => void issues.refetch()}>
            Refresh
          </button>
        </header>
        {issues.isLoading && <LoadingPanel />}
        {issues.error && <ErrorPanel error={issues.error} />}
        {retryIssue.error && <ErrorPanel error={retryIssue.error} />}
        <div className="issue-list">
          {issueRows.map((issue) => {
            const retryable =
              ["window", "fact", "observation"].includes(issue.kind) &&
              ["deferred", "quarantined"].includes(issue.state);
            const retrying =
              retryIssue.isPending && retryIssue.variables?.id === issue.id;
            return (
              <article key={`${issue.kind}-${issue.id}`}>
                <header>
                  <span>{issue.kind}</span>
                  <StatePill state={issue.state} />
                  <time>{formatTime(issue.occurred_at)}</time>
                </header>
                <code>{issue.id}</code>
                {issue.summary && <p>{issue.summary}</p>}
                <footer>
                  <span>{issue.project_tag ?? "unscoped"}</span>
                  <span>{issue.source ?? "system"}</span>
                  {issue.attempt_count > 0 && (
                    <span>attempt {issue.attempt_count}</span>
                  )}
                  {issue.failure_count > 0 && (
                    <span>failure {issue.failure_count}</span>
                  )}
                  {retryable && (
                    <button
                      type="button"
                      className="issue-retry"
                      disabled={retrying}
                      onClick={() => {
                        const action =
                          issue.state === "quarantined"
                            ? "Restore and retry"
                            : "Retry now";
                        if (confirm(`${action} ${issue.kind} ${issue.id}?`)) {
                          retryIssue.mutate(issue);
                        }
                      }}
                    >
                      {retrying
                        ? "Retrying..."
                        : issue.state === "quarantined"
                          ? "Restore and retry"
                          : "Retry now"}
                    </button>
                  )}
                </footer>
                {issue.last_error && <pre>{issue.last_error}</pre>}
              </article>
            );
          })}
          {!issues.isLoading && issueRows.length === 0 && (
            <div className="message">
              No current operational issues in this scope. Historical failures
              remain in execution history.
            </div>
          )}
        </div>
        {issues.hasNextPage && (
          <button
            type="button"
            className="load-more"
            onClick={() => void issues.fetchNextPage()}
          >
            Load next 50
          </button>
        )}
      </section>

      <div className="operations-side">
        <section className="ledger-panel">
          <header className="panel-heading">
            <div>
              <p className="eyebrow">Clock</p>
              <h3>{scheduler.data?.enabled ? "Scheduler active" : "Scheduler disabled"}</h3>
            </div>
          </header>
          {scheduler.error && <ErrorPanel error={scheduler.error} />}
          <div className="schedule-list">
            {scheduler.data?.jobs.map((job) => (
              <div key={job.job}>
                <span>{job.job}</span>
                <code>{job.cronExpr}</code>
              </div>
            ))}
          </div>
        </section>
        <section className="ledger-panel">
          <header className="panel-heading">
            <div>
              <p className="eyebrow">Execution history</p>
              <h3>{runs.data?.total.toLocaleString() ?? "—"} runs</h3>
              <small>
                {overview.data?.history_issue_count.toLocaleString() ?? "—"}
                {" global failed / partial"}
              </small>
            </div>
          </header>
          {runs.error && <ErrorPanel error={runs.error} />}
          <div className="run-list">
            {runs.data?.runs.map((run) => {
              const metrics = readDreamingRunMetrics(run.metadata);
              return (
                <article key={run.id}>
                  <time>{formatTime(run.started_at)}</time>
                  <b>{run.job_kind}</b>
                  <StatePill state={run.status} />
                  <span>
                    {run.input_count} in / {run.output_count} out
                  </span>
                  {metrics && (
                    <div className="run-metrics" aria-label="Batch processing metrics">
                      {(metrics.factsSelected !== null ||
                        metrics.factsCompleted !== null) && (
                        <span>
                          <b>facts</b>
                          {formatRunCount(metrics.factsCompleted)} /{" "}
                          {formatRunCount(metrics.factsSelected)}
                        </span>
                      )}
                      {metrics.factBatchesSelected !== null && (
                        <span>
                          <b>batches</b>
                          {formatRunCount(metrics.factBatchesSelected)}
                        </span>
                      )}
                      {metrics.factBatchFallbacks !== null && (
                        <span>
                          <b>fallback</b>
                          {formatRunCount(metrics.factBatchFallbacks)} ·{" "}
                          {formatFallbackRate(metrics.fallbackRate)}
                        </span>
                      )}
                      {metrics.factsDeferred !== null && (
                        <span>
                          <b>defer</b>
                          {formatRunCount(metrics.factsDeferred)}
                        </span>
                      )}
                      {metrics.stoppedReason && (
                        <span>
                          <b>stop</b>
                          {metrics.stoppedReason}
                        </span>
                      )}
                    </div>
                  )}
                  {run.error_message && <p>{run.error_message}</p>}
                </article>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}

export default function App() {
  const initial = useMemo(initialLocation, []);
  const [activeView, setActiveView] = useState<ViewId>(initial.view);
  const [filters, setFilters] = useState<Filters>(initial.filters);
  const [memoryMode, setMemoryMode] = useState<MemoryMode>(initial.memoryMode);
  const filterOptions = useQuery({
    queryKey: ["admin-filter-options"],
    queryFn: () => api<AdminFilterOptions>("/admin/filter-options"),
    staleTime: 5 * 60_000,
  });

  useEffect(() => {
    const params = new URLSearchParams();
    params.set("view", activeView);
    if (activeView === "memories") params.set("mode", memoryMode);
    if (filters.project) params.set("project", filters.project);
    if (filters.source) params.set("source", filters.source);
    if (filters.state) params.set("state", filters.state);
    if (filters.from) params.set("from", filters.from);
    if (filters.to) params.set("to", filters.to);
    if (filters.query) params.set("q", filters.query);
    window.history.replaceState(null, "", `?${params.toString()}`);
  }, [activeView, filters, memoryMode]);

  useEffect(() => {
    const onPopState = () => {
      const next = initialLocation();
      setActiveView(next.view);
      setFilters(next.filters);
      setMemoryMode(next.memoryMode);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const stateOptions =
    activeView === "pipeline"
      ? (filterOptions.data?.states.pipeline ?? [])
      : activeView === "memories"
        ? memoryMode === "decisions"
          ? ["in_progress", "completed", "superseded", "archived"]
          : (filterOptions.data?.states.memories ?? [])
        : activeView === "operations"
          ? (filterOptions.data?.states.operations ?? [])
          : [];
  const currentView = views.find((view) => view.id === activeView)!;

  return (
    <main className="shell">
      <aside className="sidebar">
        <div className="brand">
          <p className="eyebrow">tsumugi admin</p>
          <h1>紬</h1>
          <p>記憶が残るまでの工程を、静かに見守る運用卓。</p>
        </div>
        <nav className="nav" aria-label="Admin views">
          {views.map((view) => (
            <button
              key={view.id}
              type="button"
              className={activeView === view.id ? "nav-item active" : "nav-item"}
              onClick={() => {
                setActiveView(view.id);
                setFilters({ ...filters, state: "" });
              }}
            >
              <span>{view.mark}</span>
              <b>{view.label}</b>
              <small>{view.description}</small>
            </button>
          ))}
        </nav>
        <div className="sidebar-status">
          <span className={filterOptions.isError ? "status-dot error" : "status-dot"} />
          <div>
            <b>{filterOptions.isError ? "API unavailable" : "Operational scope active"}</b>
            <small>recovery actions require confirmation</small>
          </div>
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">Three-layer console</p>
            <h2>{currentView.label}</h2>
            <p>{currentView.description}</p>
          </div>
          <div className="topbar-note">
            <span>Capture</span>
            <i />
            <span>Observation</span>
            <i />
            <span>Memory</span>
          </div>
        </header>

        <FilterBar
          filters={filters}
          onChange={setFilters}
          options={filterOptions.data}
          states={stateOptions}
        />

        {activeView === "overview" && <OverviewView filters={filters} />}
        {activeView === "pipeline" && <PipelineView filters={filters} />}
        {activeView === "memories" && (
          <MemoriesView
            filters={filters}
            mode={memoryMode}
            onModeChange={(mode) => {
              setMemoryMode(mode);
              setFilters({ ...filters, state: "" });
            }}
          />
        )}
        {activeView === "operations" && <OperationsView filters={filters} />}
      </section>
    </main>
  );
}
