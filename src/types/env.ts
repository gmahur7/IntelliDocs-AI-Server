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
}
