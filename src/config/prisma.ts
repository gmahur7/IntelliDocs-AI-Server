import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import type { PoolConfig } from "pg";

import { env } from "@config/env";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter: new PrismaPg({
      connectionString: env.DATABASE_URL,
      ssl:
        env.NODE_ENV === "development" &&
        !env.DATABASE_URL.includes("localhost") &&
        !env.DATABASE_URL.includes("127.0.0.1")
          ? ({ rejectUnauthorized: false } as PoolConfig["ssl"])
          : undefined,
    }),
    log: env.NODE_ENV === "development" ? ["query", "info", "warn", "error"] : ["warn", "error"],
  });

if (env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
