import { unzipSync } from 'fflate';
import type { AppBuilderReference } from '@workspace/api-client-react';
import { formatAndroidManifestSummary, parseAndroidManifest } from './android-manifest';

export const MAX_REFERENCE_FILES = 5;
export const REFERENCE_FILE_ACCEPT = [
  '.apk', '.zip', '.pdf', '.docx', '.pptx', '.xlsx',
  '.png', '.jpg', '.jpeg', '.webp',
  '.txt', '.md', '.csv', '.json', '.xml', '.html', '.css', '.py',
  '.js', '.jsx', '.ts', '.tsx', '.yaml', '.yml', '.sql', '.svg',
  '.java', '.kt', '.swift', '.go', '.rs', '.sh',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.elf', '.jar', '.class',
].join(',');

export type ReferenceAttachment = {
  id: string;
  name: string;
  detail: string;
  payload: AppBuilderReference;
};

const MAX_FILE_SIZE = 25 * 1024 * 1024;
const MAX_APK_SIZE = 70 * 1024 * 1024;
const MAX_ARCHIVE_SIZE = 15 * 1024 * 1024;
const MAX_ARCHIVE_ENTRY_SIZE = 900 * 1024;
const MAX_ARCHIVE_EXPANDED_SIZE = 3 * 1024 * 1024;
const MAX_REFERENCE_TEXT = 12_000;
const MAX_IMAGE_DATA_URL = 1_200_000;

const textExtensions = new Set([
  'txt', 'md', 'csv', 'json', 'xml', 'html', 'css', 'js', 'jsx',
  'ts', 'tsx', 'yaml', 'yml', 'sql', 'svg', 'py', 'java', 'kt',
  'swift', 'go', 'rs', 'sh',
]);
const imageExtensions = new Set(['png', 'jpg', 'jpeg', 'webp']);
const binaryExtensions = new Set(['exe', 'dll', 'so', 'dylib', 'bin', 'elf', 'jar', 'class']);
const archiveCodeExtensions = new Set([
  ...textExtensions,
  'java', 'kt', 'swift', 'py', 'go', 'rs', 'sh',
]);

function extensionOf(name: string): string {
  return name.split('.').pop()?.toLowerCase() ?? '';
}

function truncateText(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > MAX_REFERENCE_TEXT
    ? `${trimmed.slice(0, MAX_REFERENCE_TEXT)}\n[Fragmento acotado para usar como referencia.]`
    : trimmed;
}

function makeAttachment(
  file: File,
  kind: AppBuilderReference['kind'],
  extractedText: string,
  detail: string,
  imageDataUrl?: string,
): ReferenceAttachment {
  const payload: AppBuilderReference = {
    name: file.name.slice(0, 160),
    kind,
    extractedText: truncateText(extractedText),
    ...(imageDataUrl ? { imageDataUrl } : {}),
  };
  return {
    id: crypto.randomUUID(),
    name: file.name,
    detail,
    payload,
  };
}

async function imageToDataUrl(blob: Blob): Promise<string> {
  const bitmap = await createImageBitmap(blob);
  try {
    const scale = Math.min(1, 1280 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('No pude procesar esta imagen en el navegador.');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const result = canvas.toDataURL('image/jpeg', 0.76);
    if (result.length > MAX_IMAGE_DATA_URL) {
      throw new Error('La imagen sigue siendo muy pesada. Probá con una versión más liviana.');
    }
    return result;
  } finally {
    bitmap.close();
  }
}

function normalizeArchivePath(path: string): string | null {
  const normalized = path.replaceAll('\\', '/').replace(/^\/+/, '');
  if (normalized.split('/').some((part) => part === '..')) return null;
  if (/(^|\/)(node_modules|vendor|dist|build|coverage|\.git)(\/|$)/i.test(normalized)) return null;
  return normalized;
}

async function selectedArchiveEntries(
  file: File,
  shouldInclude: (path: string) => boolean,
  isApk: boolean,
): Promise<Record<string, Uint8Array>> {
  const maxSize = isApk ? MAX_APK_SIZE : MAX_ARCHIVE_SIZE;
  if (file.size > maxSize) {
    throw new Error(
      isApk
        ? 'El APK supera el límite de 70 MB.'
        : 'El archivo comprimido supera el límite de 15 MB.',
    );
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  let count = 0;
  let expanded = 0;
  return unzipSync(bytes, {
    filter: (entry) => {
      const path = normalizeArchivePath(entry.name);
      if (!path || !shouldInclude(path)) return false;
      if (entry.originalSize > MAX_ARCHIVE_ENTRY_SIZE) return false;
      if (count >= 32 || expanded + entry.originalSize > MAX_ARCHIVE_EXPANDED_SIZE) return false;
      count += 1;
      expanded += entry.originalSize;
      return true;
    },
  });
}

function xmlText(bytes: Uint8Array): string {
  const xml = new TextDecoder().decode(bytes);
  const parsed = new DOMParser().parseFromString(xml, 'application/xml');
  return parsed.documentElement?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
}

function archiveImageMime(path: string): string | null {
  const ext = extensionOf(path);
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  return null;
}

function printableBinaryStrings(bytes: Uint8Array): string[] {
  const strings = new Set<string>();
  const collectRuns = (readCodeUnit: (index: number) => number, step: number) => {
    let run = '';
    const flush = () => {
      const value = run.replace(/\s+/g, ' ').trim();
      if (value.length >= 4 && strings.size < 100) strings.add(value.slice(0, 220));
      run = '';
    };
    for (let index = 0; index + (step === 2 ? 1 : 0) < bytes.length; index += step) {
      const code = readCodeUnit(index);
      if (code >= 0x20 && code <= 0x7e) run += String.fromCharCode(code);
      else flush();
    }
    flush();
  };

  collectRuns((index) => bytes[index], 1);
  collectRuns((index) => bytes[index] | (bytes[index + 1] << 8), 2);
  return [...strings].slice(0, 100);
}

function staticEndpoints(text: string): string[] {
  return [...new Set(text.match(/https?:\/\/[A-Za-z0-9._~:/?#\[\]@!$&'()*+,;=%-]{5,240}/g) ?? [])]
    .slice(0, 40);
}

async function firstArchiveImage(entries: Record<string, Uint8Array>): Promise<string | undefined> {
  const match = Object.entries(entries).find(([path]) => archiveImageMime(path));
  if (!match) return undefined;
  const [path, bytes] = match;
  const blob = new Blob([new Uint8Array(bytes).buffer as ArrayBuffer], { type: archiveImageMime(path) ?? 'application/octet-stream' });
  return imageToDataUrl(blob);
}

async function preparePdf(file: File): Promise<ReferenceAttachment> {
  const [{ getDocument, GlobalWorkerOptions }, worker] = await Promise.all([
    import('pdfjs-dist'),
    import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
  ]);
  GlobalWorkerOptions.workerSrc = worker.default;
  const loadingTask = getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  const pdf = await loadingTask.promise;
  try {
    const textParts: string[] = [];
    const pagesToRead = Math.min(pdf.numPages, 8);
    for (let pageNumber = 1; pageNumber <= pagesToRead; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const text = await page.getTextContent();
      const pageText = text.items
        .filter((item): item is typeof item & { str: string } => 'str' in item)
        .map((item) => item.str)
        .join(' ');
      if (pageText.trim()) textParts.push(`Página ${pageNumber}: ${pageText}`);
    }

    let imageDataUrl: string | undefined;
    if (pdf.numPages > 0) {
      const page = await pdf.getPage(1);
      const naturalViewport = page.getViewport({ scale: 1 });
      const scale = Math.min(1.3, 1200 / naturalViewport.width, 1200 / naturalViewport.height);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext('2d');
      if (context) {
        await page.render({ canvas, canvasContext: context, viewport }).promise;
        imageDataUrl = canvas.toDataURL('image/jpeg', 0.76);
        if (imageDataUrl.length > MAX_IMAGE_DATA_URL) imageDataUrl = undefined;
      }
    }

    const extractedText = textParts.length
      ? `Texto extraído de hasta ${pagesToRead} páginas:\n${textParts.join('\n')}`
      : 'No se encontró texto seleccionable en este PDF; se adjunta la primera página como referencia visual.';
    return makeAttachment(file, 'document', extractedText, 'PDF: texto y primera página como referencia visual', imageDataUrl);
  } finally {
    await loadingTask.destroy();
  }
}

async function prepareOfficeDocument(file: File, extension: string): Promise<ReferenceAttachment> {
  const isWord = extension === 'docx';
  const isSlides = extension === 'pptx';
  const entries = await selectedArchiveEntries(file, (path) => {
    if (isWord) return path === 'word/document.xml' || /^word\/media\/.+\.(png|jpe?g|webp)$/i.test(path);
    if (isSlides) return /^ppt\/slides\/slide\d+\.xml$/i.test(path) || /^ppt\/media\/.+\.(png|jpe?g|webp)$/i.test(path);
    return path === 'xl/sharedStrings.xml' || /^xl\/worksheets\/sheet\d+\.xml$/i.test(path);
  }, false);
  const xmlFiles = Object.entries(entries)
    .filter(([path]) => path.endsWith('.xml'))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, bytes]) => `${path}: ${xmlText(bytes)}`);
  const imageDataUrl = await firstArchiveImage(entries);
  const extractedText = xmlFiles.length
    ? xmlFiles.join('\n').slice(0, MAX_REFERENCE_TEXT)
    : 'No se encontró texto legible en el documento.';
  if (!xmlFiles.length && !imageDataUrl) {
    throw new Error('No pude leer contenido de este documento. Probá con un PDF o una captura.');
  }
  const documentName = isWord ? 'Documento Word' : isSlides ? 'Presentación' : 'Planilla';
  return makeAttachment(
    file,
    'document',
    extractedText,
    `${documentName}: texto${imageDataUrl ? ' e imagen de referencia' : ''}`,
    imageDataUrl,
  );
}

async function prepareArchive(file: File, isApk: boolean): Promise<ReferenceAttachment> {
  const entries = await selectedArchiveEntries(file, (path) => {
    if (isApk) {
      if (imageExtensions.has(extensionOf(path)) && /(^|\/)(mipmap|drawable)[^/]*\//i.test(path) && /(launcher|app[_-]?icon|ic[_-]?logo)/i.test(path)) return true;
      if (/^(AndroidManifest\.xml|classes\d*\.dex|resources\.arsc)$/i.test(path)) return true;
      if (/^lib\/[^/]+\/[^/]+\.so$/i.test(path)) return true;
      return /^assets\/.+\.(html|css|js|json|txt|md)$/i.test(path) ||
        /^res\/(layout|menu|navigation|xml|values)[^/]*\/.+\.xml$/i.test(path);
    }
    return archiveCodeExtensions.has(extensionOf(path)) || imageExtensions.has(extensionOf(path));
  }, isApk);

  const entryNames = Object.keys(entries);
  const textFiles = Object.entries(entries)
    .filter(([path]) => isApk
      ? archiveCodeExtensions.has(extensionOf(path)) || /^(AndroidManifest\.xml|classes\d*\.dex|resources\.arsc)$/i.test(path)
      : archiveCodeExtensions.has(extensionOf(path)))
    .slice(0, 18)
    .map(([path, bytes]) => {
      if (isApk && path === 'AndroidManifest.xml') {
        const manifest = parseAndroidManifest(bytes);
        return manifest
          ? formatAndroidManifestSummary(manifest)
          : 'AndroidManifest.xml fue encontrado, pero no se pudo decodificar con este analizador estático.';
      }
      if (isApk && (/^classes\d*\.dex$/i.test(path) || path === 'resources.arsc')) {
        const strings = printableBinaryStrings(bytes);
        return `Cadenas estáticas recuperadas de ${path} (pueden estar incompletas; no demuestran que una función se ejecute):\n${strings.join('\n')}`;
      }
      return `Archivo ${path}:\n${new TextDecoder().decode(bytes)}`;
    });
  const extractedText = isApk
    ? `APK analizado de forma estática; no se ejecutó ni se descompiló en código fuente. Se revisó una selección acotada de estructura, manifiesto, permisos, componentes Android, bibliotecas nativas, assets, recursos de interfaz y cadenas legibles: ${entryNames.join(', ') || 'no se encontraron recursos reconocibles'}.\n${textFiles.join('\n\n')}\nEndpoints visibles en las cadenas seleccionadas: ${staticEndpoints(textFiles.join('\n')).join(', ') || 'no se detectaron URLs HTTP visibles'}.\nLos nombres y cadenas sueltas no prueban que una función se ejecute ni que un endpoint esté activo. Para describir pantallas con más precisión, adjuntá también capturas.`
    : `Archivos incluidos en el ZIP: ${entryNames.join(', ')}.\n${textFiles.join('\n\n')}`;
  const imageDataUrl = await firstArchiveImage(entries);
  if (!textFiles.length && !imageDataUrl) {
    throw new Error(isApk
      ? 'No encontré recursos estáticos compatibles. Para una referencia visual más precisa, adjuntá capturas de la app.'
      : 'El ZIP no contiene imágenes ni archivos de texto compatibles.');
  }
  return makeAttachment(
    file,
    isApk ? 'apk' : 'archive',
    extractedText,
    isApk ? 'APK: revisión estática, sin ejecutar' : 'ZIP: textos, código e imágenes seleccionadas',
    imageDataUrl,
  );
}

export async function prepareReferenceFile(file: File): Promise<ReferenceAttachment> {
  const extension = extensionOf(file.name);
  const maxSize = extension === 'apk' ? MAX_APK_SIZE : MAX_FILE_SIZE;
  if (file.size > maxSize) {
    throw new Error(
      extension === 'apk'
        ? 'Cada APK puede pesar hasta 70 MB.'
        : 'Cada archivo puede pesar hasta 25 MB.',
    );
  }

  if (imageExtensions.has(extension)) {
    const imageDataUrl = await imageToDataUrl(file);
    return makeAttachment(file, 'image', 'Imagen adjunta como referencia visual.', 'Imagen lista para usar como referencia', imageDataUrl);
  }

  if (extension === 'pdf') return preparePdf(file);
  if (extension === 'docx' || extension === 'pptx' || extension === 'xlsx') {
    return prepareOfficeDocument(file, extension);
  }
  if (extension === 'zip') return prepareArchive(file, false);
  if (extension === 'apk') return prepareArchive(file, true);

  if (textExtensions.has(extension)) {
    const text = await file.text();
    if (!text.trim()) throw new Error('El archivo no contiene texto para usar como referencia.');
    return makeAttachment(file, 'code', `Contenido de referencia:\n${text}`, 'Texto o código listo para usar como referencia');
  }

  if (binaryExtensions.has(extension)) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const strings = printableBinaryStrings(bytes);
    const endpoints = staticEndpoints(strings.join('\n'));
    return makeAttachment(
      file,
      'binary',
      [
        'Archivo binario analizado de forma estática; no se ejecutó ni se instaló.',
        `Tipo de archivo: .${extension}.`,
        `Cadenas legibles recuperadas (pueden ser incompletas):\n${strings.join('\n') || 'No se encontraron cadenas imprimibles.'}`,
        `URLs visibles: ${endpoints.join(', ') || 'No se detectaron URLs HTTP visibles.'}`,
      ].join('\n\n'),
      'Binario: cadenas y URLs visibles; sin ejecución',
    );
  }

  throw new Error('Ese formato todavía no está soportado.');
}