import { OllamaService } from "@services/ollama.service";

export class EmbeddingService {
  constructor(private readonly ollamaService: OllamaService = new OllamaService()) {}

  async embedText(text: string): Promise<number[]> {
    return this.ollamaService.embedText(text);
  }

  async embedMany(texts: string[]): Promise<number[][]> {
    return this.ollamaService.embedMany(texts);
  }
}
