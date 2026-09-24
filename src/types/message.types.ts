import { MessageRole, Prisma } from "@prisma/client";

export type MessageCreateFields = {
  conversationId: string;
  userId: string;
  role: MessageRole;
  content: string;
  citations?: Prisma.InputJsonValue;
  tokenCount: number;
};
