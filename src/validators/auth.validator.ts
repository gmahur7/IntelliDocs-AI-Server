import { z } from "zod";

export const signupSchema = z.object({
  firstName: z.string().trim().min(1, "firstName is required").max(100, "firstName is too long"),
  lastName: z.string().trim().min(1, "lastName is required").max(100, "lastName is too long"),
  email: z.string().trim().email("email must be valid").max(255, "email is too long"),
  password: z
    .string()
    .min(8, "password must be at least 8 characters")
    .max(72, "password is too long"),
});

export const signinSchema = z.object({
  email: z.string().trim().email("email must be valid"),
  password: z.string().min(1, "password is required"),
});
