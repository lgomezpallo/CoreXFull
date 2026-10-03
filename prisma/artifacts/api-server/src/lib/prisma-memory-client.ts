function memoryConfig() {
  const url = process.env.PRISMA_MEMORY_URL?.trim();
  const key = process.env.PRISMA_MEMORY_SECRET?.trim();
  if (!url || !key) throw new Error("La memoria persistente de Prisma no está configurada.");
  return { url, key };
}

export async function prismaMemoryRequest<T>(payload: Record<string, unknown>): Promise<T> {
  const { url, key } = memoryConfig();
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-prisma-memory-key": key,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20_000),
  });
  const data = await response.json().catch(() => null) as { data?: T; error?: string } | null;
  if (!response.ok) {
    throw new Error(`La memoria de Prisma falló (HTTP ${response.status}${data?.error ? `: ${data.error}` : ""}).`);
  }
  return data?.data as T;
}
