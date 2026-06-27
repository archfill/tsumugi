import { CaptureInput } from "@tsumugi/shared";
import { captureRepo } from "../../data/repos/capture.js";
import { newId } from "../../lib/id.js";

export interface SaveCaptureResult {
  id: string;
}

export async function saveCapture(
  rawInput: unknown,
): Promise<SaveCaptureResult> {
  const input = CaptureInput.parse(rawInput);
  const id = newId("cap");

  await captureRepo.insert({
    id,
    session_id: input.session_id,
    project_tag: input.project_tag ?? null,
    source: input.source,
    hook_event: input.hook_event,
    tool_name: input.tool_name ?? null,
    raw_content: input.raw_content,
  });

  return { id };
}
