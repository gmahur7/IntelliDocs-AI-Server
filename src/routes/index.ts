import { Router } from "express";

import { requireAuth } from "@middlewares/auth.middleware";
import { authRouter } from "@routes/auth.route";
import { fileRouter } from "@routes/file.route";
import { healthRouter } from "@routes/health.route";
import { ragRouter } from "@routes/rag.route";
import { userRouter } from "@routes/user.route";
import { conversationRouter } from "./conversation.route";

const router = Router();

router.use("/health", healthRouter);
router.use("/auth", authRouter);
router.use("/users", userRouter);
router.use("/files", requireAuth, fileRouter);
router.use("/", ragRouter);
router.use("/conversations", conversationRouter);

export { router };
