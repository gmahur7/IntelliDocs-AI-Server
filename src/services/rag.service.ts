import { env } from "@config/env";
import { logger } from "@config/logger";
import { HTTP_STATUS } from "@constants/http-status";
import type { RetrievedChunk } from "@repositories/document-chunk.repository";
import { RetrievalService } from "@services/retrieval.service";
import { OllamaService } from "@services/ollama.service";
import { TokenizerService } from "@services/tokenizer.service";
import type { OllamaChatMessage } from "../types/ollama.types";
import type {
  AskQuestionResponse,
  ChatTurn,
  RagCitation,
  RagStreamResult,
  RagTrace,
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

// Kept exact: clients may match on it to render a "not found" state.
export const NOT_FOUND_ANSWER = "I could not find this in your uploaded documents.";

// Rough cost of one "[Source N | Document M | p.4]" label plus its blank-line separator.
const SOURCE_LABEL_TOKENS = 16;

// Sources come before the question so the question is the last thing the model reads. Rule 2
// covers paraphrase, rule 3 exact values, and rule 6 makes the refusal a last resort rather than
// the safest completion.
const SYSTEM_PROMPT = [
  "You are IntelliDocs, an assistant that answers questions using the user's uploaded documents.",
  "",
  "Rules:",
  "1. Base every statement on the SOURCES in the user message. Do not use outside knowledge.",
  '2. The question may use different words than the document (e.g. "how long do I have to get my money back" vs "refund period is 30 days"). Read every source carefully before deciding.',
  "3. Copy numbers, dates, amounts, names and defined terms exactly as they appear.",
  "4. Cite the page after each fact, like (p.4). If the sources come from more than one document, name the document too, like (Document 2, p.4).",
  "5. If the sources contain part of the answer, give that part and say what is missing.",
  `6. Only if the sources contain nothing relevant, reply exactly: ${NOT_FOUND_ANSWER}`,
  "7. Earlier conversation turns are only for understanding what the user refers to; they are not a source of facts.",
  "Answer directly and concisely.",
].join("\n");

function formatPageLabel(pageStart: number | null, pageEnd: number | null): string {
  if (pageStart === null) {
    return "";
  }
  if (pageEnd === null || pageEnd === pageStart) {
    return `p.${pageStart}`;
  }
  return `p.${pageStart}-${pageEnd}`;
}

function buildUserPrompt(question: string, sources: string): string {
  return ["SOURCES:", sources, "", `QUESTION: ${question}`].join("\n");
}

/**
 * The answer model only needs enough history to resolve references, and every prompt token costs
 * time on a CPU host, so it sees the last few messages. The condenser still gets the full history.
 * Keeps the slice starting on a user turn so the roles alternate correctly.
 */
function lastMessages(history: ChatTurn[], limit: number): ChatTurn[] {
  if (limit === 0) {
    return [];
  }
  const tail = history.slice(-limit);
  return tail.length > 0 && tail[0].role === "assistant" ? tail.slice(1) : tail;
}

/**
 * Orders chunks for reading: documents in order of their best-ranked chunk, then by position
 * within each document, so a passage that spans two chunks reads continuously.
 */
function inReadingOrder(chunks: RetrievedChunk[]): RetrievedChunk[] {
  const documentOrder = [...new Set(chunks.map((chunk) => chunk.documentId))];
  return [...chunks].sort((a, b) =>
    a.documentId === b.documentId
      ? a.seq - b.seq
      : documentOrder.indexOf(a.documentId) - documentOrder.indexOf(b.documentId),
  );
}

/** Labels carry no UUIDs (small models copy them into answers); the ids live in `citations`. */
function renderSources(orderedChunks: RetrievedChunk[]): string {
  const documentOrder = [...new Set(orderedChunks.map((chunk) => chunk.documentId))];
  return orderedChunks
    .map((chunk, index) => {
      const parts = [`Source ${index + 1}`];
      if (documentOrder.length > 1) {
        parts.push(`Document ${documentOrder.indexOf(chunk.documentId) + 1}`);
      }
      const page = formatPageLabel(chunk.pageStart, chunk.pageEnd);
      if (page) {
        parts.push(page);
      }
      return `[${parts.join(" | ")}]\n${chunk.text}`;
    })
    .join("\n\n");
}

export class RagService {
  constructor(
    private readonly retrievalService: RetrievalService = new RetrievalService(),
    private readonly ollamaService: OllamaService = new OllamaService(),
    private readonly conversationService: ConversationService = new ConversationService(),
    private readonly condenseService: CondenseService = new CondenseService(),
    private readonly tokenizerService: TokenizerService = new TokenizerService(),
  ) {}

  async ask(input: AskInput): Promise<AskQuestionResponse> {
    const { messages, citations, needsTitle, documentId, trace } = await this.prepare(input);
    const { conversationId, created } = await this.resolveConversation(input, documentId);
    try {
      const chatStartedAt = Date.now();
      const answer = await this.ollamaService.chat(messages);
      logger.info(
        {
          ...trace,
          chatMs: Date.now() - chatStartedAt,
          answerTokens: this.tokenizerService.countTokens(answer),
        },
        "RAG timing",
      );
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
    const { messages, citations, needsTitle, documentId, trace } = await this.prepare(input);
    const { conversationId, created } = await this.resolveConversation(input, documentId);
    return {
      citations,
      conversationId,
      trace,
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

  /**
   * Chunks arrive ranked by relevance. Keeps the best-ranked ones that fit the context window
   * after the system prompt, history, question and answer reserve are accounted for, so Ollama
   * never truncates the prompt silently (it drops from the start, i.e. the system prompt first).
   */
  private selectWithinBudget(chunks: RetrievedChunk[], budgetTokens: number): RetrievedChunk[] {
    const kept: RetrievedChunk[] = [];
    let used = 0;
    for (const chunk of chunks) {
      const cost = this.tokenizerService.countTokens(chunk.text) + SOURCE_LABEL_TOKENS;
      if (used + cost > budgetTokens) {
        break;
      }
      used += cost;
      kept.push(chunk);
    }
    // A budget too small for even the top chunk means num_ctx is misconfigured; answering from
    // one source beats answering from none.
    return kept.length > 0 ? kept : chunks.slice(0, 1);
  }

  private async prepare(input: AskInput): Promise<{
    messages: OllamaChatMessage[];
    citations: RagCitation[];
    needsTitle: boolean;
    documentId?: string;
    trace: RagTrace;
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

    const condenseStartedAt = Date.now();
    const searchQuery = await this.condenseService.condense(history, input.question);
    const condenseMs = Date.now() - condenseStartedAt;

    const retrievalStartedAt = Date.now();
    const retrieved = await this.retrievalService.retrieveTopK({
      userId: input.userId,
      query: searchQuery,
      topK: input.topK,
      documentId,
    });
    const retrievalMs = Date.now() - retrievalStartedAt;
    if (retrieved.length === 0) {
      throw new AppError(
        "No indexed content found for this query. Upload and process documents first.",
        HTTP_STATUS.BAD_REQUEST,
      );
    }

    const answerHistory = lastMessages(history, env.RAG_ANSWER_HISTORY_MESSAGES);
    const fixedTokens =
      this.tokenizerService.countTokens(SYSTEM_PROMPT) +
      this.tokenizerService.countTokens(input.question) +
      answerHistory.reduce(
        (sum, turn) => sum + this.tokenizerService.countTokens(turn.content),
        0,
      ) +
      env.OLLAMA_NUM_PREDICT;
    const selected = inReadingOrder(
      this.selectWithinBudget(retrieved, Math.max(0, env.OLLAMA_NUM_CTX - fixedTokens)),
    );

    const messages: OllamaChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      ...answerHistory.map((turn) => ({ role: turn.role, content: turn.content })),
      { role: "user", content: buildUserPrompt(input.question, renderSources(selected)) },
    ];

    return {
      messages,
      // Same order as the rendered sources, so citations[i] is "Source i+1" in the prompt.
      citations: selected.map((chunk) => ({
        chunkId: chunk.id,
        documentId: chunk.documentId,
        pageStart: chunk.pageStart,
        pageEnd: chunk.pageEnd,
        score: chunk.score,
      })),
      needsTitle,
      documentId,
      trace: {
        condensed: searchQuery !== input.question,
        condenseMs,
        retrievalMs,
        historyMessages: answerHistory.length,
        sources: selected.length,
        promptTokens: messages.reduce(
          (sum, message) => sum + this.tokenizerService.countTokens(message.content),
          0,
        ),
      },
    };
  }
}
