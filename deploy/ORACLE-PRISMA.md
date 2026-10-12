# Prisma en Oracle — traslado reversible

Estos archivos NO ejecutan una migración ni modifican los servicios Render. Prisma existente está en `CoreXFull/prisma` y requiere Node.js >=22 y pnpm 10.26.1.

## Preparar (en VM con Ubuntu, usuario ubuntu)

```bash
# Instalar Node 22 por el método oficial preferido del administrador (no viene automatizado).
git clone https://github.com/lgomezpallo/CoreXFull.git /home/ubuntu/CoreXFull
cd /home/ubuntu/CoreXFull
bash deploy/oracle-prisma-build.sh
```

Si el repositorio es privado, usar credenciales de GitHub con alcance mínimo; nunca ponerlas en la línea de comandos ni en los archivos de la app.

## Secretos y arranque

```bash
sudo install -d -m 700 /etc/prisma
sudo install -m 600 /dev/null /etc/prisma/prisma.env
sudoedit /etc/prisma/prisma.env
```

Variables mínimas que se deben configurar con valores reales y probados:

```ini
AI_ROUTER_BASE_URL=https://ROUTER_REAL/api/v1
AI_ROUTER_API_KEY=TOKEN_REAL
AI_ROUTER_CHAT_MODEL=router-ia-auto
```

No colocar claves de proveedores en Prisma. Si Router está en la misma Oracle, usar su URL local real y proteger el puerto. No elegir URL de Router sin verificar contrato y conectividad.

```bash
sudo cp /home/ubuntu/CoreXFull/deploy/oracle-prisma.service /etc/systemd/system/prisma.service
sudo systemctl daemon-reload
sudo systemctl enable --now prisma
sudo systemctl status prisma --no-pager
curl -fsS http://127.0.0.1:8080/api/healthz
sudo journalctl -u prisma -n 80 --no-pager
```

**No exponer el puerto 8080 públicamente.** Servir detrás del proxy HTTPS ya disponible (por ejemplo Caddy) con autenticación apropiada, sin pisar los dominios actuales. Antes de cambiar DNS, probar host/HTTPS y una llamada real al Router, además de la ruta healthz.

## Recuperación

Render permanece intacto. Ante un fallo: `sudo systemctl stop prisma`; restaurar DNS/proxy anterior si se cambió. No borrar datos ni credenciales. El Prisma actual arranca sin PostgreSQL para chat/health, pero NO tiene memoria de proyecto persistente ni herramientas reales de programación: esta migración no añade esas capacidades.

## Limitaciones

Los scripts suponen /home/ubuntu/CoreXFull, Ubuntu y node ya instalado; ajustar rutas si difieren. La compilación en una VM pequeña puede agotar RAM: verificar `free -h` y `df -h` antes. Solo una prueba de compilación y una prueba de la app desplegada demostrarán compatibilidad real. Esta rama NO instala Prisma, no valida Oracle y no cambia main.
