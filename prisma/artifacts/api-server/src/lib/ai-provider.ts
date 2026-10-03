export class AiProviderConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiProviderConfigurationError";
  }
}

export interface AiProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function validateBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AiProviderConfigurationError(
      "AI_ROUTER_BASE_URL must be a valid HTTP or HTTPS URL.",
    );
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new AiProviderConfigurationError(
      "AI_ROUTER_BASE_URL must use HTTP or HTTPS.",
    );
  }

  return value.replace(/\/+$/, "");
}

function routerConfig(
  baseUrl: string,
  apiKey: string | undefined,
  model: string | undefined,
  modelVariable: string,
  apiKeyVariable: string,
): AiProviderConfig {
  if (!apiKey) {
    throw new AiProviderConfigurationError(
      `${apiKeyVariable} must be set when using the AI Router.`,
    );
  }

  if (!model) {
    throw new AiProviderConfigurationError(
      `${modelVariable} must be set when using the AI Router.`,
    );
  }

  return {
    baseUrl: validateBaseUrl(baseUrl),
    apiKey,
    model,
  };
}

export function getChatProviderConfig(): AiProviderConfig {
  const routerBaseUrl = readEnv("AI_ROUTER_BASE_URL");
  if (routerBaseUrl) {
    return routerConfig(
      routerBaseUrl,
      readEnv("AI_ROUTER_API_KEY"),
      readEnv("AI_ROUTER_CHAT_MODEL"),
      "AI_ROUTER_CHAT_MODEL",
      "AI_ROUTER_API_KEY",
    );
  }

  const legacyBaseUrl = readEnv("AI_INTEGRATIONS_OPENAI_BASE_URL");
  const legacyApiKey = readEnv("AI_INTEGRATIONS_OPENAI_API_KEY");
  if (legacyBaseUrl && legacyApiKey) {
    return {
      baseUrl: validateBaseUrl(legacyBaseUrl),
      apiKey: legacyApiKey,
      model: readEnv("AI_INTEGRATIONS_OPENAI_CHAT_MODEL") ?? "gpt-5.6-terra",
    };
  }

  throw new AiProviderConfigurationError(
    "Configure AI_ROUTER_BASE_URL, AI_ROUTER_API_KEY, and AI_ROUTER_CHAT_MODEL.",
  );
}

export function getImageProviderConfig(): AiProviderConfig {
  const routerBaseUrl =
    readEnv("AI_ROUTER_IMAGE_BASE_URL") ?? readEnv("AI_ROUTER_BASE_URL");
  if (routerBaseUrl) {
    return routerConfig(
      routerBaseUrl,
      readEnv("AI_ROUTER_IMAGE_API_KEY") ?? readEnv("AI_ROUTER_API_KEY"),
      readEnv("AI_ROUTER_IMAGE_MODEL"),
      "AI_ROUTER_IMAGE_MODEL",
      "AI_ROUTER_IMAGE_API_KEY or AI_ROUTER_API_KEY",
    );
  }

  const legacyBaseUrl = readEnv("AI_INTEGRATIONS_OPENAI_BASE_URL");
  const legacyApiKey = readEnv("AI_INTEGRATIONS_OPENAI_API_KEY");
  if (legacyBaseUrl && legacyApiKey) {
    return {
      baseUrl: validateBaseUrl(legacyBaseUrl),
      apiKey: legacyApiKey,
      model: readEnv("AI_INTEGRATIONS_OPENAI_IMAGE_MODEL") ?? "gpt-image-1",
    };
  }

  throw new AiProviderConfigurationError(
    "Configure AI_ROUTER_BASE_URL, AI_ROUTER_API_KEY, and AI_ROUTER_IMAGE_MODEL.",
  );
}

export function getProviderHeaders(
  config: AiProviderConfig,
): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${config.apiKey}`,
  };
}

export function getProviderEndpoint(baseUrl: string, path: string): string {
  return new URL(path, `${baseUrl.replace(/\/+$/, "")}/`).toString();
}