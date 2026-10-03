import { isIP } from "node:net";

export const PROVIDER_PRESETS = Object.freeze([
  { id: "groq", name: "Groq", baseUrl: "https://api.groq.com/openai/v1" },
  { id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1" },
  { id: "openrouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" },
  { id: "custom", name: "Personalizado", baseUrl: "" },
]);

export const GROQ_FREE_PLAN_MODEL_IDS = Object.freeze([
  "canopylabs/orpheus-arabic-saudi",
  "canopylabs/orpheus-v1-english",
  "meta-llama/llama-prompt-guard-2-22m",
  "meta-llama/llama-prompt-guard-2-86m",
  "openai/gpt-oss-120b",
  "openai/gpt-oss-20b",
  "openai/gpt-oss-safeguard-20b",
  "qwen/qwen3.8-27b",
  "whisper-large-v3",
  "whisper-large-v3-turbo",
]);

export const CLOUDFLARE_PAID_ONLY_MODEL_IDS = Object.freeze([
  "@cf/moonshotai/kimi-k2.6",
  "@cf/moonshotai/kimi-k2.7-code",
  "@cf/zai-org/glm-5.2",
  "@cf/zai-org/glm-5.3",
  "@cf/zai-org/glm-5.3-flash",
  "@cf/deepseek-ai/deepseek-v4-flash-0731",
  "@cf/deepseek-ai/deepseek-v4-pro-0813",
]);

export const ROUTER_TASK_TYPES = Object.freeze([
  "chat",
  "coding",
  "reasoning",
  "summarization",
  "vision",
  "document",
  "transcription",
  "speech",
  "image_generation",
  "image_editing",
]);

export const PROVIDER_CAPABILITIES = Object.freeze([
  ...ROUTER_TASK_TYPES,
  "long_context",
  "fast",
]);

const presetById = new Map(PROVIDER_PRESETS.map((preset) => [preset.id, preset]));
const MAX_PROVIDER_RESPONSE_BYTES = 2_000_000;
const MAX_MODEL_METADATA_LIST_ITEMS = 20;
const MAX_MODEL_METADATA_STRING_LENGTH = 64;
const MAX_MODEL_PRICING_FIELDS = 30;
const MAX_DISCOVERED_MODELS = 2_000;
const CLOUDFLARE_PAGE_SIZE = 100;
const groqFreePlanModelIds = new Set(GROQ_FREE_PLAN_MODEL_IDS);
const cloudflarePaidOnlyModelIds = new Set(CLOUDFLARE_PAID_ONLY_MODEL_IDS);

export function isGroqFreePlanBaseUrl(baseUrl) {
  try {
    const parsed = new URL(baseUrl);
    return parsed.origin === "https://api.groq.com" && parsed.pathname.replace(/\/+$/, "") === "/openai/v1" && !parsed.search && !parsed.hash;
  } catch {
    return false;
  }
}

export function isGroqFreePlanModel(model, baseUrl) {
  return isGroqFreePlanBaseUrl(baseUrl) && typeof model?.id === "string" && groqFreePlanModelIds.has(model.id.trim().toLowerCase());
}

export function isNvidiaApiCatalogBaseUrl(baseUrl) {
  try {
    const parsed = new URL(baseUrl);
    return parsed.origin === "https://integrate.api.nvidia.com" && parsed.pathname.replace(/\/+$/, "") === "/v1" && !parsed.search && !parsed.hash;
  } catch {
    return false;
  }
}

export function isCloudflareWorkersAiBaseUrl(baseUrl) {
  try {
    const parsed = new URL(baseUrl);
    return (
      parsed.origin === "https://api.cloudflare.com" &&
      /^\/client\/v4\/accounts\/[A-Za-z0-9_-]{16,64}\/ai$/.test(parsed.pathname.replace(/\/+$/, "")) &&
      !parsed.search &&
      !parsed.hash
    );
  } catch {
    return false;
  }
}

export function isCloudflareWorkersAiFreeModel(model, baseUrl) {
  return (
    isCloudflareWorkersAiBaseUrl(baseUrl) &&
    typeof model?.id === "string" &&
    model.id.startsWith("@cf/") &&
    !cloudflarePaidOnlyModelIds.has(model.id)
  );
}

export function normalizeCapabilities(value) {
  if (!Array.isArray(value)) throw new Error("Elegí al menos una capacidad para este modelo.");
  const capabilities = [...new Set(value)];
  if (capabilities.length === 0 || capabilities.some((capability) => typeof capability !== "string" || !PROVIDER_CAPABILITIES.includes(capability))) {
    throw new Error("Las capacidades seleccionadas no son válidas.");
  }
  return capabilities;
}

export function normalizeModelMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const metadata = {};
  const contextLength = Number(value.contextLength);
  if (Number.isSafeInteger(contextLength) && contextLength > 0) metadata.contextLength = contextLength;

  for (const key of ["inputModalities", "outputModalities", "supportedParameters"]) {
    if (!Array.isArray(value[key])) continue;
    const values = [...new Set(value[key]
      .filter((item) => typeof item === "string" && item.trim().length > 0 && item.trim().length <= MAX_MODEL_METADATA_STRING_LENGTH)
      .map((item) => item.trim().toLowerCase()))].slice(0, MAX_MODEL_METADATA_LIST_ITEMS);
    if (values.length > 0) metadata[key] = values;
  }

  if (["groq_free_plan", "nvidia_api_catalog_prototyping", "cloudflare_workers_ai_free"].includes(value.freePlanAccess)) {
    metadata.freePlanAccess = value.freePlanAccess;
  }

  if (typeof value.taskName === "string" && value.taskName.trim().length > 0 && value.taskName.trim().length <= 80) {
    metadata.taskName = value.taskName.trim();
  }

  if (value.pricing && typeof value.pricing === "object" && !Array.isArray(value.pricing)) {
    const pricing = {};
    const entries = Object.entries(value.pricing);
    let pricingIsComplete = entries.length > 0 && entries.length <= MAX_MODEL_PRICING_FIELDS;
    for (const [rawKey, price] of entries) {
      const key = typeof rawKey === "string" ? rawKey.trim().toLowerCase() : "";
      const text = typeof price === "number" && Number.isFinite(price) ? String(price) : typeof price === "string" ? price.trim() : "";
      if (!/^[a-z][a-z0-9_]{0,63}$/.test(key) || Object.hasOwn(pricing, key) || text.length > MAX_MODEL_METADATA_STRING_LENGTH || !/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text) || !Number.isFinite(Number(text)) || Number(text) < 0) {
        pricingIsComplete = false;
        break;
      }
      pricing[key] = text;
    }
    if (pricingIsComplete && Object.keys(pricing).length === entries.length) metadata.pricing = pricing;
  }
  return metadata;
}

export function isExplicitlyFreeModel(model) {
  if (model?.freePlanAccess === "cloudflare_workers_ai_free") return true;
  const pricing = normalizeModelMetadata({ pricing: model?.pricing }).pricing;
  if (!pricing || !Object.hasOwn(pricing, "prompt") || !Object.hasOwn(pricing, "completion")) return false;
  return Object.values(pricing).every((price) => Number(price) === 0);
}

function taskCapabilities(taskName, modelId) {
  const task = typeof taskName === "string" ? taskName.trim().toLowerCase() : "";
  const capabilities = [];
  if (task === "text generation") capabilities.push("chat");
  else if (task === "image-to-text") capabilities.push("vision");
  else if (task === "automatic speech recognition") capabilities.push("transcription");
  else if (task === "text-to-speech") capabilities.push("speech");
  else if (task === "text-to-image") {
    capabilities.push("image_generation");
    if (/flux-2-(?:dev|klein)/i.test(modelId ?? "")) capabilities.push("image_editing");
  } else if (task === "summarization") capabilities.push("summarization");
  return capabilities;
}

export function inferModelCapabilities(model) {
  const metadata = normalizeModelMetadata(model);
  const inputs = metadata.inputModalities ?? [];
  const outputs = metadata.outputModalities ?? [];
  const parameters = metadata.supportedParameters ?? [];
  const capabilities = [...taskCapabilities(metadata.taskName, model?.id)];
  if (inputs.includes("text") && outputs.includes("text") && !capabilities.includes("chat")) capabilities.push("chat");
  if (inputs.includes("image") && outputs.includes("text") && !capabilities.includes("vision")) capabilities.push("vision");
  if (inputs.some((modality) => ["document", "pdf"].includes(modality)) && !capabilities.includes("document")) capabilities.push("document");
  if (inputs.includes("audio") && outputs.some((modality) => ["text", "transcription"].includes(modality)) && !capabilities.includes("transcription")) capabilities.push("transcription");
  if (inputs.includes("text") && outputs.some((modality) => ["audio", "speech"].includes(modality)) && !capabilities.includes("speech")) capabilities.push("speech");
  if (inputs.includes("text") && outputs.includes("image") && !capabilities.includes("image_generation")) capabilities.push("image_generation");
  if (inputs.includes("image") && outputs.includes("image") && !capabilities.includes("image_editing")) capabilities.push("image_editing");
  if (parameters.some((parameter) => ["image", "image_generation", "images", "generate_image"].includes(parameter)) && !capabilities.includes("image_generation")) capabilities.push("image_generation");
  if (Number.isSafeInteger(metadata.contextLength) && metadata.contextLength >= 100_000) capabilities.push("long_context");
  if (/coder|code/i.test(model?.id ?? "") && capabilities.includes("chat")) capabilities.push("coding");
  if (/reason|qwq|r1|gpt-oss/i.test(model?.id ?? "") && capabilities.includes("chat")) capabilities.push("reasoning");
  return [...new Set(capabilities)];
}

export function normalizeProviderInput(input) {
  const provider = typeof input?.provider === "string" ? input.provider.trim().toLowerCase() : "";
  const preset = presetById.get(provider);
  if (!preset) throw new Error("Elegí un proveedor disponible.");
  const name = provider === "custom" ? (typeof input?.name === "string" ? input.name.trim() : "") : preset.name;
  if (!name || name.length > 80) throw new Error("El nombre del proveedor debe tener entre 1 y 80 caracteres.");
  const baseUrl = provider === "custom" ? normalizeCustomBaseUrl(input?.baseUrl) : preset.baseUrl;
  const apiKey = typeof input?.apiKey === "string" ? input.apiKey.trim() : "";
  if (!apiKey || apiKey.length > 4096 || /\s/.test(apiKey)) throw new Error("Ingresá una API key válida.");
  const model = typeof input?.model === "string" ? input.model.trim() : "";
  if (model.length > 200) throw new Error("El identificador del modelo es demasiado largo.");
  const capabilities = Array.isArray(input?.capabilities) ? normalizeCapabilities(input.capabilities) : [];
  const priority = input?.priority === undefined ? 50 : Number(input.priority);
  if (!Number.isInteger(priority) || priority < 1 || priority > 100) throw new Error("La prioridad debe ser un número entero entre 1 y 100.");
  const modelMetadata = normalizeModelMetadata(input?.modelMetadata);
  if (modelMetadata.freePlanAccess === "groq_free_plan" && !isGroqFreePlanModel({ id: model }, baseUrl)) delete modelMetadata.freePlanAccess;
  if (modelMetadata.freePlanAccess === "nvidia_api_catalog_prototyping" && !isNvidiaApiCatalogBaseUrl(baseUrl)) delete modelMetadata.freePlanAccess;
  if (modelMetadata.freePlanAccess === "cloudflare_workers_ai_free" && !isCloudflareWorkersAiFreeModel({ id: model }, baseUrl)) delete modelMetadata.freePlanAccess;
  return { provider, name, baseUrl, apiKey, model, capabilities, priority, modelMetadata };
}

export function normalizeCustomBaseUrl(value) {
  if (typeof value !== "string" || value.length > 2048) throw new Error("Ingresá una URL base HTTPS válida.");
  let parsed;
  try { parsed = new URL(value.trim()); } catch { throw new Error("Ingresá una URL base HTTPS válida."); }
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash || !hostname || isIP(hostname) || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal") || hostname.endsWith(".test")) {
    throw new Error("Usá una URL HTTPS pública, sin credenciales ni parámetros.");
  }
  const path = parsed.pathname.replace(/\/+$/, "");
  if (/\/(?:models|chat\/completions)$/i.test(path)) throw new Error("Ingresá la URL base del proveedor, no la ruta de un endpoint.");
  return `${parsed.origin}${path}`;
}

export function getModelsEndpoint(baseUrl, page = 1) {
  const normalized = baseUrl.replace(/\/+$/, "");
  if (isCloudflareWorkersAiBaseUrl(normalized)) {
    return `${normalized}/models/search?hide_experimental=true&include_deprecated=false&per_page=${CLOUDFLARE_PAGE_SIZE}&page=${page}`;
  }
  return normalized.endsWith("/models") ? normalized : `${normalized}/models`;
}

function asRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizeModel(entry) {
  if (typeof entry === "string") return entry.length > 0 && entry.length <= 200 ? { id: entry } : null;
  const model = asRecord(entry);
  const id = typeof model.id === "string" ? model.id.trim() : typeof model.name === "string" ? model.name.trim() : "";
  if (!id || id.length > 200) return null;
  const architecture = asRecord(model.architecture);
  const pricing = asRecord(model.pricing);
  const task = asRecord(model.task);
  const taskName = typeof task.name === "string" ? task.name : typeof model.task === "string" ? model.task : typeof model.task_name === "string" ? model.task_name : "";
  const metadata = normalizeModelMetadata({
    contextLength: model.context_length ?? model.context_window ?? model.contextLength,
    inputModalities: architecture.input_modalities ?? model.input_modalities ?? model.inputModalities,
    outputModalities: architecture.output_modalities ?? model.output_modalities ?? model.outputModalities,
    supportedParameters: model.supported_parameters ?? model.supportedParameters,
    taskName,
    pricing,
  });
  return { id, ...metadata };
}

async function fetchCatalogPage({ baseUrl, apiKey, page, fetchImpl }) {
  let response;
  try {
    response = await fetchImpl(getModelsEndpoint(baseUrl, page), {
      method: "GET",
      headers: { accept: "application/json", authorization: `Bearer ${apiKey}` },
      redirect: "error",
      signal: AbortSignal.timeout(12_000),
    });
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  if (!response.ok) return { ok: false, reason: response.status === 401 || response.status === 403 ? "unauthorized" : "models_unavailable", status: response.status };
  try {
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_PROVIDER_RESPONSE_BYTES) return { ok: false, reason: "response_too_large" };
    return { ok: true, payload: JSON.parse(text) };
  } catch {
    return { ok: false, reason: "invalid_response" };
  }
}

export async function discoverModels({ baseUrl, apiKey, fetchImpl = globalThis.fetch }) {
  const cloudflare = isCloudflareWorkersAiBaseUrl(baseUrl);
  const models = [];
  const seen = new Set();
  let page = 1;

  while (true) {
    const fetched = await fetchCatalogPage({ baseUrl, apiKey, page, fetchImpl });
    if (!fetched.ok) return fetched;
    const payload = fetched.payload;
    const source = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : Array.isArray(payload?.result) ? payload.result : [];
    if (models.length + source.length > MAX_DISCOVERED_MODELS) return { ok: false, reason: "too_many_models" };

    for (const entry of source) {
      const normalized = normalizeModel(entry);
      if (!normalized || seen.has(normalized.id)) continue;
      seen.add(normalized.id);
      models.push(
        cloudflare && isCloudflareWorkersAiFreeModel(normalized, baseUrl)
          ? { ...normalized, freePlanAccess: "cloudflare_workers_ai_free" }
          : normalized,
      );
    }

    if (!cloudflare || source.length < CLOUDFLARE_PAGE_SIZE || source.length === 0) break;
    page += 1;
  }

  return { ok: true, models };
}
