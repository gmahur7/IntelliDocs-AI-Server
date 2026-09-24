import { Router } from "express";

import {
  createConversation,
  deleteConversation,
  getConversation,
  listConversations,
} from "@controllers/conversation.controller";
import { requireAuth } from "@middlewares/auth.middleware";
import { validateRequest } from "@middlewares/validate-request";
import {
  conversationIdParamsSchema,
  createConversationSchema,
} from "@validators/conversation.validator";

const conversationRouter = Router();

conversationRouter.post(
  "/",
  requireAuth,
  validateRequest({ body: createConversationSchema }),
  createConversation,
);

conversationRouter.get("/", requireAuth, listConversations);

conversationRouter.get(
  "/:id",
  requireAuth,
  validateRequest({ params: conversationIdParamsSchema }),
  getConversation,
);

conversationRouter.delete(
  "/:id",
  requireAuth,
  validateRequest({ params: conversationIdParamsSchema }),
  deleteConversation,
);

export { conversationRouter };
