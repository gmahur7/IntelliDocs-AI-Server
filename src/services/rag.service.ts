import { logger } from "@config/logger";
import { HTTP_STATUS } from "@constants/http-status";
import { RetrievalService } from "@services/retrieval.service";
import { OllamaService } from "@services/ollama.service";
import type { OllamaChatMessage } from "../types/ollama.types";
import type {
  AskQuestionResponse,
  ChatTurn,
  RagCitation,
  RagStreamResult,
} from "../types/rag.types";
import { AppError } from "@utils/app-error";
import { ConversationService } from "./conversation.service";
import { CondenseService } from "./condense.service";

type AskInput = {
  userId: string;
  question: string;
  documentId?: string;
  topK?: number;
  conversationId?: string;
};

type ResolvedConversation = {
  conversationId: string;
  // True when this request created the conversation, so a failed turn can discard it again.
  created: boolean;
};

function formatPageLabel(pageStart: number | null, pageEnd: number | null): string {
  if (pageStart === null) {
    return "";
  }
  if (pageEnd === null || pageEnd === pageStart) {
    return ` p.${pageStart}`;
  }
  return ` p.${pageStart}-${pageEnd}`;
}

const SYSTEM_PROMPT = [
  "You are IntelliDocs, a friendly and precise assistant that answers questions about the user's uploaded documents.",
  "",
  "GROUNDING RULES (non-negotiable):",
  "- Answer ONLY from the provided context. Do not use outside knowledge and do not hallucinate.",
  "- Cite the page number from the context block you used, e.g. (p.4), right after the claim it supports.",
  '- If the context does not contain the answer, reply exactly: "I could not find this in your uploaded documents." and nothing else.',
  "",
  "FORMATTING RULES (make the answer creative, scannable, and good-looking using Markdown):",
  "- Start with a short bold headline that summarizes the answer, prefixed with a fitting emoji (e.g. 📌, ✅, 💡, 📊, ⚠️).",
  "- Use bullet points (•) or numbered lists for multiple facts, steps, or options; use **bold** for key terms, names, dates, and figures.",
  "- Use a small Markdown table when comparing items or listing structured data.",
  "- Use emojis sparingly as visual markers (e.g. ✅ yes / ❌ no / ⚠️ caveat / 🔍 detail / 📄 source), never more than one per line.",
  "- Keep sentences short. Prefer whitespace and sections over long paragraphs.",
  "- End with a one-line '📄 Sources:' footer listing the cited pages, e.g. '📄 Sources: p.2, p.5'.",
  "- Never add decoration that is not backed by the context; style must never change the facts.",
].join("\n");

function buildPrompt(question: string, contextBlocks: string): string {
  return [
    "You are a grounded assistant for IntelliDocs.",
    "Answer using ONLY the context.",
    "Cite the page number shown on each context block when you use it, e.g. (p.4).",
    "If the context does not contain the answer, reply exactly:",
    '"I could not find this in your uploaded documents."',
    "",
    `Question: ${question}`,
    "",
    "Context:",
    contextBlocks,
  ].join("\n");
}

export class RagService {
  constructor(
    private readonly retrievalService: RetrievalService = new RetrievalService(),
    private readonly ollamaService: OllamaService = new OllamaService(),
    private readonly conversationService: ConversationService = new ConversationService(),
    private readonly condenseService: CondenseService = new CondenseService(),
  ) {}

  async ask(input: AskInput): Promise<AskQuestionResponse> {
    const { messages, citations, needsTitle, documentId } = await this.prepare(input);
    const { conversationId, created } = await this.resolveConversation(input, documentId);
    try {
      const answer = await this.ollamaService.chat(messages);
      await this.conversationService.saveTurn({
        conversationId,
        userId: input.userId,
        question: input.question,
        answer,
        citations,
        needsTitle,
      });
      return { answer, citations, conversationId };
    } catch (error) {
      await this.discardIfCreated(conversationId, input.userId, created);
      throw error;
    }
  }

  async askStream(input: AskInput): Promise<RagStreamResult> {
    const { messages, citations, needsTitle, documentId } = await this.prepare(input);
    const { conversationId, created } = await this.resolveConversation(input, documentId);
    return {
      citations,
      conversationId,
      tokens: this.ollamaService.chatStream(messages),
      onComplete: async (answer: string) => {
        await this.conversationService.saveTurn({
          conversationId,
          userId: input.userId,
          question: input.question,
          answer,
          citations,
          needsTitle,
        });
      },
      onAbort: async () => {
        await this.discardIfCreated(conversationId, input.userId, created);
      },
    };
  }

  private async resolveConversation(
    input: AskInput,
    documentId?: string,
  ): Promise<ResolvedConversation> {
    if (input.conversationId) {
      return { conversationId: input.conversationId, created: false };
    }
    const conversation = await this.conversationService.create(input.userId, {
      documentId: documentId ?? null,
    });
    return { conversationId: conversation.id, created: true };
  }

  // Cleanup must never mask the error that triggered it, so failures are logged, not thrown.
  private async discardIfCreated(
    conversationId: string,
    userId: string,
    created: boolean,
  ): Promise<void> {
    if (!created) {
      return;
    }
    try {
      await this.conversationService.deleteIfEmpty(conversationId, userId);
    } catch (error) {
      logger.error({ err: error, conversationId }, "Failed to discard empty conversation");
    }
  }

  private async prepare(input: AskInput): Promise<{
    messages: OllamaChatMessage[];
    citations: RagCitation[];
    history: ChatTurn[];
    needsTitle: boolean;
    documentId?: string;
  }> {
    let history: ChatTurn[] = [];
    let needsTitle = true;
    let documentId = input.documentId;

    if (input.conversationId) {
      const conversation = await this.conversationService.requireOwned(
        input.conversationId,
        input.userId,
      );
      history = await this.conversationService.getHistory(input.conversationId);
      needsTitle = conversation.title === null;
      documentId = input.documentId ?? conversation.documentId ?? undefined;
    }

    const searchQuery = await this.condenseService.condense(history, input.question);

    const retrieved = await this.retrievalService.retrieveTopK({
      userId: input.userId,
      query: searchQuery,
      topK: input.topK,
      documentId,
    });
    if (retrieved.length === 0) {
      throw new AppError(
        "No indexed content found for this query. Upload and process documents first.",
        HTTP_STATUS.BAD_REQUEST,
      );
    }
    const contextBlocks = retrieved
      .map(
        (chunk, index) =>
          `[chunk_${index + 1}] (${chunk.documentId}/${chunk.id}${formatPageLabel(chunk.pageStart, chunk.pageEnd)}) ${chunk.text}`,
      )
      .join("\n\n");
    const prompt = buildPrompt(input.question, contextBlocks);
    return {
      messages: [
        {
          role: "system",
          content: SYSTEM_PROMPT,
        },
        ...history.map((turn) => ({ role: turn.role, content: turn.content })),
        {
          role: "user",
          content: prompt,
        },
      ],
      citations: retrieved.map((chunk) => ({
        chunkId: chunk.id,
        documentId: chunk.documentId,
        pageStart: chunk.pageStart,
        pageEnd: chunk.pageEnd,
        score: chunk.score,
      })),
      history,
      needsTitle,
      documentId,
    };
  }
}
