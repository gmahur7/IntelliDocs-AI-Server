import type { User } from "@prisma/client";
import { Role } from "@prisma/client";

import { HTTP_STATUS } from "@constants/http-status";
import { UserRepository } from "@repositories/user.repository";
import { AppError } from "@utils/app-error";

interface CreateUserInput {
  firstName: string;
  lastName: string;
  email: string;
  role?: Role;
}

interface UpdateUserInput {
  firstName?: string;
  lastName?: string;
  email?: string;
  role?: Role;
}

type PublicUser = Omit<User, "password">;

function toPublicUser(user: User): PublicUser {
  const { password, ...publicUser } = user;
  void password;
  return publicUser;
}

export class UserService {
  constructor(private readonly userRepository: UserRepository = new UserRepository()) {}

  async createUser(input: CreateUserInput): Promise<PublicUser> {
    const existingUser = await this.userRepository.findByEmail(input.email);

    if (existingUser) {
      throw new AppError("User with this email already exists", HTTP_STATUS.CONFLICT);
    }

    const user = await this.userRepository.create({
      firstName: input.firstName,
      lastName: input.lastName,
      email: input.email,
      role: input.role ?? Role.USER,
    });
    return toPublicUser(user);
  }

  async getUsers(): Promise<PublicUser[]> {
    const users = await this.userRepository.findMany();
    return users.map(toPublicUser);
  }

  async getUserById(id: string): Promise<PublicUser> {
    const user = await this.userRepository.findById(id);

    if (!user) {
      throw new AppError("User not found", HTTP_STATUS.NOT_FOUND);
    }

    return toPublicUser(user);
  }

  async updateUser(id: string, input: UpdateUserInput): Promise<PublicUser> {
    await this.getUserById(id);

    if (input.email) {
      const existingUser = await this.userRepository.findByEmail(input.email);
      if (existingUser && existingUser.id !== id) {
        throw new AppError("User with this email already exists", HTTP_STATUS.CONFLICT);
      }
    }

    const user = await this.userRepository.update(id, input);
    return toPublicUser(user);
  }

  async deleteUser(id: string): Promise<void> {
    await this.getUserById(id);
    await this.userRepository.delete(id);
  }
}
