import { Router, type IRouter } from "express";
import healthRouter from "./health";
import aiRouter from "./ai";
import prismaRouter from "./prisma";

const router: IRouter = Router();

router.use(healthRouter);
router.use(aiRouter);
router.use(prismaRouter);

export default router;
