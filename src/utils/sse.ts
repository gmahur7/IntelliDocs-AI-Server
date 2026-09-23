import type { Response } from "express";

import { HTTP_STATUS } from "@constants/http-status";

export function initSse(res: Response): void {
  res.status(HTTP_STATUS.OK);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
}

export function sendSseEvent<T>(res: Response, event: string, data: T): void {
  if (res.writableEnded) {
    return;
  }
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
