import { Router, type IRouter } from "express";
import {
  SendPrismaChatBody,
  SendPrismaChatResponse,
} from "@workspace/api-zod";
import { createRouterCompletion, type RouterChatMessage } from "../lib/router-client";
import { requireSupabaseUser } from "../lib/supabase-auth";

const router: IRouter = Router();
const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 15;
const MAX_TOTAL_MESSAGE_CHARS = 24_000;
const SYSTEM_PROMPT =
  "Sos Prisma, el asistente conversacional opcional de CoreX. Respondé en el idioma del usuario con claridad. No afirmes que ejecutaste acciones externas si no las realizaste.";

const requestTimesByUser = new Map<string, number[]>();

function takeRateLimitToken(userId: string, now: number): boolean {
  const activeTimes = (requestTimesByUser.get(userId) ?? [])
    .filter((timestamp) => now - timestamp < WINDOW_MS);
  if (activeTimes.length >= MAX_REQUESTS_PER_WINDOW) {
    requestTimesByUser.set(userId, activeTimes);
    return false;
  }
  activeTimes.push(now);
  requestTimesByUser.set(userId, activeTimes);

  if (requestTimesByUser.size > 2_000) {
    for (const [id, timestamps] of requestTimesByUser) {
      if (!timestamps.some((timestamp) => now - timestamp < WINDOW_MS)) {
        requestTimesByUser.delete(id);
      }
    }
  }
  return true;
}

router.post("/prisma/chat", requireSupabaseUser, async (req, res): Promise<void> => {
  if (process.env.PRISMA_MODULE_ENABLED?.trim().toLowerCase() !== "true") {
    res.status(404).json({ error: "El módulo Prisma está deshabilitado." });
    return;
  }

  const parsed = SendPrismaChatBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "El mensaje o historial de Prisma no es válido." });
    return;
  }

  const inputMessages = parsed.data.messages;
  const totalCharacters = inputMessages.reduce((total, message) => total + message.content.length, 0);
  if (totalCharacters > MAX_TOTAL_MESSAGE_CHARS) {
    res.status(400).json({ error: "El historial supera el límite de texto permitido." });
    return;
  }
  if (inputMessages[inputMessages.length - 1]?.role !== "user") {
    res.status(400).json({ error: "El último mensaje debe ser del usuario." });
    return;
  }

  const userId = req.authenticatedUserId!;
  if (!takeRateLimitToken(userId, Date.now())) {
    res.status(429).json({ error: "Alcanzaste el límite temporal de mensajes. Esperá un minuto e intentá de nuevo." });
    return;
  }

  const messages: RouterChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...inputMessages.map((message) => ({
      role: message.role,
      content: message.content,
    })),
  ];

  try {
    const completion = await createRouterCompletion("chat", messages, {
      maxTokens: 1_200,
      jsonMode: false,
    });
    const response = SendPrismaChatResponse.safeParse({
      message: completion.slice(0, 8_000),
    });
    if (!response.success) {
      res.status(502).json({ error: "Router IA devolvió una respuesta no válida." });
      return;
    }
    res.json(response.data);
  } catch (error) {
    req.log.error({ err: error }, "Prisma chat completion failed");
    res.status(502).json({
      error: error instanceof Error
        ? error.message.slice(0, 220)
        : "No se pudo completar la respuesta de Prisma.",
    });
  }
});

export default router;