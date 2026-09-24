import { MessageRole, Prisma } from "@prisma/client";
import { env } from "@config/env";
import { HTTP_STATUS } from "@constants/http-status";
import { ConversationRepository } from "@repositories/conversation.repository";
import { TokenizerService } from "@services/tokenizer.service";
import type { ChatTurn, RagCitation } from "../types/rag.types";
import { AppError } from "@utils/app-error";

export class ConversationService {
  constructor(
    private readonly conversationRepository: ConversationRepository = new ConversationRepository(),
    private readonly tokenizerService: TokenizerService = new TokenizerService(),
  ) {}

  async create(userId: string, input: { title?: string; documentId?: string | null }) {
    return this.conversationRepository.create({ userId, ...input });
  }

  async listForUser(userId: string) {
    return this.conversationRepository.findManyByUserId(userId);
  }

  async requireOwned(conversationId: string, userId: string) {
    const conversation = await this.conversationRepository.findByIdAndUserId(
      conversationId,
      userId,
    );
    if (!conversation) {
      throw new AppError("Conversation not found", HTTP_STATUS.NOT_FOUND);
    }
    return conversation;
  }

  async getWithMessages(conversationId: string, userId: string) {
    const conversation = await this.requireOwned(conversationId, userId);
    const messages = await this.conversationRepository.findAllMessages(conversationId);
    return { conversation, messages };
  }

  async delete(conversationId: string, userId: string): Promise<void> {
    const { count } = await this.conversationRepository.deleteByIdAndUserId(conversationId, userId);
    if (count === 0) {
      throw new AppError("Conversation not found", HTTP_STATUS.NOT_FOUND);
    }
  }

  async getHistory(conversationId: string): Promise<ChatTurn[]> {
    if (env.RAG_MAX_HISTORY_MESSAGES === 0) {
      return [];
    }
    const rows = await this.conversationRepository.findRecentMessages(
      conversationId,
      env.RAG_MAX_HISTORY_MESSAGES,
    );

    const budgeted: ChatTurn[] = [];
    let used = 0;
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const row = rows[i];
      const cost = row.tokenCount ?? this.tokenizerService.countTokens(row.content);
      if (used + cost > env.RAG_MAX_HISTORY_TOKENS) {
        break;
      }
      used += cost;
      budgeted.unshift({
        role: row.role === MessageRole.USER ? "user" : "assistant",
        content: row.content,
      });
    }

    if (budgeted.length > 0 && budgeted[0].role === "assistant") {
      budgeted.shift();
    }
    return budgeted;
  }

  async saveTurn(params: {
    conversationId: string;
    userId: string;
    question: string;
    answer: string;
    citations: RagCitation[];
    isFirstTurn: boolean;
  }): Promise<void> {
    await this.conversationRepository.appendTurns({
      conversationId: params.conversationId,
      userMessage: {
        conversationId: params.conversationId,
        userId: params.userId,
        role: MessageRole.USER,
        content: params.question,
        tokenCount: this.tokenizerService.countTokens(params.question),
      },
      assistantMessage: {
        conversationId: params.conversationId,
        userId: params.userId,
        role: MessageRole.ASSISTANT,
        content: params.answer,
        citations: params.citations as unknown as Prisma.InputJsonValue,
        tokenCount: this.tokenizerService.countTokens(params.answer),
      },
      ...(params.isFirstTurn ? { title: params.question.slice(0, 60) } : {}),
    });
  }
}
