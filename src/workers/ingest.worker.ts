import { logger } from "@config/logger";
import { DocumentChunkRepository } from "@repositories/document-chunk.repository";
import { DocumentService } from "@services/document.service";
import { EmbeddingService } from "@services/embedding.service";
import { B2Service } from "@services/b2.service";
import { ChunkingService } from "@services/chunking.service";
import { FileParserService } from "@services/file-parser.service";
import { TokenizerService } from "@services/tokenizer.service";
import { env } from "@config/env";
import { consumeIngestMessages, publishIngestMessage } from "../queue/rabbitmq.client";
import { normalizeText } from "@utils/text-normalizer";
import {
  detectScannedPages,
  formatPageList,
  type PageExtractionReport,
} from "@utils/scanned-page-detector";
import { isPermanentIngestError, PermanentIngestError } from "@utils/ingest-error";
import type { DocumentIngestRequestedPayload } from "../queue/ingest.producer";

export class IngestWorker {
  constructor(
    private readonly documentService: DocumentService = new DocumentService(),
    private readonly documentChunkRepository: DocumentChunkRepository = new DocumentChunkRepository(),
    private readonly b2Service: B2Service = new B2Service(),
    private readonly fileParserService: FileParserService = new FileParserService(),
    private readonly chunkingService: ChunkingService = new ChunkingService(),
    private readonly embeddingService: EmbeddingService = new EmbeddingService(),
    private readonly tokenizerService: TokenizerService = new TokenizerService(),
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
      const pages = await this.fileParserService.parseByMime(fileBuffer, document.mimeType);
      const normalizedPages = pages.map((page) => ({
        pageNumber: page.pageNumber,
        text: normalizeText(page.text),
      }));
      const extraction = detectScannedPages(normalizedPages);
      if (extraction.isUnindexable) {
        throw new PermanentIngestError(this.describeUnindexable(document.mimeType, extraction));
      }
      let warning: string | undefined;
      if (extraction.scannedPages.length > 0) {
        warning = `No text layer on page(s) ${formatPageList(extraction.scannedPages)} of ${extraction.totalPages}; answers cannot cite them. Re-upload an OCR'd copy to index those pages.`;
        logger.warn(
          {
            documentId: payload.documentId,
            scannedPages: extraction.scannedPages,
            totalPages: extraction.totalPages,
          },
          "Document has pages with no extractable text; indexing the remainder.",
        );
      }
      const chunks = this.chunkingService.chunkPages(normalizedPages);
      if (chunks.length === 0) {
        throw new PermanentIngestError(
          "Document produced no indexable chunks after parsing. It may be empty or corrupt.",
        );
      }
      const embeddings = await this.embeddingService.embedDocuments(
        chunks.map((chunk) => chunk.text),
      );
      await this.documentChunkRepository.deleteByDocumentId(payload.documentId);
      await this.documentChunkRepository.createMany(
        chunks.map((chunk, index) => ({
          documentId: payload.documentId,
          userId: payload.userId,
          seq: index,
          text: chunk.text,
          tokenCount: this.tokenizerService.countTokens(chunk.text),
          pageStart: chunk.pageStart,
          pageEnd: chunk.pageEnd,
          embedding: embeddings[index],
        })),
      );
      await this.documentService.markReady(payload.documentId, warning);
      logger.info(
        {
          documentId: payload.documentId,
          pageCount: pages.length,
          scannedPageCount: extraction.scannedPages.length,
          chunkCount: chunks.length,
        },
        "Document ingestion completed.",
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown ingestion error";
      await this.documentService.markFailed(payload.documentId, message);
      logger.error({ err: error, payload }, "Document ingestion failed.");
      throw error;
    }
  }

  private describeUnindexable(mimeType: string, extraction: PageExtractionReport): string {
    if (extraction.totalPages === 0) {
      return "Document contains no pages to index.";
    }
    if (mimeType !== "application/pdf") {
      return "Document contains no extractable text to index.";
    }
    if (extraction.textPages.length === 0) {
      return `PDF has no text layer on any of its ${extraction.totalPages} page(s); it looks like a scan or images. Run OCR on it and re-upload.`;
    }
    return `PDF has no text layer on ${extraction.scannedPages.length} of ${extraction.totalPages} page(s) (${formatPageList(extraction.scannedPages)}); too little of it is machine-readable to index. Run OCR on it and re-upload.`;
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
      if (isPermanentIngestError(error)) {
        logger.error(
          { err: error, message: parsed },
          "Document cannot be ingested; moving to dead-letter queue without retrying.",
        );
        ch.nack(message, false, false);
        return;
      }
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
