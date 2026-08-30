import { Router, type IRouter } from "express";
import healthRouter from "./health";
import recoveraiRouter from "./recoverai";

const router: IRouter = Router();

router.use(healthRouter);
router.use(recoveraiRouter);

export default router;
