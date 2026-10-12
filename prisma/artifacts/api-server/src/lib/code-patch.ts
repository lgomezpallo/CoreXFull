export function applyExactPatch(before: string, patch: unknown): string {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new Error("Parche inválido.");
  }
  const candidate = patch as { find?: unknown; replace?: unknown };
  if (typeof candidate.find !== "string" || typeof candidate.replace !== "string" ||
      !candidate.find || candidate.find === candidate.replace) {
    throw new Error("El parche requiere un cambio de texto válido.");
  }
  if (before.split(candidate.find).length !== 2) {
    throw new Error("El fragmento buscado debe aparecer exactamente una vez.");
  }
  const after = before.replace(candidate.find, candidate.replace);
  if (Buffer.byteLength(after, "utf8") > 35000) {
    throw new Error("El archivo resultante supera el tamaño permitido.");
  }
  return after;
}
