-- A conversation may span every document the user owns, so it is no longer pinned to one.
ALTER TABLE "Conversation" ALTER COLUMN "documentId" DROP NOT NULL;

-- Rows written before this used "" as a stand-in for "no document".
UPDATE "Conversation" SET "documentId" = NULL WHERE "documentId" = '';
