import { corexListTree } from "./corex-ssh-read";
import { rememberPrisma, searchPrismaMemory } from "./prisma-memory";

export type CorexMapEntry = {
  path: string;
  type: string;
  sha: string;
  size?: number;
};

export type CorexMapSnapshot = {
  branch: string;
  updatedAt: string;
  entries: CorexMapEntry[];
};

const MAP_KEY = "corex_map_current";

function normalizeEntries(entries: Array<{ path: string; type: string; sha: string; size?: number }>): CorexMapEntry[] {
  return entries
    .map((entry) => ({
      path: entry.path,
      type: entry.type,
      sha: entry.sha,
      ...(typeof entry.size === "number" ? { size: entry.size } : {}),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

function fingerprint(entries: CorexMapEntry[]) {
  return entries.map((entry) => `${entry.path}:${entry.sha}`).join("|");
}

function parseStoredMap(content: string): CorexMapSnapshot | null {
  try {
    const parsed = JSON.parse(content) as Partial<CorexMapSnapshot>;
    if (!parsed || !Array.isArray(parsed.entries) || typeof parsed.branch !== "string") return null;
    const entries = parsed.entries.filter(
      (entry): entry is CorexMapEntry =>
        !!entry &&
        typeof entry === "object" &&
        typeof entry.path === "string" &&
        typeof entry.type === "string" &&
        typeof entry.sha === "string",
    );
    return {
      branch: parsed.branch,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
      entries,
    };
  } catch {
    return null;
  }
}

async function loadStoredMap() {
  const memories = await searchPrismaMemory(MAP_KEY, "corex", 8).catch(() => []);
  return memories
    .filter((item) => item.key === MAP_KEY)
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .map((item) => parseStoredMap(item.content))
    .find((item): item is CorexMapSnapshot => Boolean(item)) ?? null;
}

async function persistMap(snapshot: CorexMapSnapshot) {
  await rememberPrisma({
    kind: "map",
    scope: "corex",
    key: MAP_KEY,
    content: JSON.stringify(snapshot),
    importance: 100,
  });
}

export async function getCurrentCorexMap(): Promise<CorexMapSnapshot> {
  const [stored, liveTree] = await Promise.all([
    loadStoredMap(),
    corexListTree("corex", 4),
  ]);

  const live: CorexMapSnapshot = {
    branch: liveTree.branch,
    updatedAt: new Date().toISOString(),
    entries: normalizeEntries(liveTree.entries),
  };

  if (!stored || stored.branch !== live.branch || fingerprint(stored.entries) !== fingerprint(live.entries)) {
    await persistMap(live);
    return live;
  }

  return stored;
}

export async function refreshCorexMap(): Promise<CorexMapSnapshot> {
  const liveTree = await corexListTree("corex", 4);
  const snapshot: CorexMapSnapshot = {
    branch: liveTree.branch,
    updatedAt: new Date().toISOString(),
    entries: normalizeEntries(liveTree.entries),
  };
  await persistMap(snapshot);
  return snapshot;
}

export function mapCandidates(snapshot: CorexMapSnapshot, terms: string[], limit = 8) {
  const normalizedTerms = terms
    .map((term) => term.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, ""))
    .filter(Boolean);

  return snapshot.entries
    .filter((entry) => entry.type === "blob")
    .map((entry) => {
      const path = entry.path.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
      let score = 0;
      for (const term of normalizedTerms) {
        const pieces = term.split(/[^a-z0-9]+/).filter((piece) => piece.length >= 3);
        for (const piece of pieces) {
          if (path.includes(piece)) score += 1;
        }
      }
      if (/builder|generated-project|router|preview|design/i.test(path)) score += 0.25;
      return { entry, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.path.localeCompare(b.entry.path))
    .slice(0, limit)
    .map((item) => item.entry);
}
