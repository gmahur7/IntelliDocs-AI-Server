import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import type { PoolConfig } from "pg";

import { env } from "@config/env";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

function pgSslForAdapter(): PoolConfig["ssl"] | undefined {
  if (env.DATABASE_URL.toLowerCase().includes("sslmode=disable")) {
    return false;
  }
  if (
    env.NODE_ENV === "development" &&
    !env.DATABASE_URL.includes("localhost") &&
    !env.DATABASE_URL.includes("127.0.0.1")
  ) {
    return { rejectUnauthorized: false } as PoolConfig["ssl"];
  }
  return undefined;
}

function createPrismaClient(): PrismaClient {
  return new PrismaClient({
    adapter: new PrismaPg({
      connectionString: env.DATABASE_URL,
      ssl: pgSslForAdapter(),
    }),
    log: env.NODE_ENV === "development" ? ["query", "info", "warn", "error"] : ["warn", "error"],
  });
}

const prismaClient: PrismaClient = globalForPrisma.prisma ?? createPrismaClient();

if (env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prismaClient;
}

export const prisma: PrismaClient = prismaClient;
