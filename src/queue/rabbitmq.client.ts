import amqp, { type Channel, type ChannelModel, type ConsumeMessage, type Options } from "amqplib";

import { env } from "@config/env";
import { logger } from "@config/logger";

const INGEST_EXCHANGE = "doc.ingest.exchange";
const INGEST_ROUTING_KEY = "document.ingest.requested";
const INGEST_DLQ_ROUTING_KEY = "document.ingest.failed";

let connection: ChannelModel | null = null;
let channel: Channel | null = null;

async function getConnection(): Promise<ChannelModel> {
  if (!connection) {
    const conn = await amqp.connect(env.RABBITMQ_URL);
    conn.on("error", (error) => {
      logger.error({ err: error }, "RabbitMQ connection error.");
    });
    conn.on("close", () => {
      logger.warn("RabbitMQ connection closed.");
      connection = null;
      channel = null;
    });
    connection = conn;
  }
  return connection;
}

export async function getChannel(): Promise<Channel> {
  if (!channel) {
    const conn = await getConnection();
    const createdChannel = await conn.createChannel();
    await createdChannel.assertExchange(INGEST_EXCHANGE, "direct", { durable: true });
    await createdChannel.assertQueue(env.RABBITMQ_INGEST_DLQ, { durable: true });
    await createdChannel.bindQueue(
      env.RABBITMQ_INGEST_DLQ,
      INGEST_EXCHANGE,
      INGEST_DLQ_ROUTING_KEY,
    );
    await createdChannel.assertQueue(env.RABBITMQ_INGEST_QUEUE, {
      durable: true,
      deadLetterExchange: INGEST_EXCHANGE,
      deadLetterRoutingKey: INGEST_DLQ_ROUTING_KEY,
    });
    await createdChannel.bindQueue(env.RABBITMQ_INGEST_QUEUE, INGEST_EXCHANGE, INGEST_ROUTING_KEY);
    await createdChannel.prefetch(env.RABBITMQ_PREFETCH_COUNT);
    channel = createdChannel;
  }
  return channel;
}

export async function publishIngestMessage(
  message: object,
  options?: Options.Publish,
): Promise<boolean> {
  const ch = await getChannel();
  const payload = Buffer.from(JSON.stringify(message));
  return ch.publish(INGEST_EXCHANGE, INGEST_ROUTING_KEY, payload, {
    persistent: true,
    contentType: "application/json",
    ...options,
  });
}

export async function consumeIngestMessages(
  onMessage: (message: ConsumeMessage, ch: Channel) => Promise<void>,
): Promise<void> {
  const ch = await getChannel();
  await ch.consume(
    env.RABBITMQ_INGEST_QUEUE,
    (message) => {
      if (!message) {
        return;
      }
      void onMessage(message, ch);
    },
    { noAck: false },
  );
}
