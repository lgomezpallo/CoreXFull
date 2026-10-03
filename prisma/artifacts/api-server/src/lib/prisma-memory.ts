import { prismaMemoryRequest } from "./prisma-memory-client";

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

type MemoryRow = {
  id: number;
  kind: string;
  scope: string;
  key: string;
  content: string;
  importance: number;
  created_at: string;
  updated_at: string;
};

function mapMemory(row: MemoryRow): PrismaMemory {
  return {
    id: Number(row.id),
    kind: row.kind,
    scope: row.scope,
    key: row.key,
    content: row.content,
    importance: Number(row.importance),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function ensurePrismaMemory(): Promise<void> {
  await listImportantMemories(["prisma"], 1);
}

export async function listImportantMemories(scopes = ["global", "prisma", "corex"], limit = 24): Promise<PrismaMemory[]> {
  const rows = await prismaMemoryRequest<MemoryRow[]>({ op: "important", scopes, limit });
  return (rows ?? []).map(mapMemory);
}

export async function searchPrismaMemory(query: string, scope?: string, limit = 12): Promise<PrismaMemory[]> {
  const rows = await prismaMemoryRequest<MemoryRow[]>({ op: "search", query, scope, limit });
  return (rows ?? []).map(mapMemory);
}

export async function rememberPrisma(input: {
  kind?: string;
  scope?: string;
  key: string;
  content: string;
  importance?: number;
}): Promise<PrismaMemory> {
  const row = await prismaMemoryRequest<MemoryRow>({
    op: "remember",
    kind: input.kind ?? "fact",
    scope: input.scope ?? "global",
    key: input.key,
    content: input.content,
    importance: input.importance ?? 60,
  });
  return mapMemory(row);
}

export async function recordConversationTurn(input: {
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  mode: string;
}): Promise<void> {
  await prismaMemoryRequest<unknown>({
    op: "record_turn",
    conversationId: input.conversationId,
    role: input.role,
    content: input.content,
    mode: input.mode,
  });
}

export async function getConversationTurns(conversationId: string, limit = 80) {
  return prismaMemoryRequest<Array<{
    role: "user" | "assistant";
    content: string;
    mode: string;
    created_at: string;
  }>>({ op: "get_turns", conversationId, limit });
}
