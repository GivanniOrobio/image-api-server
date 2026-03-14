import { Router, type IRouter } from "express";
import healthRouter from "./health";
import studiesRouter from "./studies";
import imagesRouter from "./images";
import driveRouter from "./drive";

const router: IRouter = Router();

router.use(healthRouter);
router.use(driveRouter);
router.use("/studies", studiesRouter);
router.use("/images", imagesRouter);

export default router;
