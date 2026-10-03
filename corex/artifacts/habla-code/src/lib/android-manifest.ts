export type AndroidManifestSummary = {
  packageName: string | null;
  versionName: string | null;
  versionCode: string | null;
  minSdkVersion: string | null;
  targetSdkVersion: string | null;
  permissions: string[];
  components: string[];
  features: string[];
};

type ManifestAttribute = { name: string; value: string };

function emptySummary(): AndroidManifestSummary {
  return {
    packageName: null,
    versionName: null,
    versionCode: null,
    minSdkVersion: null,
    targetSdkVersion: null,
    permissions: [],
    components: [],
    features: [],
  };
}

function applyManifestTag(
  summary: AndroidManifestSummary,
  tagName: string,
  attributes: ManifestAttribute[],
): void {
  const values = new Map(attributes.map((attribute) => [attribute.name.split(":").pop() ?? attribute.name, attribute.value]));
  if (tagName === "manifest") {
    summary.packageName = values.get("package") ?? summary.packageName;
    summary.versionName = values.get("versionName") ?? summary.versionName;
    summary.versionCode = values.get("versionCode") ?? summary.versionCode;
  }
  if (tagName === "uses-sdk") {
    summary.minSdkVersion = values.get("minSdkVersion") ?? summary.minSdkVersion;
    summary.targetSdkVersion = values.get("targetSdkVersion") ?? summary.targetSdkVersion;
  }
  if (tagName.startsWith("uses-permission")) {
    const permission = values.get("name");
    if (permission && !summary.permissions.includes(permission)) summary.permissions.push(permission);
  }
  if (["activity", "activity-alias", "service", "receiver", "provider"].includes(tagName)) {
    const component = values.get("name");
    if (component && !summary.components.includes(`${tagName}: ${component}`)) {
      summary.components.push(`${tagName}: ${component}`);
    }
  }
  if (tagName === "uses-feature") {
    const feature = values.get("name");
    if (feature && !summary.features.includes(feature)) summary.features.push(feature);
  }
}

function decodePlainXml(xml: string): AndroidManifestSummary | null {
  if (!/<manifest(?:\s|>)/i.test(xml)) return null;
  const summary = emptySummary();
  const tagPattern = /<([A-Za-z][\w.-]*)(\s[^<>]*?)?\/?>/g;
  for (const match of xml.matchAll(tagPattern)) {
    const attributes: ManifestAttribute[] = [];
    const source = match[2] ?? "";
    const attributePattern = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    for (const attribute of source.matchAll(attributePattern)) {
      attributes.push({
        name: attribute[1],
        value: (attribute[2] ?? attribute[3] ?? "")
          .replaceAll("&quot;", '"')
          .replaceAll("&amp;", "&")
          .replaceAll("&lt;", "<")
          .replaceAll("&gt;", ">")
          .slice(0, 220),
      });
    }
    applyManifestTag(summary, match[1], attributes);
  }
  return summary;
}

function readU16(view: DataView, offset: number): number {
  if (offset < 0 || offset + 2 > view.byteLength) throw new Error("Android manifest truncado.");
  return view.getUint16(offset, true);
}

function readU32(view: DataView, offset: number): number {
  if (offset < 0 || offset + 4 > view.byteLength) throw new Error("Android manifest truncado.");
  return view.getUint32(offset, true);
}

function readLength8(bytes: Uint8Array, offset: number): { length: number; next: number } {
  const first = bytes[offset];
  if (first === undefined) throw new Error("String pool Android incompleto.");
  if ((first & 0x80) === 0) return { length: first, next: offset + 1 };
  const second = bytes[offset + 1];
  if (second === undefined) throw new Error("String pool Android incompleto.");
  return { length: ((first & 0x7f) << 8) | second, next: offset + 2 };
}

function readLength16(view: DataView, offset: number): { length: number; next: number } {
  const first = readU16(view, offset);
  if ((first & 0x8000) === 0) return { length: first, next: offset + 2 };
  const second = readU16(view, offset + 2);
  return { length: ((first & 0x7fff) << 16) | second, next: offset + 4 };
}

function decodeStringPool(
  bytes: Uint8Array,
  view: DataView,
  chunkOffset: number,
  chunkSize: number,
): string[] {
  const stringCount = Math.min(readU32(view, chunkOffset + 8), 100_000);
  const flags = readU32(view, chunkOffset + 16);
  const stringsStart = readU32(view, chunkOffset + 20);
  const isUtf8 = (flags & 0x100) !== 0;
  const strings: string[] = [];
  for (let index = 0; index < stringCount; index += 1) {
    const relativeOffset = readU32(view, chunkOffset + 28 + index * 4);
    const start = chunkOffset + stringsStart + relativeOffset;
    if (start < chunkOffset || start >= chunkOffset + chunkSize || start >= bytes.length) {
      strings.push("");
      continue;
    }
    try {
      let dataStart: number;
      let byteLength: number;
      if (isUtf8) {
        const utf16Length = readLength8(bytes, start);
        const utf8Length = readLength8(bytes, utf16Length.next);
        dataStart = utf8Length.next;
        byteLength = utf8Length.length;
      } else {
        const length = readLength16(view, start);
        dataStart = length.next;
        byteLength = Math.min(length.length * 2, chunkOffset + chunkSize - dataStart);
      }
      const end = Math.min(dataStart + byteLength, chunkOffset + chunkSize, bytes.length);
      strings.push(new TextDecoder(isUtf8 ? "utf-8" : "utf-16le").decode(bytes.subarray(dataStart, end)).slice(0, 500));
    } catch {
      strings.push("");
    }
  }
  return strings;
}

function decodeBinaryXml(bytes: Uint8Array): AndroidManifestSummary | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 8 || readU16(view, 0) !== 0x0003) return null;
  const documentSize = Math.min(readU32(view, 4), bytes.byteLength);
  let offset = readU16(view, 2);
  let strings: string[] = [];
  const summary = emptySummary();
  let tagCount = 0;
  while (offset + 8 <= documentSize && tagCount < 20_000) {
    const type = readU16(view, offset);
    const headerSize = readU16(view, offset + 2);
    const chunkSize = readU32(view, offset + 4);
    if (chunkSize < 8 || offset + chunkSize > documentSize || headerSize > chunkSize) break;

    if (type === 0x0001) {
      strings = decodeStringPool(bytes, view, offset, chunkSize);
    } else if (type === 0x0102 && chunkSize >= 36) {
      const nameIndex = readU32(view, offset + 20);
      const attributeStart = readU16(view, offset + 24);
      const attributeSize = readU16(view, offset + 26);
      const attributeCount = Math.min(readU16(view, offset + 28), 128);
      const tagName = strings[nameIndex] ?? "";
      const attributes: ManifestAttribute[] = [];
      if (attributeSize >= 20) {
        const firstAttribute = offset + 16 + attributeStart;
        for (let index = 0; index < attributeCount; index += 1) {
          const attributeOffset = firstAttribute + index * attributeSize;
          if (attributeOffset + 20 > offset + chunkSize) break;
          const attributeName = strings[readU32(view, attributeOffset + 4)] ?? "";
          const rawValueIndex = readU32(view, attributeOffset + 8);
          const valueType = bytes[attributeOffset + 15];
          const typedValue = readU32(view, attributeOffset + 16);
          let value = rawValueIndex !== 0xffffffff ? strings[rawValueIndex] ?? "" : "";
          if (valueType === 0x03) value = strings[typedValue] ?? value;
          else if (valueType === 0x12) value = typedValue === 0 ? "false" : "true";
          else if (valueType !== undefined && valueType >= 0x10 && valueType <= 0x1f) value = String(typedValue);
          attributes.push({ name: attributeName, value: value.slice(0, 220) });
        }
      }
      applyManifestTag(summary, tagName, attributes);
      tagCount += 1;
    }
    offset += chunkSize;
  }
  if (!strings.length || tagCount === 0) return null;
  return summary;
}

export function parseAndroidManifest(bytes: Uint8Array): AndroidManifestSummary | null {
  const text = new TextDecoder().decode(bytes);
  const plain = decodePlainXml(text);
  if (plain) return plain;
  try {
    return decodeBinaryXml(bytes);
  } catch {
    return null;
  }
}

export function formatAndroidManifestSummary(summary: AndroidManifestSummary): string {
  const lines = ["Resumen estático del AndroidManifest.xml:"];
  if (summary.packageName) lines.push(`Paquete: ${summary.packageName}`);
  if (summary.versionName || summary.versionCode) {
    lines.push(`Versión: ${summary.versionName ?? "desconocida"} (${summary.versionCode ?? "código no disponible"})`);
  }
  if (summary.minSdkVersion || summary.targetSdkVersion) {
    lines.push(`SDK: mínimo ${summary.minSdkVersion ?? "no indicado"}, objetivo ${summary.targetSdkVersion ?? "no indicado"}`);
  }
  for (const permission of summary.permissions) lines.push(`Permiso declarado: ${permission}`);
  for (const component of summary.components) lines.push(`Componente declarado: ${component}`);
  for (const feature of summary.features) lines.push(`Recurso requerido: ${feature}`);
  if (lines.length === 1) lines.push("Se encontró el manifiesto, pero no se pudo decodificar su estructura.");
  return lines.join("\n").slice(0, 8000);
}