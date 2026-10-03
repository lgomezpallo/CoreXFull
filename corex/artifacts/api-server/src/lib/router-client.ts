import type { RouterTaskType } from "@workspace/api-zod";
    export type { RouterTaskType } from "@workspace/api-zod";

    const DEFAULT_ROUTER_URL = "https://router-ia-standalone.onrender.com";
    const HEALTH_TIMEOUT_MS = 5_000;
    const COMPLETION_TIMEOUT_MS = 120_000;

    export type RouterChatMessage = {
      role: "system" | "user" | "assistant";
      content: string | Array<
        | { type: "text"; text: string }
        | { type: "image_url"; image_url: { url: string; detail?: "auto" | "low" | "high" } }
      >;
    };

    export type CompletionOptions = {
      maxTokens: number;
      jsonMode: boolean;
    };

    type RouterHealthState = {
      connected: boolean;
      lastTestAt: string | null;
      lastLatencyMs: number | null;
      message: string | null;
    };

    let healthState: RouterHealthState = {
      connected: false,
      lastTestAt: null,
      lastLatencyMs: null,
      message: null,
    };

    function routerBaseUrl(): string {
      const configuredUrl =
        process.env.ROUTER_IA_URL?.trim() ||
        process.env.ROUTER_URL?.trim() ||
        DEFAULT_ROUTER_URL;
      let parsed: URL;

      try {
        parsed = new URL(configuredUrl);
      } catch {
        throw new Error("ROUTER_IA_URL no es una URL válida.");
      }

      const allowedPaths = new Set([
        "",
        "/",
        "/api",
        "/api/v1/chat/completions",
      ]);
      const localDevelopmentHost =
        process.env.NODE_ENV !== "production" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
      if (
        (parsed.protocol !== "https:" &&
          !(parsed.protocol === "http:" && localDevelopmentHost)) ||
        parsed.username ||
        parsed.password ||
        !allowedPaths.has(parsed.pathname) ||
        parsed.search ||
        parsed.hash
      ) {
        throw new Error(
          "ROUTER_IA_URL debe ser HTTPS y apuntar al origen, /api o endpoint /api/v1/chat/completions, sin credenciales ni parámetros.",
        );
      }

      return parsed.origin;
    }

    function routerAppKey(): string | null {
      const appKey =
        process.env.ROUTER_IA_TOKEN?.trim() ||
        process.env.ROUTER_APP_KEY?.trim();
      return appKey || null;
    }

    export function routerApiUrl(path: string): URL {
      if (!path.startsWith("/api/") || path.startsWith("//")) {
        throw new Error("La ruta de Router IA debe ser una ruta API absoluta.");
      }
      return new URL(path, routerBaseUrl());
    }

    function configurationMessage(): string | null {
      try {
        routerBaseUrl();
      } catch (error) {
        return error instanceof Error ? error.message : "La URL de Router IA no es válida.";
      }

      return routerAppKey()
        ? null
        : "Falta configurar ROUTER_IA_TOKEN en el servidor para habilitar las solicitudes.";
    }

    async function validateRouterAuthentication(token: string): Promise<void> {
      const endpoint = routerApiUrl("/api/v1/auth/check");
      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: "GET",
          headers: {
            Authorization: "Bearer " + token,
            Accept: "application/json",
          },
          redirect: "error",
          signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
        });
      } catch {
        throw new Error("No se pudo conectar con Router IA para validar el token del servidor.");
      }

      if (response.status === 204) return;
      if (response.status === 401) {
        throw new Error("Router IA rechazó ROUTER_IA_TOKEN: el token del servidor no coincide.");
      }
      if (response.status === 503) {
        throw new Error("Router IA no tiene configurado su token de aplicación y no puede validar la conexión.");
      }
      throw new Error("Router IA no confirmó el token del servidor (HTTP " + response.status + ").");
    }

    function finalModelText(value: string): string {
      const finalMatch = value.match(/<final>([\s\S]*?)<\/final>/i);
      if (finalMatch) return finalMatch[1].trim();
      return value.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
    }

    function extractCompletionText(payload: unknown): string {
      if (!payload || typeof payload !== "object") {
        throw new Error("Router IA devolvió una respuesta no válida.");
      }

      const choices = (payload as {
        choices?: Array<{ message?: { content?: unknown } }>;
      }).choices;
      const content = choices?.[0]?.message?.content;
      if (typeof content !== "string") {
        throw new Error("Router IA no devolvió texto.");
      }

      const text = finalModelText(content);
      if (!text) throw new Error("Router IA devolvió una respuesta vacía.");
      return text;
    }

    function jsonModeMessages(messages: RouterChatMessage[]): RouterChatMessage[] {
      const instruction =
        "Respondé únicamente con un objeto JSON válido, sin bloques Markdown ni texto adicional.";
      const firstSystemIndex = messages.findIndex((message) => message.role === "system");
      if (firstSystemIndex < 0) {
        return [{ role: "system", content: instruction }, ...messages];
      }

      return messages.map((message, index) =>
        index === firstSystemIndex && typeof message.content === "string"
          ? { ...message, content: message.content + "\n\n" + instruction }
          : message,
      );
    }

    export function getRouterStatus() {
      const configurationError = configurationMessage();
      return {
        configured: configurationError === null,
        connected: configurationError === null && healthState.connected,
        lastTestAt: healthState.lastTestAt,
        lastLatencyMs: healthState.lastLatencyMs,
        message: configurationError ?? healthState.message,
      };
    }

    /**
     * Validates the server token with Router IA without sending a prompt or invoking
     * a model/provider, so this check cannot trigger an inference charge.
     */
    export async function testRouterConnection(_taskType: RouterTaskType) {
      const startedAt = Date.now();
      const testedAt = new Date().toISOString();

      try {
        const token = routerAppKey();
        if (!token) {
          throw new Error("Falta configurar ROUTER_IA_TOKEN en el servidor para validar la conexión.");
        }
        await validateRouterAuthentication(token);

        healthState = {
          connected: true,
          lastTestAt: testedAt,
          lastLatencyMs: Math.max(0, Date.now() - startedAt),
          message: "Token del servidor validado con Router IA. No se consultaron modelos ni proveedores; las completions requieren un proveedor configurado.",
        };
      } catch (error) {
        healthState = {
          connected: false,
          lastTestAt: testedAt,
          lastLatencyMs: Math.max(0, Date.now() - startedAt),
          message: error instanceof Error
            ? error.message.slice(0, 220)
            : "No se pudo validar el token con Router IA.",
        };
      }

      return getRouterStatus();
    }

    /**
     * Routes all CoreX model requests through Router IA. The application token is
     * validated server-to-server before each completion and is never sent to the browser.
     */
    export async function createRouterCompletion(
      taskType: RouterTaskType,
      messages: RouterChatMessage[],
      options: CompletionOptions,
    ): Promise<string> {
      const appKey = routerAppKey();
      if (!appKey) {
        throw new Error("Router IA no está configurado: falta ROUTER_IA_TOKEN en el servidor.");
      }

      await validateRouterAuthentication(appKey);

      const requestMessages = options.jsonMode ? jsonModeMessages(messages) : messages;
      const endpoint = routerApiUrl("/api/v1/chat/completions");
      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: "POST",
          headers: {
            Authorization: "Bearer " + appKey,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            task_type: taskType,
            messages: requestMessages,
            max_tokens: options.maxTokens,
            stream: false,
          }),
          redirect: "error",
          signal: AbortSignal.timeout(COMPLETION_TIMEOUT_MS),
        });
      } catch {
        throw new Error("No se pudo conectar con Router IA para solicitar una completion.");
      }

      if (!response.ok) {
        if (response.status === 503) {
          const payload: unknown = await response.json().catch(() => null);
          if (payload && typeof payload === "object" && "error" in payload) {
            const error = payload.error;
            if (
              error && typeof error === "object" && "message" in error &&
              error.message === "The model provider is not configured."
            ) {
              throw new Error("El proveedor de modelos todavía no está configurado en Router IA.");
            }
          }
          throw new Error("Router IA no está disponible para generar respuestas (HTTP 503).");
        }
        if (response.status === 401) {
          throw new Error("Router IA rechazó ROUTER_IA_TOKEN al solicitar la completion.");
        }
        throw new Error("Router IA respondió con HTTP " + response.status + ".");
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new Error("Router IA devolvió una respuesta no válida.");
      }

      return extractCompletionText(payload);
    }
