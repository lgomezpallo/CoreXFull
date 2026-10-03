import { createClient } from "@supabase/supabase-js";

const environment = import.meta.env ?? {};
const supabaseUrl = environment.VITE_SUPABASE_URL;
const supabasePublicKey = environment.VITE_SUPABASE_PUBLIC_KEY;

export const supabaseConfigReady = Boolean(supabaseUrl && supabasePublicKey);

export const supabase = supabaseConfigReady
  ? createClient(supabaseUrl, supabasePublicKey, {
      auth: {
        autoRefreshToken: true,
        detectSessionInUrl: false,
        persistSession: true,
      },
    })
  : null;