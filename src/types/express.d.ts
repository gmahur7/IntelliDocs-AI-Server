import type { Logger } from "pino";

import type { Role } from "@prisma/client";

declare global {
  namespace Express {
    interface AuthUser {
      id: string;
      email: string;
      firstName: string;
      lastName: string;
      role: Role;
    }

    interface Request {
      log: Logger;
      user?: AuthUser;
    }
  }
}

export {};
