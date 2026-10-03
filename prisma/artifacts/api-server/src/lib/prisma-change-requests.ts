import { pool } from "@workspace/db";

let ready: Promise<void> | null = null;

async function ensureChangeRequests() {
  if (ready) return ready;
  ready = pool.query(`
    create table if not exists prisma_change_requests (
      id bigserial primary key,
      target_path text not null,
      expected_sha text,
      proposed_content text not null,
      reason text not null,
      status text not null default 'pending' check (status in ('pending','approved','applied','rejected','stale','error')),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `).then(() => undefined);
  return ready;
}

export async function createChangeRequest(input: {
  targetPath: string;
  expectedSha?: string;
  proposedContent: string;
  reason: string;
}) {
  await ensureChangeRequests();
  const targetPath = input.targetPath.replaceAll("\\", "/").replace(/^\/+/, "").trim();
  if (!targetPath.startsWith("corex/") || targetPath.includes("..")) {
    throw new Error("Los cambios de Prisma sólo pueden apuntar a corex/.");
  }
  if (!input.proposedContent.trim()) throw new Error("El cambio propuesto está vacío.");
  if (!input.reason.trim()) throw new Error("El cambio necesita una razón explícita.");
  const result = await pool.query(
    `insert into prisma_change_requests(target_path, expected_sha, proposed_content, reason)
     values($1,$2,$3,$4)
     returning id, target_path, expected_sha, reason, status, created_at`,
    [targetPath, input.expectedSha?.trim() || null, input.proposedContent, input.reason.trim().slice(0, 4000)],
  );
  return result.rows[0];
}

export async function listChangeRequests(status = "pending", limit = 20) {
  await ensureChangeRequests();
  const result = await pool.query(
    `select id, target_path, expected_sha, reason, status, created_at, updated_at
     from prisma_change_requests
     where ($1::text = 'all' or status = $1)
     order by created_at desc limit $2`,
    [status, Math.max(1, Math.min(100, limit))],
  );
  return result.rows;
}
