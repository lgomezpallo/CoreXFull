import { Router, type IRouter } from "express";
import { getChatProviderConfig, getProviderEndpoint, getProviderHeaders } from "../lib/ai-provider";

const router: IRouter = Router();
const owner = process.env.PRISMA_CODE_OWNER?.trim() || "lgomezpallo";
const allowed = (process.env.PRISMA_CODE_REPOS || "I.achat.Full,CoreXFull,R.outer.full").split(",").map(x => x.trim());
function fail(message: string): never { throw new Error(message); }
function authorized(req: any, res: any, next: any) {
  const secret = process.env.PRISMA_CODE_ACCESS_TOKEN?.trim();
  if (!secret || req.get("X-Prisma-Code-Token") !== secret)
    return res.status(403).json({ error: "Acceso denegado." });
  next();
}
router.use("/code-agent", authorized);

router.post("/code-agent/patch", async (req, res) => {
  try {
    const repo = String(req.body?.repo ?? "");
    const path = String(req.body?.path ?? "");
    const branch = String(req.body?.branch ?? "");
    const task = String(req.body?.task ?? "").trim();
    const apply = req.body?.apply === true;
    if (!allowed.includes(repo)) fail("Repositorio no autorizado.");
    if (!path || path.length > 400 || path.startsWith("/") ||
      path.split("/").some((segment) => !segment || segment.startsWith(".") || segment === ".."))
      fail("Ruta no permitida.");
    if (!/^prisma\/[A-Za-z0-9_-]{1,80}$/.test(branch)) fail("Rama inválida: se exige prisma/*.");
    if (!task || task.length > 2500) fail("Describí una corrección concreta (máximo 2500 caracteres).");
    const token = process.env.PRISMA_GITHUB_TOKEN?.trim();
    if (!token) fail("Falta PRISMA_GITHUB_TOKEN.");
    const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path.split("/").map(encodeURIComponent).join("/")}`;
    const headers = {
      "Accept": "application/vnd.github+json",
      "User-Agent": "Prisma-Code-Agent",
      "Authorization": `Bearer ${token}`,
    };
    const fileResp = await fetch(`${url}?ref=${encodeURIComponent(branch)}`, {
      headers, signal: AbortSignal.timeout(15000),
    });
    if (!fileResp.ok) fail(`No se pudo leer el archivo en la rama: HTTP ${fileResp.status}`);
    const file: any = await fileResp.json();
    if (file.type !== "file" || file.encoding !== "base64" || file.size > 30000)
      fail("El archivo debe ser texto y tener menos de 30 KB.");
    const before = Buffer.from(String(file.content).replace(/\s/g, ""), "base64").toString("utf8");
    if (before.includes("\0")) fail("Archivo binario no permitido.");
    const provider = getChatProviderConfig();
    const aiResp = await fetch(getProviderEndpoint(provider.baseUrl, "chat/completions"), {
      method: "POST", headers: getProviderHeaders(provider),
      body: JSON.stringify({
        model: provider.model, router_capability: "coding", stream: false, max_tokens: 6000,
        messages: [
          { role: "system", content: "Sos un editor de código. Devolvé EXCLUSIVAMENTE un objeto JSON con las propiedades 'find' y 'replace', ambas strings. 'find' debe ser una secuencia exacta y única presente en el archivo y 'replace' su sustitución completa. No devuelvas markdown. No cambies otros archivos. Si no podés hacerlo con certeza, devolvé {}." },
          { role: "user", content: `TAREA: ${task}\nARCHIVO: ${path}\nCONTENIDO:\n${before}` },
        ],
      }), signal: AbortSignal.timeout(120000),
    });
    if (!aiResp.ok) fail(`Router falló (HTTP ${aiResp.status})`);
    const ai: any = await aiResp.json();
    const raw = ai.choices?.[0]?.message?.content;
    if (typeof raw !== "string") fail("Router no devolvió código.");
    let patch: any;
    try { patch = JSON.parse(raw.trim().replace(/^\x60\x60\x60(?:json)?\s*/i, "").replace(/\x60\x60\x60\s*$/, "")); }
    catch { fail("Router no produjo un parche JSON válido."); }
    if (typeof patch?.find !== "string" || typeof patch?.replace !== "string" ||
      !patch.find || patch.find === patch.replace || before.split(patch.find).length !== 2)
      fail("El parche no coincide exactamente una sola vez con el archivo.");
    const after = before.replace(patch.find, patch.replace);
    if (after === before || Buffer.byteLength(after, "utf8") > 35000)
      fail("Parche vacío o demasiado grande.");
    // Default: preview. Writes require a second explicit opt-in and never reach main.
    if (!apply) return res.json({ applied: false, repository: `${owner}/${repo}`, path, branch,
      sha: file.sha, find: patch.find, replace: patch.replace, preview: after });
    if (process.env.PRISMA_CODE_WRITE_ENABLED !== "1")
      return res.status(403).json({ error: "Escritura deshabilitada." });
    const putResp = await fetch(url, {
      method: "PUT", headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        branch, sha: file.sha, message: `[Prisma] ${task.slice(0, 75)}`,
        content: Buffer.from(after, "utf8").toString("base64"),
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!putResp.ok) fail(`GitHub rechazó el parche (HTTP ${putResp.status})`);
    const saved: any = await putResp.json();
    const verify = await fetch(`${url}?ref=${encodeURIComponent(branch)}`, {
      headers, signal: AbortSignal.timeout(15000),
    });
    if (!verify.ok) fail("Se escribió el parche pero no pudo verificarse la lectura posterior.");
    const updated: any = await verify.json();
    const observed = Buffer.from(String(updated.content ?? "").replace(/\s/g, ""), "base64").toString("utf8");
    if (observed !== after) fail("El contenido leído después del commit no coincide: verificación fallida.");
    return res.json({ applied: true, verified: true, branch, path,
      commit: saved.commit?.sha, sha: updated.sha,
      warning: "Se verificó contenido, NO compilación ni tests. Revisar PR antes del merge." });
  } catch (error) {
    return res.status(400).json({ error: error instanceof Error ? error.message : "Error del agente." });
  }
});

export default router;
