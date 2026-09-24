import type { Request, Response } from "express";

import { HTTP_STATUS } from "@constants/http-status";
import { ConversationService } from "@services/conversation.service";
import { AppError } from "@utils/app-error";
import { sendSuccess } from "@utils/api-response";
import { asyncHandler } from "@utils/async-handler";

const conversationService = new ConversationService();

export const createConversation = asyncHandler(
  async (
    req: Request<unknown, unknown, { title?: string; documentId?: string }>,
    res: Response,
  ): Promise<void> => {
    if (!req.user) {
      throw new AppError("Unauthorized", HTTP_STATUS.UNAUTHORIZED);
    }
    const conversation = await conversationService.create(req.user.id, {
      title: req.body.title,
      documentId: req.body.documentId || "",
    });
    sendSuccess(res, HTTP_STATUS.CREATED, conversation);
  },
);

export const listConversations = asyncHandler(
  async (req: Request, res: Response): Promise<void> => {
    if (!req.user) {
      throw new AppError("Unauthorized", HTTP_STATUS.UNAUTHORIZED);
    }
    const conversations = await conversationService.listForUser(req.user.id);
    sendSuccess(res, HTTP_STATUS.OK, conversations);
  },
);

export const getConversation = asyncHandler(
  async (req: Request<{ id: string }>, res: Response): Promise<void> => {
    if (!req.user) {
      throw new AppError("Unauthorized", HTTP_STATUS.UNAUTHORIZED);
    }
    const data = await conversationService.getWithMessages(req.params.id, req.user.id);
    sendSuccess(res, HTTP_STATUS.OK, data);
  },
);

export const deleteConversation = asyncHandler(
  async (req: Request<{ id: string }>, res: Response): Promise<void> => {
    if (!req.user) {
      throw new AppError("Unauthorized", HTTP_STATUS.UNAUTHORIZED);
    }
    await conversationService.delete(req.params.id, req.user.id);
    sendSuccess(res, HTTP_STATUS.OK, { id: req.params.id }, "Conversation deleted");
  },
);
