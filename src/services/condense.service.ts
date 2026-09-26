import { logger } from "@config/logger";
import { OllamaService } from "./ollama.service";
import { ChatTurn } from "../types/rag.types";

const CONDENSE_SYSTEM =
  "You rewrite a follow-up question into a standalone question. " +
  "Output ONLY the rewritten question, with no preamble, quotes or explanation.";

function buildCondensePrompt(history: ChatTurn[], question: string): string {
  const transcript = history
    .map((turn) => `${turn.role === "user" ? "USER" : "Assistant"}: ${turn.content}`)
    .join("\n");

  return [
    "Given the conversation below, rewrite the final question so it can be understood on its own,",
    "replacing every pronoun and reference with the thing it refers to.",
    "If the question is already standalone, repeat it unchanged.",
    "",
    "Conversation:",
    transcript,
    "",
    `Final question: ${question}`,
    "",
    "Standalone question:",
  ].join("\n");
}

export class CondenseService {
  constructor(private readonly ollamaService: OllamaService = new OllamaService()) {}

  async condense(history: ChatTurn[], question: string): Promise<string> {
    if (history.length === 0) {
      return question;
    }
    try {
      const rewritten = await this.ollamaService.chat([
        { role: "system", content: CONDENSE_SYSTEM },
        { role: "user", content: buildCondensePrompt(history, question) },
      ]);
      const cleaned = rewritten.trim().replace(/^["']|["']$/g, "");
      if (!cleaned || cleaned.length > question.length + 300) {
        return question;
      }
      return cleaned;
    } catch (error) {
      logger.error(error);
      return question;
    }
  }
}
