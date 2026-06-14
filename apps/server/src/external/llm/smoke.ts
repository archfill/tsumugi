/**
 * Smoke test for the LLM client layer.
 * Run: pnpm llm:smoke
 * Requires LLM_LOW_API_KEY to be set in env.
 */
import process from "node:process";
import { getLlm } from "./singleton.js";

const apiKey = process.env["LLM_LOW_API_KEY"];
if (!apiKey) {
  console.log("LLM_LOW_API_KEY is not set — skipping smoke test");
  process.exit(0);
}

console.log("Running LLM smoke test (tier: low)...");

try {
  const llm = getLlm("low");

  // JSON completion smoke
  const result = await llm.completeJson<{ answer: string; confidence: number }>(
    {
      system: "You are a helpful assistant that responds in JSON.",
      user: 'What is 2 + 2? Respond with {"answer": "<number>", "confidence": <0-1>}',
    },
  );

  console.log("completeJson result:", result);

  if (
    typeof result.answer !== "string" ||
    typeof result.confidence !== "number"
  ) {
    console.error("Unexpected shape:", result);
    process.exit(1);
  }

  // Plain text completion smoke
  const textResult = await llm.complete({
    system: "You are a concise assistant.",
    user: "Say exactly: hello from tsumugi",
  });

  console.log("complete result text:", textResult.text);
  console.log("usage:", textResult.usage);
  console.log("Smoke test passed.");
} catch (err) {
  console.error("Smoke test failed:", err);
  process.exit(1);
}
