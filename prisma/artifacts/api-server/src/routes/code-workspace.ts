import { Router } from "express";

const routes = Router();
const owner = process.env.PRISMA_CODE_OWNER?.trim() || "lgomezpallo";
const allowed = (process.env.PRISMA_CODE_REPOS || "I.achat.Full,CoreXFull,R.outer.full")
  .split(",").map(x => x.trim()).filter(Boolean);

function checkedRepo(value: unknown): string {
  const repo = String(value ?? "");
  if (!/^[a-zA-Z0-9_.-]{1,100}$/.test(repo) || !allowed.includes(repo)) {
    throw new Error("Repositorio no autorizado.");
  }
  return repo;
}

function checkedPath(value: unknown): string {
  const path = String(value ?? "");
  const segments = path.split("/");
  if (!path || path.length > 500 || path.startsWith("/") ||
      segments.some(s => !s || s === "." || s === ".." || s.startsWith("."))) {
    throw new Error("Ruta inválida o sensible.");
  }
  return path;
}

async function fetchGitHub(url: string) {
  const token = process.env.PRISMA_GITHUB_TOKEN?.trim();
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "Prisma-Code-Workspace",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw new Error(`GitHub respondió HTTP ${response.status}`);
  return response.json() as Promise<any>;
}

// Disabled unless a separate access gate is deliberately configured.
// Expose only behind an authenticated private reverse proxy.
function authorize(req: any, res: any, next: any) {
  const secret = process.env.PRISMA_CODE_ACCESS_TOKEN;
  const candidate = req.get("X-Prisma-Code-Token");
  if (!secret || !candidate || candidate !== secret) {
    res.status(403).json({ error: "Acceso de programación deshabilitado o no autorizado." });
    return;
  }
  next();
}
routes.use("/code", authorize);

routes.get("/code/repos", (_req, res) => res.json({ owner, repositories: allowed }));

routes.get("/code/tree", async (req, res) => {
  try {
    const repo = checkedRepo(req.query.repo);
    const ref = String(req.query.ref || "main");
    if (!/^[a-zA-Z0-9_./-]{1,120}$/.test(ref) || ref.includes("..")) throw new Error("Rama inválida.");
    const payload = await fetchGitHub(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(ref)}?recursive=1`
    );
    res.json({
      repository: `${owner}/${repo}`, ref,
      truncated: Boolean(payload.truncated),
      entries: (Array.isArray(payload.tree) ? payload.tree : []).slice(0, 1500)
        .map((item: any) => ({ path: item.path, type: item.type, size: item.size, sha: item.sha })),
    });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "No se pudo leer el repositorio." });
  }
});

routes.get("/code/file", async (req, res) => {
  try {
    const repo = checkedRepo(req.query.repo);
    const path = checkedPath(req.query.path);
    const ref = String(req.query.ref || "main");
    if (!/^[a-zA-Z0-9_./-]{1,120}$/.test(ref) || ref.includes("..")) throw new Error("Rama inválida.");
    const apiPath = path.split("/").map(encodeURIComponent).join("/");
    const payload = await fetchGitHub(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${apiPath}?ref=${encodeURIComponent(ref)}`
    );
    if (payload.type !== "file" || payload.encoding !== "base64" || payload.size > 180000)
      throw new Error("Archivo demasiado grande o no es texto.");
    const content = Buffer.from(String(payload.content).replace(/\\n/g, ""), "base64").toString("utf8");
    res.json({ repository: `${owner}/${repo}`, ref, path, sha: payload.sha, content });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "No se pudo leer el archivo." });
  }
});


routes.put("/code/file", async (req, res) => {
  try {
    if (process.env.PRISMA_CODE_WRITE_ENABLED !== "1")
      return res.status(403).json({ error: "Escritura deshabilitada." });
    const token = process.env.PRISMA_GITHUB_TOKEN?.trim();
    if (!token) return res.status(503).json({ error: "Falta token GitHub de escritura." });
    const repo = checkedRepo(req.body?.repo);
    const path = checkedPath(req.body?.path);
    const branch = String(req.body?.branch ?? "");
    if (!/^[a-zA-Z0-9_./-]{1,120}$/.test(branch) || branch.includes("..") ||
        ["main", "master"].includes(branch.toLowerCase()))
      throw new Error("Solo se permite escribir en ramas de trabajo.");
    const expectedSha = String(req.body?.sha ?? "");
    if (!/^[a-f0-9]{40}$/.test(expectedSha))
      throw new Error("Se requiere SHA válido del archivo leído.");
    const nextContent = req.body?.content;
    if (typeof nextContent !== "string" || Buffer.byteLength(nextContent, "utf8") > 180000)
      throw new Error("Contenido inválido o demasiado grande.");
    const message = String(req.body?.message ?? "Update file via Prisma").slice(0, 120);
    const apiPath = path.split("/").map(encodeURIComponent).join("/");
    const response = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${apiPath}`,
      {
        method: "PUT",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "User-Agent": "Prisma-Code-Workspace",
        },
        body: JSON.stringify({
          branch, sha: expectedSha, message: `[Prisma] ${message}`,
          content: Buffer.from(nextContent, "utf8").toString("base64"),
        }),
        signal: AbortSignal.timeout(15000),
      }
    );
    if (!response.ok) throw new Error(`GitHub rechazó el cambio: HTTP ${response.status}`);
    const saved: any = await response.json();
    res.json({ branch, path, commit: saved.commit?.sha, sha: saved.content?.sha });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "No se pudo editar el archivo." });
  }
});

export default routes;
