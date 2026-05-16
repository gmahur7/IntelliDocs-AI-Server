export type RagCitation = {
  chunkId: string;
  documentId: string;
  score: number;
};

export type AskQuestionResponse = {
  answer: string;
  citations: RagCitation[];
};
