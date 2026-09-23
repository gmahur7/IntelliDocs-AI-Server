import path from "path";

import multer from "multer";

import { HTTP_STATUS } from "@constants/http-status";
import { AppError } from "@utils/app-error";

const maxBytes = 10 * 1024 * 1024;
const mimeByExtension: Record<string, string> = {
  ".pdf": "application/pdf",
  ".txt": "text/plain",
};

const genericMime = new Set(["", "application/octet-stream", "binary/octet-stream"]);

const storage = multer.memoryStorage();

export const uploadPdfOrTxt = multer({
  storage,
  limits: { fileSize: maxBytes },
  fileFilter(_req, file, cb): void {
    const ext = path.extname(file.originalname).toLowerCase();
    const expectedMime = mimeByExtension[ext];
    if (!expectedMime) {
      cb(new AppError("Only .pdf and .txt files are allowed.", HTTP_STATUS.BAD_REQUEST));
      return;
    }
    const declaredMime = (file.mimetype ?? "").split(";")[0].trim().toLowerCase();
    if (declaredMime !== expectedMime && !genericMime.has(declaredMime)) {
      cb(
        new AppError(
          "Invalid file type. Upload a PDF (application/pdf) or plain text (text/plain).",
          HTTP_STATUS.BAD_REQUEST,
        ),
      );
      return;
    }
    file.mimetype = expectedMime;
    cb(null, true);
  },
});
