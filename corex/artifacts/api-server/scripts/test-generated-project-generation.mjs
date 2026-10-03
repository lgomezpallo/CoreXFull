import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "corex-generation-tests-"));
const testSources = [
  "generated-project-generation.test.ts",
  "router-client.test.ts",
].map((file) => path.join(packageRoot, "src/lib", file));
const bundledTests = testSources.map((file) =>
  path.join(temporaryDirectory, path.basename(file).replace(/\.ts$/, ".mjs")),
);

try {
  await build({
    entryPoints: testSources,
    bundle: true,
    platform: "node",
    format: "esm",
    outdir: temporaryDirectory,
    outExtension: { ".js": ".mjs" },
  });
  const result = spawnSync(process.execPath, ["--test", ...bundledTests], { stdio: "inherit" });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}