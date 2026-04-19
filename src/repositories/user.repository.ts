import type { Prisma, Role, User } from "@prisma/client";

import { prisma } from "@config/prisma";

export type UserCreateFields = {
  firstName: string;
  lastName: string;
  email: string;
  password?: string | null;
  role?: Role;
  status?: string;
  isVerified?: boolean;
  isActive?: boolean;
  isDeleted?: boolean;
};

export type UserUpdateFields = {
  firstName?: string;
  lastName?: string;
  email?: string;
  password?: string | null;
  role?: Role;
  status?: string;
  isVerified?: boolean;
  isActive?: boolean;
  isDeleted?: boolean;
  lastLoginAt?: Date | null;
  lastLoginIp?: string | null;
};

export class UserRepository {
  async create(data: UserCreateFields): Promise<User> {
    return prisma.user.create({ data: data as Prisma.UserCreateInput });
  }

  async findMany(): Promise<User[]> {
    return prisma.user.findMany({ orderBy: { createdAt: "desc" } });
  }

  async findById(id: string): Promise<User | null> {
    return prisma.user.findUnique({ where: { id } });
  }

  async findByEmail(email: string): Promise<User | null> {
    return prisma.user.findUnique({ where: { email } });
  }

  async update(id: string, data: UserUpdateFields): Promise<User> {
    return prisma.user.update({
      where: { id },
      data: data as Prisma.UserUpdateInput,
    });
  }

  async delete(id: string): Promise<User> {
    return prisma.user.delete({ where: { id } });
  }
}
