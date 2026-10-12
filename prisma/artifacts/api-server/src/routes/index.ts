import { Router, type IRouter } from "express";
import healthRouter from "./health";
import aiRouter from "./ai";
import prismaRouter from "./prisma";
import codeWorkspaceRouter from "./code-workspace";
import codeAgentRouter from "./code-agent";

const router: IRouter = Router();

router.use(healthRouter);
router.use(aiRouter);
router.use(prismaRouter);
router.use(codeWorkspaceRouter);
router.use(codeAgentRouter);

export default router;
