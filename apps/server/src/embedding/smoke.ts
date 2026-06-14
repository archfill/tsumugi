/**
 * Smoke test for BGE-M3 embedding.
 * Run: pnpm exec tsx src/embedding/smoke.ts
 */
import process from "node:process";
import { createBgeEmbedder } from "./index.js";

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
    normA += (a[i] ?? 0) ** 2;
    normB += (b[i] ?? 0) ** 2;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function main(): Promise<void> {
  console.log(
    "Initializing BGE-M3 embedder (first call may download the model)...",
  );
  const embedder = createBgeEmbedder();

  const texts = [
    "Today is a sunny day.",
    "今日はいい天気です。",
    "The weather is nice today.",
    "I love programming in TypeScript.",
  ];

  console.log(`\nEmbedding ${texts.length} texts in batch...`);
  const embeddings = await embedder.embedMany(texts);

  console.log(`\nResults:`);
  for (let i = 0; i < texts.length; i++) {
    const emb = embeddings[i];
    console.log(`  [${i}] "${texts[i]}" → dim=${emb?.length}`);
  }

  const e0 = embeddings[0];
  const e1 = embeddings[1];
  const e2 = embeddings[2];
  const e3 = embeddings[3];

  if (e0 && e1 && e2 && e3) {
    const sim01 = cosineSimilarity(e0, e1);
    const sim02 = cosineSimilarity(e0, e2);
    const sim03 = cosineSimilarity(e0, e3);

    console.log("\nCosine similarities:");
    console.log(
      `  "Today is sunny" vs "今日はいい天気です" → ${sim01.toFixed(4)}`,
    );
    console.log(
      `  "Today is sunny" vs "The weather is nice" → ${sim02.toFixed(4)}`,
    );
    console.log(`  "Today is sunny" vs "TypeScript" → ${sim03.toFixed(4)}`);
    console.log(
      "\n[sim02 > sim01 > sim03 is expected for cross-lingual BGE-M3]",
    );
  }

  console.log(`\nembedder.dimension() = ${embedder.dimension()}`);
  console.log("\nSmoke test passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
