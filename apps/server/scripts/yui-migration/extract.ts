/**
 * yui DB から tsumugi 移行候補データを抽出して staging/ に JSONL で書き出す。
 *
 * 設計: ADR-010 (Phase 4 yui 移行戦略) を参照。
 *
 * 出力:
 *   staging/observations.jsonl  — 1 行 1 record、filter / transform 適用済
 *   staging/memories.jsonl      — 同上
 *   staging/decisions.jsonl     — 同上
 *   staging/stats.md            — filter 内訳と削除件数の人間用サマリ
 *   staging/exclusions.txt      — user が追記する追加除外 ID 一覧 (初期は空)
 *
 * 実行:
 *   YUI_DATABASE_URL=postgresql://... pnpm exec tsx scripts/yui-migration/extract.ts
 */

import process from "node:process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool } = pg;

const HERE = dirname(fileURLToPath(import.meta.url));
const STAGING = join(HERE, "staging");

// ---------------------------------------------------------------------------
// Filter rules (ADR-010 で合意済)
// ---------------------------------------------------------------------------

const SOURCE_EXCLUDE = new Set(["claude_mem_import"]);
const OBS_KIND_EXCLUDE = new Set(["user_prompt"]);
const MIN_NARRATIVE_LEN = 30;
const MIN_MEM_IMPORTANCE = 4;

/** thin tool_use の narrative パターン (path / cmd だけのもの) */
const THIN_TOOL_RE =
  /^(Read|Edit|Write|Bash|Glob|Grep|MultiEdit|NotebookEdit):\s*\S+\s*$/;
const THIN_MEM_PREFIX = ["File edit:", "Command run:", "session ended:"];
const THIN_MEM_TOOL_RE = /^(Read|Edit|Write|Bash|Glob|Grep): \S+\s*$/;
const THIN_MEM_MAX_LEN = 120;

/**
 * Secrets / credentials 参照を含む narrative。observations にも memories にも適用。
 * - postgresql://user:pass@... / mysql:// / mongodb:// 等の inline 接続文字列
 * - password= / token= / secret= の代入パターン (quoted も)
 * - yui_pg_password / secrets.yml / 秘密鍵 等の既知識別子
 * - API_KEY / private_key / access_key 等の典型キー名
 */
const SECRETS_RE =
  /(postgresql:\/\/[^:\s]+:[^@\s]+@|mysql:\/\/[^:\s]+:[^@\s]+@|mongodb(?:\+srv)?:\/\/[^:\s]+:[^@\s]+@|password\s*[=:]\s*['"]?\S+|token\s*[=:]\s*['"]?[\w.-]+|secret\s*[=:]\s*['"]?\S+|Authorization\s*:\s*(Bearer|Basic|Token)\s+[\w.\-+/=]+|Bearer\s+[\w.\-]{20,}|yui_pg_password|secrets\.yml|秘密鍵|private[_-]?key|\bAPI[_-]?KEY\b|access[_-]?key|\beyJ[\w.\-]{30,})/i;

/**
 * 内部インフラへの ssh コマンドを含む narrative (情報密度低 + creds 隣接リスク)。
 * 「Command run: echo ... ssh pve-docker ...」のような中央配置も捕捉。
 */
const INTERNAL_SSH_RE = /\bssh\s+(pve-|root@|deploy@|admin@)/i;

/** Tailscale CGNAT 帯 (100.64.0.0/10) を含む narrative */
const TAILSCALE_IP_RE =
  /\b100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/;

// ---------------------------------------------------------------------------
// kind → type マッピング (observations 用)
// ---------------------------------------------------------------------------

function mapType(kind: string | null | undefined): string {
  switch (kind) {
    case "tool_use":
    case "file_edit":
      return "progress";
    case "session_summary":
    case "reflection":
      return "reflection";
    case "discovery":
      return "discovery";
    case "blocker":
      return "blocker";
    case "decision":
      return "decision";
    default:
      return "other";
  }
}

function mapSource(source: string): string {
  if (source === "claude_code") return "claude-code";
  if (source === "codex") return "codex";
  if (source === "yui") return "yui";
  return "other";
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

interface RawObs {
  id: string;
  source: string;
  kind: string;
  narrative: string | null;
  facts: string[] | null;
  recorded_at: Date;
}

interface RawMem {
  id: string;
  kind: string;
  narrative: string;
  importance: number | null;
  created_at: Date;
}

interface RawDec {
  id: string;
  title: string | null;
  body: string | null;
  status: string;
  created_at: Date;
}

interface ObsOut {
  src_id: string;
  src_source: string;
  src_kind: string;
  source: string;
  type: string;
  content: string;
  facts: string[] | null;
  recorded_at: string;
}

interface MemOut {
  src_id: string;
  kind: string;
  narrative: string;
  importance: number | null;
  created_at: string;
}

interface DecOut {
  src_id: string;
  content: string;
  status: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// SQL extraction
// ---------------------------------------------------------------------------

async function loadObservations(pool: pg.Pool): Promise<RawObs[]> {
  const r = await pool.query<RawObs>(`
    SELECT
      id::text AS id,
      source,
      kind,
      payload->>'narrative' AS narrative,
      payload->'facts' AS facts,
      recorded_at
    FROM observations
    WHERE archived_at IS NULL
    ORDER BY recorded_at ASC
  `);
  return r.rows;
}

async function loadMemories(pool: pg.Pool): Promise<RawMem[]> {
  const r = await pool.query<RawMem>(`
    SELECT
      id::text AS id,
      kind,
      narrative,
      importance,
      created_at
    FROM memories
    WHERE archived_at IS NULL
    ORDER BY created_at ASC
  `);
  return r.rows;
}

async function loadDecisions(pool: pg.Pool): Promise<RawDec[]> {
  const r = await pool.query<RawDec>(`
    SELECT
      id::text AS id,
      title,
      body,
      status,
      created_at
    FROM decisions
    WHERE status = 'active'
    ORDER BY created_at ASC
  `);
  return r.rows;
}

// ---------------------------------------------------------------------------
// Filter pipelines (return [kept, droppedReasonCounts])
// ---------------------------------------------------------------------------

function isThinObs(narrative: string): boolean {
  return THIN_TOOL_RE.test(narrative);
}

function isThinMem(narrative: string): boolean {
  if (narrative.length > THIN_MEM_MAX_LEN) return false;
  for (const p of THIN_MEM_PREFIX) {
    if (narrative.startsWith(p)) return true;
  }
  if (THIN_MEM_TOOL_RE.test(narrative)) return true;
  return false;
}

function filterObservations(rows: RawObs[]): {
  kept: ObsOut[];
  drops: Map<string, number>;
} {
  const drops = new Map<string, number>();
  const inc = (k: string) => drops.set(k, (drops.get(k) ?? 0) + 1);
  const kept: ObsOut[] = [];

  for (const r of rows) {
    if (SOURCE_EXCLUDE.has(r.source)) {
      inc(`source=${r.source}`);
      continue;
    }
    if (OBS_KIND_EXCLUDE.has(r.kind)) {
      inc(`kind=${r.kind}`);
      continue;
    }
    const narr = r.narrative?.trim() ?? "";
    if (narr.length < MIN_NARRATIVE_LEN) {
      inc(`narrative<${MIN_NARRATIVE_LEN}`);
      continue;
    }
    if (isThinObs(narr)) {
      inc("thin-tool-pattern");
      continue;
    }
    if (SECRETS_RE.test(narr)) {
      inc("secrets-reference");
      continue;
    }
    if (INTERNAL_SSH_RE.test(narr)) {
      inc("internal-ssh-cmd");
      continue;
    }
    if (TAILSCALE_IP_RE.test(narr)) {
      inc("tailscale-ip");
      continue;
    }
    kept.push({
      src_id: r.id,
      src_source: r.source,
      src_kind: r.kind,
      source: mapSource(r.source),
      type: mapType(r.kind),
      content: narr,
      facts: r.facts,
      recorded_at: r.recorded_at.toISOString(),
    });
  }

  return { kept, drops };
}

function filterMemories(rows: RawMem[]): {
  kept: MemOut[];
  drops: Map<string, number>;
} {
  const drops = new Map<string, number>();
  const inc = (k: string) => drops.set(k, (drops.get(k) ?? 0) + 1);
  const kept: MemOut[] = [];
  const seenNarratives = new Set<string>();

  for (const r of rows) {
    const narr = r.narrative.trim();
    if ((r.importance ?? 0) < MIN_MEM_IMPORTANCE) {
      inc(`importance<${MIN_MEM_IMPORTANCE}`);
      continue;
    }
    if (isThinMem(narr)) {
      inc("thin-narrative");
      continue;
    }
    if (SECRETS_RE.test(narr)) {
      inc("secrets-reference");
      continue;
    }
    if (TAILSCALE_IP_RE.test(narr)) {
      inc("tailscale-ip");
      continue;
    }
    if (seenNarratives.has(narr)) {
      inc("duplicate");
      continue;
    }
    seenNarratives.add(narr);
    kept.push({
      src_id: r.id,
      kind: r.kind,
      narrative: narr,
      importance: r.importance,
      created_at: r.created_at.toISOString(),
    });
  }

  return { kept, drops };
}

function filterDecisions(rows: RawDec[]): {
  kept: DecOut[];
  drops: Map<string, number>;
} {
  const drops = new Map<string, number>();
  const inc = (k: string) => drops.set(k, (drops.get(k) ?? 0) + 1);
  const kept: DecOut[] = [];

  for (const r of rows) {
    const content = (r.body ?? r.title ?? "").trim();
    if (content.length < 10) {
      inc("body-empty");
      continue;
    }
    kept.push({
      src_id: r.id,
      content,
      status: r.status,
      created_at: r.created_at.toISOString(),
    });
  }

  return { kept, drops };
}

// ---------------------------------------------------------------------------
// Output writers
// ---------------------------------------------------------------------------

async function writeJsonl<T>(path: string, rows: T[]): Promise<void> {
  await writeFile(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

function fmtMap(drops: Map<string, number>): string {
  const entries = Array.from(drops.entries()).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return "  (none)\n";
  return entries.map(([k, v]) => `  - ${k}: ${v.toLocaleString()}`).join("\n");
}

async function writeStats(
  obsIn: number,
  obsOut: number,
  obsDrops: Map<string, number>,
  memIn: number,
  memOut: number,
  memDrops: Map<string, number>,
  decIn: number,
  decOut: number,
  decDrops: Map<string, number>,
): Promise<void> {
  const total = obsIn + memIn + decIn;
  const kept = obsOut + memOut + decOut;
  const dropped = total - kept;
  const md = `# yui → tsumugi migration extract stats

Generated: ${new Date().toISOString()}

## サマリ

| 系 | 元 | 移行候補 (kept) | 削除 |
|---|---|---|---|
| observations | ${obsIn.toLocaleString()} | ${obsOut.toLocaleString()} | ${(obsIn - obsOut).toLocaleString()} |
| memories | ${memIn.toLocaleString()} | ${memOut.toLocaleString()} | ${(memIn - memOut).toLocaleString()} |
| decisions | ${decIn.toLocaleString()} | ${decOut.toLocaleString()} | ${(decIn - decOut).toLocaleString()} |
| **合計** | **${total.toLocaleString()}** | **${kept.toLocaleString()}** | **${dropped.toLocaleString()} (${((dropped / total) * 100).toFixed(1)}%)** |

## observations 削除内訳 (${(obsIn - obsOut).toLocaleString()} 件)

${fmtMap(obsDrops)}

## memories 削除内訳 (${(memIn - memOut).toLocaleString()} 件)

${fmtMap(memDrops)}

## decisions 削除内訳 (${(decIn - decOut).toLocaleString()} 件)

${fmtMap(decDrops)}

## 次の手順

1. 各 \`*.jsonl\` を VS Code 等で開いて目視確認
2. 追加で除外したいレコードの \`src_id\` を \`exclusions.txt\` に 1 行ずつ追記
3. 怪しい narrative は jsonl を直接編集して sanitize しても OK
4. 確認完了したら apply スクリプト (別途) で tsumugi へ投入
`;
  await writeFile(join(STAGING, "stats.md"), md);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const databaseUrl = process.env["YUI_DATABASE_URL"];
  if (!databaseUrl) {
    throw new Error("YUI_DATABASE_URL is required");
  }

  const pool = new Pool({ connectionString: databaseUrl });

  try {
    console.log("loading yui data...");
    const [observations, memories, decisions] = await Promise.all([
      loadObservations(pool),
      loadMemories(pool),
      loadDecisions(pool),
    ]);
    console.log(
      `  observations: ${observations.length.toLocaleString()}, memories: ${memories.length.toLocaleString()}, decisions: ${decisions.length.toLocaleString()}`,
    );

    console.log("applying filters...");
    const { kept: obsKept, drops: obsDrops } = filterObservations(observations);
    const { kept: memKept, drops: memDrops } = filterMemories(memories);
    const { kept: decKept, drops: decDrops } = filterDecisions(decisions);

    console.log(
      `  observations kept: ${obsKept.length.toLocaleString()}, memories kept: ${memKept.length.toLocaleString()}, decisions kept: ${decKept.length.toLocaleString()}`,
    );

    await mkdir(STAGING, { recursive: true });
    await Promise.all([
      writeJsonl(join(STAGING, "observations.jsonl"), obsKept),
      writeJsonl(join(STAGING, "memories.jsonl"), memKept),
      writeJsonl(join(STAGING, "decisions.jsonl"), decKept),
    ]);
    await writeStats(
      observations.length,
      obsKept.length,
      obsDrops,
      memories.length,
      memKept.length,
      memDrops,
      decisions.length,
      decKept.length,
      decDrops,
    );

    // create empty exclusions.txt if not exists (don't overwrite)
    const exclusionsPath = join(STAGING, "exclusions.txt");
    try {
      const { existsSync } = await import("node:fs");
      if (!existsSync(exclusionsPath)) {
        await writeFile(
          exclusionsPath,
          `# Add src_id values (one per line) to additionally exclude from migration.\n# Lines starting with # are comments.\n`,
        );
      }
    } catch {
      // ignore
    }

    console.log(`\n✓ wrote files to ${STAGING}/`);
    console.log("  - observations.jsonl");
    console.log("  - memories.jsonl");
    console.log("  - decisions.jsonl");
    console.log("  - stats.md   ← まず見てください");
    console.log("  - exclusions.txt   ← user 編集用");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
