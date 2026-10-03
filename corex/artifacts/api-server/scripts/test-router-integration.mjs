import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const testEntries = [
  "../src/lib/router-client.test.ts",
  "../src/lib/builder-conversation.test.ts",
  "../src/lib/router-providers.test.ts",
  "../src/lib/router-contract.test.ts",
];
const outputDirectory = await mkdtemp(join(tmpdir(), "corex-router-tests-"));

try {
  const testFiles = [];
  for (const entry of testEntries) {
    const sourcePath = fileURLToPath(new URL(entry, import.meta.url));
    const outputPath = join(
      outputDirectory,
      `${basename(entry, ".test.ts")}.test.mjs`,
    );
    await build({
      entryPoints: [sourcePath],
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node20",
      outfile: outputPath,
    });
    testFiles.push(outputPath);
  }

  const result = spawnSync(process.execPath, ["--test", ...testFiles], {
    encoding: "utf8",
    env: { NODE_ENV: "test" },
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.status ?? 1;
} finally {
  await rm(outputDirectory, { recursive: true, force: true });
}