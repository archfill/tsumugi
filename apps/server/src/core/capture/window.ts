import type { CaptureRow } from "../../data/repos/capture.js";

export const CAPTURE_WINDOW_DEFAULTS = {
  maxTurns: 3,
  maxChars: 12_000,
  fallbackAfterMs: 60 * 60 * 1000,
} as const;

export interface CaptureWindowCandidate {
  source: string;
  sessionId: string;
  projectTag: string | null;
  captureIds: string[];
  cutoffAt: Date;
  content: string;
  rawChars: number;
  completedTurns: number;
  fallback: boolean;
}

function parsePayload(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function payloadText(capture: CaptureRow): string {
  if (capture.continuity_content?.trim()) {
    return capture.continuity_content.trim();
  }
  const payload = parsePayload(capture.raw_content);
  if (payload) {
    const keys =
      capture.hook_event === "Stop"
        ? ["last_assistant_message", "lastAssistantMessage"]
        : capture.hook_event === "UserPromptSubmit"
          ? ["prompt", "userPrompt", "message"]
          : [];
    for (const key of keys) {
      const value = payload[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  return capture.raw_content.trim();
}

function captureBlock(capture: CaptureRow, maxChars: number): string {
  const content = payloadText(capture);
  const bounded =
    content.length <= maxChars
      ? content
      : `${content.slice(0, maxChars)}\n[truncated for promotion window]`;
  const label =
    capture.hook_event === "UserPromptSubmit"
      ? "User"
      : capture.hook_event === "Stop"
        ? "Assistant checkpoint"
        : capture.hook_event;
  return `[${label}]\n${bounded}`;
}

function sessionKey(capture: CaptureRow): string {
  return `${capture.source}\u0000${capture.project_tag ?? ""}\u0000${capture.session_id}`;
}

function buildCandidate(
  captures: CaptureRow[],
  completedTurns: number,
  fallback: boolean,
  maxChars: number,
): CaptureWindowCandidate {
  const first = captures[0]!;
  const unboundedContent = captures
    .map((capture) => captureBlock(capture, maxChars))
    .join("\n\n");
  const marker = "\n[window content truncated]\n";
  const content =
    unboundedContent.length <= maxChars
      ? unboundedContent
      : `${unboundedContent.slice(0, Math.floor((maxChars - marker.length) * 0.4))}${marker}${unboundedContent.slice(-Math.ceil((maxChars - marker.length) * 0.6))}`;
  return {
    source: first.source,
    sessionId: first.session_id,
    projectTag: first.project_tag,
    captureIds: captures.map((capture) => capture.id),
    cutoffAt: captures[captures.length - 1]!.captured_at,
    content,
    rawChars: content.length,
    completedTurns,
    fallback,
  };
}

export function buildCaptureWindows(
  rows: CaptureRow[],
  options?: {
    maxTurns?: number;
    maxChars?: number;
    fallbackAfterMs?: number;
    now?: Date;
  },
): CaptureWindowCandidate[] {
  const maxTurns = options?.maxTurns ?? CAPTURE_WINDOW_DEFAULTS.maxTurns;
  const maxChars = options?.maxChars ?? CAPTURE_WINDOW_DEFAULTS.maxChars;
  const fallbackAfterMs =
    options?.fallbackAfterMs ?? CAPTURE_WINDOW_DEFAULTS.fallbackAfterMs;
  const now = options?.now ?? new Date();
  const grouped = new Map<string, CaptureRow[]>();
  for (const row of rows) {
    const key = sessionKey(row);
    const group = grouped.get(key) ?? [];
    group.push(row);
    grouped.set(key, group);
  }

  const result: CaptureWindowCandidate[] = [];
  for (const sessionRows of grouped.values()) {
    sessionRows.sort(
      (left, right) => left.captured_at.getTime() - right.captured_at.getTime(),
    );
    const byTurn = new Map<string, CaptureRow[]>();
    const noTurn: CaptureRow[] = [];
    for (const row of sessionRows) {
      if (!row.turn_id) {
        noTurn.push(row);
        continue;
      }
      const turn = byTurn.get(row.turn_id) ?? [];
      turn.push(row);
      byTurn.set(row.turn_id, turn);
    }

    const completed = [...byTurn.values()]
      .filter((turn) => turn.some((capture) => capture.hook_event === "Stop"))
      .sort(
        (left, right) =>
          left[left.length - 1]!.captured_at.getTime() -
          right[right.length - 1]!.captured_at.getTime(),
      );
    let implicitTurn: CaptureRow[] = [];
    for (const row of noTurn) {
      implicitTurn.push(row);
      if (row.hook_event === "Stop") {
        completed.push(implicitTurn);
        implicitTurn = [];
      }
    }
    completed.sort(
      (left, right) =>
        left[left.length - 1]!.captured_at.getTime() -
        right[right.length - 1]!.captured_at.getTime(),
    );

    const consumed = new Set<string>();
    let pendingTurns: CaptureRow[][] = [];
    let pendingChars = 0;
    const flushTurns = () => {
      if (pendingTurns.length === 0) return;
      const captures = pendingTurns.flat();
      captures.forEach((capture) => consumed.add(capture.id));
      result.push(
        buildCandidate(
          captures,
          pendingTurns.length,
          false,
          maxChars,
        ),
      );
      pendingTurns = [];
      pendingChars = 0;
    };

    for (const turn of completed) {
      const turnChars = turn.reduce(
        (total, capture) => total + payloadText(capture).length,
        0,
      );
      if (
        pendingTurns.length > 0 &&
        (pendingTurns.length >= maxTurns || pendingChars + turnChars > maxChars)
      ) {
        flushTurns();
      }
      pendingTurns.push(turn);
      pendingChars += turnChars;
    }
    flushTurns();

    const fallbackCutoff = now.getTime() - fallbackAfterMs;
    const fallbackRows = sessionRows.filter(
      (row) =>
        !consumed.has(row.id) && row.captured_at.getTime() <= fallbackCutoff,
    );
    let fallbackBatch: CaptureRow[] = [];
    let fallbackChars = 0;
    const flushFallback = () => {
      if (fallbackBatch.length === 0) return;
      result.push(buildCandidate(fallbackBatch, 0, true, maxChars));
      fallbackBatch = [];
      fallbackChars = 0;
    };
    for (const row of fallbackRows) {
      const chars = payloadText(row).length;
      if (
        fallbackBatch.length > 0 &&
        (fallbackBatch.length >= maxTurns || fallbackChars + chars > maxChars)
      ) {
        flushFallback();
      }
      fallbackBatch.push(row);
      fallbackChars += chars;
    }
    flushFallback();
  }

  return result.sort(
    (left, right) => left.cutoffAt.getTime() - right.cutoffAt.getTime(),
  );
}
