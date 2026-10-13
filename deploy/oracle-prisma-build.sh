#!/usr/bin/env bash
# Run from CoreXFull checkout; safe: does not alter Render or start production.
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/prisma"
command -v node >/dev/null || { echo "Node.js 22+ required"; exit 1; }
command -v corepack >/dev/null || { echo "corepack required"; exit 1; }
MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if (( MAJOR < 22 )); then echo "Node >=22 required, found $(node -v)"; exit 1; fi
corepack enable
corepack prepare pnpm@10.26.1 --activate
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run build
echo "Build passed. To run: cd $ROOT/prisma && PORT=8080 pnpm start"
echo "For permanent service use deploy/oracle-prisma.service and put credentials in /etc/prisma/prisma.env"
