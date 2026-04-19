import { Router } from "express";

import { me, signin, signout, signup } from "@controllers/auth.controller";
import { requireAuth } from "@middlewares/auth.middleware";
import { validateRequest } from "@middlewares/validate-request";
import { signinSchema, signupSchema } from "@validators/auth.validator";

const authRouter = Router();

authRouter.post("/signup", validateRequest({ body: signupSchema }), signup);
authRouter.post("/signin", validateRequest({ body: signinSchema }), signin);
authRouter.post("/signout", requireAuth, signout);
authRouter.get("/me", requireAuth, me);

export { authRouter };
