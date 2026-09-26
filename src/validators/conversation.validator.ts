import { z } from "zod";

export const createConversationSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  documentId: z.string().uuid("documentId must be a valid UUID").optional(),
});

export const conversationIdParamsSchema = z.object({
  id: z.string().uuid("id must be a valid UUID"),
});
