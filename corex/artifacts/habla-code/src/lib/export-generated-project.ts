import type { GeneratedProjectFile } from "./builder-workspace";

const encoder = new TextEncoder();

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let number = 0; number < table.length; number += 1) {
    let value = number;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[number] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let checksum = 0xffffffff;
  for (const byte of bytes) {
    checksum = crcTable[(checksum ^ byte) & 0xff] ^ (checksum >>> 8);
  }
  return (checksum ^ 0xffffffff) >>> 0;
}

function write16(view: DataView, offset: number, value: number): void {
  view.setUint16(offset, value, true);
}

function write32(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value >>> 0, true);
}

function dosTimestamp(date: Date): { time: number; day: number } {
  const year = Math.max(1980, date.getFullYear());
  const time =
    (date.getHours() << 11) |
    (date.getMinutes() << 5) |
    Math.floor(date.getSeconds() / 2);
  const day =
    ((year - 1980) << 9) |
    ((date.getMonth() + 1) << 5) |
    date.getDate();
  return { time, day };
}

function safeProjectPath(filePath: string): boolean {
  return (
    filePath.length > 0 &&
    filePath.length <= 180 &&
    !filePath.startsWith("/") &&
    !filePath.includes("\\") &&
    !filePath.split("/").some((part) => !part || part === "." || part === ".." || part.startsWith("."))
  );
}

function safeFileName(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `${slug || "corex-app"}.zip`;
}

export function downloadGeneratedProjectZip(title: string, files: GeneratedProjectFile[]): void {
  const entries = files
    .filter((file) => safeProjectPath(file.path))
    .map((file) => ({
      name: encoder.encode(file.path),
      content: encoder.encode(file.content),
    }));
  if (!entries.length) throw new Error("No hay archivos seguros para exportar.");
  if (entries.some((entry) => entry.content.length > 0xffffffff)) {
    throw new Error("Un archivo supera el tamaño permitido para ZIP.");
  }

  const parts: Uint8Array[] = [];
  const centralDirectory: Uint8Array[] = [];
  const timestamp = dosTimestamp(new Date());
  let localOffset = 0;

  for (const entry of entries) {
    if (entry.name.length > 0xffff) throw new Error("La ruta del archivo supera el límite ZIP.");
    const checksum = crc32(entry.content);
    const localHeader = new Uint8Array(30);
    const localView = new DataView(localHeader.buffer);
    write32(localView, 0, 0x04034b50);
    write16(localView, 4, 20);
    write16(localView, 6, 0x0800);
    write16(localView, 8, 0);
    write16(localView, 10, timestamp.time);
    write16(localView, 12, timestamp.day);
    write32(localView, 14, checksum);
    write32(localView, 18, entry.content.length);
    write32(localView, 22, entry.content.length);
    write16(localView, 26, entry.name.length);
    write16(localView, 28, 0);
    parts.push(localHeader, entry.name, entry.content);

    const centralHeader = new Uint8Array(46);
    const centralView = new DataView(centralHeader.buffer);
    write32(centralView, 0, 0x02014b50);
    write16(centralView, 4, 20);
    write16(centralView, 6, 20);
    write16(centralView, 8, 0x0800);
    write16(centralView, 10, 0);
    write16(centralView, 12, timestamp.time);
    write16(centralView, 14, timestamp.day);
    write32(centralView, 16, checksum);
    write32(centralView, 20, entry.content.length);
    write32(centralView, 24, entry.content.length);
    write16(centralView, 28, entry.name.length);
    write16(centralView, 30, 0);
    write16(centralView, 32, 0);
    write16(centralView, 34, 0);
    write16(centralView, 36, 0);
    write32(centralView, 38, 0);
    write32(centralView, 42, localOffset);
    centralDirectory.push(centralHeader, entry.name);
    localOffset += localHeader.length + entry.name.length + entry.content.length;
  }

  const centralSize = centralDirectory.reduce((total, part) => total + part.length, 0);
  const endRecord = new Uint8Array(22);
  const endView = new DataView(endRecord.buffer);
  write32(endView, 0, 0x06054b50);
  write16(endView, 4, 0);
  write16(endView, 6, 0);
  write16(endView, 8, entries.length);
  write16(endView, 10, entries.length);
  write32(endView, 12, centralSize);
  write32(endView, 16, localOffset);
  write16(endView, 20, 0);

  const blobParts: BlobPart[] = [];
  for (const bytes of [...parts, ...centralDirectory, endRecord]) {
    const buffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buffer).set(bytes);
    blobParts.push(buffer);
  }
  const archive = new Blob(blobParts, { type: "application/zip" });
  const url = URL.createObjectURL(archive);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = safeFileName(title);
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
}