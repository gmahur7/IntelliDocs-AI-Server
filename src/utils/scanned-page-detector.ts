import { env } from "@config/env";
import type { ParsedPage } from "@services/file-parser.service";

export type PageExtractionReport = {
  totalPages: number;
  scannedPages: number[];
  textPages: number[];
  scannedRatio: number;
  isUnindexable: boolean;
};

function usableCharCount(text: string): number {
  let count = 0;
  for (const char of text) {
    if (/[\p{L}\p{N}]/u.test(char)) {
      count += 1;
    }
  }
  return count;
}

export function detectScannedPages(
  pages: ParsedPage[],
  minChars = env.RAG_MIN_PAGE_TEXT_CHARS,
  maxScannedRatio = env.RAG_MAX_SCANNED_PAGE_RATIO,
): PageExtractionReport {
  const scannedPages: number[] = [];
  const textPages: number[] = [];
  for (const page of pages) {
    if (usableCharCount(page.text) < minChars) {
      scannedPages.push(page.pageNumber);
    } else {
      textPages.push(page.pageNumber);
    }
  }
  const scannedRatio = pages.length === 0 ? 1 : scannedPages.length / pages.length;
  return {
    totalPages: pages.length,
    scannedPages,
    textPages,
    scannedRatio,
    isUnindexable: textPages.length === 0 || scannedRatio > maxScannedRatio,
  };
}

export function formatPageList(pageNumbers: number[]): string {
  const ranges: string[] = [];
  let index = 0;
  while (index < pageNumbers.length) {
    let end = index;
    while (end + 1 < pageNumbers.length && pageNumbers[end + 1] === pageNumbers[end] + 1) {
      end += 1;
    }
    ranges.push(
      index === end ? `${pageNumbers[index]}` : `${pageNumbers[index]}-${pageNumbers[end]}`,
    );
    index = end + 1;
  }
  return ranges.join(", ");
}
