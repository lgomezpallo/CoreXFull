FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PORT=8080

WORKDIR /app
COPY --chown=node:node package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY --chown=node:node server.mjs main.mjs chat-handler.mjs chat-routing.mjs multimodal-routes.mjs capabilities-route.mjs admin-extra-routes.mjs admin-routes.mjs admin-passkey-store.mjs provider-adapter.mjs provider-store.mjs provider-capabilities.mjs provider-auditor.mjs cloudflare-sync.mjs ./
COPY --chown=node:node admin ./admin
COPY --chown=node:node supabase/migrations ./supabase/migrations

USER node
EXPOSE 8080
CMD ["node", "main.mjs"]
