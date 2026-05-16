import { env } from "@config/env";
import {
  DocumentChunkRepository,
  type RetrievedChunk,
} from "@repositories/document-chunk.repository";
import { EmbeddingService } from "@services/embedding.service";

type RetrieveTopKInput = {
  userId: string;
  query: string;
  topK?: number;
  documentId?: string;
};

export class RetrievalService {
  constructor(
    private readonly embeddingService: EmbeddingService = new EmbeddingService(),
    private readonly documentChunkRepository: DocumentChunkRepository = new DocumentChunkRepository(),
  ) {}

  async retrieveTopK(input: RetrieveTopKInput): Promise<RetrievedChunk[]> {
    const topK = Math.max(1, Math.min(input.topK ?? env.RAG_DEFAULT_TOP_K, 12));
    const queryEmbedding = await this.embeddingService.embedText(input.query);
    return this.documentChunkRepository.findTopKByVector({
      userId: input.userId,
      queryEmbedding,
      topK,
      documentId: input.documentId,
    });
  }
}
