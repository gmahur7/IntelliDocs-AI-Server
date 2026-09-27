export type RagCitation = {
  chunkId: string;
  documentId: string;
  pageStart: number | null;
  pageEnd: number | null;
  score: number;
};

export type AskQuestionResponse = {
  answer: string;
  citations: RagCitation[];
  conversationId: string;
};

// Per-stage timings and sizes for one request, logged so latency can be attributed to a stage.
export type RagTrace = {
  condensed: boolean;
  condenseMs: number;
  retrievalMs: number;
  historyMessages: number;
  sources: number;
  promptTokens: number;
};

export type RagStreamResult = {
  citations: RagCitation[];
  tokens: AsyncIterable<string>;
  conversationId: string;
  trace: RagTrace;
  onComplete: (answer: string) => Promise<void>;
  // Call when the stream fails before onComplete; discards a conversation created for this turn.
  onAbort: () => Promise<void>;
};

export type ChatTurn = {
  role: "user" | "assistant";
  content: string;
};

export type ConversationSummary = {
  id: string;
  title: string | null;
  documentId: string | null;
  createdAt: Date;
  updatedAt: Date;
};
