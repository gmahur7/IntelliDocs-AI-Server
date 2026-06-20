import type { Request, Response } from "express";

import { HTTP_STATUS } from "@constants/http-status";
import { B2Service } from "@services/b2.service";
import { DocumentService } from "@services/document.service";
import { IngestProducer } from "../queue/ingest.producer";
import { AppError } from "@utils/app-error";
import { sendSuccess } from "@utils/api-response";
import { asyncHandler } from "@utils/async-handler";

const b2Service = new B2Service();
const documentService = new DocumentService();
const ingestProducer = new IngestProducer();

export const uploadFile = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  if (!req.user) {
    throw new AppError("Unauthorized", HTTP_STATUS.UNAUTHORIZED);
  }
  const file = req.file;
  if (!file) {
    throw new AppError(
      'No file uploaded. Send multipart/form-data with field "file".',
      HTTP_STATUS.BAD_REQUEST,
    );
  }
  const result = await b2Service.uploadFile({
    buffer: file.buffer,
    originalName: "intellidocs-" + file.originalname,
    mimeType: file.mimetype,
  });
  const document = await documentService.createDocumentFromUpload({
    userId: req.user.id,
    fileKey: result.key,
    fileUrl: result.url,
    mimeType: result.contentType,
  });
  try {
    await ingestProducer.enqueueDocumentIngestRequested({
      documentId: document.id,
      userId: req.user.id,
      fileKey: result.key,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to queue document processing";
    await documentService.markFailed(document.id, message);
    throw new AppError(
      "File uploaded, but ingestion queue is unavailable.",
      HTTP_STATUS.INTERNAL_SERVER_ERROR,
    );
  }
  sendSuccess(res, HTTP_STATUS.CREATED, {
    ...result,
    documentId: document.id,
  });
});

export const getFileMetadata = asyncHandler(
  async (
    req: Request<unknown, unknown, unknown, { key: string }>,
    res: Response,
  ): Promise<void> => {
    const meta = await b2Service.getFileMetadata(req.query.key);
    sendSuccess(res, HTTP_STATUS.OK, meta);
  },
);

export const deleteFile = asyncHandler(
  async (
    req: Request<unknown, unknown, unknown, { key: string }>,
    res: Response,
  ): Promise<void> => {
    await b2Service.deleteFile(req.query.key);
    res.status(HTTP_STATUS.NO_CONTENT).send();
  },
);

export const getPresignedPutUrl = asyncHandler(
  async (
    req: Request<unknown, unknown, unknown, { extension: string }>,
    res: Response,
  ): Promise<void> => {
    const data = await b2Service.getPresignedPutUrl(req.query.extension);
    sendSuccess(res, HTTP_STATUS.OK, data);
  },
);
