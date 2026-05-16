import { HTTP_STATUS } from "@constants/http-status";
import { RetrievalService } from "@services/retrieval.service";
import { OllamaService } from "@services/ollama.service";
import type { AskQuestionResponse } from "../types/rag.types";
import { AppError } from "@utils/app-error";

type AskInput = {
  userId: string;
  question: string;
  documentId?: string;
  topK?: number;
};

function buildPrompt(question: string, contextBlocks: string): string {
  return [
    "You are a grounded assistant for IntelliDocs.",
    "Answer using ONLY the context.",
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
      .map((chunk, index) => `[chunk_${index + 1}] (${chunk.documentId}/${chunk.id}) ${chunk.text}`)
      .join("\n\n");
    const prompt = buildPrompt(input.question, contextBlocks);
    const answer = await this.ollamaService.chat([
      {
        role: "system",
        content:
          "You must answer only from the provided context. Do not use outside knowledge and do not hallucinate.",
      },
      {
        role: "user",
        content: prompt,
      },
    ]);
    return {
      answer,
      citations: retrieved.map((chunk) => ({
        chunkId: chunk.id,
        documentId: chunk.documentId,
        score: chunk.score,
      })),
    };
  }
}
