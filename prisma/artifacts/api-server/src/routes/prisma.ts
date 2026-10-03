import { Router, type IRouter } from "express";
import {
  AiProviderConfigurationError,
  getChatProviderConfig,
} from "../lib/ai-provider";
import { corexToolStatus } from "../lib/corex-tools";
import { logger } from "../lib/logger";
import { runPrismaAgent } from "../lib/prisma-agent";
import {
  ensurePrismaMemory,
  listImportantMemories,
  recordConversationTurn,
} from "../lib/prisma-memory";

const router: IRouter = Router();

type RequestMessage = { role: "user" | "assistant"; content: string };

function parseRequest(value: unknown): {
  messages: RequestMessage[];
  mode: "chat" | "document";
  conversationId: string;
} | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (body.mode !== "chat" && body.mode !== "document") return null;
  if (typeof body.conversationId !== "string" || !body.conversationId.trim() || body.conversationId.length > 160) return null;
  if (!Array.isArray(body.messages) || body.messages.length < 1 || body.messages.length > 40) return null;
  const messages: RequestMessage[] = [];
  for (const raw of body.messages) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const message = raw as Record<string, unknown>;
    if ((message.role !== "user" && message.role !== "assistant") || typeof message.content !== "string" || message.content.length > 12_000) return null;
    messages.push({ role: message.role, content: message.content });
  }
  return {
    messages,
    mode: body.mode,
    conversationId: body.conversationId.trim(),
  };
}

router.get("/prisma/status", async (_req, res) => {
  try {
    const memories = await listImportantMemories(["prisma", "corex"], 8);
    res.json({
      ok: true,
      memory: {
        available: true,
        entriesLoaded: memories.length,
        scopes: [...new Set(memories.map((item) => item.scope))],
      },
      corex: corexToolStatus(),
      changeMode: "prepare-and-approve",
    });
  } catch (error) {
    logger.error({ err: error }, "Prisma status check failed");
    res.status(503).json({
      ok: false,
      memory: { available: false },
      corex: corexToolStatus(),
    });
  }
});

router.post("/prisma/chat", async (req, res) => {
  const input = parseRequest(req.body);
  if (!input) {
    res.status(400).json({ error: "El mensaje no tiene un formato válido." });
    return;
  }

  let provider;
  try {
    provider = getChatProviderConfig();
  } catch (error) {
    if (error instanceof AiProviderConfigurationError) {
      res.status(503).json({ error: "El servicio de IA todavía no está configurado." });
      return;
    }
    throw error;
  }

  const latestUser = [...input.messages].reverse().find((message) => message.role === "user");

  try {
    await ensurePrismaMemory();
    if (latestUser) {
      await recordConversationTurn({
        conversationId: input.conversationId,
        role: "user",
        content: latestUser.content,
        mode: input.mode,
      });
    }

    const content = await runPrismaAgent({
      provider,
      messages: input.messages,
      mode: input.mode,
    });

    await recordConversationTurn({
      conversationId: input.conversationId,
      role: "assistant",
      content,
      mode: input.mode,
    });

    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.write(`data: ${JSON.stringify({ content })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  } catch (error) {
    logger.error({ err: error }, "Prisma agent request failed");
    res.status(502).json({
      error: error instanceof Error
        ? error.message.slice(0, 500)
        : "Prisma no pudo completar la solicitud.",
    });
  }
});

export default router;
