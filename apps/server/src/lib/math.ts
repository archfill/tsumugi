/**
 * Math utility functions.
 */

/**
 * Compute the cosine similarity between two vectors.
 * Returns 0 if either vector is zero-length or dimensions mismatch.
 */
export function cosineSimilarity(
  a: number[] | Float32Array,
  b: number[] | Float32Array,
): number {
  if (a.length !== b.length) return 0;
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
