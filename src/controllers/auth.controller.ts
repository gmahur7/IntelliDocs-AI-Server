import type { CookieOptions, Request, Response } from "express";

import { env } from "@config/env";
import { HTTP_STATUS } from "@constants/http-status";
import { AuthService } from "@services/auth.service";
import { sendSuccess } from "@utils/api-response";
import { asyncHandler } from "@utils/async-handler";

const authService = new AuthService();

const REFRESH_TOKEN_COOKIE = "refreshToken";

const refreshCookieOptions: CookieOptions = {
  httpOnly: true,
  secure: env.NODE_ENV === "production",
  sameSite: "strict",
  path: "/api/v1/auth",
};

function setRefreshTokenCookie(res: Response, token: string, expiresAt: Date): void {
  res.cookie(REFRESH_TOKEN_COOKIE, token, { ...refreshCookieOptions, expires: expiresAt });
}

export const signup = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { refreshToken, refreshTokenExpiresAt, ...result } = await authService.signup(
    req.body as { firstName: string; lastName: string; email: string; password: string },
  );
  setRefreshTokenCookie(res, refreshToken, refreshTokenExpiresAt);
  sendSuccess(res, HTTP_STATUS.CREATED, result);
});

export const signin = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { refreshToken, refreshTokenExpiresAt, ...result } = await authService.signin(
    req.body as { email: string; password: string },
    req.ip,
  );
  setRefreshTokenCookie(res, refreshToken, refreshTokenExpiresAt);
  sendSuccess(res, HTTP_STATUS.OK, result);
});

export const refresh = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const cookies = req.cookies as Record<string, string | undefined>;
  const { refreshToken, refreshTokenExpiresAt, ...result } = await authService.refresh(
    cookies[REFRESH_TOKEN_COOKIE],
  );
  setRefreshTokenCookie(res, refreshToken, refreshTokenExpiresAt);
  sendSuccess(res, HTTP_STATUS.OK, result);
});

export const signout = asyncHandler(async (_req: Request, res: Response): Promise<void> => {
  res.clearCookie(REFRESH_TOKEN_COOKIE, refreshCookieOptions);
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
