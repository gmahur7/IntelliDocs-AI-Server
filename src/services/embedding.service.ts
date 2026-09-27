import { env } from "@config/env";
import { OllamaService } from "@services/ollama.service";

// nomic-embed-text is trained on task-prefixed input; unprefixed queries and passages land in
// poorly aligned regions of the vector space. The prefix is applied only here, at embed time, so
// DocumentChunk.text stays clean. Changing a prefix invalidates every stored vector: reindex.
export class EmbeddingService {
  constructor(private readonly ollamaService: OllamaService = new OllamaService()) {}

  async embedQuery(text: string): Promise<number[]> {
    return this.ollamaService.embedText(`${env.RAG_EMBED_QUERY_PREFIX}${text}`);
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    return this.ollamaService.embedMany(
      texts.map((text) => `${env.RAG_EMBED_DOCUMENT_PREFIX}${text}`),
    );
  }
}
