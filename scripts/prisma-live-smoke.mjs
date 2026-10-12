// Real-provider smoke test. Requires running Prisma, Router and GitHub credentials.
// Never commits by default; writes only after explicit PRISMA_SMOKE_APPLY=1.
const required = ["PRISMA_SMOKE_URL", "PRISMA_CODE_ACCESS_TOKEN", "PRISMA_SMOKE_REPO", "PRISMA_SMOKE_PATH", "PRISMA_SMOKE_BRANCH", "PRISMA_SMOKE_TASK"];
const missing = required.filter(key => !process.env[key]);
if (missing.length) {
  console.error("Missing smoke configuration:", missing.join(", "));
  process.exit(2);
}
const endpoint = new URL("/api/code-agent/patch", process.env.PRISMA_SMOKE_URL);
const apply = process.env.PRISMA_SMOKE_APPLY === "1";
const branch = process.env.PRISMA_SMOKE_BRANCH;
if (!/^prisma\/[A-Za-z0-9_-]{1,80}$/.test(branch)) throw new Error("Use a prisma/* work branch.");
const response = await fetch(endpoint, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Prisma-Code-Token": process.env.PRISMA_CODE_ACCESS_TOKEN,
  },
  body: JSON.stringify({
    repo: process.env.PRISMA_SMOKE_REPO,
    path: process.env.PRISMA_SMOKE_PATH,
    branch,
    task: process.env.PRISMA_SMOKE_TASK,
    apply,
  }),
  signal: AbortSignal.timeout(150000),
});
const data = await response.json();
if (!response.ok) throw new Error(`Prisma HTTP ${response.status}: ${JSON.stringify(data)}`);
if (apply) {
  if (data.applied !== true || data.verified !== true || !data.commit)
    throw new Error("Prisma did not confirm a verified commit.");
  console.log(JSON.stringify({ result: "PASS", mode: "commit", verified: true, branch, commit: data.commit }));
} else {
  if (data.applied !== false || typeof data.preview !== "string" || data.preview.length === 0)
    throw new Error("Prisma did not produce a valid preview.");
  console.log(JSON.stringify({ result: "PASS", mode: "preview", branch, path: data.path, bytes: Buffer.byteLength(data.preview) }));
}
