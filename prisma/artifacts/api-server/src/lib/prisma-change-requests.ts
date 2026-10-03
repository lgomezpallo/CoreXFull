import { prismaMemoryRequest } from "./prisma-memory-client";

export async function createChangeRequest(input: {
  targetPath: string;
  expectedSha?: string;
  proposedContent: string;
  reason: string;
}) {
  const targetPath = input.targetPath.replaceAll("\\", "/").replace(/^\/+/, "").trim();
  if (!targetPath.startsWith("corex/") || targetPath.includes("..")) {
    throw new Error("Los cambios de Prisma sólo pueden apuntar a corex/.");
  }
  if (!input.proposedContent.trim()) throw new Error("El cambio propuesto está vacío.");
  if (!input.reason.trim()) throw new Error("El cambio necesita una razón explícita.");
  return prismaMemoryRequest<Record<string, unknown>>({
    op: "create_change",
    targetPath,
    expectedSha: input.expectedSha?.trim() || "",
    proposedContent: input.proposedContent,
    reason: input.reason.trim(),
  });
}

export async function listChangeRequests(status = "pending", limit = 20) {
  return prismaMemoryRequest<Array<Record<string, unknown>>>({
    op: "list_changes",
    status,
    limit: Math.max(1, Math.min(100, limit)),
  });
}
