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
};

export type RagStreamResult = {
  citations: RagCitation[];
  tokens: AsyncIterable<string>;
};
