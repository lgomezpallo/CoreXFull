import {
  type AiProviderConfig,
  getProviderEndpoint,
  getProviderHeaders,
} from "./ai-provider";
import {
  corexCreateFile,
  corexListTree,
  corexManagedWriteSetup,
  corexReadFile,
  corexSearch,
  corexToolStatus,
  corexWriteFile,
} from "./corex-tools";
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
      description: "Busca memoria persistente de Prisma sobre arquitectura, decisiones, errores y cambios previos.",
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
      description: "Guarda algo que Prisma deba conservar entre sesiones.",
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
      description: "Lee un archivo actual dentro de corex/ y devuelve contenido y SHA.",
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
      description: "Busca archivos/código dentro de corex/ antes de asumir dónde vive una función.",
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
  return text.length > 45_000
    ? `${text.slice(0, 45_000)}\n[resultado recortado]`
    : text;
}

export async function runPrismaAgent(input: {
  provider: AiProviderConfig;
  messages: AgentInputMessage[];
  mode: "chat" | "document";
}) {
  const memories = await listImportantMemories(
    ["global", "prisma", "corex"],
    28,
  );

  const system = [
    "Eres Prisma, agente responsable de conocer, preservar y evolucionar CoreX.",
    "Responde en español por defecto y de forma directa.",
    "Tu memoria persistente es parte de tu contexto operativo. Consulta memoria cuando una decisión anterior pueda afectar la respuesta.",
    "No inventes el estado de CoreX: si depende del código actual, usa herramientas de lectura/búsqueda.",
    "Antes de proponer o aplicar una modificación de CoreX, recupera memoria relevante, inspecciona la estructura necesaria y lee el archivo actual cuando exista.",
    "Preserva el principio fundamental de CoreX: construir desglosando operaciones pequeñas, sin convertir el trabajo en una única tarea gigante de programación.",
    "No escribas en CoreX por iniciativa propia. Sólo usa corex_write_file o corex_create_file cuando el pedido actual del usuario exija explícitamente aplicar, modificar, corregir, arreglar o implementar algo en CoreX.",
    "Para modificar un archivo existente debes haberlo leído en esta misma solicitud y usar exactamente el SHA devuelto por corex_read_file. Si el SHA cambió, relee y reevalúa antes de intentar otra vez.",
    "Si el usuario sólo consulta, pide diagnóstico, opinión o propuesta, limita tu acción a leer, buscar, recordar y, si corresponde, corex_prepare_change; no escribas.",
    "Después de un cambio aplicado correctamente, conserva en memoria la decisión o motivo arquitectónico relevante si puede afectar trabajo futuro.",
    input.mode === "document"
      ? "Si el usuario pide un documento, redacta el documento completo."
      : "Mantén una conversación práctica y orientada a resolver.",
    `MEMORIA PERSISTENTE:\n${memoryBlock(memories)}`,
  ].join("\n\n");

  const messages: AgentMessage[] = [
    { role: "system", content: system },
    ...input.messages.slice(-40),
  ];

  for (let step = 0; step < 6; step += 1) {
    const response = await fetch(
      getProviderEndpoint(input.provider.baseUrl, "chat/completions"),
      {
        method: "POST",
        headers: getProviderHeaders(input.provider),
        body: JSON.stringify({
          model: input.provider.model,
          messages,
          tools: TOOL_DEFINITIONS,
          tool_choice: "auto",
          max_tokens: 1800,
          stream: false,
        }),
        signal: AbortSignal.timeout(120_000),
      },
    );

    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 500);
      throw new Error(
        `Router IA no pudo completar el paso de Prisma (HTTP ${response.status})${detail ? `: ${detail}` : ""}`,
      );
    }

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

    if (!calls.length) {
      if (!content?.trim()) {
        throw new Error("Prisma no devolvió contenido ni pidió herramientas.");
      }
      return content.trim();
    }

    messages.push({ role: "assistant", content, tool_calls: calls });
    for (const call of calls.slice(0, 6)) {
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
  }

  throw new Error("Prisma alcanzó el máximo de pasos de herramientas para esta solicitud.");
}
