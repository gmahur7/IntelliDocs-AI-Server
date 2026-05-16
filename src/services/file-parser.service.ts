import { PDFParse } from "pdf-parse";

export class FileParserService {
  async parseByMime(buffer: Buffer, mimeType: string): Promise<string> {
    if (mimeType === "application/pdf") {
      const parser = new PDFParse({ data: buffer });
      try {
        const parsed = await parser.getText();
        return parsed.text ?? "";
      } finally {
        await parser.destroy();
      }
    }
    if (mimeType === "text/plain") {
      return buffer.toString("utf-8");
    }
    throw new Error(`Unsupported mime type: ${mimeType}`);
  }
}
