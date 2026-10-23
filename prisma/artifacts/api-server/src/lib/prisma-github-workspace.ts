import { listPrismaGithubRepositories } from "./prisma-github-repositories";

export type PrismaWorkspace = { repository: string; branch: string; canPush: boolean };

function validPath(path: string): string {
  const cleaned = path.replaceAll("\\", "/").trim();
  const segments = cleaned.split("/");
  if (!cleaned || cleaned.startsWith("/") || segments.some((s) => !s || s === "." || s === "..") || /[\x00-\x1f]/.test(cleaned)) {
    throw new Error("Ruta de archivo inválida dentro del repositorio.");
  }
  return cleaned;
}

async function workspace(name: string, write: boolean): Promise<PrismaWorkspace> {
  const repos = await listPrismaGithubRepositories();
  const repo = repos.find((r) => r.fullName.toLowerCase() === name.toLowerCase());
  if (!repo) throw new Error("El repositorio no pertenece a la cuenta autorizada o no es accesible.");
  if (write && !repo.canPush) throw new Error("Prisma no tiene permiso de escritura en este repositorio.");
  return { repository: repo.fullName, branch: repo.defaultBranch, canPush: repo.canPush };
}

function headers() {
  const token = process.env.PRISMA_GITHUB_TOKEN?.trim();
  if (!token) throw new Error("Falta PRISMA_GITHUB_TOKEN.");
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "Prisma-Programmer",
  };
}

function fileUrl(repo: string, path: string) {
  return `https://api.github.com/repos/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}`;
}

async function githubRequest(url: string, init: RequestInit) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  const result: any = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`GitHub HTTP ${res.status}: ${String(result?.message ?? "Error").slice(0, 200)}`);
  return result;
}

/** Read a file from any repository owned by the configured user. */
export async function prismaReadRepositoryFile(repository: string, pathValue: string) {
  const target = await workspace(repository, false);
  const path = validPath(pathValue);
  const data = await githubRequest(`${fileUrl(target.repository, path)}?ref=${encodeURIComponent(target.branch)}`, { headers: headers() });
  if (data?.type !== "file" || typeof data.content !== "string") throw new Error("No es un archivo de texto accesible.");
  const size = Number(data.size ?? 0);
  if (size > 500_000) throw new Error("Archivo demasiado grande para lectura directa.");
  return {
    repository: target.repository, branch: target.branch, path,
    sha: String(data.sha), content: Buffer.from(data.content.replace(/\n/g, ""), "base64").toString("utf8"),
  };
}

/** A SHA is mandatory for editing; writes cannot overwrite an unseen revision. */
export async function prismaUpdateRepositoryFile(input: {
  repository: string; path: string; content: string; expectedSha: string; message: string;
}) {
  const target = await workspace(input.repository, true);
  const path = validPath(input.path);
  if (!/^[a-f0-9]{40}$/i.test(input.expectedSha)) throw new Error("Falta el SHA válido del archivo leído.");
  if (!input.message.trim()) throw new Error("Falta el mensaje del commit.");
  if (Buffer.byteLength(input.content, "utf8") > 500_000) throw new Error("Archivo demasiado grande.");
  const result = await githubRequest(fileUrl(target.repository, path), {
    method: "PUT", headers: { ...headers(), "Content-Type": "application/json" },
    body: JSON.stringify({
      branch: target.branch,
      sha: input.expectedSha,
      message: `[Prisma] ${input.message.trim().slice(0, 150)}`,
      content: Buffer.from(input.content, "utf8").toString("base64"),
    }),
  });
  return { repository: target.repository, path, commitSha: String(result.commit?.sha ?? ""), contentSha: String(result.content?.sha ?? "") };
}
