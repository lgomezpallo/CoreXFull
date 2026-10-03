function toStoredCredential(row) {
  return {
    id: row.credential_id,
    publicKey: Buffer.from(row.credential_public_key, "base64url"),
    counter: Number(row.sign_count),
    transports: Array.isArray(row.transports) ? row.transports : [],
    name: row.name,
    createdAt: row.created_at,
  };
}

export function createSupabaseAdminPasskeyStore({
  supabaseUrl,
  serviceRoleKey,
  fetchImpl = globalThis.fetch,
}) {
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Router IA passkey storage is not configured.");
  }

  const parsedUrl = new URL(supabaseUrl);
  if (
    parsedUrl.protocol !== "https:" ||
    parsedUrl.username ||
    parsedUrl.password ||
    parsedUrl.pathname !== "/" ||
    parsedUrl.search ||
    parsedUrl.hash
  ) {
    throw new Error("Supabase URL must use HTTPS.");
  }
  const baseUrl = parsedUrl.toString().replace(/\/+$/, "");
  const columns =
    "credential_id,credential_public_key,sign_count,transports,name,created_at";

  async function request(path, { method = "GET", body, prefer } = {}) {
    const headers = {
      accept: "application/json",
      apikey: serviceRoleKey,
      authorization: `Bearer ${serviceRoleKey}`,
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (prefer) headers.prefer = prefer;

    let response;
    try {
      response = await fetchImpl(`${baseUrl}/rest/v1/${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(12_000),
      });
    } catch {
      throw new Error("Router IA passkey storage is unavailable.");
    }

    if (!response.ok) {
      throw new Error("Router IA passkey storage request failed.");
    }
    if (response.status === 204) return null;

    try {
      return await response.json();
    } catch {
      throw new Error("Router IA passkey storage returned an invalid response.");
    }
  }

  return {
    async listCredentials() {
      const rows = await request(
        `router_ia_admin_passkeys?select=${columns}&order=created_at.asc`,
      );
      return Array.isArray(rows) ? rows.map(toStoredCredential) : [];
    },

    async getCredential(id) {
      const rows = await request(
        `router_ia_admin_passkeys?select=${columns}&credential_id=eq.${encodeURIComponent(id)}&limit=1`,
      );
      return Array.isArray(rows) && rows[0] ? toStoredCredential(rows[0]) : null;
    },

    async addCredential(credential) {
      const rows = await request(
        `router_ia_admin_passkeys?select=${columns}`,
        {
          method: "POST",
          body: {
            credential_id: credential.id,
            credential_public_key: Buffer.from(credential.publicKey).toString("base64url"),
            sign_count: credential.counter,
            transports: credential.transports,
            name: credential.name,
          },
          prefer: "return=representation",
        },
      );
      if (!Array.isArray(rows) || !rows[0]?.credential_id) {
        throw new Error("Supabase did not return the saved Router IA passkey.");
      }
      return toStoredCredential(rows[0]);
    },

    async updateCounter(id, counter) {
      await request(
        `router_ia_admin_passkeys?credential_id=eq.${encodeURIComponent(id)}`,
        {
          method: "PATCH",
          body: { sign_count: counter },
          prefer: "return=minimal",
        },
      );
    },

    async deleteCredential(id) {
      await request(
        `router_ia_admin_passkeys?credential_id=eq.${encodeURIComponent(id)}`,
        { method: "DELETE", prefer: "return=minimal" },
      );
    },
  };
}