import type { NextFunction, Request, Response } from "express";
import { Prisma } from "@prisma/client";
import multer from "multer";
import { ZodError } from "zod";

import { env } from "@config/env";
import { logger } from "@config/logger";
import { HTTP_STATUS } from "@constants/http-status";
import { AppError } from "@utils/app-error";

export function errorHandler(
  error: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  let statusCode: number = HTTP_STATUS.INTERNAL_SERVER_ERROR;
  let message = "Internal server error";
  let details: unknown;

  if (error instanceof AppError) {
    statusCode = error.statusCode;
    message = error.message;
  } else if (error instanceof multer.MulterError) {
    if (error.code === "LIMIT_FILE_SIZE") {
      statusCode = HTTP_STATUS.PAYLOAD_TOO_LARGE;
      message = "File exceeds the maximum size of 10MB.";
    } else if (error.code === "LIMIT_UNEXPECTED_FILE") {
      statusCode = HTTP_STATUS.BAD_REQUEST;
      message = 'Unexpected file field. Use multipart field name "file".';
    } else {
      statusCode = HTTP_STATUS.BAD_REQUEST;
      message = error.message;
    }
  } else if (error instanceof ZodError) {
    statusCode = HTTP_STATUS.BAD_REQUEST;
    message = "Validation error";
    details = error.issues;
  } else if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2002") {
      statusCode = HTTP_STATUS.CONFLICT;
      message = "Resource already exists";
      details = error.meta;
    }
  }

  logger.error(
    {
      err: error,
      path: req.originalUrl,
      method: req.method,
      statusCode,
    },
    message,
  );

  res.status(statusCode).json({
    message,
    ...(details ? { details } : {}),
    ...(env.NODE_ENV === "development" && error instanceof Error ? { stack: error.stack } : {}),
  });
}
