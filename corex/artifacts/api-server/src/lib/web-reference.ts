import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { isIP } from "node:net";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";

const MAX_PAGE_BYTES = 1_000_000;
const MAX_REDIRECTS = 3;
const REQUEST_TIMEOUT_MS = 8_000;

type PageResponse = {
  statusCode: number;
  contentType: string;
  location?: string;
  body: Buffer;
};

type ExtractedWebReference = {
  url: string;
  title: string;
  extractedText: string;
};

type ResolvedAddress = {
  address: string;
  family: 4 | 6;
};

function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && (b === 0 || b === 168)) return false;
    if (a === 192 && b === 88 && c === 99) return false;
    if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
    if (a === 203 && b === 0 && c === 113) return false;
    return true;
  }
  if (family === 6) {
    const normalized = address.toLowerCase().split("%")[0];
    if (
      normalized === "::" ||
      normalized === "::1" ||
      normalized.startsWith("::ffff:") ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe8") ||
      normalized.startsWith("fe9") ||
      normalized.startsWith("fea") ||
      normalized.startsWith("feb") ||
      normalized.startsWith("ff") ||
      normalized.startsWith("2001:db8:") ||
      normalized.startsWith("2001:0:") ||
      normalized.startsWith("2002:")
    ) return false;
    const firstHextet = Number.parseInt(normalized.split(":")[0] || "0", 16);
    return firstHextet >= 0x2000 && firstHextet <= 0x3fff;
  }
  return false;
}

async function validateAndResolveHost(url: URL) {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Usá una dirección web que empiece con http:// o https://.");
  }
  if (url.username || url.password) {
    throw new Error("No se admiten direcciones web con usuario o contraseña.");
  }
  if (
    (url.protocol === "http:" && url.port && url.port !== "80") ||
    (url.protocol === "https:" && url.port && url.port !== "443")
  ) {
    throw new Error("Solo se admiten páginas web públicas en los puertos habituales.");
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (
    !hostname ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".test") ||
    hostname.endsWith(".invalid")
  ) {
    throw new Error("Solo se pueden analizar páginas web públicas.");
  }

  let lookupResults: Array<{ address: string; family: number }>;
  try {
    lookupResults = isIP(hostname)
      ? [{ address: hostname, family: isIP(hostname) }]
      : await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new Error("No pude encontrar ese dominio. Revisá la dirección e intentá de nuevo.");
  }
  const resolved: ResolvedAddress[] = lookupResults.map(({ address }) => ({
    address,
    family: isIP(address) as 4 | 6,
  }));
  if (!resolved.length || resolved.some((address) => !isPublicAddress(address.address))) {
    throw new Error("La dirección debe apuntar únicamente a una página pública.");
  }
  return resolved;
}

function pinnedLookupFor(resolved: ResolvedAddress[]): LookupFunction {
  const pinnedLookup = ((
    _hostname: string,
    options: number | { family?: number; all?: boolean },
    callback: (...args: unknown[]) => void,
  ) => {
    const family = typeof options === "number" ? options : options.family;
    const matches = resolved.filter((address) => !family || address.family === family);
    if (!matches.length) {
      callback(new Error("No hay una dirección pública compatible."));
      return;
    }
    if (typeof options === "object" && options.all) {
      callback(null, matches);
      return;
    }
    callback(null, matches[0].address, matches[0].family);
  }) as LookupFunction;
  return pinnedLookup;
}

function requestPage(url: URL, resolved: ResolvedAddress[]): Promise<PageResponse> {
  return new Promise((resolve, reject) => {
    const requester = url.protocol === "https:" ? httpsRequest : httpRequest;
    const request = requester(
      url,
      {
        method: "GET",
        headers: {
          Accept: "text/html,application/xhtml+xml,text/plain;q=0.9",
          "Accept-Encoding": "identity",
          "User-Agent": "ProgramaHablando-ReferenceReader/1.0",
        },
        lookup: pinnedLookupFor(resolved),
        timeout: REQUEST_TIMEOUT_MS,
      },
      (response) => {
        const statusCode = response.statusCode ?? 0;
        const contentType = response.headers["content-type"] ?? "";
        const location = response.headers.location;
        const declaredLength = Number(response.headers["content-length"] ?? 0);
        if (declaredLength > MAX_PAGE_BYTES) {
          response.resume();
          reject(new Error("La página supera el límite de tamaño permitido."));
          return;
        }

        const chunks: Buffer[] = [];
        let receivedBytes = 0;
        response.on("data", (chunk: Buffer | string) => {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          receivedBytes += bytes.byteLength;
          if (receivedBytes > MAX_PAGE_BYTES) {
            response.destroy(new Error("La página supera el límite de tamaño permitido."));
            return;
          }
          chunks.push(bytes);
        });
        response.on("error", reject);
        response.on("end", () => {
          resolve({
            statusCode,
            contentType,
            ...(location ? { location } : {}),
            body: Buffer.concat(chunks),
          });
        });
      },
    );

    request.on("timeout", () => request.destroy(new Error("La página tardó demasiado en responder.")));
    request.on("error", reject);
    request.end();
  });
}

async function fetchPublicPage(url: URL, redirects = 0): Promise<{ url: URL; html: string }> {
  const resolved = await validateAndResolveHost(url);
  let response: PageResponse;
  try {
    response = await requestPage(url, resolved);
  } catch {
    throw new Error("No pude acceder a esa página pública. Revisá el enlace e intentá de nuevo.");
  }

  if (response.statusCode >= 300 && response.statusCode < 400 && response.location) {
    if (redirects >= MAX_REDIRECTS) throw new Error("La página redirige demasiadas veces.");
    return fetchPublicPage(new URL(response.location, url), redirects + 1);
  }
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error("La página no respondió correctamente.");
  }
  if (!/^(text\/html|application\/xhtml\+xml|text\/plain)\b/i.test(response.contentType)) {
    throw new Error("La dirección no parece ser una página HTML o de texto.");
  }
  return { url, html: response.body.toString("utf8") };
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
    copy: "©",
    reg: "®",
    trade: "™",
  };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, code: string) => {
    if (code.startsWith("#x") || code.startsWith("#X")) {
      const point = Number.parseInt(code.slice(2), 16);
      return point >= 0 && point <= 0x10ffff ? String.fromCodePoint(point) : entity;
    }
    if (code.startsWith("#")) {
      const point = Number.parseInt(code.slice(1), 10);
      return point >= 0 && point <= 0x10ffff ? String.fromCodePoint(point) : entity;
    }
    return named[code.toLowerCase()] ?? entity;
  });
}

function htmlToText(html: string): { title: string; description: string; body: string } {
  const titleMarkup = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "";
  const metaTags = html.match(/<meta\b[^>]*>/gi) ?? [];
  const descriptionTag = metaTags.find((tag) =>
    /\bname\s*=\s*["']description["']/i.test(tag) ||
    /\bproperty\s*=\s*["']og:description["']/i.test(tag),
  );
  const description = descriptionTag?.match(/\bcontent\s*=\s*["']([^"']*)["']/i)?.[1] ?? "";
  const mainMarkup = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1] ?? html;
  const body = decodeEntities(
    mainMarkup
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(script|style|svg|noscript|template)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<(br|\/p|\/div|\/section|\/article|\/li|\/h[1-6])\b[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/[\u00a0\t ]+/g, " ")
      .replace(/\n\s+/g, "\n")
      .replace(/\n{3,}/g, "\n\n"),
  ).trim();

  return {
    title: decodeEntities(titleMarkup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()).slice(0, 160),
    description: decodeEntities(description).replace(/\s+/g, " ").trim().slice(0, 400),
    body,
  };
}

export async function extractWebReference(rawUrl: string): Promise<ExtractedWebReference> {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    throw new Error("Pegá una dirección web válida.");
  }

  const { url, html } = await fetchPublicPage(parsedUrl);
  const extracted = htmlToText(html);
  if (extracted.body.length < 20) {
    throw new Error("No encontré suficiente texto visible. Probá con una captura o un archivo HTML guardado.");
  }

  const title = extracted.title || url.hostname;
  const shareableUrl = new URL(url);
  shareableUrl.search = "";
  shareableUrl.hash = "";
  const extractedText = [
    `Fuente web: ${shareableUrl.toString()}`,
    `Título: ${title}`,
    extracted.description ? `Descripción: ${extracted.description}` : "",
    `Texto visible extraído:\n${extracted.body}`,
  ].filter(Boolean).join("\n\n").slice(0, 12_000);
  return { url: shareableUrl.toString(), title, extractedText };
}