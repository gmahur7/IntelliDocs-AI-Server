import { prisma } from "@config/prisma";
import { randomUUID } from "crypto";

type CreateChunkInput = {
  documentId: string;
  userId: string;
  seq: number;
  text: string;
  tokenCount?: number;
  pageStart?: number;
  pageEnd?: number;
  embedding: number[];
};

export type RetrievedChunk = {
  id: string;
  text: string;
  documentId: string;
  pageStart: number | null;
  pageEnd: number | null;
  score: number;
};

export class DocumentChunkRepository {
  async deleteByDocumentId(documentId: string): Promise<void> {
    await prisma.documentChunk.deleteMany({
      where: { documentId },
    });
  }

  async createMany(chunks: CreateChunkInput[]): Promise<void> {
    if (chunks.length === 0) {
      return;
    }
    for (const chunk of chunks) {
      const vectorLiteral = `[${chunk.embedding.join(",")}]`;
      await prisma.$executeRawUnsafe(
        `
        INSERT INTO "DocumentChunk" ("id", "documentId", "userId", "seq", "text", "tokenCount", "pageStart", "pageEnd", "embedding", "createdAt")
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::vector, NOW())
        ON CONFLICT ("documentId", "seq")
        DO UPDATE SET
          "text" = EXCLUDED."text",
          "tokenCount" = EXCLUDED."tokenCount",
          "pageStart" = EXCLUDED."pageStart",
          "pageEnd" = EXCLUDED."pageEnd",
          "embedding" = EXCLUDED."embedding",
          "userId" = EXCLUDED."userId"
        `,
        randomUUID(),
        chunk.documentId,
        chunk.userId,
        chunk.seq,
        chunk.text,
        chunk.tokenCount ?? null,
        chunk.pageStart ?? null,
        chunk.pageEnd ?? null,
        vectorLiteral,
      );
    }
  }

  async findByDocumentIdAndUserId(documentId: string, userId: string) {
    return prisma.documentChunk.findMany({
      where: {
        documentId,
        userId,
      },
      orderBy: { seq: "asc" },
      select: {
        id: true,
        seq: true,
        text: true,
        tokenCount: true,
        pageStart: true,
        pageEnd: true,
        createdAt: true,
      },
    });
  }

  async findTopKByVector(params: {
    userId: string;
    queryEmbedding: number[];
    topK: number;
    documentId?: string;
  }): Promise<RetrievedChunk[]> {
    const vectorLiteral = `[${params.queryEmbedding.join(",")}]`;
    return prisma.$transaction(async (tx) => {
      // The HNSW index yields ef_search candidates before the WHERE clause runs, so a user with few
      // chunks could get fewer than topK rows. Iterative scan (pgvector >= 0.8) keeps searching
      // until LIMIT rows pass the filter. SET LOCAL scopes it to this transaction.
      await tx.$executeRawUnsafe(`SET LOCAL hnsw.iterative_scan = relaxed_order`);
      return tx.$queryRawUnsafe<RetrievedChunk[]>(
        `
        SELECT c.id, c.text, c."documentId", c."pageStart", c."pageEnd", (c.embedding <=> $1::vector) AS score
        FROM "DocumentChunk" c
        JOIN "Document" d ON d.id = c."documentId"
        WHERE d."userId" = $2
          AND d.status = 'READY'
          AND ($3::text IS NULL OR d.id = $3::text)
        ORDER BY c.embedding <=> $1::vector
        LIMIT $4
        `,
        vectorLiteral,
        params.userId,
        params.documentId ?? null,
        params.topK,
      );
    });
  }
}
