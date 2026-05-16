import { logger } from "@config/logger";
import { DocumentChunkRepository } from "@repositories/document-chunk.repository";
import { DocumentService } from "@services/document.service";
import { EmbeddingService } from "@services/embedding.service";
import { B2Service } from "@services/b2.service";
import { ChunkingService } from "@services/chunking.service";
import { FileParserService } from "@services/file-parser.service";
import { env } from "@config/env";
import { consumeIngestMessages, publishIngestMessage } from "../queue/rabbitmq.client";
import { normalizeText } from "@utils/text-normalizer";
import type { DocumentIngestRequestedPayload } from "../queue/ingest.producer";

export class IngestWorker {
  constructor(
    private readonly documentService: DocumentService = new DocumentService(),
    private readonly documentChunkRepository: DocumentChunkRepository = new DocumentChunkRepository(),
    private readonly b2Service: B2Service = new B2Service(),
    private readonly fileParserService: FileParserService = new FileParserService(),
    private readonly chunkingService: ChunkingService = new ChunkingService(),
    private readonly embeddingService: EmbeddingService = new EmbeddingService(),
  ) {}

  async processDocumentIngestRequested(payload: DocumentIngestRequestedPayload): Promise<void> {
    logger.info({ payload }, "Starting document ingestion pipeline.");
    await this.documentService.markProcessing(payload.documentId);
    try {
      const document = await this.documentService.getById(payload.documentId);
      if (!document) {
        throw new Error(`Document not found: ${payload.documentId}`);
      }
      const fileBuffer = await this.b2Service.downloadFile(payload.fileKey);
      const rawText = await this.fileParserService.parseByMime(fileBuffer, document.mimeType);
      const normalizedText = normalizeText(rawText);
      const chunks = this.chunkingService.chunkText(normalizedText);
      const embeddings = await this.embeddingService.embedMany(chunks);
      await this.documentChunkRepository.deleteByDocumentId(payload.documentId);
      await this.documentChunkRepository.createMany(
        chunks.map((chunkText, index) => ({
          documentId: payload.documentId,
          userId: payload.userId,
          seq: index,
          text: chunkText,
          tokenCount: chunkText.length,
          embedding: embeddings[index],
        })),
      );
      await this.documentService.markReady(payload.documentId);
      logger.info(
        { documentId: payload.documentId, chunkCount: chunks.length },
        "Document ingestion completed.",
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown ingestion error";
      await this.documentService.markFailed(payload.documentId, message);
      logger.error({ err: error, payload }, "Document ingestion failed.");
      throw error;
    }
  }
}

if (require.main === module) {
  const worker = new IngestWorker();
  void consumeIngestMessages(async (message, ch) => {
    const parsed = JSON.parse(message.content.toString()) as DocumentIngestRequestedPayload;
    const headers = message.properties.headers ?? {};
    const retryCount = Number(headers.retryCount ?? 0);
    try {
      await worker.processDocumentIngestRequested(parsed);
      ch.ack(message);
    } catch (error) {
      if (retryCount >= env.RABBITMQ_MAX_RETRIES) {
        logger.error(
          { err: error, message: parsed, retryCount },
          "Document ingestion failed permanently; moving to dead-letter queue.",
        );
        ch.nack(message, false, false);
        return;
      }
      const nextRetryCount = retryCount + 1;
      const backoffMs = Math.min(30000, 1000 * 2 ** retryCount);
      logger.warn(
        { err: error, message: parsed, retryCount, backoffMs },
        "Document ingestion failed; scheduling retry.",
      );
      setTimeout(() => {
        void publishIngestMessage(parsed, {
          messageId: `${parsed.documentId}:retry:${nextRetryCount}`,
          timestamp: Date.now(),
          headers: {
            retryCount: nextRetryCount,
          },
        });
      }, backoffMs);
      ch.ack(message);
    }
  })
    .then(() => {
      logger.info("Ingest worker consuming RabbitMQ queue.");
    })
    .catch((error) => {
      logger.fatal({ err: error }, "Failed to start ingest worker.");
      process.exit(1);
    });
}
