import { unzipSync } from 'fflate';

export const MAX_XAPK_SIZE = 180 * 1024 * 1024;
const MAX_XAPK_MANIFEST_SIZE = 1024 * 1024;
const MAX_NESTED_APK_SIZE = 70 * 1024 * 1024;

type XapkMetadata = {
  packageName?: string;
  versionName?: string;
  appName?: string;
  basePath: string;
  apkPaths: string[];
  manifestText?: string;
};

function normalized(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\/+/, '');
}

function isSafePath(path: string): boolean {
  const value = normalized(path);
  return Boolean(value) && !value.split('/').some((part) => part === '..');
}

function collectArchivePaths(bytes: Uint8Array): string[] {
  const paths: string[] = [];
  unzipSync(bytes, {
    filter: (entry) => {
      const path = normalized(entry.name);
      if (isSafePath(path) && paths.length < 512) paths.push(path);
      return false;
    },
  });
  return paths;
}

function readManifest(bytes: Uint8Array, paths: string[]): { value: Record<string, unknown> | null; text?: string } {
  const manifestPath = paths.find((path) => /(^|\/)manifest\.json$/i.test(path));
  if (!manifestPath) return { value: null };
  const files = unzipSync(bytes, {
    filter: (entry) => normalized(entry.name) === manifestPath && entry.originalSize <= MAX_XAPK_MANIFEST_SIZE,
  });
  const raw = files[manifestPath];
  if (!raw) return { value: null };
  const text = new TextDecoder().decode(raw);
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? { value: parsed as Record<string, unknown>, text }
      : { value: null, text };
  } catch {
    return { value: null, text };
  }
}

function stringField(value: Record<string, unknown> | null, ...keys: string[]): string | undefined {
  if (!value) return undefined;
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return undefined;
}

function manifestApkCandidates(value: Record<string, unknown> | null): string[] {
  if (!value) return [];
  const found = new Set<string>();
  const visit = (node: unknown, depth = 0) => {
    if (depth > 5 || node == null) return;
    if (typeof node === 'string') {
      if (/\.apk$/i.test(node.trim())) found.add(normalized(node.trim()));
      return;
    }
    if (Array.isArray(node)) {
      node.slice(0, 64).forEach((item) => visit(item, depth + 1));
      return;
    }
    if (typeof node === 'object') {
      Object.values(node as Record<string, unknown>).slice(0, 64).forEach((item) => visit(item, depth + 1));
    }
  };
  visit(value);
  return [...found];
}

function chooseBasePath(apkPaths: string[], manifestCandidates: string[]): string | null {
  const byLower = new Map(apkPaths.map((path) => [path.toLowerCase(), path]));
  for (const candidate of manifestCandidates) {
    const exact = byLower.get(candidate.toLowerCase());
    if (exact && /(^|\/)base\.apk$/i.test(exact)) return exact;
  }
  const exactBase = apkPaths.find((path) => /(^|\/)base\.apk$/i.test(path));
  if (exactBase) return exactBase;
  for (const candidate of manifestCandidates) {
    const exact = byLower.get(candidate.toLowerCase());
    if (exact && !/(^|\/)(config\.|split[_-]|config[_-])/i.test(exact)) return exact;
  }
  return apkPaths.find((path) => !/(^|\/)(config\.|split[_-]|config[_-])/i.test(path)) ?? apkPaths[0] ?? null;
}

export function extractXapkBase(bytes: Uint8Array): { apkBytes: Uint8Array; metadata: XapkMetadata } {
  const paths = collectArchivePaths(bytes);
  const apkPaths = paths.filter((path) => /\.apk$/i.test(path));
  if (!apkPaths.length) throw new Error('El XAPK no contiene ningún APK reconocible.');

  const manifest = readManifest(bytes, paths);
  const basePath = chooseBasePath(apkPaths, manifestApkCandidates(manifest.value));
  if (!basePath) throw new Error('No pude identificar el APK base dentro del XAPK.');

  const files = unzipSync(bytes, {
    filter: (entry) => {
      const path = normalized(entry.name);
      if (path !== basePath) return false;
      if (entry.originalSize > MAX_NESTED_APK_SIZE) {
        throw new Error('El APK base dentro del XAPK supera el límite de 70 MB.');
      }
      return true;
    },
  });
  const apkBytes = files[basePath];
  if (!apkBytes) throw new Error('No pude extraer el APK base del XAPK.');

  return {
    apkBytes,
    metadata: {
      packageName: stringField(manifest.value, 'package_name', 'packageName', 'package'),
      versionName: stringField(manifest.value, 'version_name', 'versionName'),
      appName: stringField(manifest.value, 'name', 'app_name', 'appName'),
      basePath,
      apkPaths,
      manifestText: manifest.text,
    },
  };
}
