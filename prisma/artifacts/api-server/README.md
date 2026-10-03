# API de Prisma y contrato de Router IA

Prisma solo se conecta a este servidor. El servidor habla con el Router IA, así que las credenciales no se incluyen en la app móvil.

## Contrato que debe ofrecer el Router IA

La base URL del Router incluido termina en `/api/v1`. El servidor agrega las rutas siguientes:

### Chat y documentos

`POST /v1/chat/completions`

Encabezados:

```http
Authorization: Bearer <token>
Content-Type: application/json
```

Solicitud:

```json
{
  "model": "nombre-del-modelo",
  "max_tokens": 1024,
  "messages": [
    { "role": "system", "content": "..." },
    { "role": "user", "content": "Hola" }
  ],
  "stream": false
}
```

Por defecto, respuesta JSON Chat Completions con `choices[0].message.content`. El API la convierte a eventos SSE para la app. `finish_reason=length` se informa como respuesta incompleta.

Sólo con `AI_ROUTER_STREAM=true` se espera una respuesta `text/event-stream`:

```text
data: {"choices":[{"delta":{"content":"Hola"}}]}

data: [DONE]
```

El Router puede responder con eventos de error SSE; Prisma mostrará un error genérico y el servidor registrará el fallo sin exponer la credencial.

### Generación de imágenes

`POST /v1/images/generations`

Solicitud:

```json
{
  "model": "nombre-del-modelo-de-imagen",
  "prompt": "Descripción de la imagen",
  "size": "1024x1024"
}
```

Respuesta JSON:

```json
{
  "data": [{ "b64_json": "<imagen codificada en base64>" }]
}
```

## Configuración del servidor

Variables para el Router IA:

| Variable | Uso |
| --- | --- |
| `AI_ROUTER_BASE_URL` | URL base común, por ejemplo `https://router.example.com/api/v1`. |
| `AI_ROUTER_API_KEY` | Token Bearer obligatorio para chat y, por defecto, imágenes. Se guarda solo en el entorno del servidor. |
| `AI_ROUTER_CHAT_MODEL` | Nombre o alias de modelo que entiende el Router para chat y documentos. |
| `AI_ROUTER_IMAGE_MODEL` | Nombre o alias de modelo para generación de imágenes. |
| `AI_ROUTER_IMAGE_BASE_URL` | Opcional: base URL distinta para imágenes. |
| `AI_ROUTER_IMAGE_API_KEY` | Opcional: token distinto para imágenes; si no se configura, se usa `AI_ROUTER_API_KEY`. |

Hasta que se configure `AI_ROUTER_BASE_URL`, el servidor conserva como transición el proveedor de desarrollo actual mediante `AI_INTEGRATIONS_OPENAI_BASE_URL` y `AI_INTEGRATIONS_OPENAI_API_KEY`. Al configurar el Router, sus variables tienen prioridad.

No se requiere cambiar la app móvil para conectar el Router. El servidor mantiene las rutas actuales de Prisma (`/api/ai/chat` y `/api/ai/generate-image`) y convierte las solicitudes/respuestas al contrato descrito.