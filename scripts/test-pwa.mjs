import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

for (const folder of ['corex/artifacts/habla-code/dist/public', 'prisma/artifacts/ai-companion/dist']) {
  const html = await readFile(`${folder}/index.html`, 'utf8');
  assert.match(html, /rel="manifest" href="\/manifest.webmanifest"/);
  assert.match(html, /pwa-register.js/);
  assert.match(html, /apple-touch-icon/);
  const manifest = JSON.parse(await readFile(`${folder}/manifest.webmanifest`, 'utf8'));
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.start_url, '/');
  for (const icon of manifest.icons) assert.ok((await readFile(`${folder}${icon.src}`)).length > 100);
  const offline = await readFile(`${folder}/offline.html`, 'utf8');
  const handlers = {};
  vm.runInNewContext(await readFile(`${folder}/service-worker.js`, 'utf8'), {
    self: { location: { origin: 'https://app.example' }, addEventListener: (name, handler) => { handlers[name] = handler; } },
    caches: { match: async () => new Response(offline) },
    fetch: async () => { throw new Error('offline'); }, URL, Response,
  });
  for (const request of [
    { method: 'POST', mode: 'navigate', url: 'https://app.example/api/ai/chat' },
    { method: 'GET', mode: 'navigate', url: 'https://app.example/api/router/status' },
    { method: 'GET', mode: 'cors', url: 'https://app.example/assets/bundle.js' },
    { method: 'GET', mode: 'navigate', url: 'https://other.example/' },
  ]) {
    handlers.fetch({ request, respondWith: () => assert.fail('Must not intercept API, assets or external requests') });
  }
  let result;
  handlers.fetch({ request: { method: 'GET', mode: 'navigate', url: 'https://app.example/' }, respondWith: (promise) => { result = promise; } });
  assert.equal(await (await result).text(), offline);
  console.log(`${manifest.name}: manifest, exported assets, API exclusion and offline navigation OK`);
}
