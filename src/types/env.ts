export interface EnvironmentVariables {
  PORT: number;
  DATABASE_URL: string;
  NODE_ENV: "development" | "test" | "production";
  JWT_ACCESS_SECRET: string;
  JWT_ACCESS_EXPIRES_IN: string;
  B2_KEY_ID: string;
  B2_APPLICATION_KEY: string;
  B2_BUCKET_NAME: string;
  B2_ENDPOINT: string;
  B2_REGION?: string;
  B2_S3_REGION: string;
  OLLAMA_BASE_URL: string;
  OLLAMA_CHAT_MODEL: string;
  OLLAMA_EMBED_MODEL: string;
  RABBITMQ_URL: string;
  RABBITMQ_INGEST_QUEUE: string;
  RABBITMQ_INGEST_DLQ: string;
  RABBITMQ_PREFETCH_COUNT: number;
  RABBITMQ_MAX_RETRIES: number;
  RAG_CHUNK_SIZE: number;
  RAG_CHUNK_OVERLAP: number;
  RAG_DEFAULT_TOP_K: number;
}
