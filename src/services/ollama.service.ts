import { OllamaClient } from "../client/ollama.client";
import { OllamaChatMessage } from "../types/ollama.types";

export class OllamaService {
  private client: OllamaClient;

  constructor() {
    this.client = new OllamaClient();
  }

  async askQuestion(question: string): Promise<string> {
    const messages: OllamaChatMessage[] = [{ role: "user", content: question }];

    const response = await this.client.chat(messages);
    return response.message.content;
  }

  async chat(messages: OllamaChatMessage[]): Promise<string> {
    const response = await this.client.chat(messages);
    return response.message.content;
  }

  async embedText(text: string): Promise<number[]> {
    const response = await this.client.embed(text);
    return response.embeddings[0];
  }

  async embedMany(texts: string[]): Promise<number[][]> {
    const response = await this.client.embed(texts);
    return response.embeddings;
  }

  cosineSimilarity(vecA: number[], vecB: number[]): number {
    const dot = vecA.reduce((sum, a, i) => sum + a * vecB[i], 0);

    const magA = Math.sqrt(vecA.reduce((sum, a) => sum + a * a, 0));
    const magB = Math.sqrt(vecB.reduce((sum, b) => sum + b * b, 0));

    if (magA === 0 || magB === 0) return 0;

    return dot / (magA * magB);
  }

  async findMostSimilar(
    query: string,
    candidates: string[],
  ): Promise<{ text: string; score: number }> {
    const [queryVec, ...candidateVecs] = await Promise.all([
      this.embedText(query),
      ...candidates.map((c) => this.embedText(c)),
    ]);

    const scored = candidates.map((text, i) => ({
      text,
      score: this.cosineSimilarity(queryVec, candidateVecs[i]),
    }));

    return scored.sort((a, b) => b.score - a.score)[0];
  }

  async isHealthy(): Promise<boolean> {
    return this.client.healthCheck();
  }
}
