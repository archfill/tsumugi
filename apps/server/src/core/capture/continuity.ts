import { CaptureContinuityInput } from "@tsumugi/shared";
import { captureRepo } from "../../data/repos/capture.js";

export interface ContinuitySession {
  source: string;
  sessionId: string;
  latestAt: string;
  checkpoints: string[];
}

function parseFinalMessage(raw: string): string | null {
  try {
    const payload = JSON.parse(raw) as Record<string, unknown>;
    for (const key of ["last_assistant_message", "lastAssistantMessage"]) {
      const value = payload[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  } catch {
    return null;
  }
  return null;
}

export async function getCaptureContinuity(rawInput: unknown): Promise<{
  sessions: ContinuitySession[];
}> {
  const input = CaptureContinuityInput.parse(rawInput);
  const rows = await captureRepo.listContinuityCandidates({
    projectTag: input.project_tag,
    excludeSessionId: input.exclude_session_id,
    limit: input.max_sessions * input.max_turns_per_session * 4,
  });
  const grouped = new Map<string, ContinuitySession>();
  for (const row of rows) {
    const content =
      row.continuity_content?.trim() || parseFinalMessage(row.raw_content);
    if (!content) continue;
    let session = grouped.get(row.session_id);
    if (!session) {
      if (grouped.size >= input.max_sessions) continue;
      session = {
        source: row.source,
        sessionId: row.session_id,
        latestAt: row.captured_at.toISOString(),
        checkpoints: [],
      };
      grouped.set(row.session_id, session);
    }
    if (session.checkpoints.length < input.max_turns_per_session) {
      session.checkpoints.push(content);
    }
  }
  return { sessions: [...grouped.values()] };
}
