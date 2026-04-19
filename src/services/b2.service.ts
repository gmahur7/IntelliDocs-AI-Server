import {
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "crypto";
import path from "path";

import { env } from "@config/env";
import { HTTP_STATUS } from "@constants/http-status";
import type {
  FileMetadataResponse,
  FileUploadResponse,
  PresignedPutUrlResponse,
} from "../types/file.types";
import { AppError } from "@utils/app-error";
import { logger } from "@config/logger";

let s3Client: S3Client | null = null;

function getClient(): S3Client {
  if (!s3Client) {
    logger.info(
      "Initializing S3 client with region: " +
        env.B2_S3_REGION +
        " and endpoint: " +
        env.B2_ENDPOINT,
    );
    s3Client = new S3Client({
      region: env.B2_S3_REGION,
      endpoint: env.B2_ENDPOINT,
      forcePathStyle: true,
      tls: true,
      credentials: {
        accessKeyId: env.B2_KEY_ID,
        secretAccessKey: env.B2_APPLICATION_KEY,
      },
    });
  }
  logger.info(
    "S3 client initialized with region: " + env.B2_S3_REGION + " and endpoint: " + env.B2_ENDPOINT,
  );
  return s3Client;
}

function buildPublicObjectUrl(key: string): string {
  const base = env.B2_ENDPOINT.replace(/\/$/, "");
  return `${base}/${env.B2_BUCKET_NAME}/${encodeURIComponent(key)}`;
}

function extensionToContentType(ext: string): string {
  if (ext === ".pdf") {
    return "application/pdf";
  }
  if (ext === ".txt") {
    return "text/plain";
  }
  throw new AppError("Unsupported file extension.", HTTP_STATUS.BAD_REQUEST);
}

function mapS3Error(error: unknown, fallbackMessage: string): never {
  if (error instanceof S3ServiceException) {
    const httpCode = error.$metadata?.httpStatusCode;
    if (httpCode === 404) {
      throw new AppError("File not found.", HTTP_STATUS.NOT_FOUND);
    }
    const errName = error.name;
    if (
      errName === "InvalidAccessKeyId" ||
      errName === "SignatureDoesNotMatch" ||
      errName === "InvalidToken"
    ) {
      throw new AppError(
        "Backblaze B2 rejected this request (credentials or signing). Set B2_KEY_ID to the application keyID from the console (e.g. 005…), B2_APPLICATION_KEY to the secret shown only when the key was created, and B2_ENDPOINT to the S3 endpoint for that bucket. The AWS SDK region must match the endpoint: copy https://s3.<region>.backblazeb2.com from Bucket Settings, or set B2_REGION to that <region> if your endpoint URL is non-standard.",
        HTTP_STATUS.FORBIDDEN,
      );
    }
    if (httpCode === 403) {
      throw new AppError(
        "Storage access was denied. Check the application key capabilities (e.g. writeFiles, readFiles), bucket name, and B2_ENDPOINT (S3 URL from Bucket Settings; region in the URL must match the bucket).",
        HTTP_STATUS.FORBIDDEN,
      );
    }
  }
  throw new AppError(fallbackMessage, HTTP_STATUS.INTERNAL_SERVER_ERROR);
}

export class B2Service {
  async uploadFile(params: {
    buffer: Buffer;
    originalName: string;
    mimeType: string;
  }): Promise<FileUploadResponse> {
    const ext = path.extname(params.originalName).toLowerCase();
    const key = `${randomUUID()}${ext}`;
    logger.info("Uploading file to storage.: " + params.originalName);
    try {
      await getClient().send(
        new PutObjectCommand({
          Bucket: env.B2_BUCKET_NAME,
          Key: key,
          Body: params.buffer,
          ContentType: params.mimeType,
        }),
      );
      return {
        key,
        url: buildPublicObjectUrl(key),
        contentType: params.mimeType,
        size: params.buffer.length,
      };
    } catch (error) {
      logger.error("Failed to upload file to storage." + JSON.stringify(error, null, 2));
      mapS3Error(error, "Failed to upload file to storage.");
    }
  }

  async getFileMetadata(key: string): Promise<FileMetadataResponse> {
    try {
      const out = await getClient().send(
        new HeadObjectCommand({
          Bucket: env.B2_BUCKET_NAME,
          Key: key,
        }),
      );
      return {
        key,
        contentType: out.ContentType,
        contentLength: out.ContentLength,
        lastModified: out.LastModified?.toISOString(),
        etag: out.ETag,
      };
    } catch (error) {
      mapS3Error(error, "Failed to read file metadata.");
    }
  }

  async deleteFile(key: string): Promise<void> {
    try {
      await getClient().send(
        new DeleteObjectCommand({
          Bucket: env.B2_BUCKET_NAME,
          Key: key,
        }),
      );
    } catch (error) {
      mapS3Error(error, "Failed to delete file from storage.");
    }
  }

  async getPresignedPutUrl(extension: string): Promise<PresignedPutUrlResponse> {
    const ext = extension.toLowerCase();
    const contentType = extensionToContentType(ext);
    const key = `${randomUUID()}${ext}`;
    const command = new PutObjectCommand({
      Bucket: env.B2_BUCKET_NAME,
      Key: key,
      ContentType: contentType,
    });
    const expiresIn = 900;
    try {
      const url = await getSignedUrl(getClient(), command, { expiresIn });
      return {
        url,
        key,
        contentType,
        expiresIn,
        publicUrl: buildPublicObjectUrl(key),
      };
    } catch (error) {
      mapS3Error(error, "Failed to create presigned upload URL.");
    }
  }
}
