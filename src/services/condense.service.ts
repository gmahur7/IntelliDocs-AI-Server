import { logger } from "@config/logger";
import { OllamaService } from "./ollama.service";
import { ChatTurn } from "../types/rag.types";

const CONDENSE_SYSTEM =
  "You rewrite a follow-up question into a standalone question. " +
  "Output ONLY the rewritten question, with no preamble, quotes or explanation.";

// Words that point back at something said earlier. A question without any of them is already
// standalone, and rewriting it would only cost a full model call (and risk distorting it).
const REFERENCE_PATTERN =
  /\b(it|its|that|this|these|those|they|them|their|he|she|his|her|him|the same|above|previous|earlier|mentioned|former|latter)\b/i;
// Elliptical openers such as "And the pricing?" or "What about weekends?".
const ELLIPSIS_PATTERN = /^(and|also|or|but|what about|how about)\b/i;
const MIN_STANDALONE_WORDS = 4;

// A rewritten question is short; capping generation keeps a rambling model from burning seconds.
const CONDENSE_OPTIONS = { temperature: 0, num_predict: 64 };

export function needsCondensing(question: string): boolean {
  const trimmed = question.trim();
  return (
    REFERENCE_PATTERN.test(trimmed) ||
    ELLIPSIS_PATTERN.test(trimmed) ||
    trimmed.split(/\s+/).length < MIN_STANDALONE_WORDS
  );
}

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
    if (history.length === 0 || !needsCondensing(question)) {
      return question;
    }
    try {
      const rewritten = await this.ollamaService.chat(
        [
          { role: "system", content: CONDENSE_SYSTEM },
          { role: "user", content: buildCondensePrompt(history, question) },
        ],
        CONDENSE_OPTIONS,
      );
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
