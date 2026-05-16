import { prisma } from "@config/prisma";
import { DocumentStatus } from "@prisma/client";

export type DocumentCreateFields = {
  userId: string;
  fileKey: string;
  fileUrl: string;
  mimeType: string;
};

export class DocumentRepository {
  async create(data: DocumentCreateFields) {
    return prisma.document.create({ data });
  }

  async findById(id: string) {
    return prisma.document.findUnique({
      where: { id },
    });
  }

  async findByIdAndUserId(id: string, userId: string) {
    return prisma.document.findFirst({
      where: {
        id,
        userId,
      },
    });
  }

  async findManyByUserId(userId: string) {
    return prisma.document.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });
  }

  async updateStatus(params: { id: string; status: DocumentStatus; error?: string | null }) {
    return prisma.document.update({
      where: { id: params.id },
      data: {
        status: params.status,
        error: params.error ?? null,
      },
    });
  }
}

export type CreatedDocument = Awaited<ReturnType<DocumentRepository["create"]>>;
