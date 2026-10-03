import { pool } from "@workspace/db";

export type PrismaMemory = {
  id: number;
  kind: string;
  scope: string;
  key: string;
  content: string;
  importance: number;
  createdAt: string;
  updatedAt: string;
};

let ready: Promise<void> | null = null;

export function ensurePrismaMemory(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    await pool.query(`
      create table if not exists prisma_memory (
        id bigserial primary key,
        kind text not null default 'fact',
        scope text not null default 'global',
        key text not null,
        content text not null,
        importance integer not null default 50 check (importance between 0 and 100),
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        unique(scope, key)
      )
    `);
    await pool.query(`create index if not exists prisma_memory_scope_idx on prisma_memory(scope, importance desc, updated_at desc)`);
    await pool.query(`create index if not exists prisma_memory_search_idx on prisma_memory using gin (to_tsvector('simple', coalesce(key,'') || ' ' || coalesce(content,'')))`);
    await seedInvariant("corex", "architecture.builder_decomposition", "CoreX construye desglosando el trabajo en operaciones pequeñas. No reemplazar ese enfoque por una única tarea gigante de programación. La planificación usa reasoning/document/vision según el contexto y las secciones se generan por tareas separadas.", 100);
    await seedInvariant("corex", "architecture.product_boundary", "CoreX es el constructor. Los productos que fabrica deben quedar independientes de CoreX. No mezclar producto final, Router IA y CoreX como una sola aplicación.", 100);
    await seedInvariant("corex", "architecture.router_boundary", "Router IA es backend independiente. CoreX consume Router IA; no debe administrar claves de proveedores ni reimplementar routing dentro del frontend.", 100);
    await seedInvariant("corex", "change_policy", "Antes de modificar CoreX: leer el código actual, recuperar memoria relevante, identificar la razón arquitectónica de lo existente, hacer el cambio mínimo, validar y registrar qué cambió y por qué.", 100);
    await seedInvariant("prisma", "mission", "Prisma debe ser el agente que conoce, recuerda, inspecciona y modifica CoreX. Su memoria persistente y el registro de decisiones deben evitar que se pierda el contexto entre conversaciones o despliegues.", 100);
  })();
  return ready;
}

async function seedInvariant(scope: string, key: string, content: string, importance: number) {
  await pool.query(
    `insert into prisma_memory(kind, scope, key, content, importance)
     values('invariant', $1, $2, $3, $4)
     on conflict(scope, key) do nothing`,
    [scope, key, content, importance],
  );
}

function rowToMemory(row: Record<string, unknown>): PrismaMemory {
  return {
    id: Number(row.id),
    kind: String(row.kind),
    scope: String(row.scope),
    key: String(row.key),
    content: String(row.content),
    importance: Number(row.importance),
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
  };
}

export async function listImportantMemories(scopes = ["global", "prisma", "corex"], limit = 24): Promise<PrismaMemory[]> {
  await ensurePrismaMemory();
  const result = await pool.query(
    `select * from prisma_memory
     where scope = any($1::text[])
     order by importance desc, updated_at desc
     limit $2`,
    [scopes, limit],
  );
  return result.rows.map(rowToMemory);
}

export async function searchPrismaMemory(query: string, scope?: string, limit = 12): Promise<PrismaMemory[]> {
  await ensurePrismaMemory();
  const clean = query.trim().slice(0, 500);
  if (!clean) return listImportantMemories(scope ? [scope] : ["global", "prisma", "corex"], limit);
  const result = await pool.query(
    `select *,
       ts_rank(to_tsvector('simple', coalesce(key,'') || ' ' || coalesce(content,'')), plainto_tsquery('simple', $1)) as rank
     from prisma_memory
     where ($2::text is null or scope = $2)
       and (
         to_tsvector('simple', coalesce(key,'') || ' ' || coalesce(content,'')) @@ plainto_tsquery('simple', $1)
         or key ilike '%' || $1 || '%'
         or content ilike '%' || $1 || '%'
       )
     order by rank desc, importance desc, updated_at desc
     limit $3`,
    [clean, scope ?? null, limit],
  );
  return result.rows.map(rowToMemory);
}

export async function rememberPrisma(input: {
  kind?: string;
  scope?: string;
  key: string;
  content: string;
  importance?: number;
}): Promise<PrismaMemory> {
  await ensurePrismaMemory();
  const kind = (input.kind ?? "fact").trim().slice(0, 40) || "fact";
  const scope = (input.scope ?? "global").trim().slice(0, 80) || "global";
  const key = input.key.trim().slice(0, 160);
  const content = input.content.trim().slice(0, 20_000);
  const importance = Math.max(0, Math.min(100, Math.trunc(input.importance ?? 60)));
  if (!key || !content) throw new Error("key and content are required");
  const result = await pool.query(
    `insert into prisma_memory(kind, scope, key, content, importance)
     values($1,$2,$3,$4,$5)
     on conflict(scope, key) do update set
       kind = excluded.kind,
       content = excluded.content,
       importance = greatest(prisma_memory.importance, excluded.importance),
       updated_at = now()
     returning *`,
    [kind, scope, key, content, importance],
  );
  return rowToMemory(result.rows[0]);
}

export async function recordConversationTurn(input: {
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  mode: string;
}): Promise<void> {
  await ensurePrismaMemory();
  await pool.query(`
    create table if not exists prisma_conversation_turns (
      id bigserial primary key,
      conversation_id text not null,
      role text not null check (role in ('user','assistant')),
      content text not null,
      mode text not null default 'chat',
      created_at timestamptz not null default now()
    )
  `);
  await pool.query(`create index if not exists prisma_conversation_turns_conv_idx on prisma_conversation_turns(conversation_id, created_at)`);
  await pool.query(
    `insert into prisma_conversation_turns(conversation_id, role, content, mode) values($1,$2,$3,$4)`,
    [input.conversationId.slice(0, 160), input.role, input.content.slice(0, 30_000), input.mode.slice(0, 32)],
  );
}

export async function getConversationTurns(conversationId: string, limit = 80) {
  await ensurePrismaMemory();
  await pool.query(`
    create table if not exists prisma_conversation_turns (
      id bigserial primary key,
      conversation_id text not null,
      role text not null check (role in ('user','assistant')),
      content text not null,
      mode text not null default 'chat',
      created_at timestamptz not null default now()
    )
  `);
  const result = await pool.query(
    `select role, content, mode, created_at from prisma_conversation_turns
     where conversation_id = $1 order by created_at asc limit $2`,
    [conversationId.slice(0, 160), limit],
  );
  return result.rows.map((row) => ({
    role: String(row.role) as "user" | "assistant",
    content: String(row.content),
    mode: String(row.mode),
    createdAt: new Date(String(row.created_at)).toISOString(),
  }));
}
