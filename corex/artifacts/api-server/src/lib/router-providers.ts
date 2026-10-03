import { routerApiUrl } from "./router-client";

const PROVIDER_REQUEST_TIMEOUT_MS = 10_000;

export class RouterProviderApiError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "RouterProviderApiError";
  }
}

function requestApiKey(body: unknown): string | null {
  if (typeof body !== "string") return null;
  try {
    const payload: unknown = JSON.parse(body);
    if (
      payload &&
      typeof payload === "object" &&
      "apiKey" in payload &&
      typeof payload.apiKey === "string"
    ) {
      return payload.apiKey;
    }
  } catch {
    // The route only serializes JSON bodies, but treat an unreadable body as
    // having no extractable secret rather than exposing its contents.
  }
  return null;
}

function upstreamMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || !("error" in payload)) {
    return null;
  }

  const error = payload.error;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    return typeof error.message === "string" ? error.message : null;
  }
  return null;
}

function redact(message: string, token: string, apiKey: string | null): string {
  let safe = message;
  for (const secret of [token, apiKey].filter(
    (value): value is string => Boolean(value),
  )) {
    safe = safe.split(secret).join("[redactado]");
  }
  return safe.replace(/ria_live_[A-Za-z0-9_-]+/g, "[token]").slice(0, 220);
}

async function requestRouterProviders(
  path: string,
  token: string,
  init: RequestInit,
): Promise<unknown> {
  const apiKey = requestApiKey(init.body);
  let response: Response;
  try {
    response = await fetch(routerApiUrl(path), {
      ...init,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        "Cache-Control": "no-store",
        ...(init.headers ?? {}),
      },
      redirect: "error",
      signal: AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new RouterProviderApiError(
      "No se pudo conectar con la API de providers de Router IA.",
      502,
    );
  }

  if (response.status === 204) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const upstreamErrorMessage = upstreamMessage(payload);
    const fallback = `Router IA respondió con HTTP ${response.status}.`;
    const statusCode = response.status >= 500 ? 502 : response.status;
    throw new RouterProviderApiError(
      redact(upstreamErrorMessage ?? fallback, token, apiKey),
      statusCode,
    );
  }
  return payload;
}

export async function listProviders(token: string): Promise<unknown> {
  return requestRouterProviders("/api/providers", token, { method: "GET" });
}

export async function createProvider(
  token: string,
  input: unknown,
): Promise<unknown> {
  return requestRouterProviders("/api/providers", token, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function updateProvider(
  token: string,
  id: string,
  input: unknown,
): Promise<unknown> {
  return requestRouterProviders(
    `/api/providers/${encodeURIComponent(id)}`,
    token,
    {
      method: "PATCH",
      body: JSON.stringify(input),
    },
  );
}

export async function deleteProvider(token: string, id: string): Promise<void> {
  await requestRouterProviders(
    `/api/providers/${encodeURIComponent(id)}`,
    token,
    { method: "DELETE" },
  );
}