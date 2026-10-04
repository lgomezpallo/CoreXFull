import {
  type AiProviderConfig,
  getProviderEndpoint,
  getProviderHeaders,
} from "./ai-provider";
import {
  corexCreateFile,
  corexManagedWriteSetup,
  corexToolStatus,
  corexWriteFile,
} from "./corex-tools";
import {
  corexListTree,
  corexReadFile,
  corexSearch,
} from "./corex-ssh-read";
import { createChangeRequest } from "./prisma-change-requests";
import {
  listImportantMemories,
  rememberPrisma,
  searchPrismaMemory,
} from "./prisma-memory";

export type AgentInputMessage = {
  role: "user" | "assistant";
  content: string;
};

type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

type AgentMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

const TOOL_DEFINITIONS = [
  {
    type: "function",
    function: {
      name: "memory_search",
      description: "Busca memoria persistente relevante de Prisma/CoreX.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          scope: { type: "string", enum: ["global", "prisma", "corex"] },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "memory_remember",
      description: "Guarda una decisión, error, causa, cambio o invariante útil para el futuro.",
      parameters: {
        type: "object",
        properties: {
          kind: { type: "string" },
          scope: { type: "string", enum: ["global", "prisma", "corex"] },
          key: { type: "string" },
          content: { type: "string" },
          importance: { type: "integer", minimum: 0, maximum: 100 },
        },
        required: ["key", "content"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "corex_status",
      description: "Devuelve estado básico de acceso a CoreX.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "corex_write_status",
      description: "Comprueba autorización de escritura administrada por Prisma.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "corex_read_file",
      description: "Lee un archivo actual de corex/ y devuelve contenido y SHA.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "corex_list_tree",
      description: "Lista estructura de archivos dentro de corex/.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          depth: { type: "integer", minimum: 0, maximum: 4 },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "corex_search",
      description: "Busca texto, rutas, componentes o funciones dentro de corex/.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "corex_prepare_change",
      description: "Prepara una propuesta de cambio sin aplicarla.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          expectedSha: { type: "string" },
          proposedContent: { type: "string" },
          reason: { type: "string" },
        },
        required: ["path", "expectedSha", "proposedContent", "reason"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "corex_write_file",
      description: "Aplica un cambio autorizado a un archivo existente usando su SHA actual.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          expectedSha: { type: "string" },
          content: { type: "string" },
          message: { type: "string" },
        },
        required: ["path", "expectedSha", "content", "message"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "corex_create_file",
      description: "Crea un archivo nuevo autorizado dentro de corex/.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
          message: { type: "string" },
        },
        required: ["path", "content", "message"],
        additionalProperties: false,
      },
    },
  },
] as const;

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function textArg(args: Record<string, unknown>, key: string, fallback = "") {
  return typeof args[key] === "string" ? String(args[key]) : fallback;
}

async function executeTool(call: ToolCall): Promise<unknown> {
  let parsed: unknown = {};
  try {
    parsed = call.function.arguments ? JSON.parse(call.function.arguments) : {};
  } catch {
    throw new Error("Los argumentos de la herramienta no son JSON válido.");
  }
  const args = asObject(parsed);

  switch (call.function.name) {
    case "memory_search":
      return searchPrismaMemory(
        textArg(args, "query"),
        textArg(args, "scope") || undefined,
        10,
      );
    case "memory_remember":
      return rememberPrisma({
        kind: textArg(args, "kind") || undefined,
        scope: textArg(args, "scope") || undefined,
        key: textArg(args, "key"),
        content: textArg(args, "content"),
        importance: typeof args.importance === "number" ? args.importance : undefined,
      });
    case "corex_status":
      return corexToolStatus();
    case "corex_write_status":
      return corexManagedWriteSetup();
    case "corex_read_file":
      return corexReadFile(textArg(args, "path"));
    case "corex_list_tree":
      return corexListTree(
        textArg(args, "path", "corex"),
        typeof args.depth === "number" ? args.depth : 2,
      );
    case "corex_search":
      return corexSearch(textArg(args, "query"));
    case "corex_prepare_change":
      return createChangeRequest({
        targetPath: textArg(args, "path"),
        expectedSha: textArg(args, "expectedSha"),
        proposedContent: textArg(args, "proposedContent"),
        reason: textArg(args, "reason"),
      });
    case "corex_write_file":
      return corexWriteFile({
        path: textArg(args, "path"),
        expectedSha: textArg(args, "expectedSha"),
        content: textArg(args, "content"),
        message: textArg(args, "message"),
      });
    case "corex_create_file":
      return corexCreateFile({
        path: textArg(args, "path"),
        content: textArg(args, "content"),
        message: textArg(args, "message"),
      });
    default:
      throw new Error(`Herramienta desconocida: ${call.function.name}`);
  }
}

function compact(value: unknown, limit = 4500) {
  const text = JSON.stringify(value);
  return text.length > limit ? `${text.slice(0, limit)}\n[resultado recortado]` : text;
}

function memoryBlock(memories: Awaited<ReturnType<typeof listImportantMemories>>) {
  if (!memories.length) return "Sin memoria persistente relevante todavía.";
  return memories
    .map((item) => {
      const content = String(item.content ?? "");
      return `- [${item.scope}/${item.kind}] ${item.key}: ${content.slice(0, 650)}`;
    })
    .join("\n");
}

function diagnosticKeywords(text: string) {
  const ignored = new Set([
    "para", "como", "este", "esta", "esto", "esas", "esos", "quiero",
    "favor", "error", "errores", "donde", "sobre", "tiene", "tenes", "tenés",
    "porque", "pero", "entonces", "podés", "podes", "leer", "leé", "conversaciones",
  ]);
  return [...new Set(
    text
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9@._-]+/g, " ")
      .split(/\s+/)
      .filter((word) => word.length >= 4 && !ignored.has(word)),
  )].slice(0, 4);
}

const TECH_RE = /corex|mi primera app|diseñ|vista previa|preview|builder|proyecto|archivo|repo|c[oó]digo|componente|ruta|error|fall|diagn[oó]st|revis|ubic|correg|arregl|modific|implement|memoria|herramienta|xapk/i;
const CASUAL_RE = /^(hola|buenas|buen d[ií]a|buenas tardes|buenas noches|hey|holis|gracias|ok|joya|jaja+|\.\.?|\.\.\.)[!.? ]*$/i;
const CONTINUATION_RE = /^(ahora\??|y ahora\??|dale|segu[ií]|revisalo|revisá|prob[aá]|otra vez)$/i;
const ERROR_ASSISTANT_RE = /^(Router IA |Prisma alcanz[oó] |Prisma no pudo |<!doctype|<html)/i;

function shouldUseTools(input: AgentInputMessage[], latestText: string) {
  const latest = latestText.trim();
  if (CASUAL_RE.test(latest)) return false;
  if (TECH_RE.test(latest)) return true;
  if (CONTINUATION_RE.test(latest)) {
    const previousUsers = input
      .filter((message) => message.role === "user")
      .slice(-4, -1)
      .map((message) => message.content)
      .join(" ");
    return TECH_RE.test(previousUsers);
  }
  return false;
}

function sanitizeHistory(input: AgentInputMessage[], limit: number) {
  return input
    .filter((message) => {
      if (message.role !== "assistant") return true;
      return !ERROR_ASSISTANT_RE.test(message.content.trim());
    })
    .map((message) => ({
      role: message.role,
      content: message.content.length > 1600
        ? `${message.content.slice(0, 1600)}\n[mensaje anterior recortado]`
        : message.content,
    } as AgentInputMessage))
    .slice(-limit);
}

function wait(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function isTransientRouterStatus(status: number) {
  return status === 502 || status === 503 || status === 504;
}

async function routerErrorMessage(response: Response) {
  const contentType = response.headers.get("content-type") ?? "";
  const text = (await response.text().catch(() => "")).slice(0, 1000).trim();
  if (/application\/json/i.test(contentType) || text.startsWith("{")) {
    try {
      const payload = JSON.parse(text) as {
        error?: { message?: unknown } | string;
        message?: unknown;
      };
      const errorValue = payload?.error;
      const message = typeof errorValue === "object" && errorValue !== null
        ? (typeof errorValue.message === "string" ? errorValue.message : "")
        : typeof errorValue === "string"
          ? errorValue
          : typeof payload?.message === "string"
            ? payload.message
            : "";
      if (message.trim()) return message.trim().slice(0, 350);
    } catch {}
  }
  if (/<!doctype\s+html|<html[\s>]/i.test(text)) return "";
  return text.replace(/\s+/g, " ").slice(0, 350);
}

async function requestRouter(
  provider: AiProviderConfig,
  messages: AgentMessage[],
  options: { tools: boolean },
) {
  const endpoint = getProviderEndpoint(provider.baseUrl, "chat/completions");
  const body = JSON.stringify({
    model: provider.model,
    messages,
    ...(options.tools ? { tools: TOOL_DEFINITIONS, tool_choice: "auto" } : {}),
    max_tokens: options.tools ? 1100 : 900,
    stream: false,
  });

  const waits = [3500, 5500, 7500, 9500];
  let lastStatus = 502;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: getProviderHeaders(provider),
        body,
        signal: AbortSignal.timeout(120_000),
      });
    } catch (error) {
      if (attempt < 4) {
        await wait(waits[attempt]);
        continue;
      }
      const timeout = error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name);
      throw new Error(timeout
        ? "Router IA tardó demasiado en responder."
        : "Prisma no pudo comunicarse con Router IA.");
    }

    if (response.ok) return response;
    lastStatus = response.status;
    if (isTransientRouterStatus(response.status) && attempt < 4) {
      await response.body?.cancel().catch(() => {});
      await wait(waits[attempt]);
      continue;
    }

    const detail = await routerErrorMessage(response);
    if (isTransientRouterStatus(response.status)) {
      throw new Error(`Router IA sigue sin estar disponible (HTTP ${response.status}).`);
    }
    throw new Error(
      `Router IA no pudo completar el paso de Prisma (HTTP ${response.status})${detail ? `: ${detail}` : "."}`,
    );
  }
  throw new Error(`Router IA sigue sin estar disponible (HTTP ${lastStatus}).`);
}

async function parseAssistantResponse(response: Response) {
  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: unknown; tool_calls?: unknown } }>;
  };
  const rawMessage = payload.choices?.[0]?.message;
  const content = typeof rawMessage?.content === "string" ? rawMessage.content : null;
  const calls = Array.isArray(rawMessage?.tool_calls)
    ? rawMessage.tool_calls.filter((candidate): candidate is ToolCall => {
        const value = asObject(candidate);
        const fn = asObject(value.function);
        return (
          typeof value.id === "string" &&
          value.type === "function" &&
          typeof fn.name === "string" &&
          typeof fn.arguments === "string"
        );
      })
    : [];
  return { content, calls };
}

async function finalizeWithEvidence(
  provider: AiProviderConfig,
  latestUserText: string,
  messages: AgentMessage[],
) {
  const evidence = messages
    .filter((message): message is Extract<AgentMessage, { role: "tool" }> => message.role === "tool")
    .slice(-6)
    .map((message) => message.content.slice(0, 2600))
    .join("\n\n");

  const finalMessages: AgentMessage[] = [
    {
      role: "system",
      content: "Sos Prisma. Cerrá el diagnóstico con la evidencia disponible. No hay herramientas en esta etapa. Respondé en español y concreto: qué encontraste, dónde está el problema o la mejor hipótesis sustentada, y el siguiente paso. No inventes.",
    },
    { role: "user", content: latestUserText.slice(0, 1800) },
    {
      role: "user",
      content: `EVIDENCIA OBTENIDA POR PRISMA:\n${evidence || "No hubo resultados de herramientas utilizables."}`,
    },
  ];
  const response = await requestRouter(provider, finalMessages, { tools: false });
  const { content } = await parseAssistantResponse(response);
  if (!content?.trim()) throw new Error("Prisma no pudo sintetizar una respuesta final.");
  return content.trim();
}

export async function runPrismaAgent(input: {
  provider: AiProviderConfig;
  messages: AgentInputMessage[];
  mode: "chat" | "document";
}) {
  const latestUserText = [...input.messages]
    .reverse()
    .find((message) => message.role === "user")?.content ?? "";
  const isCasual = CASUAL_RE.test(latestUserText.trim());

  if (isCasual) {
    const casualMessages: AgentMessage[] = [
      {
        role: "system",
        content: "Sos Prisma. Respondé en español, de forma natural y breve. Esta es conversación casual: no uses, menciones ni simules herramientas, proyectos, repositorios, diagnósticos o memoria técnica.",
      },
      { role: "user", content: latestUserText.slice(0, 1000) },
    ];
    const response = await requestRouter(input.provider, casualMessages, { tools: false });
    const { content } = await parseAssistantResponse(response);
    if (!content?.trim()) throw new Error("Prisma no devolvió una respuesta.");
    return content.trim();
  }

  const useTools = shouldUseTools(input.messages, latestUserText);

  const importantMemories = await listImportantMemories(
    ["global", "prisma", "corex"],
    useTools ? 12 : 6,
  );
  const keywordMemories = useTools
    ? (
        await Promise.all(
          diagnosticKeywords(latestUserText).map((keyword) =>
            searchPrismaMemory(keyword, undefined, 5).catch(() => []),
          ),
        )
      ).flat()
    : [];
  const memoryById = new Map<number, (typeof importantMemories)[number]>();
  for (const memory of [...importantMemories, ...keywordMemories]) {
    memoryById.set(memory.id, memory);
  }
  const memories = [...memoryById.values()].slice(0, useTools ? 14 : 6);

  if (!useTools) {
    const simpleSystem = [
      "Sos Prisma. Conversá en español, de forma directa y natural.",
      "Conservá continuidad con el usuario usando el contexto breve disponible.",
      "No actives herramientas de CoreX para mensajes que no requieran inspeccionar o modificar el proyecto.",
      `CONTEXTO PERSISTENTE BREVE:\n${memoryBlock(memories)}`,
    ].join("\n\n");
    const simpleMessages: AgentMessage[] = [
      { role: "system", content: simpleSystem },
      ...sanitizeHistory(input.messages, 6),
    ];
    const response = await requestRouter(input.provider, simpleMessages, { tools: false });
    const { content } = await parseAssistantResponse(response);
    if (!content?.trim()) throw new Error("Prisma no devolvió una respuesta.");
    return content.trim();
  }

  const technicalSystem = [
    "Sos Prisma, agente responsable de conocer, preservar y evolucionar CoreX.",
    "Resolvé con memoria y herramientas antes de devolver trabajo al usuario.",
    "Diagnóstico: identifica proyecto/pantalla/fase; usa memoria; busca en corex/; lee sólo archivos candidatos; formula una hipótesis; pregunta únicamente si falta un dato imposible de obtener.",
    "No repitas una herramienta con los mismos argumentos. En un diagnóstico normal usa como máximo una búsqueda de memoria, dos búsquedas distintas en CoreX y las lecturas necesarias.",
    "Distingue fallas de CoreX, Prisma, Router IA y proveedores externos.",
    "Preserva el principio de CoreX de desglosar operaciones pequeñas.",
    "No escribas en CoreX salvo pedido explícito de modificar/corregir/arreglar/implementar. Para escribir un archivo existente, léelo antes y usa exactamente su SHA.",
    "Después de un cambio aplicado, guarda en memoria el cambio y su motivo.",
    input.mode === "document"
      ? "Si el usuario pide un documento, redacta el documento completo."
      : "Cuando tengas evidencia suficiente, deja de investigar y responde.",
    `MEMORIA RELEVANTE:\n${memoryBlock(memories)}`,
  ].join("\n\n");

  const messages: AgentMessage[] = [
    { role: "system", content: technicalSystem },
    ...sanitizeHistory(input.messages, 8),
  ];
  const seenToolSignatures = new Set<string>();
  const MAX_TOOL_ROUNDS = 4;

  for (let step = 0; step < MAX_TOOL_ROUNDS; step += 1) {
    const response = await requestRouter(input.provider, messages, { tools: true });
    const { content, calls } = await parseAssistantResponse(response);

    if (!calls.length) {
      if (!content?.trim()) throw new Error("Prisma no devolvió contenido ni pidió herramientas.");
      return content.trim();
    }

    messages.push({ role: "assistant", content, tool_calls: calls });
    let mustFinalize = step === MAX_TOOL_ROUNDS - 1;

    for (const call of calls.slice(0, 4)) {
      const signature = `${call.function.name}:${call.function.arguments}`;
      if (seenToolSignatures.has(signature)) {
        mustFinalize = true;
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: compact({ ok: false, error: "Esta consulta ya fue ejecutada; usa la evidencia existente y cierra." }),
        });
        continue;
      }
      seenToolSignatures.add(signature);
      try {
        const result = await executeTool(call);
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: compact({ ok: true, result }),
        });
      } catch (error) {
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: compact({
            ok: false,
            error: error instanceof Error ? error.message : "Error de herramienta",
          }),
        });
      }
    }

    if (mustFinalize) {
      return finalizeWithEvidence(input.provider, latestUserText, messages);
    }
  }

  return finalizeWithEvidence(input.provider, latestUserText, messages);
}
