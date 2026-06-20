import cors from "cors";
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";

import { env } from "@config/env";
import { requestLogger } from "@middlewares/request-logger";
import { errorHandler } from "@middlewares/error-handler";
import { notFoundMiddleware } from "@middlewares/not-found";
import { router } from "@routes/index";

const app = express();

app.use(helmet());
app.use(
  cors({
    origin: true,
    credentials: true,
  }),
);
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: env.NODE_ENV === "production" ? 100 : 1000,
    standardHeaders: true,
    legacyHeaders: false,
  }),
);
app.use(requestLogger);
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

app.use("/api/v1/", router);

app.use(notFoundMiddleware);
app.use(errorHandler);

export { app };
