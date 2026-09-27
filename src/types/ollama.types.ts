export interface OllamaChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface OllamaChatOptions {
  num_ctx?: number;
  temperature?: number;
  top_p?: number;
}

export interface OllamaChatRequest {
  model: string;
  messages: OllamaChatMessage[];
  stream: boolean;
  options?: OllamaChatOptions;
}

export interface OllamaChatResponse {
  model: string;
  message: OllamaChatMessage;
  done: boolean;
}

export interface OllamaChatStreamChunk {
  model: string;
  message?: OllamaChatMessage;
  done: boolean;
  done_reason?: string;
}

export interface OllamaEmbedRequest {
  model: string;
  input: string | string[];
}

export interface OllamaEmbedResponse {
  model: string;
  embeddings: number[][];
}
