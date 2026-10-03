# Router IA

Servicio independiente para administrar proveedores OpenAI-compatibles y sus
rutas desde un panel privado. La API de inferencia solo usa modelos guardados
con acceso gratuito explícito, sin reintentos ni fallback a otro proveedor. La
aplicación usa Node.js sin dependencias externas y guarda las claves de proveedor
cifradas en el proyecto Supabase exclusivo de Router IA.

## Requisitos

- Node.js 22.9 o superior
- Docker para probar el contenedor localmente (opcional)

## Ejecutar localmente

1. Copiá `.env.example` a `.env`.
2. Configurá `ROUTER_APP_TOKEN` y `ROUTER_ADMIN_TOKEN` con valores aleatorios
   largos y distintos.
3. Para habilitar el almacenamiento, configurá juntos:
   - `ROUTER_SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `ROUTER_PROVIDER_ENCRYPTION_KEY` (64 caracteres hexadecimales, 32 bytes)
4. Iniciá el servicio:

   ```sh
   npm start
   ```

5. Abrí `/admin` para iniciar sesión y configurar uno o más proveedores.
6. Ejecutá las pruebas:

   ```sh
   npm test
   ```

Las pruebas usan proveedores simulados: no ejecutan inferencias ni necesitan
credenciales. `ROUTER_APP_TOKEN` autentica solicitudes de la aplicación;
`ROUTER_ADMIN_TOKEN` solo habilita el panel. No reutilices uno para el otro.

## Inicializar Supabase

Usá un proyecto separado de Router IA; no conectes la base de datos de CoreX.
Aplicá las migraciones
`supabase/migrations/20261001_router_ia_providers.sql` y
`supabase/migrations/20261002_router_ia_capabilities.sql` antes de guardar un
proveedor. La tabla tiene RLS habilitado y no permite acceso a `anon` ni a
`authenticated`; el servicio usa `SUPABASE_SERVICE_ROLE_KEY` desde el servidor.

Las API keys de proveedor se cifran con AES-256-GCM antes de enviarse a Supabase.
`ROUTER_PROVIDER_ENCRYPTION_KEY` debe ser exactamente una clave hexadecimal de
32 bytes y mantenerse privada, junto con el token de servicio y el token admin.
Conservá una copia segura de esa clave: si se pierde o cambia, las claves
guardadas no se podrán descifrar.

## Panel de proveedores

- `GET /admin` sirve el panel; requiere `ROUTER_ADMIN_TOKEN` para iniciar sesión.
- Permite Groq, OpenAI, OpenRouter y endpoints personalizados compatibles con
  OpenAI. Los endpoints personalizados deben usar HTTPS público.
- **Consultar modelos** usa únicamente `GET /models`. No manda mensajes a un
  modelo ni ejecuta una inferencia. Los cargos por una consulta de catálogo, si
  los hubiera, dependen del proveedor.
- Para proveedores distintos de Groq y NVIDIA API Catalog, un modelo se importa
  automáticamente solo si todos sus precios publicados son `$0`. Para Groq,
  Router IA cruza el catálogo con la lista oficial de modelos que tienen cuotas
  en el plan Free: https://console.groq.com/docs/rate-limits. Esa lista se
  verificó el `2026-10-02`; el acceso aplica dentro de esas cuotas.
- Para `https://integrate.api.nvidia.com/v1`, Router IA marca como acceso de
  prototipado sujeto a cuotas los modelos devueltos por el API Catalog de NVIDIA.
  Este acceso no es una promesa de uso ilimitado ni de producción.
- `POST /api/v1/chat/completions` solo ejecuta modelos activos guardados que
  tengan una de esas autorizaciones gratuitas explícitas. Para otras rutas,
  exige precios publicados completos en cero, incluidos todos los campos de
  precio. Los modelos sin metadatos suficientes o con algún precio distinto de
  cero se rechazan.
- Cada solicitud se envía una sola vez al endpoint del proveedor del modelo
  seleccionado. Router IA no reintenta ni cambia a otro modelo o proveedor ante
  errores, límites o falta de cuota. Las solicitudes elegibles consumen las
  cuotas o créditos de prueba que aplique el proveedor.
- Las respuestas se limitan a 8.192 tokens de salida y no se admite streaming ni
  más de una respuesta por solicitud.
- Podés mantener varios proveedores activos. Cada uno tiene capacidades
  declaradas y una prioridad entre 1 y 100; las rutas muestran prioridad mayor
  primero.
- Las capacidades elegidas no se verifican con prompts. El catálogo solo
  conserva los metadatos publicados por el proveedor y no demuestra que el
  modelo cumpla una tarea.
- Guardar un proveedor cifra y persiste la clave. La lista del panel nunca
  devuelve ni vuelve a mostrar las claves.
- Las sesiones usan una cookie `HttpOnly`, `SameSite=Strict` y vencen a las ocho
  horas. En producción también se marca `Secure`.

## API de Router IA

- `GET /health` responde `200` cuando `ROUTER_APP_TOKEN` está configurado.
- `GET /api/v1/auth/check` acepta `Authorization: Bearer <ROUTER_APP_TOKEN>` y
  responde `204` si el token es válido. No llama al proveedor.
- `POST /api/v1/chat/completions` valida el token, selecciona únicamente un
  modelo activo con elegibilidad gratuita explícita y envía una sola solicitud a
  su proveedor. Puede elegirlo Router IA con `model: "router-ia-auto"` o sin
  campo `model`; en ese caso selecciona la ruta elegible activa de mayor
  prioridad. La respuesta también usa `model: "router-ia-auto"` y no revela el
  modelo interno. No hay reintentos ni fallback.

## Integración desde CoreX

CoreX llama a Router IA desde su backend y no necesita conocer el proveedor ni
el modelo interno. Router IA selecciona la ruta activa elegible de mayor
prioridad, según la configuración del panel. El proveedor, su endpoint y su
clave permanecen dentro de Router IA.

Configurá estos valores como variables de entorno del servidor de CoreX:

| Variable sugerida | Valor |
| --- | --- |
| `ROUTER_IA_BASE_URL` | `https://router-ia-standalone.onrender.com/api/v1` |
| `ROUTER_IA_APP_TOKEN` | El mismo secreto que `ROUTER_APP_TOKEN` en Router IA. |

CoreX puede comprobar el token con `GET /api/v1/auth/check`; una respuesta
`204` confirma la autenticación y no ejecuta una inferencia. Para generar una
respuesta, CoreX envía sus mensajes y el alias fijo de Router:

```js
const response = await fetch(
  `${process.env.ROUTER_IA_BASE_URL}/chat/completions`,
  {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.ROUTER_IA_APP_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "router-ia-auto",
      messages,
      stream: false,
      max_tokens: 1024,
    }),
  },
);

if (!response.ok) {
  throw new Error(`Router IA respondió ${response.status}.`);
}

const completion = await response.json();
```

No expongas `ROUTER_IA_APP_TOKEN` en el navegador ni lo guardes en el repositorio.
Las solicitudes son de backend a backend. Router IA no admite streaming, limita
las respuestas a 8.192 tokens y no reintenta ni cambia de proveedor cuando una
solicitud falla.

## Configuración en Render

El servicio mantiene `/health` como verificación y el auto-deploy desactivado.
Configurá las siguientes variables en el servicio existente:

| Variable | Uso |
| --- | --- |
| `ROUTER_APP_TOKEN` | Token que autentica solicitudes de CoreX. |
| `ROUTER_ADMIN_TOKEN` | Token independiente para iniciar sesión en `/admin`. |
| `ROUTER_SUPABASE_URL` | URL del proyecto Supabase de Router IA. |
| `SUPABASE_SERVICE_ROLE_KEY` | Acceso de servidor a la tabla privada de proveedores. |
| `ROUTER_PROVIDER_ENCRYPTION_KEY` | Clave AES-256-GCM hexadecimal de 32 bytes. |

No ingreses secretos en `render.yaml`, `.env.example`, el código o Git. Para la
configuración del servicio existente, conserva todas sus variables actuales y
agrega las necesarias como secretos. No elimines variables existentes del
servicio de Render.