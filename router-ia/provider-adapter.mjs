import { isIP } from "node:net";

export const PROVIDER_PRESETS = Object.freeze([
  {
    id: "groq",
    name: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
  },
  {
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
  },
  {
    id: "custom",
    name: "Personalizado",
    baseUrl: "",
  },
]);

// Free Plan Limits table from https://console.groq.com/docs/rate-limits, verified 2026-10-02.
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

export const ROUTER_TASK_TYPES = Object.freeze([
  "chat",
  "coding",
  "reasoning",
  "summarization",
  "vision",
  "document",
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
const groqFreePlanModelIds = new Set(GROQ_FREE_PLAN_MODEL_IDS);

export function isGroqFreePlanBaseUrl(baseUrl) {
  try {
    const parsed = new URL(baseUrl);
    return (
      parsed.origin === "https://api.groq.com" &&
      parsed.pathname.replace(/\/+$/, "") === "/openai/v1" &&
      !parsed.search &&
      !parsed.hash
    );
  } catch {
    return false;
  }
}

export function isGroqFreePlanModel(model, baseUrl) {
  return (
    isGroqFreePlanBaseUrl(baseUrl) &&
    typeof model?.id === "string" &&
    groqFreePlanModelIds.has(model.id.trim().toLowerCase())
  );
}

export function isNvidiaApiCatalogBaseUrl(baseUrl) {
  try {
    const parsed = new URL(baseUrl);
    return (
      parsed.origin === "https://integrate.api.nvidia.com" &&
      parsed.pathname.replace(/\/+$/, "") === "/v1" &&
      !parsed.search &&
      !parsed.hash
    );
  } catch {
    return false;
  }
}

export function normalizeCapabilities(value) {
  if (!Array.isArray(value)) {
    throw new Error("Elegí al menos una capacidad para este modelo.");
  }

  const capabilities = [...new Set(value)];
  if (
    capabilities.length === 0 ||
    capabilities.some(
      (capability) =>
        typeof capability !== "string" || !PROVIDER_CAPABILITIES.includes(capability),
    )
  ) {
    throw new Error("Las capacidades seleccionadas no son válidas.");
  }
  return capabilities;
}

export function normalizeModelMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};

  const metadata = {};
  const contextLength = Number(value.contextLength);
  if (Number.isSafeInteger(contextLength) && contextLength > 0) {
    metadata.contextLength = contextLength;
  }

  for (const key of ["inputModalities", "outputModalities", "supportedParameters"]) {
    if (!Array.isArray(value[key])) continue;
    const values = [
      ...new Set(
        value[key]
          .filter(
            (item) =>
              typeof item === "string" &&
              item.trim().length > 0 &&
              item.trim().length <= MAX_MODEL_METADATA_STRING_LENGTH,
          )
          .map((item) => item.trim().toLowerCase()),
      ),
    ].slice(0, MAX_MODEL_METADATA_LIST_ITEMS);
    if (values.length > 0) metadata[key] = values;
  }

  if (
    value.freePlanAccess === "groq_free_plan" ||
    value.freePlanAccess === "nvidia_api_catalog_prototyping"
  ) {
    metadata.freePlanAccess = value.freePlanAccess;
  }

  if (value.pricing && typeof value.pricing === "object" && !Array.isArray(value.pricing)) {
    const pricing = {};
    const entries = Object.entries(value.pricing);
    let pricingIsComplete = entries.length > 0 && entries.length <= MAX_MODEL_PRICING_FIELDS;
    for (const [rawKey, price] of entries) {
      const key = typeof rawKey === "string" ? rawKey.trim().toLowerCase() : "";
      if (!/^[a-z][a-z0-9_]{0,63}$/.test(key) || Object.hasOwn(pricing, key)) {
        pricingIsComplete = false;
        break;
      }
      const text =
        typeof price === "number" && Number.isFinite(price)
          ? String(price)
          : typeof price === "string"
            ? price.trim()
            : "";
      if (
        text.length <= MAX_MODEL_METADATA_STRING_LENGTH &&
        /^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text) &&
        Number.isFinite(Number(text)) &&
        Number(text) >= 0
      ) {
        pricing[key] = text;
      } else {
        pricingIsComplete = false;
        break;
      }
    }
    if (pricingIsComplete && Object.keys(pricing).length === entries.length) {
      metadata.pricing = pricing;
    }
  }

  return metadata;
}

export function isExplicitlyFreeModel(model) {
  const pricing = normalizeModelMetadata({ pricing: model?.pricing }).pricing;
  if (!pricing || !Object.hasOwn(pricing, "prompt") || !Object.hasOwn(pricing, "completion")) {
    return false;
  }

  return Object.values(pricing).every((price) => Number(price) === 0);
}

export function inferModelCapabilities(model) {
  const metadata = normalizeModelMetadata(model);
  const inputs = metadata.inputModalities ?? [];
  const outputs = metadata.outputModalities ?? [];
  const capabilities = [];

  if (inputs.includes("text") && outputs.includes("text")) capabilities.push("chat");
  if (inputs.includes("image")) capabilities.push("vision");
  if (inputs.some((modality) => ["document", "pdf"].includes(modality))) {
    capabilities.push("document");
  }
  if (Number.isSafeInteger(metadata.contextLength) && metadata.contextLength >= 100_000) {
    capabilities.push("long_context");
  }

  return capabilities;
}

export function normalizeProviderInput(input) {
  const provider = typeof input?.provider === "string" ? input.provider.trim().toLowerCase() : "";
  const preset = presetById.get(provider);
  if (!preset) throw new Error("Elegí un proveedor disponible.");

  const name =
    provider === "custom"
      ? typeof input?.name === "string"
        ? input.name.trim()
        : ""
      : preset.name;
  if (!name || name.length > 80) {
    throw new Error("El nombre del proveedor debe tener entre 1 y 80 caracteres.");
  }

  const baseUrl = provider === "custom" ? normalizeCustomBaseUrl(input?.baseUrl) : preset.baseUrl;
  const apiKey = typeof input?.apiKey === "string" ? input.apiKey.trim() : "";
  if (!apiKey || apiKey.length > 4096 || /\s/.test(apiKey)) {
    throw new Error("Ingresá una API key válida.");
  }

  const model = typeof input?.model === "string" ? input.model.trim() : "";
  if (model.length > 200) throw new Error("El identificador del modelo es demasiado largo.");
  const capabilities = Array.isArray(input?.capabilities)
    ? normalizeCapabilities(input.capabilities)
    : [];
  const priority = input?.priority === undefined ? 50 : Number(input.priority);
  if (!Number.isInteger(priority) || priority < 1 || priority > 100) {
    throw new Error("La prioridad debe ser un número entero entre 1 y 100.");
  }
  const modelMetadata = normalizeModelMetadata(input?.modelMetadata);
  if (
    modelMetadata.freePlanAccess === "groq_free_plan" &&
    !isGroqFreePlanModel({ id: model }, baseUrl)
  ) {
    delete modelMetadata.freePlanAccess;
  } else if (
    modelMetadata.freePlanAccess === "nvidia_api_catalog_prototyping" &&
    !isNvidiaApiCatalogBaseUrl(baseUrl)
  ) {
    delete modelMetadata.freePlanAccess;
  }

  return { provider, name, baseUrl, apiKey, model, capabilities, priority, modelMetadata };
}

export function normalizeCustomBaseUrl(value) {
  if (typeof value !== "string" || value.length > 2048) {
    throw new Error("Ingresá una URL base HTTPS válida.");
  }

  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error("Ingresá una URL base HTTPS válida.");
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    !hostname ||
    isIP(hostname) ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".test")
  ) {
    throw new Error("Usá una URL HTTPS pública, sin credenciales ni parámetros.");
  }

  const path = parsed.pathname.replace(/\/+$/, "");
  if (/\/(?:models|chat\/completions)$/i.test(path)) {
    throw new Error("Ingresá la URL base del proveedor, no la ruta de un endpoint.");
  }

  return `${parsed.origin}${path}`;
}

export function getModelsEndpoint(baseUrl) {
  const normalized = baseUrl.replace(/\/+$/, "");
  return normalized.endsWith("/models") ? normalized : `${normalized}/models`;
}

function asRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizeModel(entry) {
  if (typeof entry === "string") {
    return entry.length > 0 && entry.length <= 200 ? { id: entry } : null;
  }

  const model = asRecord(entry);
  const id = typeof model.id === "string" ? model.id.trim() : "";
  if (!id || id.length > 200) return null;

  const architecture = asRecord(model.architecture);
  const pricing = asRecord(model.pricing);
  const rawContextLength =
    model.context_length ?? model.context_window ?? model.contextLength;
  const metadata = normalizeModelMetadata({
    contextLength: rawContextLength,
    inputModalities:
      architecture.input_modalities ??
      model.input_modalities ??
      model.inputModalities,
    outputModalities:
      architecture.output_modalities ??
      model.output_modalities ??
      model.outputModalities,
    supportedParameters:
      model.supported_parameters ?? model.supportedParameters,
    pricing,
  });

  return { id, ...metadata };
}

export async function discoverModels({ baseUrl, apiKey, fetchImpl = globalThis.fetch }) {
  let response;
  try {
    response = await fetchImpl(getModelsEndpoint(baseUrl), {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      redirect: "error",
      signal: AbortSignal.timeout(12_000),
    });
  } catch {
    return { ok: false, reason: "unreachable" };
  }

  if (!response.ok) {
    return {
      ok: false,
      reason: response.status === 401 || response.status === 403 ? "unauthorized" : "models_unavailable",
      status: response.status,
    };
  }

  let payload;
  try {
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_PROVIDER_RESPONSE_BYTES) {
      return { ok: false, reason: "response_too_large" };
    }
    payload = JSON.parse(text);
  } catch {
    return { ok: false, reason: "invalid_response" };
  }

  const source = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload?.models)
      ? payload.models
      : [];
  if (source.length > MAX_DISCOVERED_MODELS) {
    return { ok: false, reason: "too_many_models" };
  }

  const models = [];
  const seen = new Set();
  for (const entry of source) {
    const model = normalizeModel(entry);
    if (!model || seen.has(model.id)) continue;
    seen.add(model.id);
    models.push(model);
  }

  return { ok: true, models };
}