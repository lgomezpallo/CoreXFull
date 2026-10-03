import assert from "node:assert/strict";
    import { afterEach, test } from "node:test";
    // @ts-expect-error Node's native TypeScript test runner requires the explicit extension.
    import { createRouterCompletion, testRouterConnection, type RouterChatMessage } from "./router-client.ts";

    const originalFetch = globalThis.fetch;
    const options = { maxTokens: 512, jsonMode: false };
    const messages: RouterChatMessage[] = [{ role: "user", content: "Respondé." }];

    function authenticated(): Response {
      return new Response(null, { status: 204 });
    }

    afterEach(() => {
      globalThis.fetch = originalFetch;
      delete process.env.ROUTER_IA_URL;
      delete process.env.ROUTER_IA_TOKEN;
      delete process.env.ROUTER_URL;
      delete process.env.ROUTER_APP_KEY;
    });

    test("validates the server token before sending a completion", async () => {
      process.env.ROUTER_IA_URL = "https://router.example.test/api/v1/chat/completions";
      process.env.ROUTER_IA_TOKEN = "ria_live_local_test_token";
      const requests: Array<{ url: string; init?: RequestInit }> = [];

      globalThis.fetch = (async (input, init) => {
        const url = String(input);
        requests.push({ url, init });
        if (url.endsWith("/api/v1/auth/check")) return authenticated();
        return new Response(JSON.stringify({
          choices: [{ message: { content: "<think>private reasoning</think><final>Hola</final>" } }],
        }), { status: 200 });
      }) as typeof fetch;

      const result = await createRouterCompletion("chat", messages, options);

      assert.equal(result, "Hola");
      assert.equal(requests.length, 2);
      assert.equal(requests[0].url, "https://router.example.test/api/v1/auth/check");
      assert.equal(requests[0].init?.method, "GET");
      assert.equal(new Headers(requests[0].init?.headers).get("authorization"), "Bearer ria_live_local_test_token");
      assert.equal(requests[0].init?.body, undefined);
      assert.equal(requests[1].url, "https://router.example.test/api/v1/chat/completions");
      assert.equal(requests[1].init?.method, "POST");
      assert.equal(new Headers(requests[1].init?.headers).get("authorization"), "Bearer ria_live_local_test_token");
      assert.deepEqual(JSON.parse(String(requests[1].init?.body)), {
        task_type: "chat",
        messages,
        max_tokens: 512,
        stream: false,
      });
    });

    test("JSON mode requests a JSON object and includes a JSON instruction", async () => {
      process.env.ROUTER_URL = "https://router.example.test";
      process.env.ROUTER_APP_KEY = "local-test-app-key";
      let requestBody: Record<string, any> | undefined;

      globalThis.fetch = (async (input, init) => {
        if (String(input).endsWith("/api/v1/auth/check")) return authenticated();
        requestBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({
          choices: [{ message: { content: "{\"ok\":true}" } }],
        }), { status: 200 });
      }) as typeof fetch;

      await createRouterCompletion(
        "reasoning",
        [{ role: "user", content: "Devolvé JSON." }],
        { maxTokens: 200, jsonMode: true },
      );

      assert.deepEqual(requestBody?.response_format, { type: "json_object" });
      assert.equal(requestBody?.model, undefined);
      assert.equal(requestBody?.messages[0].role, "system");
      assert.match(requestBody?.messages[0].content, /objeto JSON válido/);
    });

    test("connection test validates the token without requesting completions or providers", async () => {
      process.env.ROUTER_IA_URL = "https://router.example.test";
      process.env.ROUTER_IA_TOKEN = "server-test-token";
      let requestUrl = "";
      let requestInit: RequestInit | undefined;

      globalThis.fetch = (async (input, init) => {
        requestUrl = String(input);
        requestInit = init;
        return authenticated();
      }) as typeof fetch;

      const status = await testRouterConnection("chat");

      assert.equal(requestUrl, "https://router.example.test/api/v1/auth/check");
      assert.equal(requestInit?.method, "GET");
      assert.equal(new Headers(requestInit?.headers).get("authorization"), "Bearer server-test-token");
      assert.equal(requestInit?.body, undefined);
      assert.equal(status.configured, true);
      assert.equal(status.connected, true);
      assert.match(status.message ?? "", /token del servidor validado/i);
      assert.match(status.message ?? "", /no se consultaron modelos ni proveedores/i);
    });

    test("missing server token keeps Router disconnected and does not make a request", async () => {
      process.env.ROUTER_IA_URL = "https://router.example.test";
      let called = false;
      globalThis.fetch = (async () => {
        called = true;
        return authenticated();
      }) as typeof fetch;

      const status = await testRouterConnection("chat");

      assert.equal(called, false);
      assert.equal(status.configured, false);
      assert.equal(status.connected, false);
      assert.match(status.message ?? "", /falta configurar ROUTER_IA_TOKEN/i);
    });

    test("does not request a completion when Router rejects the application token", async () => {
      process.env.ROUTER_IA_URL = "https://router.example.test";
      process.env.ROUTER_IA_TOKEN = "incorrect-test-token";
      const urls: string[] = [];
      globalThis.fetch = (async (input) => {
        urls.push(String(input));
        return new Response(JSON.stringify({ error: { message: "Unauthorized." } }), { status: 401 });
      }) as typeof fetch;

      await assert.rejects(
        createRouterCompletion("chat", messages, options),
        /Router IA rechazó ROUTER_IA_TOKEN/,
      );
      assert.deepEqual(urls, ["https://router.example.test/api/v1/auth/check"]);
    });

    test("reports an unconfigured provider clearly and without exposing other upstream errors", async () => {
      process.env.ROUTER_IA_URL = "https://router.example.test";
      process.env.ROUTER_IA_TOKEN = "server-test-token";
      let requests = 0;
      globalThis.fetch = (async (input) => {
        requests += 1;
        if (String(input).endsWith("/api/v1/auth/check")) return authenticated();
        return new Response(JSON.stringify({ error: { message: "The model provider is not configured." } }), { status: 503 });
      }) as typeof fetch;

      await assert.rejects(
        createRouterCompletion("chat", messages, options),
        { message: "El proveedor de modelos todavía no está configurado en Router IA." },
      );
      assert.equal(requests, 2);
    });

    test("does not expose an upstream error body", async () => {
      process.env.ROUTER_URL = "https://router.example.test";
      process.env.ROUTER_APP_KEY = "local-test-app-key";
      globalThis.fetch = (async (input) => {
        if (String(input).endsWith("/api/v1/auth/check")) return authenticated();
        return new Response(JSON.stringify({ error: { message: "private upstream error body" } }), { status: 401 });
      }) as typeof fetch;

      await assert.rejects(
        createRouterCompletion("chat", messages, options),
        { message: "Router IA rechazó ROUTER_IA_TOKEN al solicitar la completion." },
      );
    });

    test("rejects an unexpected Router IA path rather than silently ignoring it", async () => {
      process.env.ROUTER_IA_URL = "https://router.example.test/unexpected/path";
      process.env.ROUTER_IA_TOKEN = "server-test-token";

      await assert.rejects(
        createRouterCompletion("chat", messages, options),
        /ROUTER_IA_URL debe ser HTTPS/,
      );
    });

test("rejects truncated completions even when content contains valid-looking JSON", async () => {
  process.env.ROUTER_IA_TOKEN = "server-test-token";
  globalThis.fetch = (async (input) => {
    if (String(input).endsWith("/api/v1/auth/check")) return authenticated();
    return new Response(JSON.stringify({ choices: [{ finish_reason: "length", message: { content: '{"ok":true}' } }] }), { status: 200 });
  }) as typeof fetch;
  await assert.rejects(createRouterCompletion("reasoning", messages, { maxTokens: 3072, jsonMode: true }), /quedó cortada/);
});
