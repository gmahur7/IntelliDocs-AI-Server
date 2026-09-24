import { HTTP_STATUS } from "@constants/http-status";
import { RetrievalService } from "@services/retrieval.service";
import { OllamaService } from "@services/ollama.service";
import type { OllamaChatMessage } from "../types/ollama.types";
import type { AskQuestionResponse, RagCitation, RagStreamResult } from "../types/rag.types";
import { AppError } from "@utils/app-error";

type AskInput = {
  userId: string;
  question: string;
  documentId?: string;
  topK?: number;
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
  ) {}

  async ask(input: AskInput): Promise<AskQuestionResponse> {
    const { messages, citations } = await this.prepare(input);
    const answer = await this.ollamaService.chat(messages);
    return { answer, citations };
  }

  /**
   * Resolves retrieval before returning, so a retrieval failure still surfaces as a normal
   * JSON error envelope — the caller has not written any response bytes yet. Returning an
   * async generator instead would defer that guard until after the SSE headers are flushed.
   */
  async askStream(input: AskInput): Promise<RagStreamResult> {
    const { messages, citations } = await this.prepare(input);
    return { citations, tokens: this.ollamaService.chatStream(messages) };
  }

  private async prepare(
    input: AskInput,
  ): Promise<{ messages: OllamaChatMessage[]; citations: RagCitation[] }> {
    const retrieved = await this.retrievalService.retrieveTopK({
      userId: input.userId,
      query: input.question,
      topK: input.topK,
      documentId: input.documentId,
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
          content:
            "You must answer only from the provided context. Do not use outside knowledge and do not hallucinate.",
        },
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
    };
  }
}
