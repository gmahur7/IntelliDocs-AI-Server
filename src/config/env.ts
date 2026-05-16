import dotenv from "dotenv";
import { z } from "zod";

import type { EnvironmentVariables } from "../types/env";

dotenv.config();

const trimString = z.preprocess((v) => (typeof v === "string" ? v.trim() : v), z.string());

const trimB2Credential = z.preprocess((v) => {
  if (typeof v !== "string") {
    return v;
  }
  let s = v.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }
  return s;
}, z.string());

const optionalB2Region = z.preprocess((v) => {
  if (typeof v !== "string") {
    return undefined;
  }
  const t = v.trim();
  return t === "" ? undefined : t;
}, z.string().min(1).optional());

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  JWT_ACCESS_SECRET: trimString.pipe(
    z.string().min(32, "JWT_ACCESS_SECRET must be at least 32 chars"),
  ),
  JWT_ACCESS_EXPIRES_IN: trimString.pipe(z.string().min(1, "JWT_ACCESS_EXPIRES_IN is required")),
  B2_KEY_ID: trimB2Credential.pipe(z.string().min(1, "B2_KEY_ID is required")),
  B2_APPLICATION_KEY: trimB2Credential.pipe(z.string().min(1, "B2_APPLICATION_KEY is required")),
  B2_BUCKET_NAME: trimString.pipe(z.string().min(1, "B2_BUCKET_NAME is required")),
  B2_ENDPOINT: trimString.pipe(z.string().url("B2_ENDPOINT must be a valid URL")),
  B2_REGION: optionalB2Region,
  OLLAMA_BASE_URL: trimString
    .pipe(z.string().url("OLLAMA_BASE_URL must be a valid URL"))
    .default("http://localhost:11434"),
  OLLAMA_CHAT_MODEL: trimString
    .pipe(z.string().min(1, "OLLAMA_CHAT_MODEL is required"))
    .default("llama3.2:1b"),
  OLLAMA_EMBED_MODEL: trimString
    .pipe(z.string().min(1, "OLLAMA_EMBED_MODEL is required"))
    .default("nomic-embed-text"),
  RABBITMQ_URL: trimString
    .pipe(z.string().url("RABBITMQ_URL must be a valid URL"))
    .default("amqp://localhost:5672"),
  RABBITMQ_INGEST_QUEUE: trimString
    .pipe(z.string().min(1, "RABBITMQ_INGEST_QUEUE is required"))
    .default("doc.ingest.parse"),
  RABBITMQ_INGEST_DLQ: trimString
    .pipe(z.string().min(1, "RABBITMQ_INGEST_DLQ is required"))
    .default("doc.ingest.deadletter"),
  RABBITMQ_PREFETCH_COUNT: z.coerce.number().int().positive().default(5),
  RABBITMQ_MAX_RETRIES: z.coerce.number().int().nonnegative().default(3),
  RAG_CHUNK_SIZE: z.coerce.number().int().positive().default(900),
  RAG_CHUNK_OVERLAP: z.coerce.number().int().nonnegative().default(150),
  RAG_DEFAULT_TOP_K: z.coerce.number().int().positive().default(5),
});

function b2S3RegionFromEndpoint(endpoint: string): string | null {
  const m = endpoint.match(/s3\.([a-z0-9-]+)\.backblazeb2\.com/i);
  return m?.[1] ?? null;
}

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const errors = parsed.error.issues
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join(", ");
  throw new Error(`Invalid environment variables: ${errors}`);
}

const raw = parsed.data;
const b2S3Region = raw.B2_REGION ?? b2S3RegionFromEndpoint(raw.B2_ENDPOINT);
if (!b2S3Region) {
  throw new Error(
    "Invalid B2 configuration: set B2_ENDPOINT to your bucket’s S3 URL (https://s3.<region>.backblazeb2.com from Bucket Settings), or set B2_REGION to that region (e.g. us-east-005).",
  );
}
if (!/\d/.test(b2S3Region)) {
  throw new Error(
    'B2 S3 region must be the full Backblaze id (e.g. us-east-005), not a short name like us-east. Copy the segment after "s3." from Bucket → Endpoint → S3, or set B2_REGION to that same value.',
  );
}

export const env: EnvironmentVariables = {
  ...raw,
  B2_S3_REGION: b2S3Region,
};
