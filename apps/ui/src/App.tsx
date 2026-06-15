import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";

type TabId =
  | "observations"
  | "memories"
  | "decisions"
  | "provenance"
  | "dreaming"
  | "settings";

interface Observation {
  id: string;
  content: string;
  type: string;
  source: string;
  session_id: string | null;
  project_tag: string | null;
  facts: string[] | null;
  created_at: string;
  promoted_at: string | null;
}

interface Memory {
  id: string;
  narrative: string;
  importance: number;
  kind: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

interface Decision {
  id: string;
  content: string;
  status: string;
  supersedes_id: string | null;
  created_at: string;
  updated_at: string;
}

interface Link {
  from_id: string;
  to_id: string;
  from_layer: string;
  to_layer: string;
  relation: string;
}

interface DreamingRun {
  id: string;
  job_kind: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  input_count: number;
  output_count: number;
  error_message: string | null;
}

const tabs: { id: TabId; label: string; mark: string }[] = [
  { id: "observations", label: "Observations", mark: "O" },
  { id: "memories", label: "Memories", mark: "M" },
  { id: "decisions", label: "Decisions", mark: "D" },
  { id: "provenance", label: "Provenance", mark: "P" },
  { id: "dreaming", label: "Dreaming runs", mark: "R" },
  { id: "settings", label: "Settings", mark: "S" },
];

const jobs = [
  "promote-observations",
  "synthesize",
  "time-update",
  "decision-contradiction",
  "full",
];

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: { "content-type": "application/json", ...init?.headers },
    ...init,
  });
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

function includesText(values: Array<string | number | null>, query: string) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return values.some((value) =>
    String(value ?? "")
      .toLowerCase()
      .includes(normalized),
  );
}

function formatTime(value: string | null) {
  if (!value) return "not yet";
  return new Intl.DateTimeFormat("ja-JP", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function StatusPill({ value }: { value: string }) {
  return <span className={`pill pill-${value}`}>{value}</span>;
}

const PAGE_SIZE = {
  observations: 200,
  memories: 200,
  decisions: 200,
  links: 500,
  runs: 50,
} as const;

interface PagedResponse<F extends string, T> {
  total: number;
  rows: T[];
  field: F;
}

function makeListQueryFn<F extends string, T>(
  path: string,
  field: F,
  pageSize: number,
) {
  return async ({ pageParam = 0 }: { pageParam: number }) => {
    const data = (await api(
      `${path}?limit=${pageSize}&offset=${pageParam}`,
    )) as {
      total: number;
    } & Record<F, T[]>;
    return {
      total: data.total ?? 0,
      rows: data[field] ?? [],
      field,
    } satisfies PagedResponse<F, T>;
  };
}

function flattenPages<F extends string, T>(
  pages: PagedResponse<F, T>[] | undefined,
): T[] {
  if (!pages) return [];
  return pages.flatMap((p) => p.rows);
}

function totalFrom<F extends string, T>(
  pages: PagedResponse<F, T>[] | undefined,
): number {
  return pages?.[0]?.total ?? 0;
}

/** 末尾要素が viewport に入ったら fetchNextPage を呼ぶ */
function useInfiniteScrollSentinel(
  hasNextPage: boolean,
  isFetchingNextPage: boolean,
  fetchNextPage: () => void,
) {
  const ref = useRef<HTMLDivElement | null>(null);
  const cb = useCallback((node: HTMLDivElement | null) => {
    ref.current = node;
  }, []);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry?.isIntersecting && hasNextPage && !isFetchingNextPage) {
          fetchNextPage();
        }
      },
      { rootMargin: "200px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);
  return cb;
}

function makeGetNextPageParam<F extends string, T>(pageSize: number) {
  return (
    lastPage: PagedResponse<F, T>,
    allPages: PagedResponse<F, T>[],
  ): number | undefined => {
    const loaded = allPages.reduce((s, p) => s + p.rows.length, 0);
    if (loaded >= lastPage.total) return undefined;
    return loaded;
  };
}

export default function App() {
  const [activeTab, setActiveTab] = useState<TabId>("observations");
  const [query, setQuery] = useState("");
  const [selectedMemory, setSelectedMemory] = useState<Memory | null>(null);
  const [dreamJob, setDreamJob] = useState("promote-observations");
  const queryClient = useQueryClient();

  const observations = useInfiniteQuery({
    queryKey: ["observations"],
    initialPageParam: 0,
    queryFn: makeListQueryFn<"observations", Observation>(
      "/observations",
      "observations",
      PAGE_SIZE.observations,
    ),
    getNextPageParam: makeGetNextPageParam<"observations", Observation>(
      PAGE_SIZE.observations,
    ),
  });
  const memories = useInfiniteQuery({
    queryKey: ["memories"],
    initialPageParam: 0,
    queryFn: makeListQueryFn<"memories", Memory>(
      "/memories",
      "memories",
      PAGE_SIZE.memories,
    ),
    getNextPageParam: makeGetNextPageParam<"memories", Memory>(
      PAGE_SIZE.memories,
    ),
  });
  const decisions = useInfiniteQuery({
    queryKey: ["decisions"],
    initialPageParam: 0,
    queryFn: makeListQueryFn<"decisions", Decision>(
      "/decisions",
      "decisions",
      PAGE_SIZE.decisions,
    ),
    getNextPageParam: makeGetNextPageParam<"decisions", Decision>(
      PAGE_SIZE.decisions,
    ),
  });
  const links = useInfiniteQuery({
    queryKey: ["links"],
    initialPageParam: 0,
    queryFn: makeListQueryFn<"links", Link>("/links", "links", PAGE_SIZE.links),
    getNextPageParam: makeGetNextPageParam<"links", Link>(PAGE_SIZE.links),
  });
  const runs = useInfiniteQuery({
    queryKey: ["dreaming-runs"],
    initialPageParam: 0,
    queryFn: makeListQueryFn<"runs", DreamingRun>(
      "/dreaming/runs",
      "runs",
      PAGE_SIZE.runs,
    ),
    getNextPageParam: makeGetNextPageParam<"runs", DreamingRun>(PAGE_SIZE.runs),
  });

  const observationsRows = useMemo(
    () => flattenPages(observations.data?.pages),
    [observations.data?.pages],
  );
  const memoriesRows = useMemo(
    () => flattenPages(memories.data?.pages),
    [memories.data?.pages],
  );
  const decisionsRows = useMemo(
    () => flattenPages(decisions.data?.pages),
    [decisions.data?.pages],
  );
  const linksRows = useMemo(
    () => flattenPages(links.data?.pages),
    [links.data?.pages],
  );
  const runsRows = useMemo(
    () => flattenPages(runs.data?.pages),
    [runs.data?.pages],
  );

  const observationsTotal = totalFrom(observations.data?.pages);
  const memoriesTotal = totalFrom(memories.data?.pages);
  const decisionsTotal = totalFrom(decisions.data?.pages);
  const linksTotal = totalFrom(links.data?.pages);
  const runsTotal = totalFrom(runs.data?.pages);

  const obsSentinelRef = useInfiniteScrollSentinel(
    !!observations.hasNextPage,
    observations.isFetchingNextPage,
    observations.fetchNextPage,
  );
  const memSentinelRef = useInfiniteScrollSentinel(
    !!memories.hasNextPage,
    memories.isFetchingNextPage,
    memories.fetchNextPage,
  );
  const decSentinelRef = useInfiniteScrollSentinel(
    !!decisions.hasNextPage,
    decisions.isFetchingNextPage,
    decisions.fetchNextPage,
  );
  const linksSentinelRef = useInfiniteScrollSentinel(
    !!links.hasNextPage,
    links.isFetchingNextPage,
    links.fetchNextPage,
  );
  const runsSentinelRef = useInfiniteScrollSentinel(
    !!runs.hasNextPage,
    runs.isFetchingNextPage,
    runs.fetchNextPage,
  );

  const deleteObservation = useMutation({
    mutationFn: (id: string) =>
      api<{ ok: true }>(`/observations/${id}`, { method: "DELETE" }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["observations"] }),
  });

  const archiveMemory = useMutation({
    mutationFn: (id: string) =>
      api<{ ok: true }>(`/memories/${id}/archive`, { method: "POST" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["memories"] }),
  });

  const updateMemory = useMutation({
    mutationFn: (memory: Memory) =>
      api<{ ok: true }>(`/memories/${memory.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          narrative: memory.narrative,
          importance: memory.importance,
          kind: memory.kind,
        }),
      }),
    onSuccess: () => {
      setSelectedMemory(null);
      queryClient.invalidateQueries({ queryKey: ["memories"] });
    },
  });

  const triggerDreaming = useMutation({
    mutationFn: (job: string) =>
      api("/dreaming/trigger", {
        method: "POST",
        body: JSON.stringify({ job }),
      }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["dreaming-runs"] }),
  });

  const filteredObservations = useMemo(
    () =>
      observationsRows.filter((item) =>
        includesText(
          [item.id, item.content, item.type, item.source, item.project_tag],
          query,
        ),
      ),
    [observationsRows, query],
  );

  const filteredMemories = useMemo(
    () =>
      memoriesRows.filter((item) =>
        includesText(
          [item.id, item.narrative, item.kind, item.importance],
          query,
        ),
      ),
    [memoriesRows, query],
  );

  const filteredDecisions = useMemo(
    () =>
      decisionsRows.filter((item) =>
        includesText(
          [item.id, item.content, item.status, item.supersedes_id],
          query,
        ),
      ),
    [decisionsRows, query],
  );

  const filteredLinks = useMemo(
    () =>
      linksRows.filter((item) =>
        includesText(
          [
            item.from_id,
            item.to_id,
            item.relation,
            item.from_layer,
            item.to_layer,
          ],
          query,
        ),
      ),
    [linksRows, query],
  );

  const filteredRuns = useMemo(
    () =>
      runsRows.filter((item) =>
        includesText(
          [item.id, item.job_kind, item.status, item.error_message],
          query,
        ),
      ),
    [runsRows, query],
  );

  return (
    <main className="shell">
      <aside className="sidebar">
        <div>
          <p className="eyebrow">tsumugi admin</p>
          <h1>紬</h1>
          <p className="sidebar-copy">Observation から Memory へ紡ぐ管理卓。</p>
        </div>
        <nav className="nav" aria-label="Admin views">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={activeTab === tab.id ? "nav-item active" : "nav-item"}
              onClick={() => setActiveTab(tab.id)}
              title={tab.label}
            >
              <span>{tab.mark}</span>
              {tab.label}
            </button>
          ))}
        </nav>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">Phase 3 console</p>
            <h2>{tabs.find((tab) => tab.id === activeTab)?.label}</h2>
          </div>
          <label className="search">
            <span>Search</span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="id, content, tag..."
            />
          </label>
        </header>

        {activeTab === "observations" && (
          <section className="panel">
            <div className="panel-head">
              <strong>
                {filteredObservations.length} shown / {observationsRows.length}{" "}
                loaded / {observationsTotal} total
              </strong>
              <button onClick={() => observations.refetch()} type="button">
                Refresh
              </button>
            </div>
            <div className="list">
              {filteredObservations.map((item) => (
                <article className="row" key={item.id}>
                  <div>
                    <div className="row-meta">
                      <StatusPill value={item.type} />
                      <span>{item.source}</span>
                      <span>{formatTime(item.created_at)}</span>
                      <span>{item.promoted_at ? "promoted" : "pending"}</span>
                    </div>
                    <h3>{item.content}</h3>
                    <p>{item.project_tag ?? item.session_id ?? item.id}</p>
                  </div>
                  <button
                    className="danger"
                    type="button"
                    onClick={() => {
                      if (confirm(`Delete observation ${item.id}?`)) {
                        deleteObservation.mutate(item.id);
                      }
                    }}
                  >
                    Delete
                  </button>
                </article>
              ))}
              <div ref={obsSentinelRef} className="infinite-sentinel">
                {observations.isFetchingNextPage
                  ? "Loading…"
                  : observations.hasNextPage
                    ? "Scroll for more"
                    : observationsRows.length > 0
                      ? "End of list"
                      : null}
              </div>
            </div>
          </section>
        )}

        {activeTab === "memories" && (
          <section className="panel">
            <div className="panel-head">
              <strong>
                {filteredMemories.length} shown / {memoriesRows.length} loaded /{" "}
                {memoriesTotal} total
              </strong>
              <button onClick={() => memories.refetch()} type="button">
                Refresh
              </button>
            </div>
            <div className="list">
              {filteredMemories.map((item) => (
                <article className="row memory-row" key={item.id}>
                  <div>
                    <div className="row-meta">
                      <StatusPill value={item.kind} />
                      <span>importance {item.importance.toFixed(1)}</span>
                      <span>updated {formatTime(item.updated_at)}</span>
                    </div>
                    <h3>{item.narrative}</h3>
                    <p>{item.id}</p>
                  </div>
                  <div className="actions">
                    <button
                      type="button"
                      onClick={() => setSelectedMemory(item)}
                    >
                      Edit
                    </button>
                    <button
                      className="danger"
                      type="button"
                      onClick={() => {
                        if (confirm(`Archive memory ${item.id}?`)) {
                          archiveMemory.mutate(item.id);
                        }
                      }}
                    >
                      Archive
                    </button>
                  </div>
                </article>
              ))}
              <div ref={memSentinelRef} className="infinite-sentinel">
                {memories.isFetchingNextPage
                  ? "Loading…"
                  : memories.hasNextPage
                    ? "Scroll for more"
                    : memoriesRows.length > 0
                      ? "End of list"
                      : null}
              </div>
            </div>
          </section>
        )}

        {activeTab === "decisions" && (
          <section className="panel">
            <div className="panel-head">
              <strong>
                {filteredDecisions.length} shown / {decisionsRows.length} loaded
                / {decisionsTotal} total
              </strong>
              <button onClick={() => decisions.refetch()} type="button">
                Refresh
              </button>
            </div>
            <div className="chain">
              {filteredDecisions.map((item) => (
                <article className="decision" key={item.id}>
                  <StatusPill value={item.status} />
                  <h3>{item.content}</h3>
                  <p>
                    {item.supersedes_id
                      ? `supersedes ${item.supersedes_id}`
                      : item.id}
                  </p>
                </article>
              ))}
              <div ref={decSentinelRef} className="infinite-sentinel">
                {decisions.isFetchingNextPage
                  ? "Loading…"
                  : decisions.hasNextPage
                    ? "Scroll for more"
                    : decisionsRows.length > 0
                      ? "End of list"
                      : null}
              </div>
            </div>
          </section>
        )}

        {activeTab === "provenance" && (
          <section className="panel provenance">
            <div className="panel-head">
              <strong>
                {filteredLinks.length} shown / {linksRows.length} loaded /{" "}
                {linksTotal} total
              </strong>
              <button onClick={() => links.refetch()} type="button">
                Refresh
              </button>
            </div>
            <div className="graph">
              {filteredLinks.map((item) => (
                <article
                  className="edge"
                  key={`${item.from_id}-${item.to_id}-${item.relation}`}
                >
                  <span>{item.from_layer}</span>
                  <strong>{item.relation}</strong>
                  <span>{item.to_layer}</span>
                  <p>
                    {item.from_id} {"->"} {item.to_id}
                  </p>
                </article>
              ))}
              <div ref={linksSentinelRef} className="infinite-sentinel">
                {links.isFetchingNextPage
                  ? "Loading…"
                  : links.hasNextPage
                    ? "Scroll for more"
                    : linksRows.length > 0
                      ? "End of list"
                      : null}
              </div>
            </div>
          </section>
        )}

        {activeTab === "dreaming" && (
          <section className="panel">
            <div className="runner">
              <select
                value={dreamJob}
                onChange={(event) => setDreamJob(event.target.value)}
              >
                {jobs.map((job) => (
                  <option key={job} value={job}>
                    {job}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => triggerDreaming.mutate(dreamJob)}
                disabled={triggerDreaming.isPending}
              >
                Trigger
              </button>
            </div>
            <div className="panel-head">
              <strong>
                {filteredRuns.length} shown / {runsRows.length} loaded /{" "}
                {runsTotal} total
              </strong>
              <button onClick={() => runs.refetch()} type="button">
                Refresh
              </button>
            </div>
            <div className="runs">
              {filteredRuns.map((run) => (
                <article className="run" key={run.id}>
                  <StatusPill value={run.status} />
                  <strong>{run.job_kind}</strong>
                  <span>{formatTime(run.started_at)}</span>
                  <span>{run.output_count} outputs</span>
                  {run.error_message && <p>{run.error_message}</p>}
                </article>
              ))}
              <div ref={runsSentinelRef} className="infinite-sentinel">
                {runs.isFetchingNextPage
                  ? "Loading…"
                  : runs.hasNextPage
                    ? "Scroll for more"
                    : runsRows.length > 0
                      ? "End of list"
                      : null}
              </div>
            </div>
          </section>
        )}

        {activeTab === "settings" && (
          <section className="panel settings">
            <div>
              <p className="eyebrow">LLM tiers</p>
              <h3>LOW: summarize / synthesize / time update / reflection</h3>
              <h3>MID: AUDN / decision contradiction</h3>
            </div>
            <div>
              <p className="eyebrow">Runtime</p>
              <h3>HTTP MCP endpoint: /mcp</h3>
              <h3>REST API prefix: /api</h3>
            </div>
            <div>
              <p className="eyebrow">Schedule</p>
              <h3>Cron display is pending deploy configuration.</h3>
            </div>
          </section>
        )}
      </section>

      {selectedMemory && (
        <div className="modal-backdrop">
          <form
            className="modal"
            onSubmit={(event) => {
              event.preventDefault();
              updateMemory.mutate(selectedMemory);
            }}
          >
            <h2>Edit memory</h2>
            <label>
              Narrative
              <textarea
                value={selectedMemory.narrative}
                onChange={(event) =>
                  setSelectedMemory({
                    ...selectedMemory,
                    narrative: event.target.value,
                  })
                }
              />
            </label>
            <label>
              Kind
              <input
                value={selectedMemory.kind}
                onChange={(event) =>
                  setSelectedMemory({
                    ...selectedMemory,
                    kind: event.target.value,
                  })
                }
              />
            </label>
            <label>
              Importance
              <input
                type="number"
                min="0"
                max="10"
                step="0.5"
                value={selectedMemory.importance}
                onChange={(event) =>
                  setSelectedMemory({
                    ...selectedMemory,
                    importance: Number(event.target.value),
                  })
                }
              />
            </label>
            <div className="actions">
              <button type="button" onClick={() => setSelectedMemory(null)}>
                Cancel
              </button>
              <button type="submit" disabled={updateMemory.isPending}>
                Save
              </button>
            </div>
          </form>
        </div>
      )}
    </main>
  );
}
