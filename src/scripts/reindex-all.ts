// Re-enqueues every READY document for ingestion. Run after any change that makes stored vectors
// stale: embedding prefixes, embedding model, chunker, or normalizer. The ingest worker must be
// running for the documents to reach READY again.
import { DocumentStatus } from "@prisma/client";

import { logger } from "@config/logger";
import { prisma } from "@config/prisma";
import { DocumentService } from "@services/document.service";
import { closeRabbitMq } from "../queue/rabbitmq.client";
import { IngestProducer } from "../queue/ingest.producer";

async function main(): Promise<void> {
  const documentService = new DocumentService();
  const ingestProducer = new IngestProducer();

  const documents = await prisma.document.findMany({
    where: { status: DocumentStatus.READY },
    select: { id: true, userId: true, fileKey: true },
  });
  logger.info({ count: documents.length }, "Reindexing READY documents.");

  for (const document of documents) {
    await documentService.markPending(document.id);
    await ingestProducer.enqueueDocumentIngestRequested({
      documentId: document.id,
      userId: document.userId,
      fileKey: document.fileKey,
      ingestionVersion: 1,
    });
  }

  await closeRabbitMq();
  await prisma.$disconnect();
  logger.info({ count: documents.length }, "Reindex requests queued.");
}

main().catch(async (error: unknown) => {
  logger.error({ err: error }, "Reindex failed.");
  await prisma.$disconnect();
  process.exit(1);
});
