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
      description: "Busca memoria persistente de Prisma sobre arquitectura, proyectos, pantallas, decisiones, errores y cambios previos. Úsala antes de pedir al usuario contexto que Prisma pueda recordar.",
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
      description: "Guarda algo que Prisma deba conservar entre sesiones. Prioriza proyectos, fases, errores, causas, decisiones e invariantes que puedan afectar trabajo futuro.",
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
      description: "Informa el repositorio, rama, alcance y estado básico de las herramientas de CoreX.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "corex_write_status",
      description: "Comprueba la identidad SSH administrada por Prisma y si GitHub ya autorizó escritura para CoreX. Devuelve sólo la clave pública, nunca la privada.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "corex_read_file",
      description: "Lee por SSH un archivo actual dentro de corex/ y devuelve contenido y SHA.",
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
      description: "Lista por SSH la estructura de archivos dentro de corex/. Úsala para orientarte antes de pedir al usuario una ruta o archivo.",
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
      description: "Busca por SSH archivos/código dentro de corex/. Ante un error o una pantalla nombrada por el usuario, úsala para localizar textos visibles, nombres de etapas, rutas, componentes o funciones antes de pedirle al usuario que señale el archivo.",
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
      description: "Guarda una propuesta completa de cambio sobre un archivo de corex/. Debe basarse en un archivo leído previamente y conservar su SHA esperado. No aplica el cambio automáticamente.",
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
      description: "APLICA una modificación a un archivo existente dentro de corex/. Úsala sólo cuando el usuario haya pedido explícitamente modificar, corregir o aplicar el cambio. Debes haber leído el archivo actual y usar exactamente su SHA.",
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
      description: "CREA un archivo nuevo dentro de corex/. Úsala sólo cuando el usuario haya pedido explícitamente implementar un cambio que requiera ese archivo y hayas verificado antes la estructura de CoreX.",
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
        14,
      );
    case "memory_remember":
      return rememberPrisma({
        kind: textArg(args, "kind") || undefined,
        scope: textArg(args, "scope") || undefined,
        key: textArg(args, "key"),
        content: textArg(args, "content"),
        importance:
          typeof args.importance === "number" ? args.importance : undefined,
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

function memoryBlock(memories: Awaited<ReturnType<typeof listImportantMemories>>) {
  if (!memories.length) return "Sin memoria persistente relevante todavía.";
  return memories
    .map(
      (item) =>
        `- [${item.scope}/${item.kind}] ${item.key}: ${item.content}`,
    )
    .join("\n");
}

function compact(value: unknown) {
  const text = JSON.stringify(value);
  return text.length > 12_000
    ? `${text.slice(0, 12_000)}\n[resultado recortado]`
    : text;
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
  )].slice(0, 5);
}

function wait(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function isTransientRouterStatus(status: number) {
  return status === 502 || status === 503 || status === 504;
}

async function routerErrorMessage(response: Response) {
  const contentType = response.headers.get("content-type") ?? "";
  const text = (await response.text().catch(() => "")).slice(0, 1200).trim();

  if (/application\/json/i.test(contentType) || text.startsWith("{")) {
    try {
      const payload = JSON.parse(text) as {
        error?: { message?: unknown; code?: unknown } | string;
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
      if (message.trim()) return message.trim().slice(0, 400);
    } catch {}
  }

  if (/<!doctype\s+html|<html[\s>]/i.test(text)) return "";
  return text.replace(/\s+/g, " ").slice(0, 400);
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
    ...(options.tools
      ? { tools: TOOL_DEFINITIONS, tool_choice: "auto" }
      : {}),
    max_tokens: options.tools ? 1800 : 1400,
    stream: false,
  });

  let lastStatus = 502;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: getProviderHeaders(provider),
        body,
        signal: AbortSignal.timeout(120_000),
      });
    } catch (error) {
      if (attempt < 2) {
        await wait(900 * (attempt + 1));
        continue;
      }
      const timeout = error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name);
      throw new Error(timeout
        ? "Router IA tardó demasiado en responder. Probá de nuevo en unos segundos."
        : "Prisma no pudo comunicarse con Router IA. Probá de nuevo en unos segundos.");
    }

    if (response.ok) return response;

    lastStatus = response.status;
    if (isTransientRouterStatus(response.status) && attempt < 2) {
      await response.body?.cancel().catch(() => {});
      await wait(900 * (attempt + 1));
      continue;
    }

    const detail = await routerErrorMessage(response);
    if (isTransientRouterStatus(response.status)) {
      throw new Error(
        `Router IA está temporalmente no disponible (HTTP ${response.status}). Probá de nuevo en unos segundos.`,
      );
    }
    throw new Error(
      `Router IA no pudo completar el paso de Prisma (HTTP ${response.status})${detail ? `: ${detail}` : "."}`,
    );
  }

  throw new Error(
    `Router IA está temporalmente no disponible (HTTP ${lastStatus}). Probá de nuevo en unos segundos.`,
  );
}

async function parseAssistantResponse(response: Response) {
  const payload = (await response.json()) as {
    choices?: Array<{
      message?: { content?: unknown; tool_calls?: unknown };
    }>;
  };
  const rawMessage = payload.choices?.[0]?.message;
  const content =
    typeof rawMessage?.content === "string" ? rawMessage.content : null;
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
  messages: AgentMessage[],
) {
  const finalMessages: AgentMessage[] = [
    ...messages,
    {
      role: "system",
      content:
        "Cerrá esta solicitud ahora. No hay más herramientas disponibles. Usá únicamente la memoria, el código y los resultados de herramientas ya obtenidos. Respondé en español, de forma concreta: qué revisaste, qué encontraste, dónde está el problema o la mejor hipótesis sustentada, y cuál es el siguiente paso. Si faltó evidencia para afirmar una causa, decilo sin volver a pedir búsquedas ya realizadas.",
    },
  ];
  const response = await requestRouter(provider, finalMessages, { tools: false });
  const { content } = await parseAssistantResponse(response);
  if (!content?.trim()) {
    throw new Error("Prisma investigó el caso pero no pudo sintetizar una respuesta final.");
  }
  return content.trim();
}

export async function runPrismaAgent(input: {
  provider: AiProviderConfig;
  messages: AgentInputMessage[];
  mode: "chat" | "document";
}) {
  const importantMemories = await listImportantMemories(
    ["global", "prisma", "corex"],
    32,
  );
  const latestUserText = [...input.messages]
    .reverse()
    .find((message) => message.role === "user")?.content ?? "";
  const keywordMemories = (
    await Promise.all(
      diagnosticKeywords(latestUserText).map((keyword) =>
        searchPrismaMemory(keyword, undefined, 8).catch(() => []),
      ),
    )
  ).flat();
  const memoryById = new Map<number, (typeof importantMemories)[number]>();
  for (const memory of [...importantMemories, ...keywordMemories]) {
    memoryById.set(memory.id, memory);
  }
  const memories = [...memoryById.values()].slice(0, 36);

  const system = [
    "Eres Prisma, agente responsable de conocer, preservar y evolucionar CoreX.",
    "Responde en español por defecto y de forma directa. Tu objetivo no es devolver trabajo al usuario sino resolver con el contexto y las herramientas disponibles.",
    "Tu memoria persistente es contexto operativo. Cuando el usuario nombre un proyecto, pantalla, etapa, error o decisión previa, úsala antes de pedir que te repita información.",
    "No inventes el estado de CoreX: si depende del código actual, usa herramientas de lectura/búsqueda.",
    "PROTOCOLO DE DIAGNÓSTICO DE COREX: 1) identifica proyecto/pantalla/fase a partir de lo que el usuario ya dijo; 2) consulta memoria relevante; 3) busca en corex/ textos visibles, nombres de etapas, rutas, componentes, errores o funciones relacionados; 4) lee los archivos candidatos; 5) formula una hipótesis basada en evidencia; 6) recién entonces pide un dato al usuario si sigue siendo imposible obtenerlo con tus herramientas.",
    "No respondas de entrada con frases genéricas como 'pasame el log', 'decime el archivo', 'compartí la ruta' o 'dame más información' cuando todavía puedas buscar memoria o CoreX por tu cuenta.",
    "No repitas una herramienta con exactamente los mismos argumentos dentro de una misma solicitud. Si una búsqueda ya se hizo, usa su resultado o cambia la consulta de manera sustancial.",
    "En un diagnóstico normal, prioriza una búsqueda de memoria, hasta dos búsquedas distintas en CoreX y luego lectura de los archivos candidatos. Cuando tengas evidencia suficiente, deja de investigar y responde.",
    "Si el usuario señala una pantalla o etapa, por ejemplo Diseño, vista previa o Mi Primera App, trata esos nombres como pistas de búsqueda: recupera memoria y busca esos textos o conceptos en el repo antes de preguntar.",
    "Ante HTTP 400 u otros errores de integración, distingue primero si el origen probable es CoreX, Prisma, Router IA o un proveedor externo. No atribuyas automáticamente el fallo a CoreX.",
    "Antes de proponer o aplicar una modificación de CoreX, recupera memoria relevante, inspecciona la estructura necesaria y lee el archivo actual cuando exista.",
    "Preserva el principio fundamental de CoreX: construir desglosando operaciones pequeñas, sin convertir el trabajo en una única tarea gigante de programación.",
    "No escribas en CoreX por iniciativa propia. Sólo usa corex_write_file o corex_create_file cuando el pedido actual del usuario exija explícitamente aplicar, modificar, corregir, arreglar o implementar algo en CoreX.",
    "Para modificar un archivo existente debes haberlo leído en esta misma solicitud y usar exactamente el SHA devuelto por corex_read_file. Si el SHA cambió, relee y reevalúa antes de intentar otra vez.",
    "Si el usuario sólo consulta, pide diagnóstico, opinión o propuesta, limita tu acción a leer, buscar, recordar y, si corresponde, corex_prepare_change; no escribas.",
    "Cuando el usuario identifique un proyecto, fase, causa de error, decisión arquitectónica o corrección importante que pueda afectar trabajo futuro, guárdalo con memory_remember. No dependas sólo del historial visible.",
    "Después de un cambio aplicado correctamente, conserva en memoria el cambio, el motivo y cualquier invariante arquitectónica relevante.",
    "Cuando diagnostiques, comunica de forma breve: qué entendiste, dónde buscaste, qué encontraste y cuál es el siguiente paso. Evita listados de posibilidades sin investigar.",
    input.mode === "document"
      ? "Si el usuario pide un documento, redacta el documento completo."
      : "Mantén una conversación práctica y orientada a resolver.",
    `MEMORIA PERSISTENTE Y CONTEXTO RECUPERADO:\n${memoryBlock(memories)}`,
  ].join("\n\n");

  const messages: AgentMessage[] = [
    { role: "system", content: system },
    ...input.messages.slice(-20),
  ];
  const seenToolSignatures = new Set<string>();
  const MAX_TOOL_ROUNDS = 6;

  for (let step = 0; step < MAX_TOOL_ROUNDS; step += 1) {
    const response = await requestRouter(input.provider, messages, { tools: true });
    const { content, calls } = await parseAssistantResponse(response);

    if (!calls.length) {
      if (!content?.trim()) {
        throw new Error("Prisma no devolvió contenido ni pidió herramientas.");
      }
      return content.trim();
    }

    messages.push({ role: "assistant", content, tool_calls: calls });
    let repeatedToolCall = false;

    for (const call of calls.slice(0, 6)) {
      const signature = `${call.function.name}:${call.function.arguments}`;
      if (seenToolSignatures.has(signature)) {
        repeatedToolCall = true;
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: compact({
            ok: false,
            error: "Esta misma herramienta con estos mismos argumentos ya fue ejecutada. Usa los resultados existentes y cierra el diagnóstico.",
          }),
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

    if (repeatedToolCall || step === MAX_TOOL_ROUNDS - 1) {
      return finalizeWithEvidence(input.provider, messages);
    }
  }

  return finalizeWithEvidence(input.provider, messages);
}
