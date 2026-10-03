import app from "./app";
import { getChatProviderConfig } from "./lib/ai-provider";
import { runPrismaAgent } from "./lib/prisma-agent";
import { corexManagedWriteSetup, corexToolStatus } from "./lib/corex-tools";
import { corexListTree } from "./lib/corex-ssh-read";
import { logger } from "./lib/logger";
import { listImportantMemories } from "./lib/prisma-memory";
import { runPrismaWriteSmoke } from "./lib/prisma-write-smoke";

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
    writeSetup: { ok: false },
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
      readTransport: "ssh",
    };
  } catch (error) {
    result.corex = {
      ok: false,
      ...corexToolStatus(),
      error: error instanceof Error ? error.message.slice(0, 300) : "unknown",
    };
  }

  try {
    const setup = await corexManagedWriteSetup();
    result.writeSetup = { ok: true, ...setup };
  } catch (error) {
    result.writeSetup = {
      ok: false,
      error: error instanceof Error ? error.message.slice(0, 300) : "unknown",
    };
  }

  const memoryOk = Boolean((result.memory as Record<string, unknown>).ok);
  const corexOk = Boolean((result.corex as Record<string, unknown>).ok);
  const writeSetupOk = Boolean((result.writeSetup as Record<string, unknown>).ok);
  if (memoryOk && corexOk && writeSetupOk) {
    logger.info({ prismaSelfTest: result }, "Prisma operational self-test passed");
  } else {
    logger.error({ prismaSelfTest: result }, "Prisma operational self-test failed");
  }
}

async function runAgentSmokeTest() {
  if (process.env.PRISMA_STARTUP_AGENT_SMOKE?.trim() !== "1") return;

  try {
    const provider = getChatProviderConfig();
    const response = await runPrismaAgent({
      provider,
      mode: "chat",
      messages: [
        {
          role: "user",
          content:
            "Prueba operativa interna. Antes de responder, usa corex_status y corex_list_tree sobre corex con profundidad 0. Luego responde únicamente con una frase breve indicando repositorio, rama, si pudiste leer CoreX y si la escritura está habilitada. No prepares ni apliques cambios.",
        },
      ],
    });
    logger.info(
      { prismaAgentSmoke: { ok: true, response: response.slice(0, 800) } },
      "Prisma agent smoke test passed",
    );
  } catch (error) {
    logger.error(
      {
        prismaAgentSmoke: {
          ok: false,
          error: error instanceof Error ? error.message.slice(0, 800) : "unknown",
        },
      },
      "Prisma agent smoke test failed",
    );
  }
}

async function runWriteSmokeTest() {
  if (process.env.PRISMA_STARTUP_WRITE_SMOKE?.trim() !== "1") return;
  try {
    const result = await runPrismaWriteSmoke();
    logger.info({ prismaWriteSmoke: result }, "Prisma write smoke test passed");
  } catch (error) {
    logger.error(
      {
        prismaWriteSmoke: {
          ok: false,
          error: error instanceof Error ? error.message.slice(0, 1000) : "unknown",
        },
      },
      "Prisma write smoke test failed",
    );
  }
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  void runOperationalSelfTest();
  void runAgentSmokeTest();
  void runWriteSmokeTest();
});
