import {
  type AiProviderConfig,
  getProviderEndpoint,
  getProviderHeaders,
} from "./ai-provider";
import {
  corexReadFile,
  corexSearch,
  corexListTree,
} from "./corex-ssh-read";
import { corexApplyPatch } from "./corex-patch";
import {
  listImportantMemories,
  rememberPrisma,
  searchPrismaMemory,
} from "./prisma-memory";

export type PrismaAgentInputMessage = {
  role: "user" | "assistant";
  content: string;
};

type AgentMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type SearchHit = {
  path: string;
  line: number | null;
  excerpt: string;
};

type EvidenceFile = {
  path: string;
  sha: string;
  size: number;
  content: string;
  truncated: boolean;
};

const CASUAL_RE = /^(hola|buenas|buen d[ií]a|buenas tardes|buenas noches|hey|holis|gracias|ok|joya|jaja+|\.\.?|\.\.\.)[!.? ]*$/i;
const COREX_RE = /corex|mi primera app|diseñ|vista previa|preview|builder|xapk|proyecto|archivo|repo|c[oó]digo|componente|ruta|error|fall|diagn[oó]st|revis|ubic|correg|arregl|modific|implement|aplic|cambi/i;
const MUTATE_RE = /correg[ií]|arregl[aá]|modific[aá]|implement[aá]|aplic[aá]|cambi[aá]|solucion[aá]|hacelo|hace el cambio|met[eé] el cambio/i;
const NEGATIVE_MUTATION_RE = /no\s+(?:modifi|toqu|cambi|apli|corrij|arregl|implement)|sin\s+(?:modificar|tocar|cambiar|aplicar)/i;
const ERROR_ASSISTANT_RE = /^(Router IA |Prisma alcanz[oó]|Prisma no pudo|<!doctype|<html)/i;

function wait(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function sanitizeHistory(messages: PrismaAgentInputMessage[], limit = 6) {
  return messages
    .filter((message) => {
      if (message.role !== "assistant") return true;
      return !ERROR_ASSISTANT_RE.test(message.content.trim());
    })
    .slice(-limit)
    .map((message) => ({
      role: message.role,
      content: message.content.slice(0, 1400),
    }));
}

function keywords(text: string) {
  const explicit: string[] = [];
  if (/mi primera app/i.test(text)) explicit.push("Mi Primera App");
  if (/diseñ/i.test(text)) explicit.push("Diseño");
  if (/vista previa|preview/i.test(text)) explicit.push("vista previa");
  if (/xapk/i.test(text)) explicit.push("xapk");

  const ignored = new Set([
    "para", "como", "este", "esta", "esto", "esas", "esos", "quiero",
    "favor", "error", "errores", "donde", "sobre", "tiene", "tenes", "tenés",
    "porque", "pero", "entonces", "podés", "podes", "leer", "leé", "revisar",
    "revisa", "revisá", "corex", "proyecto",
  ]);

  const words = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9@._-]+/g, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 4 && !ignored.has(word));

  return [...new Set([...explicit, ...words])].slice(0, 4);
}

function wantsMutation(messages: PrismaAgentInputMessage[], latestUserText: string) {
  const latest = latestUserText.trim();
  if (NEGATIVE_MUTATION_RE.test(latest)) return false;
  if (MUTATE_RE.test(latest)) return true;

  if (/^(dale|s[ií]|ok|joya|hacelo|aplicalo|aplícalo|corregilo|arreglalo)[!. ]*$/i.test(latest)) {
    const previousAssistant = [...messages]
      .reverse()
      .find((message) => message.role === "assistant")?.content ?? "";
    return /(?:aplicar|corregir|arreglar|modificar|cambio|parche)/i.test(previousAssistant);
  }

  return false;
}

async function routerError(response: Response) {
  const text = (await response.text().catch(() => "")).slice(0, 900).trim();
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown } | string; message?: unknown };
    if (typeof parsed.error === "string") return parsed.error;
    if (parsed.error && typeof parsed.error === "object" && typeof parsed.error.message === "string") {
      return parsed.error.message;
    }
    if (typeof parsed.message === "string") return parsed.message;
  } catch {}
  if (/<!doctype\s+html|<html[\s>]/i.test(text)) return "";
  return text.replace(/\s+/g, " ").slice(0, 300);
}

async function callRouter(
  provider: AiProviderConfig,
  messages: AgentMessage[],
  maxTokens = 1000,
) {
  const endpoint = getProviderEndpoint(provider.baseUrl, "chat/completions");
  const body = JSON.stringify({
    model: provider.model,
    messages,
    max_tokens: maxTokens,
    stream: false,
  });

  const waits = [3500, 6000, 9000];
  let lastStatus = 502;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: getProviderHeaders(provider),
        body,
        signal: AbortSignal.timeout(120_000),
      });
    } catch (error) {
      if (attempt < 3) {
        await wait(waits[attempt]);
        continue;
      }
      const timeout = error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name);
      throw new Error(timeout ? "Router IA tardó demasiado en responder." : "Prisma no pudo comunicarse con Router IA.");
    }

    if (response.ok) {
      const payload = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> };
      const content = payload.choices?.[0]?.message?.content;
      if (typeof content !== "string" || !content.trim()) {
        throw new Error("Router IA respondió sin contenido utilizable.");
      }
      return content.trim();
    }

    lastStatus = response.status;
    if ([502, 503, 504].includes(response.status) && attempt < 3) {
      await response.body?.cancel().catch(() => {});
      await wait(waits[attempt]);
      continue;
    }

    const detail = await routerError(response);
    throw new Error(`Router IA no pudo completar Prisma (HTTP ${response.status})${detail ? `: ${detail}` : "."}`);
  }

  throw new Error(`Router IA no quedó disponible (HTTP ${lastStatus}).`);
}

function parseJsonObject(text: string): Record<string, unknown> {
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first < 0 || last <= first) throw new Error("El modelo no devolvió JSON válido.");
  const parsed = JSON.parse(cleaned.slice(first, last + 1));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("El JSON devuelto no es un objeto.");
  return parsed as Record<string, unknown>;
}

function memoryText(memories: Awaited<ReturnType<typeof listImportantMemories>>) {
  return memories
    .slice(0, 12)
    .map((memory) => `- ${memory.key}: ${String(memory.content ?? "").slice(0, 650)}`)
    .join("\n");
}

async function gatherCorexEvidence(latestUserText: string) {
  const searchTerms = keywords(latestUserText);
  const memoryBatches = await Promise.all(
    searchTerms.slice(0, 3).map((term) => searchPrismaMemory(term, undefined, 5).catch(() => [])),
  );
  const important = await listImportantMemories(["prisma", "corex"], 10).catch(() => []);
  const memoryById = new Map<number, (typeof important)[number]>();
  for (const item of [...important, ...memoryBatches.flat()]) memoryById.set(item.id, item);
  const memories = [...memoryById.values()].slice(0, 12);

  const searches: Array<{ query: string; results: SearchHit[] }> = [];
  for (const term of searchTerms.slice(0, 3)) {
    const result = await corexSearch(term).catch(() => ({ query: term, results: [] as SearchHit[], transport: "error" }));
    searches.push({ query: result.query, results: result.results as SearchHit[] });
  }

  const scoreByPath = new Map<string, number>();
  for (const search of searches) {
    for (const hit of search.results) scoreByPath.set(hit.path, (scoreByPath.get(hit.path) ?? 0) + 1);
  }
  const candidatePaths = [...scoreByPath.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([path]) => path);

  const files: EvidenceFile[] = [];
  for (const path of candidatePaths) {
    try {
      const file = await corexReadFile(path);
      files.push({
        path: file.path,
        sha: file.sha,
        size: file.size,
        content: file.content.slice(0, 9000),
        truncated: file.truncated || file.content.length > 9000,
      });
    } catch {}
  }

  let tree: Awaited<ReturnType<typeof corexListTree>> | null = null;
  if (!files.length) {
    tree = await corexListTree("corex", 3).catch(() => null);
  }

  return { memories, searches, files, tree };
}

function evidenceText(evidence: Awaited<ReturnType<typeof gatherCorexEvidence>>) {
  const searchText = evidence.searches
    .map((search) => {
      const hits = search.results.slice(0, 10)
        .map((hit) => `  ${hit.path}:${hit.line ?? "?"} ${hit.excerpt.slice(0, 300)}`)
        .join("\n");
      return `BÚSQUEDA ${search.query}:\n${hits || "  sin coincidencias"}`;
    })
    .join("\n\n");

  const filesText = evidence.files
    .map((file) => `ARCHIVO ${file.path} SHA=${file.sha} SIZE=${file.size}\n${file.content}${file.truncated ? "\n[recortado]" : ""}`)
    .join("\n\n");

  const treeText = evidence.tree
    ? evidence.tree.entries.slice(0, 140).map((entry) => entry.path).join("\n")
    : "";

  return [
    `MEMORIA:\n${memoryText(evidence.memories) || "sin memoria relevante"}`,
    searchText,
    filesText || `ÁRBOL COREX:\n${treeText || "sin datos"}`,
  ].filter(Boolean).join("\n\n---\n\n").slice(0, 26000);
}

async function runCasual(provider: AiProviderConfig, latestUserText: string) {
  return callRouter(provider, [
    {
      role: "system",
      content: "Sos Prisma, asistente dedicado a CoreX. Respondé en español, natural y breve. Este mensaje es conversación casual: no uses ni simules herramientas, no menciones diagnósticos ni repositorios salvo que el usuario lo pida.",
    },
    { role: "user", content: latestUserText.slice(0, 1200) },
  ], 500);
}

async function synthesizeDiagnosis(
  provider: AiProviderConfig,
  latestUserText: string,
  history: PrismaAgentInputMessage[],
  evidence: Awaited<ReturnType<typeof gatherCorexEvidence>>,
) {
  const messages: AgentMessage[] = [
    {
      role: "system",
      content: [
        "Sos Prisma, mantenedor de CoreX.",
        "Tu trabajo es diagnosticar CoreX con evidencia real, no pedirle al usuario datos que vos ya podés buscar.",
        "La investigación ya fue hecha por código en pasos chicos: memoria, búsquedas y lectura de archivos candidatos.",
        "No inventes archivos ni causas. Si la evidencia no alcanza, decí exactamente qué falta.",
        "Respondé breve: qué entendiste, qué encontraste, causa o mejor hipótesis sustentada y siguiente paso.",
        "No intentes llamar herramientas: en esta etapa sólo sintetizás evidencia.",
      ].join(" "),
    },
    ...sanitizeHistory(history, 4),
    { role: "user", content: `PEDIDO ACTUAL:\n${latestUserText.slice(0, 1800)}\n\nEVIDENCIA COREX:\n${evidenceText(evidence)}` },
  ];
  return callRouter(provider, messages, 1300);
}

async function chooseMutationTarget(
  provider: AiProviderConfig,
  latestUserText: string,
  evidence: Awaited<ReturnType<typeof gatherCorexEvidence>>,
) {
  if (!evidence.files.length) throw new Error("Prisma no encontró un archivo concreto y no va a modificar CoreX a ciegas.");

  const candidates = evidence.files
    .map((file) => `- ${file.path} SHA=${file.sha} SIZE=${file.size}`)
    .join("\n");
  const searchSummary = evidence.searches
    .flatMap((search) => search.results.slice(0, 5).map((hit) => `${hit.path}:${hit.line ?? "?"} ${hit.excerpt.slice(0, 220)}`))
    .join("\n")
    .slice(0, 5000);

  const raw = await callRouter(provider, [
    {
      role: "system",
      content: "Sos el planificador de cambios de Prisma para CoreX. Elegí como máximo UN archivo de la lista candidata. No escribas código todavía. Devolvé únicamente JSON válido con targetPath y reason. targetPath debe ser exactamente uno de los candidatos.",
    },
    {
      role: "user",
      content: `PEDIDO:\n${latestUserText.slice(0, 1600)}\n\nCANDIDATOS:\n${candidates}\n\nCOINCIDENCIAS:\n${searchSummary}`,
    },
  ], 500);

  const parsed = parseJsonObject(raw);
  const targetPath = typeof parsed.targetPath === "string" ? parsed.targetPath.trim() : "";
  const reason = typeof parsed.reason === "string" ? parsed.reason.trim().slice(0, 700) : "";
  const file = evidence.files.find((candidate) => candidate.path === targetPath);
  if (!file) throw new Error("Prisma no pudo elegir de forma segura un archivo de los que había leído.");
  if (file.truncated) throw new Error("El archivo candidato es demasiado grande para editarlo con seguridad en este paso.");
  return { file, reason: reason || "Cambio solicitado por el usuario." };
}

async function generatePatch(
  provider: AiProviderConfig,
  latestUserText: string,
  file: EvidenceFile,
  reason: string,
  previousError = "",
) {
  const raw = await callRouter(provider, [
    {
      role: "system",
      content: [
        "Sos el editor de Prisma para CoreX.",
        "Trabajá sobre UN solo archivo y hacé el cambio mínimo necesario.",
        "Devolvé únicamente JSON válido con dos campos: message y patch.",
        "patch debe ser un unified diff aplicable por git apply, usando exactamente --- a/RUTA y +++ b/RUTA.",
        "No incluyas markdown, explicaciones ni cambios en otros archivos.",
      ].join(" "),
    },
    {
      role: "user",
      content: [
        `PEDIDO:\n${latestUserText.slice(0, 1600)}`,
        `MOTIVO DEL ARCHIVO ELEGIDO:\n${reason}`,
        previousError ? `ERROR DEL PARCHE ANTERIOR (corregilo):\n${previousError.slice(0, 700)}` : "",
        `ARCHIVO: ${file.path}`,
        `SHA ACTUAL: ${file.sha}`,
        `CONTENIDO ACTUAL:\n${file.content}`,
      ].filter(Boolean).join("\n\n"),
    },
  ], 3000);

  const parsed = parseJsonObject(raw);
  const message = typeof parsed.message === "string" ? parsed.message.trim().slice(0, 160) : "";
  const patch = typeof parsed.patch === "string" ? parsed.patch.trim() : "";
  if (!message || !patch) throw new Error("Prisma no generó un parche estructurado válido.");
  if (!patch.includes(`--- a/${file.path}`) || !patch.includes(`+++ b/${file.path}`)) {
    throw new Error("El parche generado no apunta exactamente al archivo autorizado.");
  }
  return { message, patch };
}

async function runCorexMutation(
  provider: AiProviderConfig,
  latestUserText: string,
  history: PrismaAgentInputMessage[],
  evidence: Awaited<ReturnType<typeof gatherCorexEvidence>>,
) {
  let target: Awaited<ReturnType<typeof chooseMutationTarget>>;
  try {
    target = await chooseMutationTarget(provider, latestUserText, evidence);
  } catch (error) {
    const diagnosis = await synthesizeDiagnosis(provider, latestUserText, history, evidence);
    return `${diagnosis}\n\nNo toqué CoreX: ${error instanceof Error ? error.message : "no pude elegir un archivo seguro"}`;
  }

  let generated = await generatePatch(provider, latestUserText, target.file, target.reason);
  let applied: Awaited<ReturnType<typeof corexApplyPatch>>;
  try {
    applied = await corexApplyPatch({
      path: target.file.path,
      expectedSha: target.file.sha,
      patch: generated.patch,
      message: generated.message,
    });
  } catch (firstError) {
    const detail = firstError instanceof Error ? firstError.message : "El primer parche no validó.";
    generated = await generatePatch(provider, latestUserText, target.file, target.reason, detail);
    try {
      applied = await corexApplyPatch({
        path: target.file.path,
        expectedSha: target.file.sha,
        patch: generated.patch,
        message: generated.message,
      });
    } catch (secondError) {
      return `No toqué CoreX. Encontré el archivo ${target.file.path}, pero el parche no pasó la validación segura después de dos intentos: ${secondError instanceof Error ? secondError.message : "error de validación"}`;
    }
  }

  await rememberPrisma({
    kind: "change",
    scope: "corex",
    key: `change:${target.file.path}`,
    content: `Se aplicó '${generated.message}' en ${target.file.path}. Commit ${applied.commitSha}. Motivo: ${target.reason}`,
    importance: 90,
  }).catch(() => undefined);

  return `Corregí CoreX en ${target.file.path}. Cambio: ${generated.message}. Commit ${applied.commitSha.slice(0, 12)}. El parche fue validado contra el SHA leído antes de escribir.`;
}

async function runCorexDiagnosis(
  provider: AiProviderConfig,
  latestUserText: string,
  history: PrismaAgentInputMessage[],
) {
  const evidence = await gatherCorexEvidence(latestUserText);
  return synthesizeDiagnosis(provider, latestUserText, history, evidence);
}

export async function runPrismaCorexAgent(input: {
  provider: AiProviderConfig;
  messages: PrismaAgentInputMessage[];
  mode: "chat" | "document";
}) {
  const latestUserText = [...input.messages].reverse().find((message) => message.role === "user")?.content?.trim() ?? "";
  if (!latestUserText) throw new Error("Prisma recibió un mensaje vacío.");

  if (CASUAL_RE.test(latestUserText)) {
    return runCasual(input.provider, latestUserText);
  }

  if (COREX_RE.test(latestUserText)) {
    const evidence = await gatherCorexEvidence(latestUserText);
    if (wantsMutation(input.messages, latestUserText)) {
      return runCorexMutation(input.provider, latestUserText, input.messages, evidence);
    }
    return synthesizeDiagnosis(input.provider, latestUserText, input.messages, evidence);
  }

  return callRouter(input.provider, [
    {
      role: "system",
      content: "Sos Prisma y tu único dominio operativo es CoreX. Conversá en español y de forma directa. Si el usuario pide algo ajeno a CoreX, respondé normalmente pero no inventes capacidades fuera de tu función.",
    },
    ...sanitizeHistory(input.messages, 5),
  ], input.mode === "document" ? 1400 : 800);
}
