import { Router } from "express";

import { requireAuth } from "@middlewares/auth.middleware";
import { authRouter } from "@routes/auth.route";
import { fileRouter } from "@routes/file.route";
import { healthRouter } from "@routes/health.route";
import { userRouter } from "@routes/user.route";

const router = Router();

router.use("/health", healthRouter);
router.use("/auth", authRouter);
router.use("/users", userRouter);
router.use("/files", requireAuth, fileRouter);

export { router };
