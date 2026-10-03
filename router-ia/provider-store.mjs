import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const SAFE_PROVIDER_COLUMNS =
  "id,provider,name,base_url,model,is_active,capabilities,priority,model_metadata,catalog_checked_at,created_at";

function readEncryptionKey(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/i.test(value)) {
    throw new Error("Provider encryption is not configured.");
  }
  return Buffer.from(value, "hex");
}

function encryptApiKey(apiKey, encryptionKey) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(apiKey, "utf8"), cipher.final()]);
  return {
    api_key_ciphertext: ciphertext.toString("base64"),
    api_key_iv: iv.toString("base64"),
    api_key_tag: cipher.getAuthTag().toString("base64"),
  };
}

function decryptApiKey(row, encryptionKey) {
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      encryptionKey,
      Buffer.from(row.api_key_iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(row.api_key_tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(row.api_key_ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error("Stored provider credentials could not be decrypted.");
  }
}

function toPublicProvider(row) {
  return {
    id: row.id,
    provider: row.provider,
    name: row.name,
    baseUrl: row.base_url,
    model: row.model,
    active: row.is_active,
    capabilities: Array.isArray(row.capabilities) ? row.capabilities : [],
    priority: Number.isInteger(row.priority) ? row.priority : 50,
    modelMetadata:
      row.model_metadata && typeof row.model_metadata === "object" && !Array.isArray(row.model_metadata)
        ? row.model_metadata
        : {},
    catalogCheckedAt: row.catalog_checked_at ?? null,
    createdAt: row.created_at,
  };
}

export function createSupabaseProviderStore({
  supabaseUrl,
  serviceRoleKey,
  encryptionKey,
  fetchImpl = globalThis.fetch,
}) {
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Supabase provider storage is not configured.");
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
  const key = readEncryptionKey(encryptionKey);

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
      throw new Error("Supabase provider storage is unavailable.");
    }

    if (!response.ok) {
      const error = new Error(
        `Supabase provider storage request failed (HTTP ${response.status}).`,
      );
      error.statusCode = response.status;
      throw error;
    }
    if (response.status === 204) return null;

    try {
      return await response.json();
    } catch {
      throw new Error("Supabase provider storage returned an invalid response.");
    }
  }

  return {
    async listProviders() {
      const rows = await request(
        `router_ia_providers?select=${SAFE_PROVIDER_COLUMNS}&order=created_at.desc`,
      );
      return Array.isArray(rows) ? rows.map(toPublicProvider) : [];
    },

    async getActiveProviders() {
      const rows = await request(
        "router_ia_providers?select=id,provider,name,base_url,model,api_key_ciphertext,api_key_iv,api_key_tag,is_active,capabilities,priority,model_metadata,catalog_checked_at,created_at&is_active=eq.true&order=priority.desc,created_at.asc",
      );
      return Array.isArray(rows)
        ? rows.map((row) => ({
            ...toPublicProvider(row),
            apiKey: decryptApiKey(row, key),
          }))
        : [];
    },

    async addProvider(provider) {
      const encrypted = encryptApiKey(provider.apiKey, key);
      const rows = await request(
        `router_ia_providers?select=${SAFE_PROVIDER_COLUMNS}`,
        {
          method: "POST",
          body: {
            provider: provider.provider,
            name: provider.name,
            base_url: provider.baseUrl,
            model: provider.model,
            ...encrypted,
            is_active: true,
            capabilities: provider.capabilities,
            priority: provider.priority,
            model_metadata: provider.modelMetadata,
          },
          prefer: "return=representation",
        },
      );
      const row = Array.isArray(rows) ? rows[0] : null;
      if (!row?.id) throw new Error("Supabase did not return the saved provider.");
      return toPublicProvider(row);
    },

    async addProviders(providers) {
      if (!Array.isArray(providers) || providers.length === 0) {
        throw new Error("At least one provider model is required.");
      }

      const body = providers.map((provider) => ({
        provider: provider.provider,
        name: provider.name,
        base_url: provider.baseUrl,
        model: provider.model,
        ...encryptApiKey(provider.apiKey, key),
        is_active: true,
        capabilities: provider.capabilities,
        priority: provider.priority,
        model_metadata: provider.modelMetadata,
      }));
      const rows = await request(
        `router_ia_providers?select=${SAFE_PROVIDER_COLUMNS}`,
        {
          method: "POST",
          body,
          prefer: "return=representation",
        },
      );
      if (!Array.isArray(rows) || rows.length !== providers.length || rows.some((row) => !row?.id)) {
        throw new Error("Supabase did not return every saved provider model.");
      }
      return rows.map(toPublicProvider);
    },

    async updateProviderVerification(id, audit) {
      const currentRows = await request(
        `router_ia_providers?select=model_metadata&id=eq.${encodeURIComponent(id)}&limit=1`,
      );
      const currentMetadata =
        Array.isArray(currentRows) && currentRows[0]?.model_metadata &&
        typeof currentRows[0].model_metadata === "object" && !Array.isArray(currentRows[0].model_metadata)
          ? currentRows[0].model_metadata
          : {};
      const rows = await request(
        `router_ia_providers?id=eq.${encodeURIComponent(id)}&select=${SAFE_PROVIDER_COLUMNS}`,
        {
          method: "PATCH",
          body: {
            capabilities: Array.isArray(audit?.capabilities) ? audit.capabilities : [],
            model_metadata: {
              ...currentMetadata,
              capabilityVerification: audit?.verification ?? null,
            },
          },
          prefer: "return=representation",
        },
      );
      const row = Array.isArray(rows) ? rows[0] : null;
      if (!row?.id) throw new Error("Supabase did not return the audited provider.");
      return toPublicProvider(row);
    },

    async activateProvider(id) {
      await request("rpc/router_ia_activate_provider", {
        method: "POST",
        body: { provider_id: id },
      });
    },

    async deactivateProvider(id) {
      await request("rpc/router_ia_deactivate_provider", {
        method: "POST",
        body: { provider_id: id },
      });
    },

    async deleteProvider(id) {
      await request(`router_ia_providers?id=eq.${encodeURIComponent(id)}`, {
        method: "DELETE",
        prefer: "return=minimal",
      });
    },
  };
}
