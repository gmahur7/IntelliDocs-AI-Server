import { DocumentStatus } from "@prisma/client";
import { DocumentRepository, type CreatedDocument } from "@repositories/document.repository";

type CreateDocumentFromUploadInput = {
  userId: string;
  fileKey: string;
  fileUrl: string;
  mimeType: string;
};

export class DocumentService {
  constructor(private readonly documentRepository: DocumentRepository = new DocumentRepository()) {}

  async createDocumentFromUpload(input: CreateDocumentFromUploadInput): Promise<CreatedDocument> {
    return this.documentRepository.create({
      userId: input.userId,
      fileKey: input.fileKey,
      fileUrl: input.fileUrl,
      mimeType: input.mimeType,
    });
  }

  async markProcessing(documentId: string): Promise<void> {
    await this.documentRepository.updateStatus({
      id: documentId,
      status: DocumentStatus.PROCESSING,
    });
  }

  async markPending(documentId: string): Promise<void> {
    await this.documentRepository.updateStatus({
      id: documentId,
      status: DocumentStatus.PENDING,
      error: null,
    });
  }

  async markReady(documentId: string): Promise<void> {
    await this.documentRepository.updateStatus({
      id: documentId,
      status: DocumentStatus.READY,
      error: null,
    });
  }

  async markFailed(documentId: string, error: string): Promise<void> {
    await this.documentRepository.updateStatus({
      id: documentId,
      status: DocumentStatus.FAILED,
      error,
    });
  }

  async getById(documentId: string) {
    return this.documentRepository.findById(documentId);
  }

  async getByIdAndUserId(documentId: string, userId: string) {
    return this.documentRepository.findByIdAndUserId(documentId, userId);
  }

  async getByUserId(userId: string) {
    return this.documentRepository.findManyByUserId(userId);
  }
}
