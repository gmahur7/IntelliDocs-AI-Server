import type { Request, Response } from "express";
import type { Role } from "@prisma/client";

import { HTTP_STATUS } from "@constants/http-status";
import { UserService } from "@services/user.service";
import { sendSuccess } from "@utils/api-response";
import { asyncHandler } from "@utils/async-handler";

const userService = new UserService();

export const createUser = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const user = await userService.createUser(
    req.body as { firstName: string; lastName: string; email: string; role?: Role },
  );
  sendSuccess(res, HTTP_STATUS.CREATED, user);
});

export const getUsers = asyncHandler(async (_req: Request, res: Response): Promise<void> => {
  const users = await userService.getUsers();
  sendSuccess(res, HTTP_STATUS.OK, users);
});

export const getUserById = asyncHandler(
  async (req: Request<{ id: string }>, res: Response): Promise<void> => {
    const user = await userService.getUserById(req.params.id);
    sendSuccess(res, HTTP_STATUS.OK, user);
  },
);

export const updateUser = asyncHandler(
  async (req: Request<{ id: string }>, res: Response): Promise<void> => {
    const user = await userService.updateUser(
      req.params.id,
      req.body as {
        firstName?: string;
        lastName?: string;
        email?: string;
        role?: Role;
      },
    );
    sendSuccess(res, HTTP_STATUS.OK, user);
  },
);

export const deleteUser = asyncHandler(
  async (req: Request<{ id: string }>, res: Response): Promise<void> => {
    await userService.deleteUser(req.params.id);
    res.status(HTTP_STATUS.NO_CONTENT).send();
  },
);
