import type { RequestHandler } from "express";

declare global {
  namespace Express {
    interface Request {
      authenticatedUserId?: string;
      supabaseAccessToken?: string;
    }
  }
}

type SupabaseAuthUser = {
  id: string;
};

function readSupabaseConfig(): { url: URL; publicKey: string } | null {
  const rawUrl = process.env.VITE_SUPABASE_URL?.trim();
  const publicKey = process.env.VITE_SUPABASE_PUBLIC_KEY?.trim();
  if (!rawUrl || !publicKey) return null;

  try {
    const url = new URL(rawUrl);
    const localDevelopmentHost =
      process.env.NODE_ENV !== "production" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1");
    if (
      (url.protocol !== "https:" && !(localDevelopmentHost && url.protocol === "http:")) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) return null;
    return { url, publicKey };
  } catch {
    return null;
  }
}

async function verifyAccessToken(token: string): Promise<SupabaseAuthUser | null> {
  const config = readSupabaseConfig();
  if (!config) throw new Error("Supabase authentication is not configured.");

  const response = await fetch(new URL("/auth/v1/user", config.url), {
    method: "GET",
    headers: {
      apikey: config.publicKey,
      authorization: `Bearer ${token}`,
      accept: "application/json",
    },
    signal: AbortSignal.timeout(5000),
  });
  if (response.status === 401 || response.status === 403) return null;
  if (!response.ok) throw new Error(`Supabase auth returned HTTP ${response.status}.`);

  const payload: unknown = await response.json().catch(() => null);
  if (
    !payload ||
    typeof payload !== "object" ||
    !("id" in payload) ||
    typeof payload.id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(payload.id)
  ) return null;
  return { id: payload.id };
}

export const requireSupabaseUser: RequestHandler = (req, res, next): void => {
  const authorization = req.header("authorization");
  const token = authorization?.match(/^Bearer ([^\s]+)$/i)?.[1];
  if (!token || token.length > 4096) {
    res.status(401).json({ error: "Iniciá sesión para generar un proyecto." });
    return;
  }

  void verifyAccessToken(token)
    .then((user) => {
      if (!user) {
        res.status(401).json({ error: "La sesión no es válida. Volvé a iniciar sesión." });
        return;
      }
      req.authenticatedUserId = user.id;
      req.supabaseAccessToken = token;
      next();
    })
    .catch((error: unknown) => {
      req.log.error(
        { err: error instanceof Error ? error.message : "Supabase auth unavailable" },
        "Generated-project authentication failed",
      );
      res.status(503).json({ error: "No pude verificar la sesión ahora. Probá de nuevo." });
    });
};