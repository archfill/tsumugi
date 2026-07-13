import { CaptureInput } from "@tsumugi/shared";
import { createHash } from "node:crypto";
import { captureRepo } from "../../data/repos/capture.js";
import { newId } from "../../lib/id.js";

export interface SaveCaptureResult {
  id: string;
  inserted: boolean;
}

export async function saveCapture(
  rawInput: unknown,
): Promise<SaveCaptureResult> {
  const input = CaptureInput.parse(rawInput);
  const id = newId("cap");
  const contentHash = `sha256:${createHash("sha256")
    .update(input.raw_content)
    .digest("hex")}`;

  return await captureRepo.insertIdempotent({
    id,
    session_id: input.session_id,
    project_tag: input.project_tag ?? null,
    source: input.source,
    hook_event: input.hook_event,
    tool_name: input.tool_name ?? null,
    turn_id: input.turn_id ?? null,
    continuity_content: input.continuity_content ?? null,
    content_hash: contentHash,
    raw_content: input.raw_content,
  });
}
