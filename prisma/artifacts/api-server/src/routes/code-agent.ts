import { Router, type IRouter } from "express";
import { getChatProviderConfig, getProviderEndpoint, getProviderHeaders } from "../lib/ai-provider";
import { applyExactPatch } from "../lib/code-patch";

const router: IRouter = Router();
const githubApiRoot = (process.env.PRISMA_GITHUB_API_BASE || "https://api.github.com").replace(/\/+$/, "");
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
    const url = `${githubApiRoot}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path.split("/").map(encodeURIComponent).join("/")}`;
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
        response_format: { type: "json_object" },
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
    // Parse plain or fenced JSON; tolerate explanatory text outside the object.
    const cleaned = raw.trim().replace(/^\x60\x60\x60(?:json)?\s*/i, "").replace(/\x60\x60\x60\s*$/, "");
    let patch: any;
    try { patch = JSON.parse(cleaned); }
    catch {
      const first = cleaned.indexOf("{");
      const last = cleaned.lastIndexOf("}");
      if (first >= 0 && last > first) {
        try { patch = JSON.parse(cleaned.slice(first, last + 1)); } catch { /* handled below */ }
      }
    }
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      const finishReason = String(ai.choices?.[0]?.finish_reason ?? "unknown");
      const prefix = raw.trim().slice(0, 160);
      const looksLikeJson = /^[\\s\\x60]*[\\{\\[]/.test(raw);
      fail(`Router no produjo un parche JSON válido (finish_reason=${finishReason}, caracteres=${raw.length}, parece_json=${looksLikeJson}, inicio=${JSON.stringify(prefix)}).`);
    }
    const after = applyExactPatch(before, patch);
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
