import { Router } from "express";

import { HTTP_STATUS } from "@constants/http-status";
import { HealthService } from "@services/health.service";
import { sendSuccess } from "@utils/api-response";
import { asyncHandler } from "@utils/async-handler";

const healthRouter = Router();
const healthService = new HealthService();

// Liveness: is the process up and able to serve requests at all?
healthRouter.get("/", (_req, res) => {
  sendSuccess(res, HTTP_STATUS.OK, { status: "ok" });
});

// Readiness: are all downstream dependencies reachable?
// Returns 200 when everything is up, 503 when any dependency is down so
// orchestrators can pull the instance out of rotation.
healthRouter.get(
  "/ready",
  asyncHandler(async (_req, res) => {
    const report = await healthService.checkReadiness();
    const statusCode = report.status === "ok" ? HTTP_STATUS.OK : HTTP_STATUS.SERVICE_UNAVAILABLE;
    res.status(statusCode).json({
      isSuccess: report.status === "ok",
      status: statusCode,
      data: report,
    });
  }),
);

export { healthRouter };
