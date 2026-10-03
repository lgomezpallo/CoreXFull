import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageManager = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const mode = process.argv[2];

function execute(args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(packageManager, args, {
      cwd: rootDirectory,
      env,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

async function build() {
  const typecheckCode = await execute(["run", "typecheck"]);
  if (typecheckCode !== 0) return typecheckCode;
  return execute(["-r", "--if-present", "run", "build"]);
}

function runLongLivedServices(services) {
  const children = [];
  let shuttingDown = false;

  const stopChildren = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const child of children) {
      if (child.exitCode === null && !child.killed) child.kill("SIGTERM");
    }
  };

  process.once("SIGINT", stopChildren);
  process.once("SIGTERM", stopChildren);

  for (const service of services) {
    const child = spawn(packageManager, service.args, {
      cwd: rootDirectory,
      env: service.env,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    children.push(child);
    child.once("error", (error) => {
      process.stderr.write(`${service.name} failed to start: ${error.message}\n`);
      process.exitCode = 1;
      stopChildren();
    });
    child.once("exit", (code) => {
      if (shuttingDown) return;
      process.exitCode = code ?? 1;
      stopChildren();
    });
  }
}

if (mode === "build") {
  process.exitCode = await build();
} else if (mode === "dev") {
  const apiPort = process.env.API_PORT || process.env.PORT || "8080";
  const webPort = process.env.WEB_PORT || "5173";
  const apiOrigin = process.env.API_ORIGIN || `http://127.0.0.1:${apiPort}`;
  const basePath = process.env.BASE_PATH || "/";

  runLongLivedServices([
    {
      name: "API server",
      args: ["--filter", "@workspace/api-server", "run", "dev"],
      env: {
        ...process.env,
        NODE_ENV: "development",
        PORT: apiPort,
        COREX_SERVE_WEB: "0",
      },
    },
    {
      name: "CoreX web",
      args: ["--filter", "@workspace/habla-code", "run", "dev"],
      env: {
        ...process.env,
        PORT: webPort,
        BASE_PATH: basePath,
        COREX_EXTERNAL_DEV: "1",
        API_ORIGIN: apiOrigin,
      },
    },
  ]);
} else if (mode === "start") {
  const port = process.env.PORT || "8080";
  const staticDirectory = path.resolve(
    rootDirectory,
    process.env.COREX_STATIC_DIR || "artifacts/habla-code/dist/public",
  );
  runLongLivedServices([
    {
      name: "CoreX server",
      args: ["--filter", "@workspace/api-server", "run", "start"],
      env: {
        ...process.env,
        NODE_ENV: "production",
        PORT: port,
        COREX_SERVE_WEB: "1",
        COREX_STATIC_DIR: staticDirectory,
      },
    },
  ]);
} else {
  process.stderr.write("Usage: node scripts/corex.mjs <dev|build|start>\n");
  process.exitCode = 2;
}