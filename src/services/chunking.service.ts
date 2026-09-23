import { env } from "@config/env";
import type { ParsedPage } from "@services/file-parser.service";

export type PageChunk = {
  text: string;
  pageStart: number;
  pageEnd: number;
};

const PAGE_SEPARATOR = "\n\n";

type Window = {
  start: number;
  end: number;
};

type PageRange = {
  pageNumber: number;
  start: number;
  end: number;
};

export class ChunkingService {
  chunkText(text: string, size = env.RAG_CHUNK_SIZE, overlap = env.RAG_CHUNK_OVERLAP): string[] {
    const chunks: string[] = [];
    for (const window of this.slidingWindows(text, size, overlap)) {
      const chunk = text.slice(window.start, window.end).trim();
      if (chunk.length > 0) {
        chunks.push(chunk);
      }
    }
    return chunks;
  }

  /**
   * Chunks pages as one continuous document so overlap still spans page breaks,
   * then maps each chunk back to the page range it was drawn from.
   */
  chunkPages(
    pages: ParsedPage[],
    size = env.RAG_CHUNK_SIZE,
    overlap = env.RAG_CHUNK_OVERLAP,
  ): PageChunk[] {
    const ranges: PageRange[] = [];
    let text = "";
    for (const page of pages) {
      if (page.text.length === 0) {
        continue;
      }
      if (text.length > 0) {
        text += PAGE_SEPARATOR;
      }
      const start = text.length;
      text += page.text;
      ranges.push({ pageNumber: page.pageNumber, start, end: text.length });
    }
    if (ranges.length === 0) {
      return [];
    }

    const chunks: PageChunk[] = [];
    for (const window of this.slidingWindows(text, size, overlap)) {
      const raw = text.slice(window.start, window.end);
      const chunk = raw.trim();
      if (chunk.length === 0) {
        continue;
      }
      // Re-anchor to the trimmed text so whitespace at a page break cannot
      // attribute a chunk to a page none of its content came from.
      const start = window.start + (raw.length - raw.trimStart().length);
      const end = window.end - (raw.length - raw.trimEnd().length);
      const covered = ranges.filter((range) => range.start < end && range.end > start);
      const spanned = covered.length > 0 ? covered : [ranges[ranges.length - 1]];
      chunks.push({
        text: chunk,
        pageStart: spanned[0].pageNumber,
        pageEnd: spanned[spanned.length - 1].pageNumber,
      });
    }
    return chunks;
  }

  private *slidingWindows(text: string, size: number, overlap: number): Generator<Window> {
    if (size <= 0) {
      throw new Error("Chunk size must be positive.");
    }
    if (overlap < 0 || overlap >= size) {
      throw new Error("Chunk overlap must be >= 0 and < size.");
    }
    let start = 0;
    while (start < text.length) {
      const end = Math.min(text.length, start + size);
      yield { start, end };
      if (end === text.length) {
        break;
      }
      start = Math.max(0, end - overlap);
    }
  }
}
