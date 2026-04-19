import { z } from "zod";

export const fileKeyQuerySchema = z.object({
  key: z.string().trim().min(1, "key is required"),
});

export const filePresignQuerySchema = z.object({
  extension: z.enum([".pdf", ".txt"], {
    message: "extension must be .pdf or .txt",
  }),
});
