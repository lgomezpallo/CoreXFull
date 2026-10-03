import path from "node:path";
import { readFile } from "node:fs/promises";
import type {
  GeneratedProjectBlueprint,
  GeneratedProjectFile,
} from "./generated-project-types";

const TEMPLATE_PATHS = new Set([
  "index.html",
  "package.json",
  "README.md",
  "tsconfig.json",
  "vite.config.ts",
  "src/main.tsx",
  "src/lib/corex.ts",
]);

const ALLOWED_EXTERNAL_IMPORTS = new Set([
  "react",
  "react-dom",
  "react-dom/client",
  "lucide-react",
]);

export const MAX_GENERATED_SOURCE_FILES = 24;
export const MAX_GENERATED_SOURCE_FILE_CHARS = 50_000;
export const MAX_GENERATED_SOURCE_CHARS = 120_000;

export class GeneratedProjectFilesError extends Error {
  readonly diagnostics: string[];

  constructor(diagnostics: string[]) {
    super(diagnostics[0] ?? "Los archivos del proyecto no son válidos.");
    this.name = "GeneratedProjectFilesError";
    this.diagnostics = diagnostics.slice(0, 12);
  }
}

function slugify(value: string): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "corex-app";
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function isGeneratedSourcePath(filePath: string): boolean {
  if (
    filePath.length > 180 ||
    filePath.startsWith("/") ||
    filePath.includes("\\") ||
    filePath.split("/").some((part) =>
      !part || part === "." || part === ".." || part.startsWith("."),
    ) ||
    TEMPLATE_PATHS.has(filePath) ||
    filePath === "src/App.tsx" ||
    filePath === "src/styles.css"
  ) return false;
  return /^src\/(?:components|features|lib|types)\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\.(?:tsx?|css|svg|json)$/.test(filePath);
}

function findImportedModules(content: string): string[] {
  const imports: string[] = [];
  const expression = /\b(?:from\s*|import\s*[\s(]|require\s*\()\s*["']([^"']+)["']/g;
  for (const match of content.matchAll(expression)) imports.push(match[1]);
  return imports;
}

function resolveRelativeImport(
  importer: string,
  specifier: string,
  availableFiles: Set<string>,
): boolean {
  const candidate = path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier));
  if (!candidate.startsWith("src/") || candidate.split("/").some((part) => part === "..")) {
    return false;
  }
  const extensions = [".tsx", ".ts", ".jsx", ".js", ".css", ".svg", ".json"];
  const candidates = path.posix.extname(candidate)
    ? [candidate]
    : [candidate, ...extensions.map((extension) => `${candidate}${extension}`),
      ...extensions.map((extension) => `${candidate}/index${extension}`)];
  return candidates.some((filePath) => availableFiles.has(filePath));
}

function validateSourceFiles(files: GeneratedProjectFile[]): string[] {
  const diagnostics: string[] = [];
  const availableFiles = new Set([
    ...files.map((file) => file.path),
    "src/lib/corex.ts",
  ]);
  if (files.length === 0 || files.length > MAX_GENERATED_SOURCE_FILES) {
    diagnostics.push(`El proyecto debe tener entre 1 y ${MAX_GENERATED_SOURCE_FILES} archivos de código.`);
  }

  const seen = new Set<string>();
  let totalChars = 0;
  for (const file of files) {
    if (!isGeneratedSourcePath(file.path) && file.path !== "src/App.tsx" && file.path !== "src/styles.css") {
      diagnostics.push(`Ruta no permitida: ${file.path}. Usá archivos dentro de src/components, src/features, src/lib o src/types.`);
      continue;
    }
    if (seen.has(file.path)) diagnostics.push(`La ruta está repetida: ${file.path}.`);
    seen.add(file.path);
    if (file.content.length > MAX_GENERATED_SOURCE_FILE_CHARS) {
      diagnostics.push(`${file.path} supera el límite de ${MAX_GENERATED_SOURCE_FILE_CHARS} caracteres.`);
    }
    totalChars += file.content.length;
    for (const moduleName of findImportedModules(file.content)) {
      if (moduleName.startsWith(".")) {
        if (!resolveRelativeImport(file.path, moduleName, availableFiles)) {
          diagnostics.push(`${file.path} importa una ruta fuera del código permitido o un archivo inexistente.`);
        }
        continue;
      }
      if (ALLOWED_EXTERNAL_IMPORTS.has(moduleName)) continue;
      diagnostics.push(`Dependencia no habilitada: ${moduleName}. Usá React, lucide-react o imports relativos.`);
    }
    if (/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|eval|postMessage)\s*\(|\bnew\s+Function\b|\bdocument\.cookie\b|\b(?:window\.)?(?:parent|top|opener)\b|\b(?:localStorage|sessionStorage|indexedDB)\b|\b(?:window\.)?caches\b|\bnavigator\.(?:sendBeacon|serviceWorker|storage)\b|\b(?:window\.)?location(?:\.href)?\s*=|\bwindow\.open\s*\(/.test(file.content)) {
      diagnostics.push(`${file.path} intenta acceder a red, almacenamiento o al documento anfitrión. Usá useCorexStore desde src/lib/corex.`);
    }
    if (/\bhttps?:\/\//i.test(file.content) || /@import\s+(?:url\(\s*)?["']?(?:https?:)?\/\//i.test(file.content) || /\b(?:src|href)\s*=\s*["'](?:https?:)?\/\//i.test(file.content)) {
      diagnostics.push(`${file.path} incluye un recurso de red; usá recursos locales o imágenes insertadas.`);
    }
  }

  if (totalChars > MAX_GENERATED_SOURCE_CHARS) {
    diagnostics.push(`El código supera el límite total de ${MAX_GENERATED_SOURCE_CHARS} caracteres.`);
  }
  if (!files.some((file) => file.path === "src/App.tsx" && file.content.trim())) {
    diagnostics.push("Falta src/App.tsx con una aplicación React.");
  }
  const appSource = files.find((file) => file.path === "src/App.tsx")?.content ?? "";
  if (!/data-testid\s*=\s*["']corex-primary-action["']/.test(appSource)) {
    diagnostics.push("src/App.tsx debe incluir un botón principal con data-testid=\"corex-primary-action\" para probar su flujo.");
  }
  if (!files.some((file) => file.path === "src/styles.css")) {
    diagnostics.push("Falta src/styles.css.");
  }
  return [...new Set(diagnostics)].slice(0, 12);
}

export function normalizeGeneratedSourceFiles(value: unknown): GeneratedProjectFile[] {
  if (!Array.isArray(value)) {
    throw new GeneratedProjectFilesError(["Router IA debe devolver un arreglo de archivos."]);
  }
  const files: GeneratedProjectFile[] = [];
  const diagnostics: string[] = [];
  for (const item of value) {
    if (
      !item ||
      typeof item !== "object" ||
      !("path" in item) ||
      !("content" in item) ||
      typeof item.path !== "string" ||
      typeof item.content !== "string"
    ) {
      diagnostics.push("Cada archivo debe tener una ruta y contenido de texto.");
      continue;
    }
    files.push({ path: item.path, content: item.content });
  }
  diagnostics.push(...validateSourceFiles(files));
  if (diagnostics.length) throw new GeneratedProjectFilesError(diagnostics);
  return files;
}

export function extractGeneratedSourceFiles(files: GeneratedProjectFile[]): GeneratedProjectFile[] {
  const sources = files.filter((file) =>
    (file.path === "src/App.tsx" || file.path === "src/styles.css" || isGeneratedSourcePath(file.path)) &&
    file.path !== "src/lib/corex.ts",
  );
  const diagnostics = validateSourceFiles(sources);
  if (diagnostics.length) throw new GeneratedProjectFilesError(diagnostics);
  return sources;
}

export function createProjectTemplateFiles(
  blueprint: Pick<GeneratedProjectBlueprint, "title" | "description">,
  projectId: string,
  sourceFiles: GeneratedProjectFile[],
): GeneratedProjectFile[] {
  const title = blueprint.title.trim().slice(0, 80) || "Mi aplicación";
  const safeTitle = escapeHtml(title);
  const packageName = slugify(title);
  const files: GeneratedProjectFile[] = [
    {
      path: "package.json",
      content: JSON.stringify({
        name: packageName,
        private: true,
        version: "1.0.0",
        type: "module",
        scripts: {
          dev: "vite --host 0.0.0.0",
          typecheck: "tsc --noEmit",
          build: "pnpm run typecheck && vite build",
          preview: "vite preview --host 0.0.0.0",
        },
        dependencies: {
          "lucide-react": "0.545.0",
          react: "19.1.0",
          "react-dom": "19.1.0",
        },
        devDependencies: {
          "@types/react": "19.3.0",
          "@types/react-dom": "19.3.0",
          "@vitejs/plugin-react": "5.2.0",
          typescript: "5.9.3",
          vite: "7.3.6",
        },
      }, null, 2),
    },
    {
      path: "index.html",
      content: `<!doctype html>
<html lang="es">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="description" content="${escapeHtml(blueprint.description.slice(0, 240))}" />
    <title>${safeTitle}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>`,
    },
    {
      path: "tsconfig.json",
      content: JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          useDefineForClassFields: true,
          lib: ["ES2022", "DOM", "DOM.Iterable"],
          module: "ESNext",
          skipLibCheck: true,
          moduleResolution: "Bundler",
          allowImportingTsExtensions: true,
          resolveJsonModule: true,
          isolatedModules: true,
          noEmit: true,
          jsx: "react-jsx",
          strict: true,
          noUnusedLocals: true,
          noUnusedParameters: true,
          types: ["vite/client"],
        },
        include: ["src"],
      }, null, 2),
    },
    {
      path: "vite.config.ts",
      content: `import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  plugins: [react()],
  cacheDir: ".corex-vite-cache",
  build: {
    cssCodeSplit: false,
    assetsInlineLimit: 1500000,
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
});`,
    },
    {
      path: "src/main.tsx",
      content: `import React, { Component, useEffect, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

const projectId = ${JSON.stringify(projectId)};

function sendPreviewMessage(
  type: "corex:app-ready" | "corex:app-error" | "corex:app-smoke-result",
  details: Record<string, unknown> = {},
) {
  if (window.parent !== window) {
    window.parent.postMessage({ type, projectId, ...details }, "*");
  }
}

class AppErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch() {
    sendPreviewMessage("corex:app-error", { message: "La aplicación tuvo un error al renderizar." });
  }

  render() {
    if (this.state.failed) {
      return <main role="alert"><h1>No se pudo iniciar esta app</h1><p>Volvé al diseño para revisar el código y corregirlo.</p></main>;
    }
    return this.props.children;
  }
}

function PreviewReady() {
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const controlsBefore = document.querySelectorAll("button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])").length;
      sendPreviewMessage("corex:app-ready", {
        controlsBefore,
        textLength: document.body.innerText.trim().length,
      });
    }, 250);
    return () => window.clearTimeout(timer);
  }, []);
  return null;
}

window.addEventListener("error", () => {
  sendPreviewMessage("corex:app-error", { message: "La aplicación tuvo un error durante la prueba." });
});
window.addEventListener("unhandledrejection", () => {
  sendPreviewMessage("corex:app-error", { message: "Una acción de la aplicación falló durante la prueba." });
});
window.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (event.source !== window.parent || !event.data || typeof event.data !== "object") return;
  const message = event.data as { type?: unknown; projectId?: unknown };
  if (message.type !== "corex:runtime-smoke" || message.projectId !== projectId) return;

  const button = document.querySelector<HTMLButtonElement>('[data-testid="corex-primary-action"]');
  const controlsBefore = document.querySelectorAll("button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])").length;
  if (!button || button.disabled || /delete|remove|cancel|clear|borrar|eliminar|cancelar|quitar/i.test(button.innerText)) {
    sendPreviewMessage("corex:app-smoke-result", {
      ok: false,
      message: "No se encontró una acción principal segura para probar.",
      controlsBefore,
      changed: false,
    });
    return;
  }

  const before = document.body.innerText.trim();
  button.click();
  window.setTimeout(() => {
    const after = document.body.innerText.trim();
    const changed = after !== before;
    sendPreviewMessage("corex:app-smoke-result", {
      ok: controlsBefore > 0 && changed,
      message: changed
        ? "La acción principal produjo un cambio visible."
        : "La acción principal no produjo un cambio visible.",
      controlsBefore,
      changed,
    });
  }, 350);
});

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("No se encontró el elemento raíz.");
createRoot(rootElement).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <PreviewReady />
      <App />
    </AppErrorBoundary>
  </React.StrictMode>,
);`,
    },
    {
      path: "src/lib/corex.ts",
      content: `import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";

const projectId = ${JSON.stringify(projectId)};
const pendingRequests = new Map<string, (value: unknown) => void>();

type StorageMessage = {
  type: "corex:storage:response";
  requestId: string;
  ok: boolean;
  value?: unknown;
};

function isStorageMessage(value: unknown): value is StorageMessage {
  return Boolean(value) && typeof value === "object" &&
    (value as StorageMessage).type === "corex:storage:response" &&
    typeof (value as StorageMessage).requestId === "string";
}

if (typeof window !== "undefined") {
  window.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (event.source !== window.parent || !isStorageMessage(event.data)) return;
    const resolve = pendingRequests.get(event.data.requestId);
    if (!resolve) return;
    pendingRequests.delete(event.data.requestId);
    resolve(event.data.ok ? event.data.value : null);
  });
}

function parentRequest(action: "get" | "set", key: string, value?: unknown): Promise<unknown> {
  if (typeof window === "undefined" || window.parent === window) {
    return Promise.reject(new Error("No hay un puente CoreX disponible."));
  }
  const requestId = typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : \`\${Date.now()}-\${Math.random().toString(36).slice(2)}\`;
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error("El puente CoreX no respondió."));
    }, 1200);
    pendingRequests.set(requestId, (result) => {
      window.clearTimeout(timeout);
      resolve(result);
    });
    window.parent.postMessage({
      type: "corex:storage:request",
      projectId,
      requestId,
      action,
      key,
      value,
    }, "*");
  });
}

function localStorageKey(key: string) {
  return \`corex-app:\${projectId}:\${key}\`;
}

export async function readCorexData<T>(key: string, fallback: T): Promise<T> {
  try {
    const value = await parentRequest("get", key);
    if (value !== null && value !== undefined) return value as T;
  } catch {
    // Standalone exports intentionally fall back to browser-local storage.
  }
  try {
    const stored = window.localStorage.getItem(localStorageKey(key));
    if (stored !== null) return JSON.parse(stored) as T;
  } catch {
    // Sandboxed previews may not have browser storage; keep the in-memory value.
  }
  return fallback;
}

export async function writeCorexData<T>(key: string, value: T): Promise<void> {
  try {
    await parentRequest("set", key, value);
    return;
  } catch {
    // Standalone exports intentionally fall back to browser-local storage.
  }
  try {
    window.localStorage.setItem(localStorageKey(key), JSON.stringify(value));
  } catch {
    // The current view remains usable when storage is unavailable.
  }
}

export function useCorexStore<T>(
  key: string,
  initialValue: T,
): [T, Dispatch<SetStateAction<T>>, boolean] {
  const initialValueRef = useRef(initialValue);
  const [value, setValue] = useState(initialValue);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let active = true;
    void readCorexData(key, initialValueRef.current).then((stored) => {
      if (active) {
        setValue(stored);
        setReady(true);
      }
    });
    return () => {
      active = false;
    };
  }, [key]);

  const update: Dispatch<SetStateAction<T>> = useCallback((next) => {
    setValue((current) => {
      const resolved = typeof next === "function"
        ? (next as (previous: T) => T)(current)
        : next;
      void writeCorexData(key, resolved);
      return resolved;
    });
  }, [key]);

  return [value, update, ready];
}`,
    },
    {
      path: "README.md",
      content: `# ${title}

Proyecto React + Vite generado con CoreX.

## Ejecutar

\`\`\`sh
pnpm install
pnpm dev
\`\`\`

## Compilar y verificar tipos

\`\`\`sh
pnpm build
\`\`\`

Los datos del editor se guardan con \`useCorexStore\` en el espacio privado de CoreX. Fuera de CoreX, el mismo adaptador usa localStorage del navegador. CoreX ejecuta únicamente la interfaz React aislada: no ejecuta código de servidor generado ni habilita un backend arbitrario. El proyecto no incluye credenciales ni ejecuta scripts del generador.`,
    },
    ...sourceFiles,
  ];
  if (!sourceFiles.some((file) => file.path === "src/styles.css")) {
    files.push({ path: "src/styles.css", content: ":root { color-scheme: light; }\nbody { margin: 0; font-family: system-ui, sans-serif; }\n" });
  }
  return files;
}

export function parseRouterProjectFiles(content: string): GeneratedProjectFile[] {
  const trimmed = content
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start) {
      throw new GeneratedProjectFilesError(["Router IA no devolvió JSON con los archivos del proyecto."]);
    }
    try {
      parsed = JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      throw new GeneratedProjectFilesError(["La respuesta de Router IA no es un JSON válido."]);
    }
  }
  if (!parsed || typeof parsed !== "object" || !("files" in parsed)) {
    throw new GeneratedProjectFilesError(["La respuesta no incluye la lista files requerida."]);
  }
  return normalizeGeneratedSourceFiles(parsed.files);
}

export function parseProjectQualityReview(content: string): { ready: boolean; issues: string[] } {
  const cleaned = content
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start < 0 || end <= start) {
      throw new Error("La revisión automática no devolvió un resultado verificable.");
    }
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("ready" in parsed) ||
    typeof parsed.ready !== "boolean" ||
    !("issues" in parsed) ||
    !Array.isArray(parsed.issues) ||
    !parsed.issues.every((issue) => typeof issue === "string")
  ) {
    throw new Error("La revisión automática no devolvió un resultado verificable.");
  }
  return {
    ready: parsed.ready,
    issues: parsed.issues.slice(0, 8).map((issue) => issue.slice(0, 240)),
  };
}

function resolveDistAsset(distDirectory: string, rawUrl: string): string {
  const relativeUrl = decodeURIComponent(rawUrl).replace(/^\.?\//, "");
  const absolutePath = path.resolve(distDirectory, relativeUrl);
  const relativePath = path.relative(distDirectory, absolutePath);
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error("El build produjo una ruta de asset no válida.");
  }
  return absolutePath;
}

export async function createSelfContainedPreview(distDirectory: string): Promise<string> {
  const indexPath = path.join(distDirectory, "index.html");
  let html = await readFile(indexPath, "utf8");
  const scriptTags = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>\s*<\/script>/gi)];
  if (scriptTags.length !== 1) {
    throw new Error("El build debe producir un único punto de entrada JavaScript.");
  }

  const scriptPath = resolveDistAsset(distDirectory, scriptTags[0][1]);
  let script = await readFile(scriptPath, "utf8");
  script = script.replace(/<\/script/gi, "<\\/script");
  html = html.replace(scriptTags[0][0], `<script type="module">${script}</script>`);

  const linkTags = [...html.matchAll(/<link\b[^>]*>/gi)];
  for (const match of linkTags) {
    const linkTag = match[0];
    if (!/\brel=["']stylesheet["']/i.test(linkTag)) continue;
    const href = linkTag.match(/\bhref=["']([^"']+)["']/i)?.[1];
    if (!href) continue;
    const css = (await readFile(resolveDistAsset(distDirectory, href), "utf8"))
      .replace(/<\/style/gi, "<\\/style");
    html = html.replace(linkTag, `<style>${css}</style>`);
  }

  html = html.replace(/<link\b[^>]*\brel=["']modulepreload["'][^>]*>/gi, "");
  const csp = "default-src 'none'; script-src 'unsafe-inline' data: blob:; style-src 'unsafe-inline' data:; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; form-action 'none'; object-src 'none'; base-uri 'none'";
  html = html.replace(
    /<head\b[^>]*>/i,
    (head) => `${head}\n<meta http-equiv="Content-Security-Policy" content="${csp}">`,
  );
  const documentStructure = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "<script></script>")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "<style></style>");
  if (/<script\b[^>]*\bsrc=|<link\b[^>]*\bhref=["'](?:https?:|\/|\.\/)/i.test(documentStructure)) {
    throw new Error("La vista previa no quedó autocontenida; detecté un recurso externo.");
  }
  if (html.length > 1_500_000) {
    throw new Error("La vista previa supera el tamaño seguro permitido.");
  }
  return html;
}