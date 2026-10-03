import type { AppBlueprint, AppBuilderItem, AppBuilderSection } from '@workspace/api-client-react';
import { buildPersonalAppRuntime } from './personal-app-runtime';

const accents = {
  violet: { main: '#7056c8', soft: '#eeebff' },
  ocean: { main: '#3f78a4', soft: '#e4f1f7' },
  mint: { main: '#3f9277', soft: '#e2f1eb' },
  amber: { main: '#bd7b2e', soft: '#fcf0db' },
} as const;

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return entities[character];
  });
}

function renderItem(item: AppBuilderItem, accent: string) {
  const checked = item.checked;
  return `<article class="item${checked ? ' checked' : ''}" aria-disabled="true">
    <span class="check" aria-hidden="true">✓</span>
    <span class="item-copy"><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.description)}</small></span>
    <span class="item-value" style="color:${accent}">${escapeHtml(item.value)}</span>
  </article>`;
}

function renderSection(section: AppBuilderSection, accent: string, soft: string) {
  let content = '';
  if (section.type === 'stats') {
    content = `<div class="stats">${section.items.map((item) => `<div class="stat" style="background:${soft}"><strong style="color:${accent}">${escapeHtml(item.value)}</strong><span>${escapeHtml(item.title)}</span></div>`).join('')}</div>`;
  } else if (section.type === 'progress') {
    const item = section.items[0];
    const percent = Math.max(0, Math.min(100, Number.parseFloat(item?.value ?? '0') || 0));
    content = item ? `<div class="progress-copy"><strong>${escapeHtml(item.title)}</strong><span style="color:${accent}">${escapeHtml(item.value)}</span></div><div class="progress-track"><span style="width:${percent}%;background:${accent}"></span></div><p class="item-description">${escapeHtml(item.description)}</p>` : '';
  } else if (section.type === 'form') {
    content = `<div class="form">${section.items.map((item) => `<label>${escapeHtml(item.title)}<input type="text" placeholder="${escapeHtml(item.description)}" disabled></label>`).join('')}<button class="submit" type="button" style="background:${accent}" disabled>${escapeHtml(section.actionLabel)}</button><p class="form-status">Esta parte todavía no tiene una acción funcional.</p></div>`;
  } else {
    content = `<div class="items">${section.items.map((item) => renderItem(item, accent)).join('')}</div>`;
  }

  return `<section class="section">
    <div class="section-heading"><div><h2>${escapeHtml(section.title)}</h2><p>${escapeHtml(section.description)}</p></div><span class="action">${escapeHtml(section.actionLabel)}</span></div>
    ${content}
  </section>`;
}

export function buildStandaloneAppHtml(blueprint: AppBlueprint, appNamespace?: string) {
  const accent = accents[blueprint.accentColor] ?? accents.mint;
  const isFunctional = blueprint.appKind !== 'prototype';
  const sections = blueprint.sections.map((section) => renderSection(section, accent.main, accent.soft)).join('');
  const personalApp = isFunctional ? buildPersonalAppRuntime(blueprint, appNamespace) : null;
  const generatedContent = personalApp?.markup ?? sections;

  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="${escapeHtml(blueprint.description)}">
  <title>${escapeHtml(blueprint.title)}</title>
  <style>
    :root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#263839;background:#f6f1e8;font-synthesis:none;--accent:${accent.main};--accent-soft:${accent.soft}}
    *{box-sizing:border-box}body{margin:0;padding:40px 20px}.app{max-width:760px;margin:auto}
    header{padding:34px 0 26px}header small{font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:#87918b}
    h1{font-size:clamp(34px,7vw,54px);letter-spacing:-.06em;line-height:1.04;margin:14px 0 10px}
    .subtitle{font-size:19px;font-weight:650;margin:0 0 8px;color:${accent.main}}.description{color:#718079;line-height:1.7;max-width:560px;margin:0}
    .section{padding:20px;margin:16px 0;background:#fffdf9;border:1px solid #e4ddd3;border-radius:20px;box-shadow:0 5px 18px #353c340b}
    .section-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;margin-bottom:15px}
    h2{font-size:16px;letter-spacing:-.02em;margin:0 0 5px}.section-heading p,.item-description{font-size:12px;line-height:1.6;color:#909892;margin:0}
    .action{font-size:11px;font-weight:650;color:${accent.main};white-space:nowrap}
    .stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.stat{padding:15px 9px;border-radius:13px;text-align:center}
    .stat strong{display:block;font-size:25px;letter-spacing:-.04em}.stat span{font-size:11px;color:#75817b}
    .item{width:100%;display:flex;align-items:center;gap:12px;padding:13px 0;text-align:left;border:0;border-bottom:1px solid #ebe5dc;background:transparent;color:inherit}
    .item:last-child{border-bottom:0}.check{width:21px;height:21px;display:grid;place-items:center;border:1px solid #d6d0c7;border-radius:7px;color:transparent;flex:none}
    .item.checked .check{background:${accent.main};border-color:${accent.main};color:white}.item.checked .item-copy{opacity:.52;text-decoration:line-through}
    .item-copy{flex:1;min-width:0}.item-copy strong,.item-copy small{display:block}.item-copy strong{font-size:13px}.item-copy small{font-size:11px;color:#8b948f;margin-top:4px}
    .item-value{font-size:11px;white-space:nowrap}.progress-copy{display:flex;justify-content:space-between;gap:12px;font-size:13px}
    .progress-track{height:9px;border-radius:999px;background:#ebe7df;overflow:hidden;margin:12px 0 8px}.progress-track span{height:100%;display:block;border-radius:inherit}
    .form label{display:block;margin:12px 0;font-size:12px;font-weight:650}.form input{display:block;width:100%;margin-top:6px;padding:11px 12px;border:1px solid #e1d9cf;border-radius:10px;background:#fffdf9;font:inherit;font-weight:400}.submit{padding:10px 14px;border:0;border-radius:9px;color:white;font-weight:700;cursor:pointer}.form-status{min-height:16px;margin:8px 0 0;color:${accent.main};font-size:12px}
    .mode-note{padding:13px 15px;margin:8px 0 18px;border:1px solid #d9e4dc;border-radius:12px;background:#f0f6f1;color:#53685b;font-size:12px;line-height:1.55}
    .mode-note.is-prototype{border-color:#eadab7;background:#fff7e8;color:#755b2e}
    .personal-workspace{padding:0 0 20px}.workspace-stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin:0 0 16px}
    .metric-card{padding:15px;border:1px solid #e7e0d7;border-radius:14px;background:#fffdf9}.metric-card span{display:block;color:#7d8982;font-size:11px}
    .metric-card strong{display:block;margin-top:6px;color:${accent.main};font-size:clamp(18px,4vw,25px);letter-spacing:-.04em}
    .entry-form{padding:20px;margin:16px 0 24px;border:1px solid #e6dfd5;border-radius:16px;background:#fffdf9}
    .entry-form h2,.workspace-list-heading h2{font-size:16px;margin:0 0 5px}.form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin:14px 0}
    .field{display:block;color:#63716a;font-size:12px;font-weight:650}.field-wide{grid-column:1/-1}
    .field input,.field select{display:block;width:100%;min-height:42px;margin-top:6px;padding:10px 11px;border:1px solid #ded8ce;border-radius:9px;background:#fff;font:inherit;font-weight:400;color:#263839}
    .field input:focus,.field select:focus{outline:2px solid ${accent.main};outline-offset:1px}.form-actions,.expense-footer-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
    .primary-button,.secondary-button,.text-button,.record-actions button,.filter-row button{font:inherit;cursor:pointer}
    .primary-button{padding:10px 15px;border:0;border-radius:9px;background:${accent.main};color:#fff;font-size:12px;font-weight:700}
    .secondary-button{padding:9px 12px;border:1px solid #ddd6cc;border-radius:9px;background:#fffdf9;color:#52645a;font-size:12px;font-weight:650}
    .text-button{padding:9px 4px;border:0;background:transparent;color:#64736b;font-size:12px}
    .primary-button:focus-visible,.secondary-button:focus-visible,.text-button:focus-visible,.record-actions button:focus-visible,.filter-row button:focus-visible,.record-check:focus-visible{outline:2px solid ${accent.main};outline-offset:2px}
    .workspace-list-heading{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;margin:20px 0 10px}.workspace-list-heading p{margin:0;color:#87928b;font-size:12px;line-height:1.5}
    .filter-row{display:flex;gap:7px;margin-bottom:9px}.filter-row button{padding:7px 11px;border:1px solid #e5dfd6;border-radius:999px;background:#fffdf9;color:#69776f;font-size:11px}
    .filter-row button[aria-pressed="true"]{border-color:${accent.main};background:${accent.soft};color:${accent.main};font-weight:700}
    .record-list{border-top:1px solid #e9e3da}.record-row{display:flex;align-items:center;gap:12px;padding:13px 4px;border-bottom:1px solid #e9e3da}
    .record-check{width:24px;height:24px;flex:none;border:1px solid #cfc9bf;border-radius:8px;background:#fff;color:transparent;cursor:pointer}
    .record-row.is-complete .record-check{border-color:${accent.main};background:${accent.main};color:#fff}
    .record-copy{flex:1;min-width:0}.record-copy strong,.record-copy span,.record-copy small{display:block}
    .record-copy strong{font-size:13px}.record-copy span,.record-copy small{margin-top:3px;color:#849087;font-size:11px;line-height:1.45}
    .record-row.is-complete .record-copy strong{text-decoration:line-through;opacity:.62}
    .record-actions{display:flex;gap:7px;justify-content:flex-end;align-items:center}.record-actions button{padding:6px 7px;border:0;border-radius:6px;background:transparent;color:#637269;font-size:11px}
    .record-actions button:hover{background:#f1eee8}.empty-state{padding:22px 12px;text-align:center;color:#8b958e;font-size:12px;line-height:1.5}
    .storage-status{margin:14px 0 0;color:#849087;font-size:11px;line-height:1.5}
    .daily-progress{height:8px;margin:0 0 16px;border-radius:999px;background:#ebe7df;overflow:hidden}.daily-progress span{display:block;height:100%;border-radius:inherit;background:${accent.main};transition:width .2s ease}
    .month-picker{display:grid;gap:5px;color:#748179;font-size:11px}.month-picker input{padding:8px;border:1px solid #e4ddd3;border-radius:8px;background:#fffdf9;font:inherit}
    .table-wrap{overflow-x:auto;border:1px solid #e9e3da;border-radius:12px;background:#fffdf9}
    .expense-table{width:100%;border-collapse:collapse;font-size:12px}.expense-table th,.expense-table td{padding:11px 12px;border-bottom:1px solid #eee8df;text-align:left;white-space:nowrap}
    .expense-table th{background:#faf7f1;color:#758078;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em}
    .expense-table tbody tr:last-child td{border-bottom:0}.expense-table td small{display:block;margin-top:3px;color:#8d968f;font-size:10px}
    .amount-cell{font-weight:700;color:#34493c}.visually-hidden{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
    .expense-footer-actions{justify-content:flex-end;margin-top:12px}
    footer{padding:25px 0;text-align:center;color:#9ba19c;font-size:11px}
    @media(max-width:520px){body{padding:20px 14px}.section{padding:16px}.stats{gap:6px}.stat{padding:12px 4px}.stat strong{font-size:21px}.item-value{font-size:10px}.workspace-stats{gap:6px}.metric-card{padding:11px 9px}.form-grid{grid-template-columns:1fr}.field-wide{grid-column:auto}.entry-form{padding:16px}.workspace-list-heading{align-items:flex-start;flex-direction:column}.expense-list-heading{flex-direction:row;align-items:flex-end}.record-row{gap:8px}.record-actions{gap:0}.record-actions button{padding:6px 5px;font-size:10px}.expense-table th,.expense-table td{padding:9px 8px}.expense-table .record-actions button{padding:5px 3px}}
  </style>
</head>
<body>
  <main class="app">
    <header><small>Una app hecha a tu manera</small><h1>${escapeHtml(blueprint.title)}</h1><p class="subtitle">${escapeHtml(blueprint.subtitle)}</p><p class="description">${escapeHtml(blueprint.description)}</p></header>
    ${isFunctional
      ? '<p class="mode-note">Esta app funciona y guarda sus datos en este navegador. Los datos no se sincronizan ni se envían a un servidor.</p>'
      : '<p class="mode-note is-prototype">Prototipo visual: la función solicitada todavía no está implementada. Los controles de muestra están desactivados.</p>'}
    ${generatedContent}
    ${personalApp?.script ?? ''}
    <footer>Creada con CoreX</footer>
  </main>
</body>
</html>`;
}

export function downloadStandaloneApp(blueprint: AppBlueprint, appNamespace?: string) {
  const fileName = blueprint.title
    .normalize('NFD')
    .replace(/[\\u0300-\\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'mi-app';
  const blob = new Blob([buildStandaloneAppHtml(blueprint, appNamespace)], { type: 'text/html;charset=utf-8' });
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = `${fileName}.html`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}