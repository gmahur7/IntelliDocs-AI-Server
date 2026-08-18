import { PDFParse } from "pdf-parse";

export type ParsedPage = {
  pageNumber: number;
  text: string;
};

export class FileParserService {
  async parseByMime(buffer: Buffer, mimeType: string): Promise<ParsedPage[]> {
    if (mimeType === "application/pdf") {
      const parser = new PDFParse({ data: buffer });
      try {
        const parsed = await parser.getText();
        return parsed.pages.map((page) => ({
          pageNumber: page.num,
          text: page.text ?? "",
        }));
      } finally {
        await parser.destroy();
      }
    }
    if (mimeType === "text/plain") {
      return [{ pageNumber: 1, text: buffer.toString("utf-8") }];
    }
    throw new Error(`Unsupported mime type: ${mimeType}`);
  }
}
