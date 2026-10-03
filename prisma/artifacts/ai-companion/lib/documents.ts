import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { Platform } from 'react-native';

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatMarkdown(content: string) {
  return content
    .split('\n')
    .map((line) => {
      const safeLine = escapeHtml(line.trim());
      if (!safeLine) return '<div class="space"></div>';
      if (safeLine.startsWith('### ')) {
        return `<h3>${safeLine.slice(4)}</h3>`;
      }
      if (safeLine.startsWith('## ')) {
        return `<h2>${safeLine.slice(3)}</h2>`;
      }
      if (safeLine.startsWith('# ')) {
        return `<h1>${safeLine.slice(2)}</h1>`;
      }
      if (safeLine.startsWith('- ') || safeLine.startsWith('* ')) {
        return `<p class="bullet">• ${safeLine.slice(2)}</p>`;
      }
      return `<p>${safeLine}</p>`;
    })
    .join('');
}

export async function exportAsPdf(title: string, content: string) {
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8" /><style>
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#183129;padding:42px;line-height:1.65}
    h1{font-size:26px;line-height:1.25;margin:0 0 24px;color:#245b45}
    h2{font-size:19px;margin:26px 0 10px;color:#245b45}
    h3{font-size:16px;margin:20px 0 8px;color:#245b45}
    p{font-size:12px;margin:0 0 10px;white-space:pre-wrap}
    .bullet{padding-left:16px}.space{height:8px}
    footer{margin-top:36px;border-top:1px solid #e2e8df;padding-top:12px;color:#75827a;font-size:10px}
  </style></head><body><main>${formatMarkdown(content)}</main><footer>Creado con Prisma</footer></body></html>`;

  if (Platform.OS === 'web') {
    await Print.printAsync({ html });
    return;
  }

  const file = await Print.printToFileAsync({ html });
  const available = await Sharing.isAvailableAsync();
  if (!available) {
    throw new Error('No está disponible la opción para compartir el PDF.');
  }
  await Sharing.shareAsync(file.uri, {
    mimeType: 'application/pdf',
    dialogTitle: title,
    UTI: 'com.adobe.pdf',
  });
}