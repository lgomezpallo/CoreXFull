import assert from "node:assert/strict";
import test from "node:test";
import { collectLabEvidence, buildLabEvidenceText } from "./lab-static-analysis";
import type { BuilderSource } from "./builder-workspace";

function source(name: string, extractedText: string): BuilderSource {
  return {
    id: name,
    name,
    detail: "static fixture",
    payload: { name, kind: "code", extractedText },
    included: true,
    useMode: "reference",
    hasVisual: false,
    wasTextTrimmed: false,
  };
}

test("collects static architecture, dependencies, endpoints, storage, and Android facts", () => {
  const project = source(
    "legacy.zip",
    [
      "Archivos incluidos en el ZIP: package.json, src/main.tsx, src/components/Account.tsx, public/logo.svg.",
      "Archivo package.json:",
      '{"dependencies":{"react":"19.0.0","zod":"3.24.0"}}',
      "Archivo src/components/Account.tsx:",
      'export function AccountPanel() { fetch("https://api.example.test/profile"); localStorage.getItem("token"); }',
      "Permiso declarado: android.permission.CAMERA",
      "Componente declarado: activity: com.example.MainActivity",
    ].join("\n\n"),
  );
  const evidence = collectLabEvidence([project]);
  assert.ok(evidence.filePaths.some((path) => path.endsWith("src/main.tsx")));
  assert.ok(evidence.dependencies.some((dependency) => dependency.includes("react@19.0.0")));
  assert.ok(evidence.entryPoints.some((entry) => entry.endsWith("src/main.tsx")));
  assert.ok(evidence.components.some((component) => component.includes("AccountPanel")));
  assert.ok(evidence.networkCalls.some((call) => call.includes("api.example.test")));
  assert.ok(evidence.storage.some((storage) => storage.endsWith("localStorage")));
  assert.ok(evidence.permissions.some((permission) => permission.endsWith("android.permission.CAMERA")));
});

test("compares imported versions without describing the diff as runtime behavior", () => {
  const first = source("release-1.zip", "Archivos incluidos en el ZIP: package.json, src/main.tsx, src/old.ts.");
  const second = source("release-2.zip", "Archivos incluidos en el ZIP: package.json, src/main.tsx, src/new.ts.");
  const text = buildLabEvidenceText([first, second], collectLabEvidence([first, second]));
  assert.match(text, /Comparación estática entre fuentes importadas/);
  assert.match(text, /src\/new\.ts/);
  assert.match(text, /no confirma que una función se ejecute/);
});