import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

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

export default function App() {
  const [activeTab, setActiveTab] = useState<TabId>("observations");
  const [query, setQuery] = useState("");
  const [selectedMemory, setSelectedMemory] = useState<Memory | null>(null);
  const [dreamJob, setDreamJob] = useState("promote-observations");
  const queryClient = useQueryClient();

  const observations = useQuery({
    queryKey: ["observations"],
    queryFn: () => api<{ observations: Observation[] }>("/observations"),
  });
  const memories = useQuery({
    queryKey: ["memories"],
    queryFn: () => api<{ memories: Memory[] }>("/memories"),
  });
  const decisions = useQuery({
    queryKey: ["decisions"],
    queryFn: () => api<{ decisions: Decision[] }>("/decisions"),
  });
  const links = useQuery({
    queryKey: ["links"],
    queryFn: () => api<{ links: Link[] }>("/links"),
  });
  const runs = useQuery({
    queryKey: ["dreaming-runs"],
    queryFn: () => api<{ runs: DreamingRun[] }>("/dreaming/runs"),
  });

  const deleteObservation = useMutation({
    mutationFn: (id: string) =>
      api<{ ok: true }>(`/observations/${id}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["observations"] }),
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
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["dreaming-runs"] }),
  });

  const filteredObservations = useMemo(
    () =>
      (observations.data?.observations ?? []).filter((item) =>
        includesText(
          [item.id, item.content, item.type, item.source, item.project_tag],
          query,
        ),
      ),
    [observations.data, query],
  );

  const filteredMemories = useMemo(
    () =>
      (memories.data?.memories ?? []).filter((item) =>
        includesText([item.id, item.narrative, item.kind, item.importance], query),
      ),
    [memories.data, query],
  );

  const filteredDecisions = useMemo(
    () =>
      (decisions.data?.decisions ?? []).filter((item) =>
        includesText([item.id, item.content, item.status, item.supersedes_id], query),
      ),
    [decisions.data, query],
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
              <strong>{filteredObservations.length} observations</strong>
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
            </div>
          </section>
        )}

        {activeTab === "memories" && (
          <section className="panel">
            <div className="panel-head">
              <strong>{filteredMemories.length} active memories</strong>
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
                    <button type="button" onClick={() => setSelectedMemory(item)}>
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
            </div>
          </section>
        )}

        {activeTab === "decisions" && (
          <section className="panel">
            <div className="panel-head">
              <strong>{filteredDecisions.length} decisions</strong>
              <button onClick={() => decisions.refetch()} type="button">
                Refresh
              </button>
            </div>
            <div className="chain">
              {filteredDecisions.map((item) => (
                <article className="decision" key={item.id}>
                  <StatusPill value={item.status} />
                  <h3>{item.content}</h3>
                  <p>{item.supersedes_id ? `supersedes ${item.supersedes_id}` : item.id}</p>
                </article>
              ))}
            </div>
          </section>
        )}

        {activeTab === "provenance" && (
          <section className="panel provenance">
            <div className="panel-head">
              <strong>{links.data?.links.length ?? 0} links</strong>
              <button onClick={() => links.refetch()} type="button">
                Refresh
              </button>
            </div>
            <div className="graph">
              {(links.data?.links ?? []).slice(0, 24).map((item) => (
                <article className="edge" key={`${item.from_id}-${item.to_id}-${item.relation}`}>
                  <span>{item.from_layer}</span>
                  <strong>{item.relation}</strong>
                  <span>{item.to_layer}</span>
                  <p>
                    {item.from_id} {"->"} {item.to_id}
                  </p>
                </article>
              ))}
            </div>
          </section>
        )}

        {activeTab === "dreaming" && (
          <section className="panel">
            <div className="runner">
              <select value={dreamJob} onChange={(event) => setDreamJob(event.target.value)}>
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
            <div className="runs">
              {(runs.data?.runs ?? []).map((run) => (
                <article className="run" key={run.id}>
                  <StatusPill value={run.status} />
                  <strong>{run.job_kind}</strong>
                  <span>{formatTime(run.started_at)}</span>
                  <span>{run.output_count} outputs</span>
                  {run.error_message && <p>{run.error_message}</p>}
                </article>
              ))}
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
                  setSelectedMemory({ ...selectedMemory, narrative: event.target.value })
                }
              />
            </label>
            <label>
              Kind
              <input
                value={selectedMemory.kind}
                onChange={(event) =>
                  setSelectedMemory({ ...selectedMemory, kind: event.target.value })
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
