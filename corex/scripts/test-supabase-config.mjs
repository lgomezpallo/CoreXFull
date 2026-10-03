import assert from 'node:assert/strict';
import { createConfiguredSupabaseClient } from '../artifacts/habla-code/src/lib/supabase.ts';
for (const value of [undefined, '', 'VITE_SUPABASE_URL', 'https://', 'file:///tmp/auth', 'https://user:password@example.com', 'https://example.com?token=x', 'https://example.com/auth']) {
  assert.equal(createConfiguredSupabaseClient(value, 'public-test-key'), null);
}
assert.equal(createConfiguredSupabaseClient('https://example.supabase.co', ''), null);
const client = createConfiguredSupabaseClient('  https://example.supabase.co/  ', '  public-test-key  ');
assert.ok(client);
assert.equal(new URL(client.supabaseUrl).origin, 'https://example.supabase.co');
await client.auth.stopAutoRefresh();
console.log('Invalid configuration cannot crash startup; valid trimmed configuration initializes.');
