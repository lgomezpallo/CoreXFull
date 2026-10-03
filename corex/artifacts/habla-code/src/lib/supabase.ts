import { createClient } from "@supabase/supabase-js";

const environment = import.meta.env ?? {};
export function createConfiguredSupabaseClient(rawUrl: unknown, rawPublicKey: unknown) {
  if (typeof rawUrl !== "string" || typeof rawPublicKey !== "string") return null;
  const publicKey = rawPublicKey.trim();
  if (!publicKey) return null;
  try {
    const url = new URL(rawUrl.trim());
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password ||
        url.search || url.hash || url.pathname !== '/') return null;
    return createClient(url.toString(), publicKey, {
      auth: {
        autoRefreshToken: true,
        detectSessionInUrl: false,
        persistSession: true,
      },
    });
  } catch {
    // AuthGate can explain a configuration error instead of crashing on import.
    return null;
  }
}

export const supabase = createConfiguredSupabaseClient(
  environment.VITE_SUPABASE_URL,
  environment.VITE_SUPABASE_PUBLIC_KEY,
);
export const supabaseConfigReady = supabase !== null;
