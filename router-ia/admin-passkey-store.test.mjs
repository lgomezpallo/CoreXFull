import assert from "node:assert/strict";
import test from "node:test";
import { createSupabaseAdminPasskeyStore } from "./admin-passkey-store.mjs";

const SUPABASE_URL = "https://router-test.supabase.co";
const SERVICE_ROLE_KEY = "test-only-service-role-key";

test("Supabase passkey storage persists credentials and updates their sign counter", async () => {
  const rows = [];
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (options.method === "POST") {
      const body = JSON.parse(options.body);
      const row = {
        ...body,
        created_at: "2026-10-02T00:00:00.000Z",
      };
      rows.push(row);
      return Response.json([row], { status: 201 });
    }
    if (options.method === "GET") {
      const requestedId = new URL(url).searchParams.get("credential_id");
      return Response.json(
        requestedId
          ? rows.filter((row) => row.credential_id === requestedId.replace(/^eq\./, ""))
          : rows,
      );
    }
    if (options.method === "PATCH") {
      const requestedId = new URL(url).searchParams
        .get("credential_id")
        .replace(/^eq\./, "");
      const row = rows.find((entry) => entry.credential_id === requestedId);
      if (row) Object.assign(row, JSON.parse(options.body));
      return new Response(null, { status: 204 });
    }
    if (options.method === "DELETE") {
      const requestedId = new URL(url).searchParams
        .get("credential_id")
        .replace(/^eq\./, "");
      const index = rows.findIndex((entry) => entry.credential_id === requestedId);
      if (index >= 0) rows.splice(index, 1);
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected request method: ${options.method}`);
  };
  const store = createSupabaseAdminPasskeyStore({
    supabaseUrl: SUPABASE_URL,
    serviceRoleKey: SERVICE_ROLE_KEY,
    fetchImpl,
  });

  const saved = await store.addCredential({
    id: "credential_01",
    publicKey: Uint8Array.from([1, 2, 3, 255]),
    counter: 0,
    transports: ["internal"],
    name: "Teléfono",
  });
  assert.equal(saved.id, "credential_01");
  assert.deepEqual(saved.publicKey, Buffer.from([1, 2, 3, 255]));
  assert.deepEqual(saved.transports, ["internal"]);
  assert.equal((await store.getCredential("credential_01")).counter, 0);
  assert.equal((await store.listCredentials()).length, 1);

  await store.updateCounter("credential_01", 3);
  assert.equal((await store.getCredential("credential_01")).counter, 3);
  await store.deleteCredential("credential_01");
  assert.equal((await store.listCredentials()).length, 0);

  assert.equal(calls.length, 7);
  assert.ok(calls.every(({ options }) =>
    options.headers.authorization === `Bearer ${SERVICE_ROLE_KEY}`,
  ));
  const insertBody = JSON.parse(calls[0].options.body);
  assert.equal(insertBody.credential_public_key, "AQID_w");
  assert.equal(insertBody.sign_count, 0);
});

test("Supabase passkey storage rejects URLs that could redirect or change the expected host", () => {
  assert.throws(
    () =>
      createSupabaseAdminPasskeyStore({
        supabaseUrl: "http://router-test.supabase.co",
        serviceRoleKey: SERVICE_ROLE_KEY,
      }),
    /HTTPS/,
  );
  assert.throws(
    () =>
      createSupabaseAdminPasskeyStore({
        supabaseUrl: "https://router-test.supabase.co/admin?redirect=1",
        serviceRoleKey: SERVICE_ROLE_KEY,
      }),
    /HTTPS/,
  );
});