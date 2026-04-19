import type { NextFunction, Request, Response } from "express";

import { HTTP_STATUS } from "@constants/http-status";
import { AuthService } from "@services/auth.service";
import { AppError } from "@utils/app-error";

const authService = new AuthService();

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    next(new AppError("Authorization token is required", HTTP_STATUS.UNAUTHORIZED));
    return;
  }
  const token = authHeader.slice(7).trim();
  if (!token) {
    next(new AppError("Authorization token is required", HTTP_STATUS.UNAUTHORIZED));
    return;
  }
  const payload = authService.verifyAccessToken(token);
  req.user = {
    id: payload.sub,
    email: payload.email,
    firstName: payload.firstName,
    lastName: payload.lastName,
    role: payload.role,
  };
  next();
}
