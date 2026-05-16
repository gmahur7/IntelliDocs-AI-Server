import { z } from "zod";

export const askQuestionSchema = z.object({
  question: z.string().trim().min(1, "question is required").max(2000, "question is too long"),
  documentId: z.string().uuid("documentId must be a valid UUID").optional(),
  topK: z.coerce
    .number()
    .int()
    .min(1, "topK must be at least 1")
    .max(12, "topK must be <= 12")
    .optional(),
});

export const documentIdParamsSchema = z.object({
  id: z.string().uuid("id must be a valid UUID"),
});
