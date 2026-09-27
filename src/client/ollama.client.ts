import { Readable } from "node:stream";
import axios, { AxiosError, AxiosInstance } from "axios";
import {
  OllamaChatMessage,
  OllamaChatOptions,
  OllamaChatRequest,
  OllamaChatResponse,
  OllamaChatStreamChunk,
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

  // Ollama's default temperature (0.8) makes grounded answers vary between runs; keep it low.
  private chatOptions(): OllamaChatOptions {
    return {
      num_ctx: env.OLLAMA_NUM_CTX,
      temperature: env.OLLAMA_TEMPERATURE,
      top_p: 0.9,
    };
  }

  async chat(messages: OllamaChatMessage[]): Promise<OllamaChatResponse> {
    const requestBody: OllamaChatRequest = {
      model: this.chatModel,
      messages,
      stream: false,
      options: this.chatOptions(),
    };

    try {
      const response = await this.http.post<OllamaChatResponse>("/api/chat", requestBody);
      return response.data;
    } catch (error) {
      throw new Error(`Ollama chat failed: ${this.extractError(error)}`, { cause: error });
    }
  }

  async *chatStream(messages: OllamaChatMessage[]): AsyncGenerator<OllamaChatStreamChunk> {
    const requestBody: OllamaChatRequest = {
      model: this.chatModel,
      messages,
      stream: true,
      options: this.chatOptions(),
    };

    let stream: Readable;
    try {
      // timeout: 0 overrides the instance timeout, which would abort a long generation.
      const response = await this.http.post<Readable>("/api/chat", requestBody, {
        responseType: "stream",
        timeout: 0,
      });
      stream = response.data;
    } catch (error) {
      throw new Error(`Ollama chat stream failed: ${await this.extractStreamError(error)}`, {
        cause: error,
      });
    }

    // Ollama emits NDJSON; a single chunk may split a line, so buffer until a newline.
    let buffer = "";
    for await (const part of stream) {
      buffer += (part as Buffer).toString("utf8");
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) {
          yield JSON.parse(line) as OllamaChatStreamChunk;
        }
        newline = buffer.indexOf("\n");
      }
    }

    const tail = buffer.trim();
    if (tail) {
      yield JSON.parse(tail) as OllamaChatStreamChunk;
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

  // With responseType "stream" an error body arrives as a Readable, not parsed JSON,
  // so it has to be drained before extractError can find the message.
  private async extractStreamError(error: unknown): Promise<string> {
    if (axios.isAxiosError(error) && error.response?.data instanceof Readable) {
      const chunks: Buffer[] = [];
      for await (const chunk of error.response.data) {
        chunks.push(chunk as Buffer);
      }
      const body = Buffer.concat(chunks).toString("utf8");
      try {
        return (JSON.parse(body) as { error?: string }).error ?? body;
      } catch {
        return body || error.message;
      }
    }
    return this.extractError(error);
  }
}
