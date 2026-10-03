# CoreX portability

CoreX can run outside Replit with Node.js and pnpm. Replit artifact metadata and workflows remain available for this workspace, but the application runtime does not require them.

## Requirements

- Node.js 20.19+ or 22.12+
- pnpm 10
- A Supabase project for sign-in and cloud snapshots
- A Router IA application key for AI generation

## Configure

```sh
cp .env.example .env
```

Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLIC_KEY` for the browser build. Set `ROUTER_IA_TOKEN` in the API server environment; do not use a `VITE_` prefix or expose this token to the browser. Create a named application token in Router IA for CoreX. `ROUTER_IA_URL` defaults to `https://router-ia-standalone.onrender.com` and accepts either the origin, `/api`, or the full `/api/v1/chat/completions` endpoint. It must use HTTPS outside local development and cannot contain credentials, a query, or a fragment. The legacy names `ROUTER_APP_KEY` and `ROUTER_URL` remain supported as fallbacks.

The optional Prisma chat module is disabled by default. Enable it on the API with `PRISMA_MODULE_ENABLED=true` and in the web build with `VITE_ENABLE_PRISMA_CHAT=true`. Both flags are required. Providers and their credentials belong in Router IA; CoreX does not need provider API keys.
Prisma conversation history stays in browser storage, scoped to the signed-in account; CoreX does not persist chat messages server-side. The API limits each account to 15 messages per minute per server process and 24,000 input characters per request.

The Supabase public key is intended for browser use. Never put a Supabase `service_role` key in the web app or `.env.example`.

## Run locally

```sh
pnpm install --frozen-lockfile
pnpm run dev
```

The web app runs on port `5173`; the API runs on port `8080`. The local Vite server proxies `/api` to the API server. Set `WEB_PORT`, `API_PORT`, or `API_ORIGIN` to override those local defaults.

## Build and run

```sh
pnpm run build
pnpm start
```

`pnpm run build` type-checks the workspace and builds its packages. `pnpm start` serves the built web app and `/api` from one Express process. It uses `PORT` when provided and otherwise listens on `8080`. Build before starting. `COREX_STATIC_DIR` can point to the built `artifacts/habla-code/dist/public` directory if the files are stored elsewhere.

## External services and request flow

- Browser sign-in and cloud snapshots use Supabase.
- AI requests go from the API server to `POST ${ROUTER_IA_URL}/api/v1/chat/completions` (or the endpoint supplied in `ROUTER_IA_URL`). The request uses the server-only Bearer `ROUTER_IA_TOKEN`, sends `task_type`, and omits `model`; Router IA owns provider and model routing. CoreX never sends Supabase access tokens on inference requests.
- `GET /api/router/status` reports server configuration and the last in-process authentication check. `POST /api/router/test` calls Router IA's `GET /api/v1/auth/check` with the server-only token; it does not send prompts or invoke a model.
- Every completion first validates the application token with Router IA. If no provider/model is configured there, CoreX reports that the provider is unavailable and does not configure one automatically.
- CoreX provider-management routes proxy to Router IA's `/api/providers` endpoints. They forward the signed-in user's Supabase access token; CoreX and Router IA must use the same Supabase Auth project, and that user must be the Router IA owner. Provider credentials are stored and managed by Router IA, not CoreX.
- When enabled, `POST /api/prisma/chat` sends authenticated chat messages through Router IA. The API keeps no conversation history, enforces message-size and per-user request limits, and does not call providers directly. The browser stores Prisma history locally, separated by signed-in user.
- Legacy provider settings already saved in Supabase are not deleted, but they are not used for completions. Direct provider test requests are disabled.
- Other application state that is described as local remains in the browser. Supabase snapshots are a separate cloud backup path.

## Separate web and API hosting

The standard `pnpm start` mode serves both pieces on one origin, avoiding proxy-specific paths. If hosting the static web build and API separately, route `/api/*` to the Express server and configure the static host to serve `index.html` for client-side routes. Set the web build's `BASE_PATH` only when the hosting proxy also serves the app under that prefix.

## Replit-only development metadata

`.replit-artifact/artifact.toml` files describe this workspace's previews and managed development workflows. They are not read by CoreX at runtime. The same API and web packages can be built and started with the commands above on a standard Node.js host.