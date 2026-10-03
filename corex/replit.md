# CoreX

CoreX convierte ideas en aplicaciones mediante conversación y conserva los proyectos del usuario con Supabase y respaldos locales.

## Run & Operate

- `pnpm run dev` — run the Vite web app and Express API together
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm start` — serve the built web app and API from one Express process
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- Browser build env: `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLIC_KEY`
- Server env: `ROUTER_APP_KEY`; optional `ROUTER_URL`, `ROUTER_APP_ID`, `PORT`, and `LOG_LEVEL`
- See `.env.example` and `COREX_PORTABILITY.md` for setup outside Replit

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- Auth and cloud snapshots: Supabase
- AI: server-side Router IA client; CoreX sends `task_type` and does not select a model or provider
- API codegen: Orval (from OpenAPI spec)
- Build: Vite static web output and an esbuild ESM API bundle

## Where things live

- `artifacts/habla-code` — CoreX web app
- `artifacts/api-server` — Express API and Router IA client
- `lib/api-spec/openapi.yaml` — API contract source of truth
- `artifacts/habla-code/src/lib/builder-workspace.ts` and `cloud-workspaces.ts` — project and snapshot persistence

## Architecture decisions

_Populate as you build — non-obvious choices a reader couldn't infer from the code (3-5 bullets)._

- Send all AI work through Router IA from the API server. Use the documented `task_type` categories and leave model/provider selection to Router IA.
- Organize creation into three stages: source intake, optional-base chat design, and app assembly/verification/publishing. Treat third-party APKs and websites as evidence for static analysis; distinguish observed details from inference, never execute untrusted APKs, and import code or assets directly only when the user has reuse rights.
- Keep the project portable outside Replit: GitHub is the source of truth for code, and Supabase is the target for persistent application data. Avoid adding Replit-specific persistence services; use portable interfaces and environment-configured connections. This remains subject to the $0 cost ceiling above: verify free-tier limits and prevent automatic overages before connecting services or persisting production data.

## Product

Every generated app must implement the behavior needed to fulfill the user's stated purpose; a visual preview with demo-only controls is not a finished app. Validate the key end-to-end flow before calling an app functional. If the requested behavior is not implemented, label the result as a prototype and state what remains incomplete.

- For the ProgramaHablando-to-CoreX migration, change visible branding only. Preserve existing behavior, route and package identifiers, storage keys, and saved data formats unless the user explicitly asks otherwise.
- **Cost ceiling:** Keep all development, hosting, storage, build, and distribution costs at $0. Use only options whose free limits and billing behavior are understood; avoid paid usage, automatic overages, and automatic upgrades. Before enabling a service, verify that reaching a free limit cannot trigger a charge. If a feature cannot be provided at $0, do not enable it; explain the limitation and offer a free alternative or leave it as a prototype/deferred. Approval to expand capabilities does not waive this cost ceiling unless the user explicitly changes it.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
