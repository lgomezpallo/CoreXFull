import { Router, type IRouter } from "express";
import {
  AiProviderConfigurationError,
  getChatProviderConfig,
} from "../lib/ai-provider";
import { corexToolStatus } from "../lib/corex-tools";
import { logger } from "../lib/logger";
import { runPrismaCorexAgent } from "../lib/prisma-corex-agent";
import {
  ensurePrismaMemory,
  listImportantMemories,
  recordConversationTurn,
} from "../lib/prisma-memory";
import {
  analyzePrismaImage,
  type PrismaImageInput,
} from "../lib/prisma-vision";

const router: IRouter = Router();

type RequestMessage = { role: "user" | "assistant"; content: string };

type ParsedRequest = {
  messages: RequestMessage[];
  mode: "chat" | "document";
  conversationId: string;
  image?: PrismaImageInput;
};

const IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

function parseRequest(value: unknown): ParsedRequest | null {
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

  let image: PrismaImageInput | undefined;
  if (body.image !== undefined) {
    if (!body.image || typeof body.image !== "object" || Array.isArray(body.image)) return null;
    const rawImage = body.image as Record<string, unknown>;
    if (typeof rawImage.data !== "string" || rawImage.data.length < 16 || rawImage.data.length > 6_500_000) return null;
    if (typeof rawImage.mimeType !== "string" || !IMAGE_MIME_TYPES.has(rawImage.mimeType)) return null;
    image = {
      data: rawImage.data,
      mimeType: rawImage.mimeType as PrismaImageInput["mimeType"],
    };
  }

  return {
    messages,
    mode: body.mode,
    conversationId: body.conversationId.trim(),
    image,
  };
}

router.get("/prisma/status", async (_req, res) => {
  try {
    const memories = await listImportantMemories(["prisma", "corex"], 8);
    res.json({
      ok: true,
      engine: "corex-focused-v2",
      memory: {
        available: true,
        entriesLoaded: memories.length,
        scopes: [...new Set(memories.map((item) => item.scope))],
      },
      corex: corexToolStatus(),
      vision: { acceptsImages: true, mimeTypes: [...IMAGE_MIME_TYPES] },
      diagnosticMode: "deterministic-memory-search-read-synthesize",
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

// Temporary deployment smoke test. Remove after live validation.
router.get("/prisma/smoke-6f31d0", async (_req, res) => {
  try {
    await ensurePrismaMemory();
    const provider = getChatProviderConfig();
    const casual = await runPrismaCorexAgent({
      provider,
      mode: "chat",
      messages: [{ role: "user", content: "Hola" }],
    });
    const diagnostic = await runPrismaCorexAgent({
      provider,
      mode: "chat",
      messages: [{ role: "user", content: "Revisá Mi Primera App/Diseño y ubicá el error de vista previa. No modifiques nada." }],
    });
    res.json({
      ok: true,
      casual: casual.slice(0, 500),
      diagnostic: diagnostic.slice(0, 1500),
    });
  } catch (error) {
    logger.error({ err: error }, "Prisma smoke test failed");
    res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message.slice(0, 800) : "Smoke test failed",
    });
  }
});

router.post("/prisma/chat", async (req, res) => {
  const input = parseRequest(req.body);
  if (!input) {
    res.status(400).json({ error: "El mensaje o la imagen no tienen un formato válido." });
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

  const latestUserIndex = [...input.messages]
    .map((message, index) => ({ message, index }))
    .reverse()
    .find(({ message }) => message.role === "user")?.index;

  try {
    await ensurePrismaMemory();

    let agentMessages = input.messages;
    let durableUserContent = latestUserIndex === undefined
      ? ""
      : input.messages[latestUserIndex]?.content ?? "";

    if (input.image && latestUserIndex !== undefined) {
      const visionAnalysis = await analyzePrismaImage(
        provider,
        input.image,
        durableUserContent,
      );
      durableUserContent = [
        durableUserContent || "Analiza esta imagen.",
        "",
        "[Lectura persistente de la imagen adjunta]",
        visionAnalysis,
      ].join("\n");
      agentMessages = input.messages.map((message, index) =>
        index === latestUserIndex
          ? { ...message, content: durableUserContent }
          : message,
      );
    }

    if (latestUserIndex !== undefined) {
      await recordConversationTurn({
        conversationId: input.conversationId,
        role: "user",
        content: durableUserContent,
        mode: input.mode,
      });
    }

    const content = await runPrismaCorexAgent({
      provider,
      messages: agentMessages,
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
