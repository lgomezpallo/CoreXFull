/**
 * Repository discovery for Prisma. The GitHub token controls which private
 * repositories are accessible; never assume that ownership grants access.
 */
export type PrismaRepository = {
  fullName: string;
  name: string;
  private: boolean;
  defaultBranch: string;
  canPush: boolean;
};

export async function listPrismaGithubRepositories(): Promise<PrismaRepository[]> {
  const owner = process.env.PRISMA_GITHUB_OWNER?.trim() || "lgomezpallo";
  const token = process.env.PRISMA_GITHUB_TOKEN?.trim();
  if (!token) {
    throw new Error("Para descubrir repositorios privados, Prisma necesita PRISMA_GITHUB_TOKEN con acceso a GitHub.");
  }

  const repositories: PrismaRepository[] = [];
  let page = 1;
  while (true) {
    const url = new URL("https://api.github.com/user/repos");
    url.searchParams.set("affiliation", "owner");
    url.searchParams.set("per_page", "100");
    url.searchParams.set("page", String(page));
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "Prisma-Programmer",
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`No se pudo consultar GitHub (HTTP ${response.status}).`);
    const items: unknown = await response.json();
    if (!Array.isArray(items)) throw new Error("GitHub devolvió un listado inesperado.");
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const repo = item as Record<string, any>;
      if (repo.owner?.login?.toLowerCase() !== owner.toLowerCase()) continue;
      if (typeof repo.name !== "string" || typeof repo.full_name !== "string") continue;
      repositories.push({
        fullName: repo.full_name,
        name: repo.name,
        private: Boolean(repo.private),
        defaultBranch: typeof repo.default_branch === "string" ? repo.default_branch : "main",
        canPush: Boolean(repo.permissions?.push),
      });
    }
    if (items.length < 100) break;
    page += 1;
    if (page > 100) throw new Error("Demasiados repositorios: paginación interrumpida.");
  }
  return repositories.sort((a, b) => a.name.localeCompare(b.name));
}
