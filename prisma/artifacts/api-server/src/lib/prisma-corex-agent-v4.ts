import { corexReadFile, corexSearch } from "./corex-ssh-read";
import { corexWriteFile } from "./corex-tools";
import { rememberPrisma } from "./prisma-memory";
import { refreshCorexMap } from "./prisma-corex-map";
import {
  runPrismaCorexAgent as runPrismaCorexAgentV3,
  type PrismaAgentInputMessage,
} from "./prisma-corex-agent-v3";
import type { AiProviderConfig } from "./ai-provider";

export type { PrismaAgentInputMessage } from "./prisma-corex-agent-v3";

const NEGATIVE_MUTATION_RE = /no\s+(?:modifi|toqu|cambi|reempl|apli|corrij|arregl|implement)|sin\s+(?:modificar|tocar|cambiar|reemplazar|aplicar)/i;

function cleanLiteralToken(value: string) {
  return value.replace(/[.,;:!?]+$/g, "");
}

function extractExactReplacement(text: string) {
  if (NEGATIVE_MUTATION_RE.test(text)) return null;

  const patterns = [
    /(?:cambi(?:á|a|alo|alo a|ar)?|cambiar|reemplaz(?:á|a|ar)?)\s+[`"']?([A-Za-z0-9_./:@-]{4,})[`"']?\s+(?:a|por)\s+[`"']?([A-Za-z0-9_./:@-]{4,})[`"']?/i,
    /busc(?:á|a|ar)?\s+[`"']?([A-Za-z0-9_./:@-]{4,})[`"']?.{0,80}?(?:cambi(?:á|a|ar)?|reemplaz(?:á|a|ar)?)\w*\s+(?:a|por)\s+[`"']?([A-Za-z0-9_./:@-]{4,})[`"']?/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1] && match?.[2]) {
      const from = cleanLiteralToken(match[1]);
      const to = cleanLiteralToken(match[2]);
      if (from && to && from !== to) return { from, to };
    }
  }
  return null;
}

function countOccurrences(text: string, needle: string) {
  if (!needle) return 0;
  let count = 0;
  let offset = 0;
  while (true) {
    const index = text.indexOf(needle, offset);
    if (index < 0) return count;
    count += 1;
    offset = index + needle.length;
  }
}

async function tryExactReplacement(text: string) {
  const replacement = extractExactReplacement(text);
  if (!replacement) return null;

  const search = await corexSearch(replacement.from).catch(() => null);
  if (!search?.results?.length) return null;

  const uniquePaths = [...new Set(search.results.map((item) => item.path))];
  if (uniquePaths.length !== 1) return null;

  const file = await corexReadFile(uniquePaths[0]).catch(() => null);
  if (!file || file.truncated) return null;

  const occurrences = countOccurrences(file.content, replacement.from);
  if (occurrences !== 1) return null;

  const nextContent = file.content.replace(replacement.from, replacement.to);
  if (nextContent === file.content) return null;

  const written = await corexWriteFile({
    path: file.path,
    expectedSha: file.sha,
    content: nextContent,
    message: `Replace ${replacement.from} with ${replacement.to}`.slice(0, 160),
  });

  await rememberPrisma({
    kind: "change",
    scope: "corex",
    key: `change:${file.path}`,
    content: `Cambio literal seguro: '${replacement.from}' -> '${replacement.to}' en ${file.path}. Commit ${written.commitSha}.`,
    importance: 90,
  }).catch(() => undefined);

  await refreshCorexMap().catch(() => undefined);

  return "Listo.";
}

export async function runPrismaCorexAgent(input: {
  provider: AiProviderConfig;
  messages: PrismaAgentInputMessage[];
  mode: "chat" | "document";
}) {
  const latest = [...input.messages]
    .reverse()
    .find((message) => message.role === "user")?.content?.trim() ?? "";

  if (latest) {
    const exact = await tryExactReplacement(latest);
    if (exact) return exact;
  }

  return runPrismaCorexAgentV3(input);
}
