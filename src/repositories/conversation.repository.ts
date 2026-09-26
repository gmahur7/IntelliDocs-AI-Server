import { prisma } from "@config/prisma";

import type { MessageCreateFields } from "../types/message.types";

export class ConversationRepository {
  async create(data: { userId: string; title?: string; documentId?: string | null }) {
    return prisma.conversation.create({ data });
  }

  async findByIdAndUserId(id: string, userId: string) {
    return prisma.conversation.findFirst({ where: { id, userId } });
  }

  async findManyByUserId(userId: string) {
    return prisma.conversation.findMany({
      where: { userId },
      orderBy: { updatedAt: "desc" },
    });
  }

  async deleteByIdAndUserId(id: string, userId: string) {
    return prisma.conversation.deleteMany({ where: { id, userId } });
  }

  async deleteIfEmpty(id: string, userId: string) {
    return prisma.conversation.deleteMany({ where: { id, userId, messages: { none: {} } } });
  }

  // Both messages of a turn are written in one transaction and can share a createdAt
  // (millisecond precision), so role breaks the tie: the enum declares USER before ASSISTANT.
  async findRecentMessages(conversationId: string, limit: number) {
    const rows = await prisma.message.findMany({
      where: { conversationId },
      orderBy: [{ createdAt: "desc" }, { role: "desc" }],
      take: limit,
    });
    return rows.reverse();
  }

  async findAllMessages(conversationId: string) {
    return prisma.message.findMany({
      where: { conversationId },
      orderBy: [{ createdAt: "asc" }, { role: "asc" }],
    });
  }

  async appendTurns(params: {
    conversationId: string;
    userMessage: MessageCreateFields;
    assistantMessage: MessageCreateFields;
    title?: string;
  }) {
    return prisma.$transaction([
      prisma.message.create({ data: params.userMessage }),
      prisma.message.create({ data: params.assistantMessage }),
      prisma.conversation.update({
        where: { id: params.conversationId },
        data: {
          updatedAt: new Date(),
          ...(params.title !== undefined ? { title: params.title } : {}),
        },
      }),
    ]);
  }
}
