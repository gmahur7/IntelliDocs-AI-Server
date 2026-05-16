export interface OllamaChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface OllamaChatRequest {
  model: string;
  messages: OllamaChatMessage[];
  stream: boolean;
  options?: {
    num_ctx?: number;
  };
}

export interface OllamaChatResponse {
  model: string;
  message: OllamaChatMessage;
  done: boolean;
}

export interface OllamaEmbedRequest {
  model: string;
  input: string | string[];
}

export interface OllamaEmbedResponse {
  model: string;
  embeddings: number[][];
}
