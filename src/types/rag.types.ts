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

export type RagStreamResult = {
  citations: RagCitation[];
  tokens: AsyncIterable<string>;
  conversationId: string;
  onComplete: (answer: string) => Promise<void>;
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
