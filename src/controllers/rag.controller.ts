import type { Request, Response } from "express";

import { HTTP_STATUS } from "@constants/http-status";
import { DocumentChunkRepository } from "@repositories/document-chunk.repository";
import { DocumentService } from "@services/document.service";
import { RagService } from "@services/rag.service";
import { IngestProducer } from "../queue/ingest.producer";
import { AppError } from "@utils/app-error";
import { sendSuccess } from "@utils/api-response";
import { asyncHandler } from "@utils/async-handler";

const ragService = new RagService();
const documentService = new DocumentService();
const documentChunkRepository = new DocumentChunkRepository();
const ingestProducer = new IngestProducer();

export const askQuestion = asyncHandler(
  async (
    req: Request<unknown, unknown, { question: string; documentId?: string; topK?: number }>,
    res: Response,
  ): Promise<void> => {
    if (!req.user) {
      throw new AppError("Unauthorized", HTTP_STATUS.UNAUTHORIZED);
    }
    const data = await ragService.ask({
      userId: req.user.id,
      question: req.body.question,
      documentId: req.body.documentId,
      topK: req.body.topK,
    });
    sendSuccess(res, HTTP_STATUS.OK, data);
  },
);

export const getUserDocuments = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  if (!req.user) {
    throw new AppError("Unauthorized", HTTP_STATUS.UNAUTHORIZED);
  }
  const documents = await documentService.getByUserId(req.user.id);
  sendSuccess(res, HTTP_STATUS.OK, documents);
});

export const getDocumentById = asyncHandler(
  async (req: Request<{ id: string }>, res: Response): Promise<void> => {
    if (!req.user) {
      throw new AppError("Unauthorized", HTTP_STATUS.UNAUTHORIZED);
    }
    const document = await documentService.getByIdAndUserId(req.params.id, req.user.id);
    if (!document) {
      throw new AppError("Document not found", HTTP_STATUS.NOT_FOUND);
    }
    sendSuccess(res, HTTP_STATUS.OK, document);
  },
);

export const getDocumentChunks = asyncHandler(
  async (req: Request<{ id: string }>, res: Response): Promise<void> => {
    if (!req.user) {
      throw new AppError("Unauthorized", HTTP_STATUS.UNAUTHORIZED);
    }
    const document = await documentService.getByIdAndUserId(req.params.id, req.user.id);
    if (!document) {
      throw new AppError("Document not found", HTTP_STATUS.NOT_FOUND);
    }
    const chunks = await documentChunkRepository.findByDocumentIdAndUserId(
      req.params.id,
      req.user.id,
    );
    sendSuccess(res, HTTP_STATUS.OK, {
      documentId: req.params.id,
      count: chunks.length,
      chunks,
    });
  },
);

export const reindexDocument = asyncHandler(
  async (req: Request<{ id: string }>, res: Response): Promise<void> => {
    if (!req.user) {
      throw new AppError("Unauthorized", HTTP_STATUS.UNAUTHORIZED);
    }
    const document = await documentService.getByIdAndUserId(req.params.id, req.user.id);
    if (!document) {
      throw new AppError("Document not found", HTTP_STATUS.NOT_FOUND);
    }
    await documentService.markPending(document.id);
    await ingestProducer.enqueueDocumentIngestRequested({
      documentId: document.id,
      userId: req.user.id,
      fileKey: document.fileKey,
      ingestionVersion: 1,
    });
    sendSuccess(res, HTTP_STATUS.OK, { documentId: document.id }, "Reindex queued");
  },
);
