const GITHUB_OWNER = process.env.PRISMA_GITHUB_OWNER?.trim() || "lgomezpallo";
const GITHUB_REPO = process.env.PRISMA_GITHUB_REPO?.trim() || "CoreXFull";
const GITHUB_BRANCH = process.env.PRISMA_GITHUB_BRANCH?.trim() || "main";
const API_ROOT = `https://api.github.com/repos/${encodeURIComponent(GITHUB_OWNER)}/${encodeURIComponent(GITHUB_REPO)}`;

function githubHeaders(write = false): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "Prisma-CoreX-Agent",
  };
  const token = process.env.PRISMA_GITHUB_TOKEN?.trim();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (write && !token) throw new Error("Prisma no tiene configurada una credencial GitHub de escritura.");
  return headers;
}

function safeCorexPath(value: string): string {
  const path = value.replaceAll("\\", "/").replace(/^\/+/, "").trim();
  if (!path || path.includes("..") || !(path === "corex" || path.startsWith("corex/"))) {
    throw new Error("La herramienta sólo puede operar dentro de corex/.");
  }
  return path;
}

async function githubJson(url: string, init?: RequestInit): Promise<any> {
  const response = await fetch(url, init);
  const text = await response.text();
  let payload: any = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }
  if (!response.ok) {
    const message = payload && typeof payload === "object" && typeof payload.message === "string"
      ? payload.message
      : `GitHub HTTP ${response.status}`;
    throw new Error(message.slice(0, 500));
  }
  return payload;
}

export async function corexReadFile(pathValue: string) {
  const path = safeCorexPath(pathValue);
  const payload = await githubJson(`${API_ROOT}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(GITHUB_BRANCH)}`, {
    headers: githubHeaders(false),
  });
  if (!payload || Array.isArray(payload) || payload.type !== "file" || typeof payload.content !== "string") {
    throw new Error("La ruta no corresponde a un archivo legible.");
  }
  const content = Buffer.from(payload.content.replace(/\n/g, ""), "base64").toString("utf8");
  return {
    path,
    sha: String(payload.sha ?? ""),
    size: Number(payload.size ?? Buffer.byteLength(content)),
    content: content.slice(0, 120_000),
    truncated: content.length > 120_000,
  };
}

export async function corexListTree(pathValue = "corex", depth = 2) {
  const root = safeCorexPath(pathValue);
  const maxDepth = Math.max(0, Math.min(4, Math.trunc(depth)));
  const collected: Array<{ path: string; type: string; sha?: string; size?: number }> = [];

  async function walk(path: string, level: number): Promise<void> {
    const payload = await githubJson(`${API_ROOT}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(GITHUB_BRANCH)}`, {
      headers: githubHeaders(false),
    });
    if (!Array.isArray(payload)) {
      collected.push({ path, type: String(payload?.type ?? "file"), sha: payload?.sha, size: payload?.size });
      return;
    }
    for (const item of payload.slice(0, 250)) {
      collected.push({ path: String(item.path), type: String(item.type), sha: item.sha, size: item.size });
      if (item.type === "dir" && level < maxDepth) await walk(String(item.path), level + 1);
      if (collected.length >= 1200) return;
    }
  }

  await walk(root, 0);
  return { root, branch: GITHUB_BRANCH, entries: collected.slice(0, 1200), truncated: collected.length >= 1200 };
}

export async function corexSearch(queryValue: string) {
  const query = queryValue.trim().slice(0, 200);
  if (!query) throw new Error("La búsqueda no puede estar vacía.");
  const encoded = encodeURIComponent(`${query} repo:${GITHUB_OWNER}/${GITHUB_REPO} path:corex`);
  const payload = await githubJson(`https://api.github.com/search/code?q=${encoded}&per_page=20`, {
    headers: githubHeaders(false),
  });
  const items = Array.isArray(payload?.items) ? payload.items : [];
  return {
    query,
    results: items.map((item: any) => ({
      name: String(item.name ?? ""),
      path: String(item.path ?? ""),
      sha: String(item.sha ?? ""),
      url: String(item.html_url ?? ""),
    })).filter((item: { path: string }) => item.path.startsWith("corex/")),
  };
}

export async function corexWriteFile(input: {
  path: string;
  content: string;
  expectedSha: string;
  message: string;
}) {
  const path = safeCorexPath(input.path);
  const expectedSha = input.expectedSha.trim();
  const message = input.message.trim().slice(0, 160);
  if (!expectedSha) throw new Error("La escritura exige el SHA actual del archivo leído previamente.");
  if (!message) throw new Error("La escritura exige un mensaje de cambio.");
  if (Buffer.byteLength(input.content, "utf8") > 800_000) throw new Error("El archivo es demasiado grande para esta herramienta.");

  const payload = await githubJson(`${API_ROOT}/contents/${path.split("/").map(encodeURIComponent).join("/")}`, {
    method: "PUT",
    headers: { ...githubHeaders(true), "Content-Type": "application/json" },
    body: JSON.stringify({
      message: `[Prisma] ${message}`,
      content: Buffer.from(input.content, "utf8").toString("base64"),
      sha: expectedSha,
      branch: GITHUB_BRANCH,
    }),
  });
  return {
    path,
    commitSha: String(payload?.commit?.sha ?? ""),
    contentSha: String(payload?.content?.sha ?? ""),
  };
}

export async function corexCreateFile(input: { path: string; content: string; message: string }) {
  const path = safeCorexPath(input.path);
  const message = input.message.trim().slice(0, 160);
  if (!message) throw new Error("La creación exige un mensaje de cambio.");
  if (Buffer.byteLength(input.content, "utf8") > 800_000) throw new Error("El archivo es demasiado grande para esta herramienta.");
  const payload = await githubJson(`${API_ROOT}/contents/${path.split("/").map(encodeURIComponent).join("/")}`, {
    method: "PUT",
    headers: { ...githubHeaders(true), "Content-Type": "application/json" },
    body: JSON.stringify({
      message: `[Prisma] ${message}`,
      content: Buffer.from(input.content, "utf8").toString("base64"),
      branch: GITHUB_BRANCH,
    }),
  });
  return {
    path,
    commitSha: String(payload?.commit?.sha ?? ""),
    contentSha: String(payload?.content?.sha ?? ""),
  };
}

export function corexToolStatus() {
  return {
    repository: `${GITHUB_OWNER}/${GITHUB_REPO}`,
    branch: GITHUB_BRANCH,
    read: true,
    write: Boolean(process.env.PRISMA_GITHUB_TOKEN?.trim()),
    writeScope: "corex/",
    optimisticLocking: true,
  };
}
