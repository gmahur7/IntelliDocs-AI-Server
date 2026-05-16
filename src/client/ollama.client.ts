import axios, { AxiosError, AxiosInstance } from "axios";
import {
  OllamaChatMessage,
  OllamaChatRequest,
  OllamaChatResponse,
  OllamaEmbedRequest,
  OllamaEmbedResponse,
} from "../types/ollama.types";
import { env } from "@config/env";

export class OllamaClient {
  private http: AxiosInstance;
  private chatModel: string;
  private embedModel: string;

  constructor() {
    this.http = axios.create({
      baseURL: env.OLLAMA_BASE_URL,
      headers: {
        "Content-Type": "application/json",
      },
      timeout: 60000,
    });

    this.chatModel = env.OLLAMA_CHAT_MODEL;
    this.embedModel = env.OLLAMA_EMBED_MODEL;
  }

  async chat(messages: OllamaChatMessage[]): Promise<OllamaChatResponse> {
    const requestBody: OllamaChatRequest = {
      model: this.chatModel,
      messages,
      stream: false,
      options: {
        num_ctx: 2048,
      },
    };

    try {
      const response = await this.http.post<OllamaChatResponse>("/api/chat", requestBody);
      return response.data;
    } catch (error) {
      throw new Error(`Ollama chat failed: ${this.extractError(error)}`, { cause: error });
    }
  }

  async embed(input: string | string[]): Promise<OllamaEmbedResponse> {
    const requestBody: OllamaEmbedRequest = {
      model: this.embedModel,
      input,
    };

    try {
      const response = await this.http.post<OllamaEmbedResponse>("/api/embed", requestBody);
      return response.data;
    } catch (error) {
      throw new Error(`Ollama embed failed: ${this.extractError(error)}`, { cause: error });
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.http.get("/api/tags");
      return true;
    } catch {
      return false;
    }
  }

  private extractError(error: unknown): string {
    if (axios.isAxiosError(error)) {
      return (
        (error as AxiosError<{ error: string }>)?.response?.data?.error ||
        (error as Error).message ||
        "Unknown error"
      );
    }
    if (error instanceof Error) {
      return error.message;
    }
    return "Unknown error";
  }
}
