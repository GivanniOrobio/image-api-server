import express, { type Express } from "express";
import cors from "cors";
import router from "../src/routes";

const app: Express = express();

app.use(cors());
app.use(express.json({ limit: "100mb" }));
app.use(express.urlencoded({ extended: true, limit: "100mb" }));

// This catch-all function is deployed under `/api/*`, so mount routes at `/`.
app.use("/", router);

export default function handler(req: any, res: any) {
  return app(req, res);
}

