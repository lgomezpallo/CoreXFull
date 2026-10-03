import type { LabStaticEvidence } from "@workspace/api-client-react";
import type { BuilderSource } from "./builder-workspace";

const emptyEvidence = (): LabStaticEvidence => ({
  filePaths: [],
  dependencies: [],
  entryPoints: [],
  components: [],
  assets: [],
  strings: [],
  permissions: [],
  networkCalls: [],
  storage: [],
});

function addUnique(target: string[], values: string[], limit: number): void {
  for (const value of values) {
    const cleaned = value.replace(/\s+/g, " ").trim().slice(0, 220);
    if (!cleaned || target.includes(cleaned)) continue;
    target.push(cleaned);
    if (target.length >= limit) return;
  }
}

function sourceFilePaths(text: string): string[] {
  const paths = new Set<string>();
  for (const match of text.matchAll(/Archivo\s+([^\r\n:]{1,180}):/g)) {
    paths.add(match[1].trim());
  }
  const inventory = text.match(/(?:Archivos incluidos en el ZIP|estructura.*?):\s*([^\r\n]+)/i)?.[1];
  if (inventory) {
    for (const path of inventory.split(",")) {
      const cleaned = path.trim();
      if (cleaned && cleaned.length <= 180) paths.add(cleaned);
    }
  }
  return [...paths].slice(0, 80);
}

function packageDependencies(text: string): string[] {
  const results = new Set<string>();
  for (const match of text.matchAll(/Archivo\s+[^\r\n]*package\.json:\s*([\s\S]*?)(?=\n\nArchivo\s|\n\n[A-ZÁÉÍÓÚ]|$)/gi)) {
    const candidate = match[1].slice(0, 15_000);
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (!parsed || typeof parsed !== "object") continue;
      for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
        const modules = (parsed as Record<string, unknown>)[field];
        if (!modules || typeof modules !== "object" || Array.isArray(modules)) continue;
        for (const [name, version] of Object.entries(modules)) {
          results.add(`${name}@${String(version).slice(0, 40)}`);
        }
      }
    } catch {
      // Keep analyzing import statements even when the manifest fragment is incomplete.
    }
  }
  for (const match of text.matchAll(/\b(?:from\s*|import\s*[\s(])["']([^."'][^"']*)["']/g)) {
    const specifier = match[1].trim();
    const packageName = specifier.startsWith("@")
      ? specifier.split("/").slice(0, 2).join("/")
      : specifier.split("/")[0];
    if (packageName && !packageName.startsWith("node:")) results.add(packageName);
  }
  return [...results].slice(0, 80);
}

function staticSourceEvidence(source: BuilderSource): LabStaticEvidence {
  const text = source.payload.extractedText;
  const filePaths = sourceFilePaths(text);
  const evidence = emptyEvidence();
  addUnique(evidence.filePaths, filePaths, 80);
  addUnique(evidence.dependencies, packageDependencies(text), 80);
  addUnique(
    evidence.entryPoints,
    filePaths.filter((path) =>
      /(^|\/)(main|index|app|server|bootstrap|program|application)\.(tsx?|jsx?|py|java|kt|swift|go|rs|sh)$/i.test(path),
    ),
    40,
  );
  addUnique(
    evidence.components,
    [
      ...[...text.matchAll(/\b(?:export\s+default\s+)?(?:function|class)\s+([A-Z][A-Za-z0-9_$]{1,60})/g)].map((match) => match[1]),
      ...[...text.matchAll(/\b(?:activity|activity-alias|service|receiver|provider):\s*([A-Za-z0-9_.$]+)/g)].map((match) => match[1]),
    ],
    60,
  );
  addUnique(
    evidence.assets,
    filePaths.filter((path) =>
      /\.(?:png|jpe?g|webp|gif|svg|woff2?|ttf|otf|mp3|mp4|webm|json|xml)$/i.test(path) ||
      /(^|\/)(assets?|drawable|mipmap|res)\//i.test(path),
    ),
    80,
  );

  const strings = text
    .split(/\r?\n/)
    .map((line) => line.replace(/^(?:Contenido de referencia:|Archivo [^\n]+:|Cadenas estáticas recuperadas[^\n]*:)\s*/, "").trim())
    .filter((line) => line.length >= 4 && line.length <= 220 && !/^(?:APK analizado|ZIP:|Binario:|URLs visibles|Permiso declarado|Componente declarado)/i.test(line));
  addUnique(evidence.strings, strings, 100);
  addUnique(
    evidence.permissions,
    [...text.matchAll(/(?:android\.permission\.[A-Z0-9_]+|Permiso declarado:\s*[A-Za-z0-9_.]+)/g)].map((match) => match[0].replace("Permiso declarado: ", "")),
    60,
  );
  addUnique(
    evidence.networkCalls,
    [
      ...[...text.matchAll(/https?:\/\/[A-Za-z0-9._~:/?#\[\]@!$&'()*+,;=%-]{5,220}/g)].map((match) => match[0]),
      ...[...text.matchAll(/\b(fetch|axios|XMLHttpRequest|WebSocket|URLSession|Retrofit|OkHttp|HttpClient)\b/g)].map((match) => `${match[1]} aparece en el texto extraído; el uso efectivo no está confirmado`),
    ],
    60,
  );
  addUnique(
    evidence.storage,
    [...text.matchAll(/\b(localStorage|sessionStorage|IndexedDB|SQLite|sqlite3|Room|CoreData|AsyncStorage|Realm|PostgreSQL|MySQL|MongoDB|Firestore|Supabase)\b/gi)]
      .map((match) => match[1]),
    40,
  );
  return evidence;
}

function prefixedValues(sourceName: string, values: string[]): string[] {
  return values.map((value) => `${sourceName} › ${value}`);
}

export function collectLabEvidence(sources: BuilderSource[]): LabStaticEvidence {
  const evidence = emptyEvidence();
  for (const source of sources) {
    const found = staticSourceEvidence(source);
    addUnique(evidence.filePaths, prefixedValues(source.name, found.filePaths), 80);
    addUnique(evidence.dependencies, prefixedValues(source.name, found.dependencies), 80);
    addUnique(evidence.entryPoints, prefixedValues(source.name, found.entryPoints), 40);
    addUnique(evidence.components, prefixedValues(source.name, found.components), 60);
    addUnique(evidence.assets, prefixedValues(source.name, found.assets), 80);
    addUnique(evidence.strings, prefixedValues(source.name, found.strings), 100);
    addUnique(evidence.permissions, prefixedValues(source.name, found.permissions), 60);
    addUnique(evidence.networkCalls, prefixedValues(source.name, found.networkCalls), 60);
    addUnique(evidence.storage, prefixedValues(source.name, found.storage), 40);
  }
  return evidence;
}

export function buildLabEvidenceText(
  sources: BuilderSource[],
  evidence: LabStaticEvidence,
): string {
  const fragments: string[] = [];
  let remaining = 23_000;
  for (const source of sources) {
    if (remaining <= 0) break;
    const fragment = `### ${source.name} (${source.payload.kind})\n${source.payload.extractedText.slice(0, Math.min(9000, remaining))}`;
    fragments.push(fragment);
    remaining -= fragment.length;
  }

  const diffs: string[] = [];
  if (sources.length > 1) {
    diffs.push("Comparación estática entre fuentes importadas (no confirma que una función se ejecute):");
    for (let index = 1; index < sources.length; index += 1) {
      const before = staticSourceEvidence(sources[index - 1]);
      const after = staticSourceEvidence(sources[index]);
      const difference = (left: string[], right: string[]) => ({
        added: right.filter((value) => !left.includes(value)),
        removed: left.filter((value) => !right.includes(value)),
      });
      const files = difference(before.filePaths, after.filePaths);
      const dependencies = difference(before.dependencies, after.dependencies);
      const permissions = difference(before.permissions, after.permissions);
      const endpoints = difference(before.networkCalls, after.networkCalls);
      diffs.push(
        `${sources[index - 1].name} → ${sources[index].name}: ` +
        `archivos +${files.added.length}/-${files.removed.length}; ` +
        `dependencias +${dependencies.added.length}/-${dependencies.removed.length}; ` +
        `permisos +${permissions.added.length}/-${permissions.removed.length}; ` +
        `red +${endpoints.added.length}/-${endpoints.removed.length}.`,
      );
      for (const [label, values] of [
        ["Archivos nuevos", files.added],
        ["Archivos quitados", files.removed],
        ["Dependencias nuevas", dependencies.added],
        ["Permisos nuevos", permissions.added],
        ["Endpoints/calls de red nuevos", endpoints.added],
      ] as const) {
        if (values.length) diffs.push(`${label}: ${values.slice(0, 12).join(", ")}`);
      }
    }
  }

  const staticSummary = JSON.stringify(evidence, null, 2);
  return [...fragments, ...diffs, `Hallazgos estáticos estructurados:\n${staticSummary}`]
    .join("\n\n")
    .slice(0, 29_500);
}