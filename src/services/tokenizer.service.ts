import { encode } from "gpt-tokenizer";

export class TokenizerService {
  countTokens(text: string): number {
    if (!text) {
      return 0;
    }
    return encode(text).length;
  }
}
