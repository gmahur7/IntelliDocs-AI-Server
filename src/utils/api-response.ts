import type { Response } from "express";

export interface ApiError {
  message: string;
  details?: unknown;
}

export interface ApiResponse<T = unknown> {
  isSuccess: boolean;
  status: number;
  message?: string;
  data?: T;
  error?: ApiError;
}

export function sendSuccess<T>(res: Response, status: number, data?: T, message?: string): void {
  const body: ApiResponse<T> = {
    isSuccess: true,
    status,
    ...(message !== undefined ? { message } : {}),
    ...(data !== undefined ? { data } : {}),
  };
  res.status(status).json(body);
}

export function sendError(res: Response, status: number, message: string, details?: unknown): void {
  const body: ApiResponse<never> = {
    isSuccess: false,
    status,
    error: {
      message,
      ...(details !== undefined ? { details } : {}),
    },
  };
  res.status(status).json(body);
}
