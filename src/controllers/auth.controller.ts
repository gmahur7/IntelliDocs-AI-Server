import type { Request, Response } from "express";

import { HTTP_STATUS } from "@constants/http-status";
import { AuthService } from "@services/auth.service";
import { sendSuccess } from "@utils/api-response";
import { asyncHandler } from "@utils/async-handler";

const authService = new AuthService();

export const signup = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const result = await authService.signup(
    req.body as { firstName: string; lastName: string; email: string; password: string },
  );
  sendSuccess(res, HTTP_STATUS.CREATED, result);
});

export const signin = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const result = await authService.signin(req.body as { email: string; password: string }, req.ip);
  sendSuccess(res, HTTP_STATUS.OK, result);
});

export const signout = asyncHandler(async (_req: Request, res: Response): Promise<void> => {
  sendSuccess(
    res,
    HTTP_STATUS.OK,
    undefined,
    "Signed out successfully. Discard the token on the client.",
  );
});

export const me = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  sendSuccess(res, HTTP_STATUS.OK, { user: req.user });
});
