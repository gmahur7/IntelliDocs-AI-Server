import type { Request, Response } from "express";

import { HTTP_STATUS } from "@constants/http-status";
import { B2Service } from "@services/b2.service";
import type {
  FileMetadataResponse,
  FileUploadResponse,
  PresignedPutUrlResponse,
} from "../types/file.types";
import { AppError } from "@utils/app-error";
import { asyncHandler } from "@utils/async-handler";

const b2Service = new B2Service();

export const uploadFile = asyncHandler(
  async (req: Request, res: Response<FileUploadResponse>): Promise<void> => {
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
    res.status(HTTP_STATUS.CREATED).json(result);
  },
);

export const getFileMetadata = asyncHandler(
  async (
    req: Request<unknown, FileMetadataResponse, unknown, { key: string }>,
    res: Response<FileMetadataResponse>,
  ): Promise<void> => {
    const meta = await b2Service.getFileMetadata(req.query.key);
    res.status(HTTP_STATUS.OK).json(meta);
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
    req: Request<unknown, PresignedPutUrlResponse, unknown, { extension: string }>,
    res: Response<PresignedPutUrlResponse>,
  ): Promise<void> => {
    const data = await b2Service.getPresignedPutUrl(req.query.extension);
    res.status(HTTP_STATUS.OK).json(data);
  },
);
