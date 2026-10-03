# CoreX

Una app privada para crear prototipos mediante conversación y guardar proyectos de Python.

## Configuración

La app necesita dos variables de entorno de Supabase:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLIC_KEY` (clave `sb_publishable_`; no uses una clave `service_role`)

Copiá `.env.example` como `.env.local` para desarrollo fuera de Replit. En Replit, configurá esas variables en el entorno de ejecución. El código no incluye claves privadas.

## Acceso de propietario

La app solo presenta inicio de sesión por correo y contraseña; no incluye una pantalla ni una llamada de registro. En Supabase:

1. Desactivá el registro de usuarios en la configuración de Authentication.
2. Creá manualmente la cuenta del propietario en Authentication → Users.
3. Ingresá en la app con esa cuenta.

La tabla `public.workspace_snapshots` tiene RLS habilitado y solo permite leer y modificar filas cuyo `user_id` coincide con `auth.uid()`.

## Persistencia y migración local

La primera sesión lee los espacios locales del navegador. Si no hay una copia remota, la importa a Supabase. Si ya existe una copia remota distinta, conserva los datos locales en una copia de seguridad descargable desde la app antes de usar la copia remota. No elimina la copia original durante la importación.

Los proyectos exportados como apps independientes conservan su almacenamiento local para seguir funcionando como archivos autónomos.

La migración de base de datos está en `supabase/migrations/`. Para desplegar este proyecto fuera de Replit, aplicá esa migración a la base de Supabase correspondiente antes de iniciar la app.