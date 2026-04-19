import type { Request, Response } from "express";

import { HTTP_STATUS } from "@constants/http-status";
import { AuthService } from "@services/auth.service";
import { asyncHandler } from "@utils/async-handler";

const authService = new AuthService();

export const signup = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const result = await authService.signup(
    req.body as { firstName: string; lastName: string; email: string; password: string },
  );
  res.status(HTTP_STATUS.CREATED).json(result);
});

export const signin = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const result = await authService.signin(req.body as { email: string; password: string }, req.ip);
  res.status(HTTP_STATUS.OK).json(result);
});

export const signout = asyncHandler(async (_req: Request, res: Response): Promise<void> => {
  res.status(HTTP_STATUS.OK).json({
    message: "Signed out successfully. Discard the token on the client.",
  });
});

export const me = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  res.status(HTTP_STATUS.OK).json({ user: req.user });
});
