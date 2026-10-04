import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { getChatProviderConfig } from "./ai-provider";
import { corexReadFile } from "./corex-ssh-read";
import { corexCreateFile } from "./corex-tools";
import { ensurePrismaSshIdentity } from "./prisma-ssh-identity";
import { runPrismaCorexAgent } from "./prisma-corex-agent";

const execFileAsync = promisify(execFile);
const OWNER = process.env.PRISMA_GITHUB_OWNER?.trim() || "lgomezpallo";
const REPO = process.env.PRISMA_GITHUB_REPO?.trim() || "CoreXFull";
const BRANCH = process.env.PRISMA_GITHUB_BRANCH?.trim() || "main";
const TEST_PATH = "corex/.prisma-agent-mutation-smoke.txt";
const BEFORE = "prisma_mutation_smoke_before";
const AFTER = "prisma_mutation_smoke_after";

async function cleanupFixture() {
  const identity = await ensurePrismaSshIdentity();
  const workdir = await mkdtemp(join(tmpdir(), "prisma-agent-mutation-cleanup-"));
  const keyPath = join(workdir, "id_ed25519");
  const repoDir = join(workdir, "repo");
  const env = {
    ...process.env,
    GIT_SSH_COMMAND: `ssh -i ${keyPath} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`,
  };

  try {
    await writeFile(keyPath, `${identity.privateKey}\n`, { mode: 0o600 });
    await execFileAsync(
      "git",
      ["clone", "--depth", "1", "--branch", BRANCH, `git@github.com:${OWNER}/${REPO}.git`, repoDir],
      { env, timeout: 90_000, maxBuffer: 2_000_000 },
    );

    try {
      await execFileAsync("git", ["-C", repoDir, "rm", "--", TEST_PATH], { env, timeout: 20_000 });
    } catch {
      return { cleaned: false, reason: "fixture_not_present" };
    }

    await execFileAsync("git", ["-C", repoDir, "config", "user.name", "Prisma CoreX Agent"], { env, timeout: 20_000 });
    await execFileAsync("git", ["-C", repoDir, "config", "user.email", "prisma-agent@users.noreply.github.com"], { env, timeout: 20_000 });
    await execFileAsync("git", ["-C", repoDir, "commit", "-m", "[Prisma] Clean mutation smoke fixture"], { env, timeout: 30_000 });
    await execFileAsync("git", ["-C", repoDir, "push", "origin", `HEAD:${BRANCH}`], { env, timeout: 90_000 });
    const { stdout } = await execFileAsync("git", ["-C", repoDir, "rev-parse", "HEAD"], { env, timeout: 20_000 });
    return { cleaned: true, cleanupCommit: stdout.trim() };
  } finally {
    await rm(workdir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function runPrismaAgentMutationSmoke() {
  let fixtureCreated = false;
  try {
    const created = await corexCreateFile({
      path: TEST_PATH,
      content: `${BEFORE}\n`,
      message: "Create isolated mutation smoke fixture",
    });
    fixtureCreated = true;

    const provider = getChatProviderConfig();
    const response = await runPrismaCorexAgent({
      provider,
      mode: "chat",
      messages: [
        {
          role: "user",
          content: `Corregí CoreX: buscá ${BEFORE} y cambialo a ${AFTER}. Esta es una prueba interna: sólo podés modificar el único archivo que contiene ese marcador.`,
        },
      ],
    });

    const verified = await corexReadFile(TEST_PATH);
    const ok = verified.content.trim() === AFTER;
    if (!ok) {
      throw new Error(`Prisma terminó pero el fixture no quedó en el estado esperado. Respuesta: ${response.slice(0, 500)}`);
    }

    const cleanup = await cleanupFixture();
    fixtureCreated = false;
    if (!cleanup.cleaned) throw new Error("La mutación pasó pero no se pudo limpiar el fixture de prueba.");

    return {
      ok: true,
      createCommit: created.commitSha,
      agentResponse: response.slice(0, 900),
      observedContent: verified.content.trim(),
      cleanup,
    };
  } finally {
    if (fixtureCreated) {
      await cleanupFixture().catch(() => undefined);
    }
  }
}
