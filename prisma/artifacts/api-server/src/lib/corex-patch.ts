import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ensurePrismaSshIdentity } from "./prisma-ssh-identity";

const execFileAsync = promisify(execFile);
const OWNER = process.env.PRISMA_GITHUB_OWNER?.trim() || "lgomezpallo";
const REPO = process.env.PRISMA_GITHUB_REPO?.trim() || "CoreXFull";
const BRANCH = process.env.PRISMA_GITHUB_BRANCH?.trim() || "main";

function safePath(value: string) {
  const path = value.replaceAll("\\", "/").replace(/^\/+/, "").trim();
  if (!path || path.includes("..") || !path.startsWith("corex/")) {
    throw new Error("Prisma sólo puede aplicar parches dentro de corex/.");
  }
  return path;
}

function sshEnv(keyPath: string) {
  return {
    ...process.env,
    GIT_SSH_COMMAND: `ssh -i ${keyPath} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`,
  };
}

export async function corexApplyPatch(input: {
  path: string;
  expectedSha: string;
  patch: string;
  message: string;
}) {
  const path = safePath(input.path);
  const expectedSha = input.expectedSha.trim();
  const message = input.message.trim().slice(0, 160);
  const patch = input.patch.trim();

  if (!expectedSha) throw new Error("El parche exige el SHA del archivo leído.");
  if (!message) throw new Error("El parche exige un mensaje de cambio.");
  if (!patch) throw new Error("El parche está vacío.");
  if (Buffer.byteLength(patch, "utf8") > 220_000) throw new Error("El parche es demasiado grande.");

  const identity = await ensurePrismaSshIdentity();
  const workdir = await mkdtemp(join(tmpdir(), "prisma-corex-patch-"));
  const keyPath = join(workdir, "id_ed25519");
  const repoDir = join(workdir, "repo");
  const patchPath = join(workdir, "change.patch");
  const env = sshEnv(keyPath);

  try {
    await writeFile(keyPath, `${identity.privateKey}\n`, { mode: 0o600 });
    await writeFile(patchPath, `${patch}\n`, "utf8");

    await execFileAsync(
      "git",
      ["clone", "--depth", "1", "--branch", BRANCH, `git@github.com:${OWNER}/${REPO}.git`, repoDir],
      { env, timeout: 90_000, maxBuffer: 2_000_000 },
    );

    const { stdout: shaOut } = await execFileAsync(
      "git",
      ["-C", repoDir, "rev-parse", `HEAD:${path}`],
      { env, timeout: 20_000, maxBuffer: 200_000 },
    );
    const actualSha = shaOut.trim();
    if (actualSha !== expectedSha) {
      throw new Error("El archivo cambió desde que Prisma lo leyó. Debe releerlo antes de aplicar el parche.");
    }

    try {
      await execFileAsync(
        "git",
        ["-C", repoDir, "apply", "--check", "--whitespace=nowarn", patchPath],
        { env, timeout: 30_000, maxBuffer: 1_000_000 },
      );
    } catch (error: any) {
      const detail = typeof error?.stderr === "string" ? error.stderr.trim().slice(0, 700) : "";
      throw new Error(`El parche no valida${detail ? `: ${detail}` : "."}`);
    }

    await execFileAsync(
      "git",
      ["-C", repoDir, "apply", "--whitespace=nowarn", patchPath],
      { env, timeout: 30_000, maxBuffer: 1_000_000 },
    );

    const { stdout: namesOut } = await execFileAsync(
      "git",
      ["-C", repoDir, "diff", "--name-only"],
      { env, timeout: 20_000, maxBuffer: 300_000 },
    );
    const changedPaths = namesOut.split("\n").map((item) => item.trim()).filter(Boolean);
    if (changedPaths.length !== 1 || changedPaths[0] !== path) {
      throw new Error("El parche intentó modificar archivos fuera del objetivo autorizado.");
    }

    await execFileAsync("git", ["-C", repoDir, "config", "user.name", "Prisma CoreX Agent"], { env, timeout: 20_000 });
    await execFileAsync("git", ["-C", repoDir, "config", "user.email", "prisma-agent@users.noreply.github.com"], { env, timeout: 20_000 });
    await execFileAsync("git", ["-C", repoDir, "add", "--", path], { env, timeout: 20_000 });
    await execFileAsync("git", ["-C", repoDir, "commit", "-m", `[Prisma] ${message}`], { env, timeout: 30_000 });
    await execFileAsync("git", ["-C", repoDir, "push", "origin", `HEAD:${BRANCH}`], { env, timeout: 90_000 });

    const { stdout: commitSha } = await execFileAsync("git", ["-C", repoDir, "rev-parse", "HEAD"], { env, timeout: 20_000 });
    const { stdout: contentSha } = await execFileAsync("git", ["-C", repoDir, "rev-parse", `HEAD:${path}`], { env, timeout: 20_000 });

    return {
      path,
      commitSha: commitSha.trim(),
      contentSha: contentSha.trim(),
      changed: true,
      transport: "ssh",
    };
  } finally {
    await rm(workdir, { recursive: true, force: true }).catch(() => undefined);
  }
}
