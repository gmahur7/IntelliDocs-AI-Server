import { prisma } from "@config/prisma";
import { randomUUID } from "crypto";

type CreateChunkInput = {
  documentId: string;
  userId: string;
  seq: number;
  text: string;
  tokenCount?: number;
  embedding: number[];
};

export type RetrievedChunk = {
  id: string;
  text: string;
  documentId: string;
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
        INSERT INTO "DocumentChunk" ("id", "documentId", "userId", "seq", "text", "tokenCount", "embedding", "createdAt")
        VALUES ($1, $2, $3, $4, $5, $6, $7::vector, NOW())
        ON CONFLICT ("documentId", "seq")
        DO UPDATE SET
          "text" = EXCLUDED."text",
          "tokenCount" = EXCLUDED."tokenCount",
          "embedding" = EXCLUDED."embedding",
          "userId" = EXCLUDED."userId"
        `,
        randomUUID(),
        chunk.documentId,
        chunk.userId,
        chunk.seq,
        chunk.text,
        chunk.tokenCount ?? null,
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
    const rows = await prisma.$queryRawUnsafe<RetrievedChunk[]>(
      `
      SELECT c.id, c.text, c."documentId", (c.embedding <=> $1::vector) AS score
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
    return rows;
  }
}
