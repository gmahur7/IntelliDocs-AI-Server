import { Role } from "@prisma/client";
import { z } from "zod";

export const userIdParamsSchema = z.object({
  id: z.string().uuid("User id must be a valid UUID"),
});

export const createUserSchema = z.object({
  firstName: z.string().min(1, "firstName is required").max(100, "firstName is too long"),
  lastName: z.string().min(1, "lastName is required").max(100, "lastName is too long"),
  email: z.string().email("email must be valid").max(255, "email is too long"),
  role: z.nativeEnum(Role).optional(),
});

export const updateUserSchema = z
  .object({
    firstName: z.string().min(1).max(100).optional(),
    lastName: z.string().min(1).max(100).optional(),
    email: z.string().email().max(255).optional(),
    role: z.nativeEnum(Role).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field must be provided",
  });
