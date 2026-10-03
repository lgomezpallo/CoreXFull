import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRouterServer } from '../router-ia/server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let upstreamStatus = 200;
let finishReason = 'stop';
let calls = 0;
const router = createRouterServer({
  appToken: 'test-token',
  providerStore: { getActiveProviders: async () => [{
    id: 'test-route', baseUrl: 'https://provider.example/v1', apiKey: 'provider-test-key',
    model: 'test-model', active: true, priority: 50,
    modelMetadata: { pricing: { prompt: '0', completion: '0' } },
  }] },
  fetchImpl: async (url, options) => {
  assert.equal(url, 'https://provider.example/v1/chat/completions');
  const body = JSON.parse(options.body);
  assert.equal(body.model, 'test-model');
  assert.equal(body.max_tokens, 1024);
  calls++;
  return new Response(JSON.stringify(upstreamStatus === 200
    ? { choices: [{ message: { content: 'Prisma sigue funcionando sin CoreX.' }, finish_reason: finishReason }] }
    : { error: 'private provider detail' }), {
    status: upstreamStatus, headers: { 'content-type': 'application/json' },
  });
  },
});
router.listen(0, '127.0.0.1');
await once(router, 'listening');
const reserve = createServer();
reserve.listen(0, '127.0.0.1');
await once(reserve, 'listening');
const port = reserve.address().port;
await new Promise(resolve => reserve.close(resolve));
const child = spawn(process.execPath, ['artifacts/api-server/dist/index.mjs'], {
  cwd: path.join(root, 'prisma'),
  env: { ...process.env, NODE_ENV: 'production', PORT: String(port),
    AI_ROUTER_BASE_URL: `http://127.0.0.1:${router.address().port}/api/v1`,
    AI_ROUTER_API_KEY: 'test-token', AI_ROUTER_CHAT_MODEL: 'router-ia-auto', AI_ROUTER_STREAM: 'false' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
child.stdout.on('data', chunk => { logs += chunk; });
child.stderr.on('data', chunk => { logs += chunk; });
const origin = `http://127.0.0.1:${port}`;
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(logs);
    try { ready = (await fetch(`${origin}/api/healthz`)).ok; } catch {}
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, logs);
  const page = await fetch(origin);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<!DOCTYPE html>/i);
  assert.equal((await fetch(`${origin}/api/missing`)).status, 404);
  const chat = () => fetch(`${origin}/api/ai/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'chat', messages: [{ role: 'user', content: 'Hola' }] }),
  });
  let reply = await chat();
  assert.equal(reply.status, 200);
  let text = await reply.text();
  assert.match(text, /Prisma sigue funcionando sin CoreX/);
  assert.match(text, /data: \[DONE\]/);
  finishReason = 'length';
  text = await (await chat()).text();
  assert.match(text, /event: error/);
  assert.doesNotMatch(text, /data: \[DONE\]/);
  upstreamStatus = 429;
  reply = await chat();
  assert.equal(reply.status, 502);
  assert.doesNotMatch(await reply.text(), /private provider detail/);
  assert.equal(calls, 3, 'No retries or duplicate inferences');
  console.log('PASS: Prisma web + health + chat sin CoreX; truncación y error upstream detectados.');
} finally {
  child.kill('SIGTERM');
  await new Promise(resolve => router.close(resolve));
}
