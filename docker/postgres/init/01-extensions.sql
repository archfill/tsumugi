-- Enable pgvector (semantic / vector search)
CREATE EXTENSION IF NOT EXISTS vector;

-- Enable pg_bigm (bigram keyword search for Japanese / CJK full-text search)
CREATE EXTENSION IF NOT EXISTS pg_bigm;
