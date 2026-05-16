import { env } from "@config/env";

export class ChunkingService {
  chunkText(text: string, size = env.RAG_CHUNK_SIZE, overlap = env.RAG_CHUNK_OVERLAP): string[] {
    if (size <= 0) {
      throw new Error("Chunk size must be positive.");
    }
    if (overlap < 0 || overlap >= size) {
      throw new Error("Chunk overlap must be >= 0 and < size.");
    }
    const chunks: string[] = [];
    let start = 0;
    while (start < text.length) {
      const end = Math.min(text.length, start + size);
      const chunk = text.slice(start, end).trim();
      if (chunk.length > 0) {
        chunks.push(chunk);
      }
      if (end === text.length) {
        break;
      }
      start = Math.max(0, end - overlap);
    }
    return chunks;
  }
}
