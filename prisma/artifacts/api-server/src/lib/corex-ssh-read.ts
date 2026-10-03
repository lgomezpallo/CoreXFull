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
  if (!path || path.includes("..") || !(path === "corex" || path.startsWith("corex/"))) {
    throw new Error("La herramienta sólo puede operar dentro de corex/.");
  }
  return path;
}

async function withRepo<T>(fn: (repoDir: string, env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
  const identity = await ensurePrismaSshIdentity();
  const workdir = await mkdtemp(join(tmpdir(), "prisma-corex-read-"));
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
    return await fn(repoDir, env);
  } finally {
    await rm(workdir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function corexReadFile(pathValue: string) {
  const path = safePath(pathValue);
  return withRepo(async (repoDir, env) => {
    const { stdout: shaOut } = await execFileAsync("git", ["-C", repoDir, "rev-parse", `HEAD:${path}`], {
      env,
      timeout: 20_000,
      maxBuffer: 200_000,
    });
    const { stdout } = await execFileAsync("git", ["-C", repoDir, "show", `HEAD:${path}`], {
      env,
      timeout: 30_000,
      maxBuffer: 2_000_000,
      encoding: "utf8",
    });
    const content = stdout;
    return {
      path,
      sha: shaOut.trim(),
      size: Buffer.byteLength(content, "utf8"),
      content: content.slice(0, 120_000),
      truncated: content.length > 120_000,
      transport: "ssh",
    };
  });
}

export async function corexListTree(pathValue = "corex", depth = 2) {
  const root = safePath(pathValue);
  const maxDepth = Math.max(0, Math.min(4, Math.trunc(depth)));
  return withRepo(async (repoDir, env) => {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", repoDir, "ls-tree", "-r", "-l", "HEAD", "--", root],
      { env, timeout: 30_000, maxBuffer: 4_000_000, encoding: "utf8" },
    );
    const baseSegments = root.split("/").length;
    const entries = stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const match = line.match(/^(\d+)\s+(\w+)\s+([0-9a-f]+)\s+(-|\d+)\t(.+)$/);
        if (!match) return null;
        const path = match[5];
        const relativeDepth = Math.max(0, path.split("/").length - baseSegments - 1);
        if (relativeDepth > maxDepth) return null;
        return {
          path,
          type: match[2],
          sha: match[3],
          size: match[4] === "-" ? undefined : Number(match[4]),
        };
      })
      .filter((item): item is { path: string; type: string; sha: string; size?: number } => Boolean(item))
      .slice(0, 1200);
    return { root, branch: BRANCH, entries, truncated: entries.length >= 1200, transport: "ssh" };
  });
}

export async function corexSearch(queryValue: string) {
  const query = queryValue.trim().slice(0, 200);
  if (!query) throw new Error("La búsqueda no puede estar vacía.");
  return withRepo(async (repoDir, env) => {
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["-C", repoDir, "grep", "-n", "-I", "-F", "--", query, "corex"],
        { env, timeout: 30_000, maxBuffer: 2_000_000, encoding: "utf8" },
      );
      const results = stdout
        .split("\n")
        .filter(Boolean)
        .slice(0, 80)
        .map((line) => {
          const first = line.indexOf(":");
          const second = first >= 0 ? line.indexOf(":", first + 1) : -1;
          if (first < 0 || second < 0) return { path: line, line: null, excerpt: "" };
          return {
            path: line.slice(0, first),
            line: Number(line.slice(first + 1, second)) || null,
            excerpt: line.slice(second + 1, second + 501),
          };
        });
      return { query, results, transport: "ssh" };
    } catch (error: any) {
      if (error?.code === 1 || error?.exitCode === 1) {
        return { query, results: [], transport: "ssh" };
      }
      const stderr = typeof error?.stderr === "string" ? error.stderr : "";
      if (!stderr.trim() && Number(error?.code) === 1) return { query, results: [], transport: "ssh" };
      throw error;
    }
  });
}
