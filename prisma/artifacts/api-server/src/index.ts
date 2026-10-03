import app from "./app";
import { corexListTree, corexToolStatus } from "./lib/corex-tools";
import { logger } from "./lib/logger";
import { listImportantMemories } from "./lib/prisma-memory";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

async function runOperationalSelfTest() {
  const result: Record<string, unknown> = {
    memory: { ok: false },
    corex: { ok: false, ...corexToolStatus() },
  };

  try {
    const memories = await listImportantMemories(["prisma", "corex"], 8);
    result.memory = {
      ok: true,
      entriesLoaded: memories.length,
      scopes: [...new Set(memories.map((item) => item.scope))],
    };
  } catch (error) {
    result.memory = {
      ok: false,
      error: error instanceof Error ? error.message.slice(0, 300) : "unknown",
    };
  }

  try {
    const tree = await corexListTree("corex", 0);
    result.corex = {
      ok: true,
      ...corexToolStatus(),
      entriesRead: tree.entries.length,
    };
  } catch (error) {
    result.corex = {
      ok: false,
      ...corexToolStatus(),
      error: error instanceof Error ? error.message.slice(0, 300) : "unknown",
    };
  }

  const memoryOk = Boolean((result.memory as Record<string, unknown>).ok);
  const corexOk = Boolean((result.corex as Record<string, unknown>).ok);
  if (memoryOk && corexOk) {
    logger.info({ prismaSelfTest: result }, "Prisma operational self-test passed");
  } else {
    logger.error({ prismaSelfTest: result }, "Prisma operational self-test failed");
  }
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  void runOperationalSelfTest();
});
