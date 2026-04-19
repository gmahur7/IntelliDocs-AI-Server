import type { User } from "@prisma/client";
import { Role } from "@prisma/client";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

import { env } from "@config/env";
import { HTTP_STATUS } from "@constants/http-status";
import { UserRepository } from "@repositories/user.repository";
import { AppError } from "@utils/app-error";

const JWT_ROLE_VALUES: Role[] = [Role.ADMIN, Role.USER, Role.GUEST];

interface SignupInput {
  firstName: string;
  lastName: string;
  email: string;
  password: string;
}

interface SigninInput {
  email: string;
  password: string;
}

interface AuthResult {
  token: string;
  user: {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
    role: Role;
  };
}

interface JwtPayload {
  sub: string;
  email: string;
  firstName: string;
  lastName: string;
  role: Role;
}

function toPublicUser(user: User): AuthResult["user"] {
  return {
    id: user.id,
    firstName: user.firstName,
    lastName: user.lastName,
    email: user.email,
    role: user.role,
  };
}

function isRole(value: unknown): value is Role {
  return typeof value === "string" && JWT_ROLE_VALUES.includes(value as Role);
}

export class AuthService {
  constructor(private readonly userRepository: UserRepository = new UserRepository()) {}

  private signAccessToken(payload: JwtPayload): string {
    const expiresIn = env.JWT_ACCESS_EXPIRES_IN as jwt.SignOptions["expiresIn"];
    return jwt.sign(
      {
        sub: payload.sub,
        email: payload.email,
        firstName: payload.firstName,
        lastName: payload.lastName,
        role: payload.role,
      },
      env.JWT_ACCESS_SECRET,
      {
        expiresIn,
      },
    );
  }

  async signup(input: SignupInput): Promise<AuthResult> {
    const existingUser = await this.userRepository.findByEmail(input.email);
    if (existingUser) {
      throw new AppError("User with this email already exists", HTTP_STATUS.CONFLICT);
    }
    const passwordHash = await bcrypt.hash(input.password, 12);
    const user = await this.userRepository.create({
      firstName: input.firstName,
      lastName: input.lastName,
      email: input.email,
      password: passwordHash,
      role: Role.USER,
    });
    const token = this.signAccessToken({
      sub: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
    });
    return {
      token,
      user: toPublicUser(user),
    };
  }

  async signin(input: SigninInput, clientIp?: string | null): Promise<AuthResult> {
    const user = await this.userRepository.findByEmail(input.email);
    if (!user || !user.password) {
      throw new AppError("Invalid email or password", HTTP_STATUS.UNAUTHORIZED);
    }
    if (user.isDeleted) {
      throw new AppError("Account not found", HTTP_STATUS.UNAUTHORIZED);
    }
    if (!user.isActive) {
      throw new AppError("Account is inactive", HTTP_STATUS.FORBIDDEN);
    }
    const isValidPassword = await bcrypt.compare(input.password, user.password);
    if (!isValidPassword) {
      throw new AppError("Invalid email or password", HTTP_STATUS.UNAUTHORIZED);
    }
    const updated = await this.userRepository.update(user.id, {
      lastLoginAt: new Date(),
      lastLoginIp: clientIp ?? undefined,
    });
    const token = this.signAccessToken({
      sub: updated.id,
      email: updated.email,
      firstName: updated.firstName,
      lastName: updated.lastName,
      role: updated.role,
    });
    return {
      token,
      user: toPublicUser(updated),
    };
  }

  verifyAccessToken(token: string): JwtPayload {
    try {
      const payload = jwt.verify(token, env.JWT_ACCESS_SECRET) as jwt.JwtPayload;
      const sub = payload.sub;
      if (typeof sub !== "string") {
        throw new AppError("Invalid token payload", HTTP_STATUS.UNAUTHORIZED);
      }
      if (
        typeof payload.email !== "string" ||
        typeof payload.firstName !== "string" ||
        typeof payload.lastName !== "string" ||
        !isRole(payload.role)
      ) {
        throw new AppError("Invalid token payload", HTTP_STATUS.UNAUTHORIZED);
      }
      return {
        sub,
        email: payload.email,
        firstName: payload.firstName,
        lastName: payload.lastName,
        role: payload.role,
      };
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError("Invalid or expired token", HTTP_STATUS.UNAUTHORIZED);
    }
  }
}
