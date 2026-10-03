# Prisma — proyecto completo

Este ZIP contiene la app móvil Expo, el servidor Express que usa Prisma, el contrato OpenAPI y los paquetes compartidos de API y base de datos.

## Requisitos

- Node.js 22 o superior
- pnpm 10
- PostgreSQL sólo para futuras funciones que importen `lib/db` (chat y health no lo usan)

No se incluyen dependencias instaladas, credenciales, configuración personal de Replit ni carpetas de compilación. El comando `dev` de Expo se dejó como `expo start` para que funcione fuera de Replit.

## Instalación

Desde esta carpeta:

```sh
pnpm install
```

## Iniciar el servidor

El servidor de chat actual no importa el paquete de base de datos y puede iniciar sin PostgreSQL. En una terminal, define la URL y el modelo del Router IA. Mantén `AI_ROUTER_API_KEY` únicamente en el entorno del servidor; nunca la pongas en Expo ni en una variable `EXPO_PUBLIC_*`.

macOS/Linux (ejemplo):

```sh
export PORT=8080
export AI_ROUTER_BASE_URL='https://router.example.com/api/v1'
export AI_ROUTER_API_KEY=''
export AI_ROUTER_CHAT_MODEL='router-ia-auto'
export AI_ROUTER_IMAGE_MODEL='nombre-del-modelo-imagen'
pnpm dev:api
```

En PowerShell, define las mismas variables con `$env:NOMBRE = 'valor'` antes de ejecutar `pnpm dev:api`.

El contrato de endpoints esperado está documentado en `artifacts/api-server/README.md`. Si todavía no hay un Router configurado, las solicitudes de IA devolverán un error de configuración.

## Iniciar Prisma

En otra terminal, configura `EXPO_PUBLIC_DOMAIN` con la dirección del servidor API y ejecuta Expo:

```sh
EXPO_PUBLIC_DOMAIN=http://localhost:8080 pnpm dev:mobile
```

En PowerShell:

```powershell
$env:EXPO_PUBLIC_DOMAIN = 'http://localhost:8080'
pnpm dev:mobile
```

Para usar Expo Go desde un teléfono físico, reemplaza `localhost` por la IP local de la computadora; para un emulador Android normalmente se usa `10.0.2.2`.

## Verificación de tipos

```sh
pnpm typecheck
```

## Publicar web independiente

`pnpm build` compila API y exporta Expo web. `pnpm start` sirve ambos desde un único servicio; la web usa su propio origen para el API. No configurar `EXPO_PUBLIC_DOMAIN` al compilar web salvo que se quiera separar API y frontend.
