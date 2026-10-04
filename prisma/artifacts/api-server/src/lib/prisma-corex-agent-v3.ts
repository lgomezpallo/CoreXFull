import {
  type AiProviderConfig,
  getProviderEndpoint,
  getProviderHeaders,
} from "./ai-provider";
import { corexApplyPatch } from "./corex-patch";
import { corexListTree, corexReadFile, corexSearch } from "./corex-ssh-read";
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
  score: number;
};

type Evidence = {
  memories: Awaited<ReturnType<typeof listImportantMemories>>;
  searches: Array<{ query: string; results: SearchHit[] }>;
  files: EvidenceFile[];
  tree: Awaited<ReturnType<typeof corexListTree>> | null;
};

const CASUAL_RE = /^(hola|buenas|buen d[ií]a|buenas tardes|buenas noches|hey|holis|gracias|jaja+|\.\.?|\.\.\.)[!.? ]*$/i;
const COREX_RE = /corex|mi primera app|diseñ|vista previa|preview|builder|xapk|proyecto|archivo|repo|c[oó]digo|componente|ruta|error|fall|diagn[oó]st|revis|ubic|correg|arregl|modific|implement|aplic|cambi/i;
const CONTINUATION_RE = /^(dale|s[ií]|ok|joya|hacelo|aplicalo|aplícalo|corregilo|arreglalo|segu[ií]|otra vez)[!.? ]*$/i;
const MUTATE_RE = /correg|arregl|modific|implement|aplic|cambi|solucion|hacelo|met[eé] el cambio/i;
const NEGATIVE_MUTATION_RE = /no\s+(?:modifi|toqu|cambi|apli|corrij|arregl|implement)|sin\s+(?:modificar|tocar|cambiar|aplicar)/i;
const ERROR_ASSISTANT_RE = /^(Router IA |Prisma alcanz[oó]|Prisma no pudo|<!doctype|<html)/i;

function wait(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function sanitizeHistory(messages: PrismaAgentInputMessage[], limit = 5) {
  return messages
    .filter((message) => message.role !== "assistant" || !ERROR_ASSISTANT_RE.test(message.content.trim()))
    .slice(-limit)
    .map((message) => ({
      role: message.role,
      content: message.content.slice(0, 1400),
    }));
}

function isCorexTurn(messages: PrismaAgentInputMessage[], latest: string) {
  if (COREX_RE.test(latest)) return true;
  if (!CONTINUATION_RE.test(latest.trim())) return false;
  return messages
    .slice(-6, -1)
    .some((message) => COREX_RE.test(message.content));
}

function contextQuery(messages: PrismaAgentInputMessage[], latest: string) {
  if (!CONTINUATION_RE.test(latest.trim())) return latest;
  const prior = messages
    .slice(-6, -1)
    .filter((message) => COREX_RE.test(message.content))
    .slice(-3)
    .map((message) => message.content)
    .join("\n");
  return `${prior}\n${latest}`.trim();
}

function wantsMutation(messages: PrismaAgentInputMessage[], latest: string) {
  if (NEGATIVE_MUTATION_RE.test(latest)) return false;
  if (MUTATE_RE.test(latest)) return true;
  if (!CONTINUATION_RE.test(latest.trim())) return false;

  const priorAssistant = [...messages]
    .reverse()
    .find((message) => message.role === "assistant")?.content ?? "";
  return /(?:aplicar|corregir|arreglar|modificar|hacer el cambio|parche)/i.test(priorAssistant);
}

function keywords(text: string) {
  const explicit: string[] = [];
  if (/mi primera app/i.test(text)) explicit.push("Mi Primera App");
  if (/diseñ/i.test(text)) explicit.push("Diseño");
  if (/vista previa|preview/i.test(text)) explicit.push("vista previa");
  if (/xapk/i.test(text)) explicit.push("xapk");

  const ignored = new Set([
    "para", "como", "este", "esta", "esto", "esas", "esos", "quiero", "favor",
    "error", "errores", "donde", "sobre", "tiene", "tenes", "tenés", "porque",
    "pero", "entonces", "podés", "podes", "leer", "revisar", "revisa", "corex",
    "proyecto", "cambiar", "cambialo", "corregir", "corregi", "busca", "buscá",
  ]);

  const words = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9@._-]+/g, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 4 && !ignored.has(word));

  return [...new Set([...explicit, ...words])].slice(0, 5);
}

async function routerError(response: Response) {
  const text = (await response.text().catch(() => "")).slice(0, 900).trim();
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown } | string; message?: unknown };
    if (typeof parsed.error === "string") return parsed.error;
    if (parsed.error && typeof parsed.error === "object" && typeof parsed.error.message === "string") return parsed.error.message;
    if (typeof parsed.message === "string") return parsed.message;
  } catch {}
  if (/<!doctype\s+html|<html[\s>]/i.test(text)) return "";
  return text.replace(/\s+/g, " ").slice(0, 300);
}

async function callRouter(provider: AiProviderConfig, messages: AgentMessage[], maxTokens = 1000) {
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
      if (typeof content !== "string" || !content.trim()) throw new Error("Router IA respondió sin contenido utilizable.");
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

function memoryText(memories: Evidence["memories"]) {
  return memories
    .slice(0, 12)
    .map((memory) => `- ${memory.key}: ${String(memory.content ?? "").slice(0, 650)}`)
    .join("\n");
}

async function gatherCorexEvidence(queryText: string): Promise<Evidence> {
  const terms = keywords(queryText);
  const memoryBatches = await Promise.all(
    terms.slice(0, 3).map((term) => searchPrismaMemory(term, undefined, 5).catch(() => [])),
  );
  const important = await listImportantMemories(["prisma", "corex"], 10).catch(() => []);
  const memoryById = new Map<number, (typeof important)[number]>();
  for (const item of [...important, ...memoryBatches.flat()]) memoryById.set(item.id, item);
  const memories = [...memoryById.values()].slice(0, 12);

  const searches: Evidence["searches"] = [];
  for (const term of terms.slice(0, 4)) {
    const result = await corexSearch(term).catch(() => ({ query: term, results: [] as SearchHit[] }));
    searches.push({ query: result.query, results: result.results as SearchHit[] });
  }

  const scoreByPath = new Map<string, number>();
  for (const search of searches) {
    for (const hit of search.results) scoreByPath.set(hit.path, (scoreByPath.get(hit.path) ?? 0) + 1);
  }

  const rankedPaths = [...scoreByPath.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);

  const files: EvidenceFile[] = [];
  for (const [path, score] of rankedPaths) {
    try {
      const file = await corexReadFile(path);
      files.push({
        path: file.path,
        sha: file.sha,
        size: file.size,
        content: file.content.slice(0, 9000),
        truncated: file.truncated || file.content.length > 9000,
        score,
      });
    } catch {}
  }

  let tree: Evidence["tree"] = null;
  if (!files.length) tree = await corexListTree("corex", 3).catch(() => null);
  return { memories, searches, files, tree };
}

function evidenceText(evidence: Evidence) {
  const searchText = evidence.searches
    .map((search) => {
      const hits = search.results.slice(0, 10)
        .map((hit) => `  ${hit.path}:${hit.line ?? "?"} ${hit.excerpt.slice(0, 300)}`)
        .join("\n");
      return `BÚSQUEDA ${search.query}:\n${hits || "  sin coincidencias"}`;
    })
    .join("\n\n");

  const filesText = evidence.files
    .map((file) => `ARCHIVO ${file.path} SHA=${file.sha} SCORE=${file.score} SIZE=${file.size}\n${file.content}${file.truncated ? "\n[recortado]" : ""}`)
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

async function runCasual(provider: AiProviderConfig, latest: string) {
  return callRouter(provider, [
    {
      role: "system",
      content: "Sos Prisma, asistente dedicado a CoreX. Respondé en español, natural y breve. Es conversación casual: no uses ni simules herramientas ni arrastres contexto técnico.",
    },
    { role: "user", content: latest.slice(0, 1200) },
  ], 500);
}

async function synthesizeDiagnosis(
  provider: AiProviderConfig,
  requestText: string,
  history: PrismaAgentInputMessage[],
  evidence: Evidence,
) {
  return callRouter(provider, [
    {
      role: "system",
      content: "Sos Prisma, mantenedor de CoreX. La investigación ya fue desglosada por código en memoria, búsquedas y lecturas. No intentes llamar herramientas. No inventes. Respondé breve: qué entendiste, qué encontraste, causa o mejor hipótesis y siguiente paso.",
    },
    ...sanitizeHistory(history, 4),
    { role: "user", content: `PEDIDO/CONTEXTO:\n${requestText.slice(0, 2400)}\n\nEVIDENCIA COREX:\n${evidenceText(evidence)}` },
  ], 1300);
}

async function chooseMutationTarget(
  provider: AiProviderConfig,
  requestText: string,
  evidence: Evidence,
) {
  if (!evidence.files.length) throw new Error("Prisma no encontró un archivo concreto y no va a modificar CoreX a ciegas.");

  if (evidence.files.length === 1) {
    const file = evidence.files[0];
    if (file.truncated) throw new Error("El único archivo candidato requiere una lectura más acotada antes de editarlo.");
    return { file, reason: "Es el único archivo encontrado por la investigación determinista para este caso." };
  }

  if (evidence.files[0].score > evidence.files[1].score) {
    const file = evidence.files[0];
    if (file.truncated) throw new Error("El archivo candidato principal requiere una lectura más acotada antes de editarlo.");
    return { file, reason: "Es el candidato con más coincidencias independientes en la búsqueda determinista." };
  }

  const candidates = evidence.files
    .map((file) => `- ${file.path} SCORE=${file.score} SHA=${file.sha} SIZE=${file.size}`)
    .join("\n");
  const raw = await callRouter(provider, [
    {
      role: "system",
      content: "Sos el selector de archivo de Prisma. Elegí UN solo archivo entre los candidatos ya leídos. No generes código. Devolvé sólo JSON válido con targetPath y reason. targetPath debe copiar exactamente una ruta candidata.",
    },
    { role: "user", content: `PEDIDO:\n${requestText.slice(0, 1800)}\n\nCANDIDATOS:\n${candidates}` },
  ], 450);

  const parsed = parseJsonObject(raw);
  const targetPath = typeof parsed.targetPath === "string" ? parsed.targetPath.trim() : "";
  const reason = typeof parsed.reason === "string" ? parsed.reason.trim().slice(0, 700) : "";
  const file = evidence.files.find((candidate) => candidate.path === targetPath);
  if (!file) throw new Error("Prisma no pudo resolver con seguridad la ambigüedad entre archivos candidatos.");
  if (file.truncated) throw new Error("El archivo elegido requiere una lectura más acotada antes de editarlo.");
  return { file, reason: reason || "Archivo seleccionado entre candidatos equivalentes." };
}

async function generatePatch(
  provider: AiProviderConfig,
  requestText: string,
  file: EvidenceFile,
  reason: string,
  previousError = "",
) {
  const raw = await callRouter(provider, [
    {
      role: "system",
      content: "Sos el editor de Prisma para CoreX. Modificá UN solo archivo y hacé el cambio mínimo. Devolvé únicamente JSON válido con message y patch. patch debe ser unified diff aplicable por git apply, con --- a/RUTA y +++ b/RUTA exactos. No uses markdown ni cambies otros archivos.",
    },
    {
      role: "user",
      content: [
        `PEDIDO:\n${requestText.slice(0, 2200)}`,
        `MOTIVO DEL ARCHIVO:\n${reason}`,
        previousError ? `ERROR PREVIO A CORREGIR:\n${previousError.slice(0, 900)}` : "",
        `ARCHIVO: ${file.path}`,
        `SHA: ${file.sha}`,
        `CONTENIDO:\n${file.content}`,
      ].filter(Boolean).join("\n\n"),
    },
  ], 2800);

  const parsed = parseJsonObject(raw);
  const message = typeof parsed.message === "string" ? parsed.message.trim().slice(0, 160) : "";
  const patch = typeof parsed.patch === "string" ? parsed.patch.trim() : "";
  if (!message || !patch) throw new Error("El modelo no generó un parche estructurado completo.");
  if (!patch.includes(`--- a/${file.path}`) || !patch.includes(`+++ b/${file.path}`)) {
    throw new Error("El parche no apunta exactamente al único archivo autorizado.");
  }
  return { message, patch };
}

async function generatePatchBounded(
  provider: AiProviderConfig,
  requestText: string,
  file: EvidenceFile,
  reason: string,
  firstError = "",
) {
  try {
    return await generatePatch(provider, requestText, file, reason, firstError);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "salida inválida";
    return generatePatch(provider, requestText, file, reason, detail);
  }
}

async function runCorexMutation(
  provider: AiProviderConfig,
  requestText: string,
  history: PrismaAgentInputMessage[],
  evidence: Evidence,
) {
  let target: Awaited<ReturnType<typeof chooseMutationTarget>>;
  try {
    target = await chooseMutationTarget(provider, requestText, evidence);
  } catch (error) {
    const diagnosis = await synthesizeDiagnosis(provider, requestText, history, evidence);
    return `${diagnosis}\n\nNo toqué CoreX: ${error instanceof Error ? error.message : "no hay un objetivo seguro"}`;
  }

  let generated: Awaited<ReturnType<typeof generatePatchBounded>>;
  try {
    generated = await generatePatchBounded(provider, requestText, target.file, target.reason);
  } catch (error) {
    return `No toqué CoreX. Encontré ${target.file.path}, pero no pude producir un parche válido en dos intentos: ${error instanceof Error ? error.message : "salida inválida"}`;
  }

  let applied: Awaited<ReturnType<typeof corexApplyPatch>>;
  try {
    applied = await corexApplyPatch({
      path: target.file.path,
      expectedSha: target.file.sha,
      patch: generated.patch,
      message: generated.message,
    });
  } catch (firstError) {
    const detail = firstError instanceof Error ? firstError.message : "El parche no validó.";
    try {
      generated = await generatePatchBounded(provider, requestText, target.file, target.reason, detail);
      applied = await corexApplyPatch({
        path: target.file.path,
        expectedSha: target.file.sha,
        patch: generated.patch,
        message: generated.message,
      });
    } catch (secondError) {
      return `No toqué CoreX. El parche para ${target.file.path} no pasó la validación segura: ${secondError instanceof Error ? secondError.message : "error de validación"}`;
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

export async function runPrismaCorexAgent(input: {
  provider: AiProviderConfig;
  messages: PrismaAgentInputMessage[];
  mode: "chat" | "document";
}) {
  const latest = [...input.messages].reverse().find((message) => message.role === "user")?.content?.trim() ?? "";
  if (!latest) throw new Error("Prisma recibió un mensaje vacío.");

  const corexTurn = isCorexTurn(input.messages, latest);
  if (!corexTurn && CASUAL_RE.test(latest)) return runCasual(input.provider, latest);

  if (corexTurn) {
    const requestText = contextQuery(input.messages, latest);
    const evidence = await gatherCorexEvidence(requestText);
    if (wantsMutation(input.messages, latest)) {
      return runCorexMutation(input.provider, requestText, input.messages, evidence);
    }
    return synthesizeDiagnosis(input.provider, requestText, input.messages, evidence);
  }

  return callRouter(input.provider, [
    {
      role: "system",
      content: "Sos Prisma y tu único dominio operativo es CoreX. Conversá en español y de forma directa. No inventes capacidades fuera de tu función.",
    },
    ...sanitizeHistory(input.messages, 5),
  ], input.mode === "document" ? 1400 : 800);
}
