import { prisma } from "@config/prisma";
import { checkRabbitMqHealth } from "../queue/rabbitmq.client";
import { OllamaService } from "@services/ollama.service";

export type DependencyStatus = "up" | "down";

export interface ReadinessReport {
  status: "ok" | "degraded";
  dependencies: {
    postgres: DependencyStatus;
    rabbitmq: DependencyStatus;
    ollama: DependencyStatus;
  };
}

const HEALTH_CHECK_TIMEOUT_MS = 3000;

/**
 * Resolves a probe to `false` if it rejects or exceeds the timeout, so a single
 * hung dependency can never stall the readiness endpoint.
 */
async function withTimeout(probe: Promise<boolean>): Promise<boolean> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), HEALTH_CHECK_TIMEOUT_MS);
  });
  try {
    return await Promise.race([probe.catch(() => false), timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

export class HealthService {
  constructor(private readonly ollamaService: OllamaService = new OllamaService()) {}

  private async checkPostgres(): Promise<boolean> {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  }

  async checkReadiness(): Promise<ReadinessReport> {
    const [postgres, rabbitmq, ollama] = await Promise.all([
      withTimeout(this.checkPostgres()),
      withTimeout(checkRabbitMqHealth()),
      withTimeout(this.ollamaService.isHealthy()),
    ]);

    const dependencies = {
      postgres: postgres ? "up" : "down",
      rabbitmq: rabbitmq ? "up" : "down",
      ollama: ollama ? "up" : "down",
    } as const;

    const allUp = postgres && rabbitmq && ollama;
    return {
      status: allUp ? "ok" : "degraded",
      dependencies,
    };
  }
}
