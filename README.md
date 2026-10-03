# CoreXFull

Repositorio desplegable fuera de Replit. Los ZIP originales se conservan como respaldo del material recibido.

| Componente | Carpeta | Arranque | Health |
| --- | --- | --- | --- |
| CoreX | `corex/` | `pnpm start` después de `pnpm build` | `/api/healthz` |
| Router-IA | `router-ia/` | `npm start` después de `npm ci` | `/health` |
| Prisma independiente | `prisma/` | `pnpm start` después de `pnpm build` | `/api/healthz` |

Usar Node 22.22 y pnpm **10.26.1** para los dos workspaces. Los proyectos mantienen sus propios lockfiles y dependencias: no unirlos en un único workspace.

## Conexiones

CoreX usa `ROUTER_IA_URL` (origen del Router) y `ROUTER_IA_TOKEN`.
Prisma usa `AI_ROUTER_BASE_URL` (origen del Router seguido de `/api/v1`), `AI_ROUTER_API_KEY` (el mismo token de aplicación) y `AI_ROUTER_CHAT_MODEL=router-ia-auto`.
Las claves de proveedores permanecen en Router-IA.

Prisma realiza una petición JSON sin streaming al Router y convierte la respuesta a los eventos que ya espera su interfaz. El límite actual del Router es 1024 tokens. Si la respuesta llega truncada, Prisma informa el límite y no la marca como completa. `AI_ROUTER_STREAM=true` se reserva para un futuro Router compatible con streaming.

`pnpm build` en Prisma compila el API y exporta la app Expo para web. El API sirve esa web; no necesita Replit, Expo Go ni CoreX para abrirse en el navegador. La web usa su propio origen para `/api`, mientras que la app nativa sigue aceptando `EXPO_PUBLIC_DOMAIN`.

El API actual de Prisma no importa la base de datos: chat y health pueden arrancar sin `DATABASE_URL`. El paquete `lib/db` se conserva para futuras funciones que sí lo necesiten.

## Render

`render.yaml` describe los tres servicios separados, con auto-deploy apagado y planes gratuitos. **Antes de aplicarlo hay que verificar los servicios existentes**, su repositorio, tipo, runtime y secretos. Los nombres en el Blueprint deben coincidir con los recursos elegidos; no aplicar a ciegas sobre servicios anteriores.

Conservar todos los secretos actuales. No generar un nuevo token del Router ni una nueva clave de cifrado para migrar el servicio. Los valores de Supabase de CoreX son los del proyecto de CoreX; los del Router son los de su propio proyecto. No trasladar una service-role key al frontend.

Las URL se completan con las direcciones reales que asigne Render. En el Blueprint los tokens de los consumidores se referencian al secreto de Router-IA. Los servicios existentes pueden configurarse directamente conservando sus variables adicionales.

## Estado del supervisor

El ZIP de Prisma contiene chat, documentos e imágenes; **no contiene supervisor, reparación de código, acceso a logs de Render, commits, redeploy ni rollback**. Separar el proceso permite que continúe cuando cae CoreX, pero no agrega por sí solo esas herramientas.

La siguiente etapa requiere conectar diagnóstico a los servicios reales y configurar acceso limitado al repositorio y a Render, con pruebas antes del despliegue y recuperación al commit anterior. No afirmar que una reparación ocurrió sólo porque el chat la describe.

Router-IA actualmente sólo ofrece chat completions: imágenes de Prisma necesitan un endpoint y modelo de imágenes aparte. La gestión de proveedores desde CoreX usa un contrato distinto al panel de este Router; el panel operativo es `/admin` del Router.

## Verificación

```sh
cd router-ia && npm ci && npm test
cd ../corex && pnpm install --frozen-lockfile && pnpm build
cd ../prisma && pnpm install --frozen-lockfile && pnpm build
cd .. && node scripts/test-prisma-standalone.mjs
```

La prueba de Prisma utiliza el servidor real de Router-IA con almacenamiento y proveedor simulados; no llama proveedores externos. Comprueba web, health, chat sin CoreX, truncación y errores del Router. Las credenciales y la inferencia en Render deben comprobarse después de conectar los servicios reales.

## Instalar las apps

Las tres interfaces tienen manifiesto PWA, íconos de instalación y service worker:

- CoreX: https://corex-egbs.onrender.com/
- Prisma: https://corexfull-prisma.onrender.com/
- Router IA (panel): https://router-ia-standalone.onrender.com/admin/

En Android, abrir el enlace en Chrome y elegir **Instalar app** o **Añadir a pantalla de inicio** desde el menú. En iPhone, abrirlo en Safari y usar **Compartir → Añadir a pantalla de inicio**.

CoreX y Prisma consultan la versión publicada al abrirse; el service worker sólo guarda una pantalla de aviso sin conexión. No intercepta ni guarda APIs, sesiones ni conversaciones. La IA requiere internet. Router conserva su caché del panel público y excluye su API privada.

Validación después de compilar ambas apps: `node scripts/test-pwa.mjs`.
