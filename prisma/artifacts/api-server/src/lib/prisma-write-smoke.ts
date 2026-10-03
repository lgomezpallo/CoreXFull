import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { corexCreateFile } from "./corex-tools";
import { ensurePrismaSshIdentity } from "./prisma-ssh-identity";

const execFileAsync = promisify(execFile);
const OWNER = process.env.PRISMA_GITHUB_OWNER?.trim() || "lgomezpallo";
const REPO = process.env.PRISMA_GITHUB_REPO?.trim() || "CoreXFull";
const BRANCH = process.env.PRISMA_GITHUB_BRANCH?.trim() || "main";
const TEST_PATH = "corex/.prisma-write-smoke.txt";

export async function runPrismaWriteSmoke() {
  const created = await corexCreateFile({
    path: TEST_PATH,
    content: `Prisma write smoke ${new Date().toISOString()}\n`,
    message: "Verify managed SSH write",
  });

  const identity = await ensurePrismaSshIdentity();
  const workdir = await mkdtemp(join(tmpdir(), "prisma-write-smoke-"));
  const keyPath = join(workdir, "id_ed25519");
  const repoDir = join(workdir, "repo");
  const env = {
    ...process.env,
    GIT_SSH_COMMAND: `ssh -i ${keyPath} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`,
  };

  try {
    await writeFile(keyPath, `${identity.privateKey}\n`, { mode: 0o600 });
    await execFileAsync("git", ["clone", "--depth", "1", "--branch", BRANCH, `git@github.com:${OWNER}/${REPO}.git`, repoDir], { env, timeout: 90_000 });
    await execFileAsync("git", ["-C", repoDir, "config", "user.name", "Prisma CoreX Agent"], { env, timeout: 20_000 });
    await execFileAsync("git", ["-C", repoDir, "config", "user.email", "prisma-agent@users.noreply.github.com"], { env, timeout: 20_000 });
    await execFileAsync("git", ["-C", repoDir, "rm", "--", TEST_PATH], { env, timeout: 20_000 });
    await execFileAsync("git", ["-C", repoDir, "commit", "-m", "[Prisma] Clean write smoke"], { env, timeout: 30_000 });
    await execFileAsync("git", ["-C", repoDir, "push", "origin", `HEAD:${BRANCH}`], { env, timeout: 90_000 });
    const { stdout } = await execFileAsync("git", ["-C", repoDir, "rev-parse", "HEAD"], { env, timeout: 20_000 });
    return {
      ok: true,
      path: TEST_PATH,
      createCommit: created.commitSha,
      cleanupCommit: stdout.trim(),
      transport: created.transport,
    };
  } finally {
    await rm(workdir, { recursive: true, force: true }).catch(() => undefined);
  }
}
