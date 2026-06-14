-- Hybrid search indexes: pg_bigm GIN + pgvector IVFFlat
-- Manually placed migration (not drizzle-kit generated).
-- Prerequisites: pg_bigm and pgvector extensions must already be enabled
--   (handled in 0000 migration or DB init).

-- pg_bigm GIN indexes for bigram keyword search
CREATE INDEX IF NOT EXISTS observations_content_bigm_idx
  ON observations USING gin (content gin_bigm_ops);

CREATE INDEX IF NOT EXISTS memories_narrative_bigm_idx
  ON memories USING gin (narrative gin_bigm_ops);

-- pgvector IVFFlat indexes for cosine distance search
-- NOTE: lists=100 is a starting point; tune upward as row count grows
--   (rule of thumb: sqrt(rows) for balanced recall/speed).
CREATE INDEX IF NOT EXISTS observations_embedding_ivfflat_idx
  ON observations USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

CREATE INDEX IF NOT EXISTS memories_embedding_ivfflat_idx
  ON memories USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
