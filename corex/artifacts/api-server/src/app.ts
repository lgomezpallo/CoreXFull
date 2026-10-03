import express, { type Express } from "express";
import cors from "cors";
import { resolve } from "node:path";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

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
app.use(express.json({ limit: "8mb" }));
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

if (process.env.COREX_SERVE_WEB === "1") {
  const staticDirectory = resolve(
    process.env.COREX_STATIC_DIR || "artifacts/habla-code/dist/public",
  );
  app.use(express.static(staticDirectory));
  app.use((req, res, next) => {
    if (req.method !== "GET" || req.path === "/api" || req.path.startsWith("/api/")) {
      next();
      return;
    }
    res.sendFile(resolve(staticDirectory, "index.html"), (error) => {
      if (error) next(error);
    });
  });
}

export default app;
