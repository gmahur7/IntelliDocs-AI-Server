import { Router } from "express";

import {
  deleteFile,
  getFileMetadata,
  getPresignedPutUrl,
  uploadFile,
} from "@controllers/file.controller";
import { validateRequest } from "@middlewares/validate-request";
import { uploadPdfOrTxt } from "@middlewares/upload-file.middleware";
import { fileKeyQuerySchema, filePresignQuerySchema } from "@validators/file.validator";

const fileRouter = Router();

fileRouter.post("/upload", uploadPdfOrTxt.single("file"), uploadFile);
fileRouter.get("/presign", validateRequest({ query: filePresignQuerySchema }), getPresignedPutUrl);
fileRouter.get("/", validateRequest({ query: fileKeyQuerySchema }), getFileMetadata);
fileRouter.delete("/", validateRequest({ query: fileKeyQuerySchema }), deleteFile);

export { fileRouter };
