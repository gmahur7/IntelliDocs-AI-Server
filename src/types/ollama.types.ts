export interface OllamaChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface OllamaChatOptions {
  num_ctx?: number;
  num_predict?: number;
  temperature?: number;
  top_p?: number;
}

export interface OllamaChatRequest {
  model: string;
  messages: OllamaChatMessage[];
  stream: boolean;
  keep_alive?: string;
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
  keep_alive?: string;
}

export interface OllamaEmbedResponse {
  model: string;
  embeddings: number[][];
}
