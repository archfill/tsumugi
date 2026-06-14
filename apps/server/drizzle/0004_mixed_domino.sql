-- observations: facts も pg_bigm 検索対象にするため search_text 生成列を追加し、
-- bigm GIN index を content から search_text に張り替える。

ALTER TABLE "observations" ADD COLUMN "search_text" text GENERATED ALWAYS AS (("content" || ' ' || coalesce("facts"::text, ''))) STORED NOT NULL;

-- 旧 GIN index は重複となるため削除し、search_text 用に張り直す
DROP INDEX IF EXISTS "observations_content_bigm_idx";
CREATE INDEX IF NOT EXISTS "observations_search_text_bigm_idx"
  ON "observations" USING gin ("search_text" gin_bigm_ops);
