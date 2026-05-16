CREATE UNIQUE INDEX IF NOT EXISTS "DocumentChunk_documentId_seq_key"
ON "DocumentChunk"("documentId", "seq");

DROP INDEX IF EXISTS "DocumentChunk_embedding_ivfflat_cos_idx";
CREATE INDEX "DocumentChunk_embedding_ivfflat_cos_idx"
ON "DocumentChunk"
USING ivfflat ("embedding" vector_cosine_ops)
WITH (lists = 100);
