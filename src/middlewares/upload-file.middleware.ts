import path from "path";

import multer from "multer";

import { HTTP_STATUS } from "@constants/http-status";
import { AppError } from "@utils/app-error";

const maxBytes = 10 * 1024 * 1024;
const allowedMime = new Set(["application/pdf", "text/plain"]);

const storage = multer.memoryStorage();

export const uploadPdfOrTxt = multer({
  storage,
  limits: { fileSize: maxBytes },
  fileFilter(_req, file, cb): void {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext !== ".pdf" && ext !== ".txt") {
      cb(new AppError("Only .pdf and .txt files are allowed.", HTTP_STATUS.BAD_REQUEST));
      return;
    }
    if (!allowedMime.has(file.mimetype)) {
      cb(
        new AppError(
          "Invalid file type. Upload a PDF (application/pdf) or plain text (text/plain).",
          HTTP_STATUS.BAD_REQUEST,
        ),
      );
      return;
    }
    cb(null, true);
  },
});
