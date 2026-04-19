import type { Request, Response } from "express";
import type { Role } from "@prisma/client";

import { HTTP_STATUS } from "@constants/http-status";
import { UserService } from "@services/user.service";
import { asyncHandler } from "@utils/async-handler";

const userService = new UserService();

export const createUser = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const user = await userService.createUser(
    req.body as { firstName: string; lastName: string; email: string; role?: Role },
  );
  res.status(HTTP_STATUS.CREATED).json(user);
});

export const getUsers = asyncHandler(async (_req: Request, res: Response): Promise<void> => {
  const users = await userService.getUsers();
  res.status(HTTP_STATUS.OK).json(users);
});

export const getUserById = asyncHandler(
  async (req: Request<{ id: string }>, res: Response): Promise<void> => {
    const user = await userService.getUserById(req.params.id);
    res.status(HTTP_STATUS.OK).json(user);
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
    res.status(HTTP_STATUS.OK).json(user);
  },
);

export const deleteUser = asyncHandler(
  async (req: Request<{ id: string }>, res: Response): Promise<void> => {
    await userService.deleteUser(req.params.id);
    res.status(HTTP_STATUS.NO_CONTENT).send();
  },
);
