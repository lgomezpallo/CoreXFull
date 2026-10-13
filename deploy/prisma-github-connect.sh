#!/usr/bin/env bash
# One-time secure setup for Prisma GitHub credentials.
# Run on Oracle over SSH; never paste the token into ChatGPT.
set -Eeuo pipefail
ENV_FILE=/etc/prisma/prisma.env
[[ -f "$ENV_FILE" ]] || { echo "No existe $ENV_FILE"; exit 1; }
read -rsp 'Pegá el token GitHub de Prisma (no se muestra): ' TOKEN
printf '\n'
[[ -n "$TOKEN" ]] || { echo "Token vacío"; exit 1; }
status="$(curl --silent --output /dev/null --write-out '%{http_code}' \
  --max-time 20 -H 'Accept: application/vnd.github+json' \
  -H "Authorization: Bearer $TOKEN" \
  https://api.github.com/repos/lgomezpallo/I.achat.Full/contents/README.md)"
if [[ "$status" != "200" ]]; then
  echo "No se pudo leer IAchat (HTTP $status). No se guardó nada."
  unset TOKEN
  exit 1
fi
tmp="$(sudo mktemp /etc/prisma/.env.XXXXXX)"
trap 'sudo rm -f "$tmp"' EXIT
sudo chmod 600 "$tmp"
sudo cp "$ENV_FILE" "$tmp"
# Replace an earlier token without exposing it in process arguments or logs.
printf '%s' "$TOKEN" | sudo python3 -c '
import sys, pathlib
p=pathlib.Path(sys.argv[1]); token=sys.stdin.read()
lines=[line for line in p.read_text().splitlines() if not line.startswith("PRISMA_GITHUB_TOKEN=")]
lines.append("PRISMA_GITHUB_TOKEN="+token)
p.write_text("\n".join(lines)+"\n")
' "$tmp"
sudo install -m 600 -o root -g root "$tmp" "$ENV_FILE"
unset TOKEN
sudo systemctl restart prisma
echo "GitHub conectado a Prisma y servicio reiniciado; la escritura continúa bloqueada."
