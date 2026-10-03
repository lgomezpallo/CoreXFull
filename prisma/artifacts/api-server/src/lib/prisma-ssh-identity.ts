import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { prismaMemoryRequest } from "./prisma-memory-client";

const execFileAsync = promisify(execFile);
const MEMORY_SCOPE = "internal_secret";
const MEMORY_KEY = "github_ssh_identity_v1";

type StoredMemory = {
  id: number;
  content: string;
};

type Identity = {
  privateKey: string;
  publicKey: string;
};

function encryptionKey() {
  const secret = process.env.PRISMA_MEMORY_SECRET?.trim();
  if (!secret) throw new Error("Prisma no tiene configurado el secreto necesario para custodiar su identidad SSH.");
  return createHash("sha256").update(`prisma-ssh-identity-v1\0${secret}`).digest();
}

function encryptIdentity(identity: Identity) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const plaintext = Buffer.from(JSON.stringify(identity), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(".");
}

function decryptIdentity(value: string): Identity {
  const [version, ivRaw, tagRaw, cipherRaw] = value.split(".");
  if (version !== "v1" || !ivRaw || !tagRaw || !cipherRaw) throw new Error("La identidad SSH guardada tiene un formato inválido.");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivRaw, "base64url"));
  decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(cipherRaw, "base64url")),
    decipher.final(),
  ]).toString("utf8");
  const parsed = JSON.parse(plaintext) as Partial<Identity>;
  if (!parsed.privateKey || !parsed.publicKey) throw new Error("La identidad SSH guardada está incompleta.");
  return { privateKey: parsed.privateKey, publicKey: parsed.publicKey };
}

async function loadStoredIdentity(): Promise<Identity | null> {
  const rows = await prismaMemoryRequest<StoredMemory[]>({
    op: "search",
    query: MEMORY_KEY,
    scope: MEMORY_SCOPE,
    limit: 2,
  });
  const row = (rows ?? []).find((item) => typeof item?.content === "string");
  return row ? decryptIdentity(row.content) : null;
}

async function generateIdentity(): Promise<Identity> {
  const dir = await mkdtemp(join(tmpdir(), "prisma-ssh-generate-"));
  const keyPath = join(dir, "id_ed25519");
  try {
    await execFileAsync("ssh-keygen", [
      "-q",
      "-t", "ed25519",
      "-N", "",
      "-C", "prisma-corex-agent",
      "-f", keyPath,
    ], { timeout: 30_000 });
    const [privateKey, publicKey] = await Promise.all([
      readFile(keyPath, "utf8"),
      readFile(`${keyPath}.pub`, "utf8"),
    ]);
    return { privateKey: privateKey.trim(), publicKey: publicKey.trim() };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function storeIdentity(identity: Identity) {
  await prismaMemoryRequest<unknown>({
    op: "remember",
    kind: "credential",
    scope: MEMORY_SCOPE,
    key: MEMORY_KEY,
    content: encryptIdentity(identity),
    importance: 0,
  });
}

let cached: Promise<Identity> | null = null;

export function ensurePrismaSshIdentity(): Promise<Identity> {
  if (!cached) {
    cached = (async () => {
      const stored = await loadStoredIdentity();
      if (stored) return stored;
      const generated = await generateIdentity();
      await storeIdentity(generated);
      return generated;
    })().catch((error) => {
      cached = null;
      throw error;
    });
  }
  return cached;
}
