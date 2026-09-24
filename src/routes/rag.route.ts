import { Router } from "express";

import {
  askQuestion,
  askQuestionStream,
  getDocumentById,
  getDocumentChunks,
  getUserDocuments,
  reindexDocument,
} from "@controllers/rag.controller";
import { requireAuth } from "@middlewares/auth.middleware";
import { validateRequest } from "@middlewares/validate-request";
import { askQuestionSchema, documentIdParamsSchema } from "@validators/rag.validator";

const ragRouter = Router();

ragRouter.post("/ask", requireAuth, validateRequest({ body: askQuestionSchema }), askQuestion);
ragRouter.post(
  "/ask/stream",
  requireAuth,
  validateRequest({ body: askQuestionSchema }),
  askQuestionStream,
);
ragRouter.get("/documents", requireAuth, getUserDocuments);
ragRouter.get(
  "/documents/:id",
  requireAuth,
  validateRequest({ params: documentIdParamsSchema }),
  getDocumentById,
);
ragRouter.get(
  "/files/:id/chunks",
  requireAuth,
  validateRequest({ params: documentIdParamsSchema }),
  getDocumentChunks,
);
ragRouter.post(
  "/documents/:id/reindex",
  requireAuth,
  validateRequest({ params: documentIdParamsSchema }),
  reindexDocument,
);

export { ragRouter };
