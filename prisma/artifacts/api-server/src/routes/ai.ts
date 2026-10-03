import { Router, type IRouter, type Response } from "express";
import { logger } from "../lib/logger";
import {
  type AiProviderConfig,
  AiProviderConfigurationError,
  getChatProviderConfig,
  getImageProviderConfig,
  getProviderEndpoint,
  getProviderHeaders,
} from "../lib/ai-provider";

const router: IRouter = Router();
const chatSystemMessage =
  "Eres Prisma, un asistente de IA útil y claro. Responde en español por defecto, conserva el idioma del usuario cuando escriba en otro idioma y usa Markdown cuando ayude a leer mejor.";
const documentSystemMessage =
  "Eres Prisma, un redactor profesional. Crea documentos completos, claros y bien organizados a partir del pedido del usuario. Escribe en español salvo que pidan otro idioma. Empieza directamente con el título del documento, usa encabezados Markdown cuando sean útiles y no añadas comentarios sobre cómo generaste el documento.";

type AiChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string };

function isChatRequest(
  value: unknown,
): value is {
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  mode: "chat" | "document";
} {
  if (!value || typeof value !== "object") return false;
  const body = value as Record<string, unknown>;
  if (body.mode !== "chat" && body.mode !== "document") return false;
  return (
    Array.isArray(body.messages) &&
    body.messages.length > 0 &&
    body.messages.length <= 40 &&
    body.messages.every(
      (message) =>
        !!message &&
        typeof message === "object" &&
        ((message as Record<string, unknown>).role === "user" ||
          (message as Record<string, unknown>).role === "assistant") &&
        typeof (message as Record<string, unknown>).content === "string" &&
        ((message as Record<string, unknown>).content as string).length <=
          12_000,
    )
  );
}

function sendStreamError(res: Response, message: string) {
  if (res.writableEnded || res.destroyed) return;
  res.write(`event: error\ndata: ${JSON.stringify({ error: message })}\n\n`);
  res.end();
}

async function forwardChatStream(
  body: ReadableStream<Uint8Array>,
  res: Response,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let completed = false;

  const handleFrame = (frame: string) => {
    const lines = frame.split(/\r?\n/);
    const data = lines
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim();
    const event = lines
      .find((line) => line.startsWith("event:"))
      ?.slice(6)
      .trim();

    if (!data || data === "[DONE]") {
      if (data === "[DONE]") completed = true;
      return;
    }

    let payload: {
      choices?: Array<{ delta?: { content?: unknown } }>;
      error?: string | { message?: string };
    };
    try {
      payload = JSON.parse(data);
    } catch {
      throw new Error("El Router IA devolvió un evento de streaming inválido.");
    }

    if (event === "error" || payload.error) {
      throw new Error("El Router IA informó un error durante la respuesta.");
    }

    const content = payload.choices?.[0]?.delta?.content;
    if (typeof content === "string" && content && !res.writableEnded) {
      res.write(`data: ${JSON.stringify({ content })}\n\n`);
    }
  };

  try {
    while (!completed) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });

      let boundary = pending.search(/\r?\n\r?\n/);
      while (boundary !== -1) {
        const separator = pending.slice(boundary).match(/^\r?\n\r?\n/)?.[0] ?? "\n\n";
        const frame = pending.slice(0, boundary);
        pending = pending.slice(boundary + separator.length);
        handleFrame(frame);
        if (completed) break;
        boundary = pending.search(/\r?\n\r?\n/);
      }
    }

    pending += decoder.decode();
    if (pending.trim() && !completed) handleFrame(pending);
  } finally {
    reader.releaseLock();
  }
}

router.post("/ai/chat", async (req, res) => {
  const body: unknown = req.body;
  if (!isChatRequest(body)) {
    res.status(400).json({ error: "El mensaje no tiene un formato válido." });
    return;
  }

  let provider: AiProviderConfig;
  try {
    provider = getChatProviderConfig();
  } catch (error) {
    if (error instanceof AiProviderConfigurationError) {
      res
        .status(503)
        .json({ error: "El servicio de IA todavía no está configurado." });
      return;
    }
    throw error;
  }

  const messages: AiChatMessage[] = [
    {
      role: "system",
      content:
        body.mode === "document" ? documentSystemMessage : chatSystemMessage,
    },
    ...body.messages.map((message) => ({
      role: message.role,
      content: message.content,
    })) as Array<Extract<AiChatMessage, { role: "user" | "assistant" }>>,
  ];

  const abortController = new AbortController();
  const useStreaming = process.env.AI_ROUTER_STREAM === "true";
  res.on("close", () => {
    if (!res.writableEnded) abortController.abort();
  });

  try {
    const upstream = await fetch(
      getProviderEndpoint(provider.baseUrl, "chat/completions"),
      {
        method: "POST",
        headers: getProviderHeaders(provider),
        body: JSON.stringify({
          model: provider.model,
          max_tokens: 1024,
          messages,
          stream: useStreaming,
        }),
        signal: AbortSignal.any([abortController.signal, AbortSignal.timeout(120_000)]),
      },
    );

    if (!upstream.ok || !upstream.body) {
      logger.error(
        { statusCode: upstream.status },
        "AI Router chat request failed",
      );
      res.status(502).json({
        error: "El Router IA no pudo completar la solicitud.",
      });
      return;
    }

    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    try {
      if (useStreaming) {
        await forwardChatStream(upstream.body, res);
      } else {
        const result = await upstream.json() as {
          choices?: Array<{ message?: { content?: unknown }; finish_reason?: string }>;
        };
        const choice = result.choices?.[0];
        const content = choice?.message?.content;
        if (typeof content !== "string" || !content.trim()) {
          throw new Error("Router IA devolvió una respuesta vacía o inválida.");
        }
        res.write(`data: ${JSON.stringify({ content })}\n\n`);
        if (choice?.finish_reason === "length") {
          sendStreamError(res, "La respuesta alcanzó el límite de 1024 tokens del Router IA y quedó incompleta.");
          return;
        }
      }
      if (!res.writableEnded) {
        res.write("data: [DONE]\n\n");
        res.end();
      }
    } catch (error) {
      if (!abortController.signal.aborted) {
        logger.error({ err: error }, "AI Router chat stream failed");
        sendStreamError(
          res,
          "No se pudo completar la respuesta. Inténtalo de nuevo.",
        );
      }
    }
  } catch (error) {
    if (abortController.signal.aborted) return;
    logger.error({ err: error }, "AI Router chat request failed");
    if (!res.headersSent) {
      res.status(502).json({
        error: "No se pudo conectar con el Router IA.",
      });
    } else {
      sendStreamError(
        res,
        "No se pudo completar la respuesta. Inténtalo de nuevo.",
      );
    }
  }
});

router.post("/ai/generate-image", async (req, res) => {
  const body = req.body as { prompt?: unknown; size?: unknown };
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  const supportedSizes = new Set([
    "1024x1024",
    "1536x1024",
    "1024x1536",
    "auto",
  ]);
  const size =
    typeof body.size === "string" && supportedSizes.has(body.size)
      ? body.size
      : "1024x1024";

  if (!prompt || prompt.length > 2000) {
    res.status(400).json({
      error: "Escribe una descripción de hasta 2000 caracteres.",
    });
    return;
  }

  let provider: AiProviderConfig;
  try {
    provider = getImageProviderConfig();
  } catch (error) {
    if (error instanceof AiProviderConfigurationError) {
      res.status(503).json({
        error:
          "El servicio de generación de imágenes todavía no está configurado.",
      });
      return;
    }
    throw error;
  }

  try {
    const upstream = await fetch(
      getProviderEndpoint(provider.baseUrl, "images/generations"),
      {
        method: "POST",
        headers: getProviderHeaders(provider),
        body: JSON.stringify({
          model: provider.model,
          prompt,
          size,
        }),
      },
    );

    if (!upstream.ok) {
      logger.error(
        { statusCode: upstream.status },
        "AI Router image request failed",
      );
      res.status(502).json({
        error: "El Router IA no pudo generar la imagen.",
      });
      return;
    }

    const result: unknown = await upstream.json();
    const image =
      result &&
      typeof result === "object" &&
      "data" in result &&
      Array.isArray(result.data)
        ? result.data[0]
        : undefined;
    const base64 =
      image && typeof image === "object" && "b64_json" in image
        ? image.b64_json
        : undefined;

    if (typeof base64 !== "string" || !base64) {
      res.status(502).json({
        error: "El Router IA no devolvió la imagen en formato base64.",
      });
      return;
    }

    res.json({ b64_json: base64 });
  } catch (error) {
    logger.error({ err: error }, "AI Router image request failed");
    res.status(502).json({
        error:
          "No se pudo conectar con el Router IA para generar la imagen.",
    });
  }
});

export default router;
