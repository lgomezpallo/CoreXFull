import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import type { User } from "@supabase/supabase-js";
import {
  bootstrapWorkspaceData,
  downloadLocalBackups,
  getLocalBackupCount,
} from "@/lib/cloud-workspaces";
import { supabase, supabaseConfigReady } from "@/lib/supabase";
import "./auth-gate.css";

type AuthContextValue = {
  user: User | null;
  signOut: () => Promise<void>;
  previewMode: boolean;
};

const AuthContext = createContext<AuthContextValue | null>(null);

function isDevelopmentPreviewRequested(): boolean {
  return import.meta.env.DEV
    && typeof window !== "undefined"
    && new URLSearchParams(window.location.search).get("preview") === "1";
}

export function useAuthenticatedUser(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("Esta vista necesita una sesión de propietario.");
  return value;
}

function AuthMessage({
  title,
  detail,
  children,
}: {
  title: string;
  detail: string;
  children?: ReactNode;
}) {
  return (
    <main className="auth-screen">
      <section className="auth-card" aria-labelledby="auth-message-title">
        <p className="auth-eyebrow">CoreX</p>
        <h1 id="auth-message-title">{title}</h1>
        <p className="auth-description">{detail}</p>
        {children}
      </section>
    </main>
  );
}

function LoginForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const client = supabase;
    if (!client) return;
    setBusy(true);
    setError(null);
    try {
      const { error: signInError } = await client.auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      if (!signInError) return;
      setError(
        /invalid login credentials/i.test(signInError.message)
          ? "El correo o la contraseña no son correctos."
          : /email not confirmed/i.test(signInError.message)
            ? "Primero hay que confirmar el correo de esta cuenta."
            : signInError.message,
      );
      setBusy(false);
    } catch {
      setError("No pude conectar con Supabase. Revisá la conexión e intentá de nuevo.");
      setBusy(false);
    }
  };

  return (
    <main className="auth-screen">
      <section className="auth-card" aria-labelledby="auth-title">
        <p className="auth-eyebrow">Acceso privado</p>
        <h1 id="auth-title">CoreX</h1>
        <p className="auth-description">
          Ingresá con la cuenta de propietario. Esta app no permite crear
          cuentas.
        </p>
        <form className="auth-form" onSubmit={handleSubmit}>
          <label htmlFor="owner-email">Correo electrónico</label>
          <input
            id="owner-email"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
          <label htmlFor="owner-password">Contraseña</label>
          <input
            id="owner-password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          {error && (
            <p className="auth-error" role="alert">
              {error}
            </p>
          )}
          <button className="auth-primary-button" type="submit" disabled={busy}>
            {busy ? "Ingresando…" : "Ingresar"}
          </button>
        </form>
        <p className="auth-footnote">
          La cuenta del propietario se administra en Supabase; no hay registro
          público desde la app.
        </p>
      </section>
    </main>
  );
}

function LocalBackupNotice({ ownerId }: { ownerId: string }) {
  const [count, setCount] = useState(() => getLocalBackupCount(ownerId));
  useEffect(() => {
    setCount(getLocalBackupCount(ownerId));
  }, [ownerId]);
  if (count === 0) return null;

  return (
    <aside className="auth-backup-notice" role="status">
      <span>
        Encontré {count === 1 ? "una copia local anterior" : `${count} copias locales anteriores`}.
        Las conservé en este navegador.
      </span>
      <button type="button" onClick={() => downloadLocalBackups(ownerId)}>
        Descargar copia
      </button>
    </aside>
  );
}

export function AuthGate({ children }: { children: ReactNode }) {
  const previewMode = isDevelopmentPreviewRequested();
  const [session, setSession] = useState<{
    user: User;
  } | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [workspaceState, setWorkspaceState] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const [signOutError, setSignOutError] = useState<string | null>(null);

  useEffect(() => {
    if (previewMode) {
      setAuthReady(true);
      return;
    }
    const client = supabase;
    if (!client) {
      setAuthReady(true);
      return;
    }
    let active = true;
    const {
      data: { subscription },
    } = client.auth.onAuthStateChange((_event, nextSession) => {
      if (!active) return;
      setSession(nextSession ? { user: nextSession.user } : null);
      setAuthReady(true);
    });
    void client.auth
      .getSession()
      .then(({ data, error }) => {
        if (!active) return;
        if (error) setWorkspaceError(error.message);
        setSession(data.session ? { user: data.session.user } : null);
        setAuthReady(true);
      })
      .catch(() => {
        if (!active) return;
        setWorkspaceError("No pude consultar la sesión. Revisá la conexión con Supabase.");
        setSession(null);
        setAuthReady(true);
      });
    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, [previewMode]);

  const userId = session?.user.id;
  useEffect(() => {
    if (!userId) {
      setWorkspaceState("idle");
      setWorkspaceError(null);
      return;
    }
    let active = true;
    setWorkspaceState("loading");
    setWorkspaceError(null);
    void bootstrapWorkspaceData(userId)
      .then(() => {
        if (active) setWorkspaceState("ready");
      })
      .catch((error: unknown) => {
        if (!active) return;
        setWorkspaceError(
          error instanceof Error
            ? error.message
            : "No pude cargar tus espacios guardados.",
        );
        setWorkspaceState("error");
      });
    return () => {
      active = false;
    };
  }, [retryCount, userId]);

  const signOut = useCallback(async () => {
    if (!supabase) return;
    setSignOutError(null);
    const { error } = await supabase.auth.signOut();
    if (error) setSignOutError(error.message);
  }, []);

  if (previewMode) {
    return (
      <AuthContext.Provider value={{ user: null, signOut: async () => undefined, previewMode: true }}>
        <aside className="auth-preview-banner" role="status">
          <span><strong>Vista previa de desarrollo.</strong> Sesión omitida; los cambios no se guardan.</span>
          <a href={window.location.pathname}>Volver al acceso</a>
        </aside>
        {children}
      </AuthContext.Provider>
    );
  }

  if (!supabaseConfigReady || !supabase) {
    return (
      <AuthMessage
        title="Falta configurar Supabase"
        detail="Definí VITE_SUPABASE_URL y VITE_SUPABASE_PUBLIC_KEY en el entorno de ejecución para habilitar el acceso."
      />
    );
  }
  if (!authReady) {
    return (
      <AuthMessage
        title="Comprobando acceso"
        detail="Conectando con la cuenta privada…"
      />
    );
  }
  if (!session) return <LoginForm />;
  if (workspaceState === "loading" || workspaceState === "idle") {
    return (
      <AuthMessage
        title="Cargando tus espacios"
        detail="Estoy comprobando los datos guardados y conservando cualquier copia local anterior."
      />
    );
  }
  if (workspaceState === "error") {
    return (
      <AuthMessage title="No pude cargar tus espacios" detail={workspaceError ?? ""}>
        <div className="auth-actions">
          <button
            className="auth-primary-button"
            type="button"
            onClick={() => setRetryCount((value) => value + 1)}
          >
            Reintentar
          </button>
          <button className="auth-secondary-button" type="button" onClick={() => void signOut()}>
            Cerrar sesión
          </button>
        </div>
        {signOutError && <p className="auth-error" role="alert">{signOutError}</p>}
      </AuthMessage>
    );
  }

  return (
    <AuthContext.Provider value={{ user: session.user, signOut, previewMode: false }}>
      <LocalBackupNotice ownerId={session.user.id} />
      {signOutError && <p className="auth-signout-error" role="alert">{signOutError}</p>}
      {children}
    </AuthContext.Provider>
  );
}