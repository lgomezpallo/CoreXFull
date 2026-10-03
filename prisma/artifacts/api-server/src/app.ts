import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

// The standalone service serves Prisma's web export independently of CoreX.
const webDirectory = path.resolve(process.env.PRISMA_STATIC_DIR ??
  path.join(path.dirname(fileURLToPath(import.meta.url)), "../../ai-companion/dist"));
if (existsSync(path.join(webDirectory, "index.html"))) {
  app.use(express.static(webDirectory));
  app.get("/{*path}", (req, res, next) => {
    if (req.path.startsWith("/api/")) return next();
    res.sendFile(path.join(webDirectory, "index.html"));
  });
}

export default app;
