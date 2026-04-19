import type { NextFunction, Request, Response } from "express";
import { ZodError, type ZodType } from "zod";

import { HTTP_STATUS } from "@constants/http-status";

type RequestSchemas = {
  body?: ZodType;
  params?: ZodType;
  query?: ZodType;
};

type ZodLikeIssue = { path: unknown; message: string };

function zodErrorIssues(error: unknown): ZodLikeIssue[] {
  if (error instanceof ZodError) {
    return error.issues;
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "issues" in error &&
    Array.isArray((error as { issues: unknown }).issues)
  ) {
    return (error as { issues: ZodLikeIssue[] }).issues;
  }
  return [];
}

function mapZodIssues(issues: ZodLikeIssue[]): string[] {
  return issues.map((issue) => {
    const pathStr = Array.isArray(issue.path) ? issue.path.map(String).join(".") : "value";
    const msg = typeof issue.message === "string" ? issue.message : "Invalid input";
    return `${pathStr || "value"}: ${msg}`;
  });
}

function setValidatedQuery(req: Request, value: Request["query"]): void {
  Object.defineProperty(req, "query", {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

export function validateRequest(schemas: RequestSchemas) {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      if (schemas.body) {
        req.body = schemas.body.parse(req.body);
      }
      if (schemas.params) {
        req.params = schemas.params.parse(req.params) as Request["params"];
      }
      if (schemas.query) {
        const parsedQuery = schemas.query.parse(req.query) as Request["query"];
        setValidatedQuery(req, parsedQuery);
      }
      next();
    } catch (error) {
      const issues = zodErrorIssues(error);
      if (issues.length === 0) {
        next(error as Error);
        return;
      }
      const messages = mapZodIssues(issues);
      res.status(HTTP_STATUS.BAD_REQUEST).json({
        message: "Validation failed",
        errors: messages,
      });
    }
  };
}
