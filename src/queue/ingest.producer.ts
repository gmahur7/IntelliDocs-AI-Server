import { logger } from "@config/logger";
import { publishIngestMessage } from "./rabbitmq.client";

export type DocumentIngestRequestedPayload = {
  documentId: string;
  userId: string;
  fileKey: string;
  ingestionVersion?: number;
};

export class IngestProducer {
  async enqueueDocumentIngestRequested(payload: DocumentIngestRequestedPayload): Promise<void> {
    const message = {
      type: "DOCUMENT_INGEST_REQUESTED",
      documentId: payload.documentId,
      userId: payload.userId,
      fileKey: payload.fileKey,
      ingestionVersion: payload.ingestionVersion ?? 1,
      requestedAt: new Date().toISOString(),
    };
    await publishIngestMessage(message, {
      messageId: `${payload.documentId}:v${payload.ingestionVersion ?? 1}`,
      timestamp: Date.now(),
      headers: {
        retryCount: 0,
      },
    });
    logger.info({ message }, "Queued document ingestion request.");
  }
}
