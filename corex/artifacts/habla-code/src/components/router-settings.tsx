import { useState } from "react";
import { AlertCircle, CheckCircle2, CircleHelp, LoaderCircle, LogOut, RefreshCw, X } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuthenticatedUser } from "@/components/auth-gate";
import {
  getGetRouterStatusQueryKey,
  useGetRouterStatus,
  useTestRouterConnection,
} from "@workspace/api-client-react";

function apiError(error: unknown): string {
  if (typeof error === "object" && error && "data" in error) {
    const data = (error as { data?: { error?: string } }).data;
    if (data?.error) return data.error;
  }
  return "No se pudo completar la operación. Intentá de nuevo.";
}

export function RouterSettings({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { user, signOut, previewMode } = useAuthenticatedUser();
  const queryClient = useQueryClient();
  const status = useGetRouterStatus({
    query: { enabled: open, queryKey: getGetRouterStatusQueryKey() },
  });
  const test = useTestRouterConnection();
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  if (!open) return null;

  const handleSignOut = async () => {
    setSigningOut(true);
    setError(null);
    try {
      await signOut();
    } catch {
      setError("No pude cerrar la sesión.");
      setSigningOut(false);
    }
  };

  const checkRouter = () => {
    setNotice(null);
    setError(null);
    test.mutate(
      { data: { task_type: "chat" } },
      {
        onSuccess: async (result) => {
          setNotice(result.message ?? "Router IA está disponible.");
          await queryClient.invalidateQueries({ queryKey: getGetRouterStatusQueryKey() });
        },
      },
    );
  };

  return (
    <div
      className="builder-provider-settings-overlay"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <section
        className="builder-provider-settings"
        role="dialog"
        aria-modal="true"
        aria-labelledby="router-settings-title"
      >
        <header className="builder-provider-settings-header">
          <div>
            <span className="builder-provider-settings-eyebrow">AJUSTES DEL GENERADOR</span>
            <h2 id="router-settings-title">Conexión con Router IA</h2>
          </div>
          <button type="button" onClick={onClose} aria-label="Cerrar configuración">
            <X size={18} />
          </button>
        </header>

        <div className="builder-provider-settings-content">
          <div className="builder-provider-card">
            <div className="builder-provider-card-heading">
              <div>
                <h4>Cuenta</h4>
                <p>{previewMode ? "Vista previa de desarrollo" : "Cuenta de propietario"}</p>
              </div>
            </div>
            {!previewMode && (
              <>
                <p className="builder-provider-settings-note">{user?.email ?? "Cuenta de propietario"}</p>
                <button
                  type="button"
                  className="builder-provider-test-button"
                  onClick={() => void handleSignOut()}
                  disabled={signingOut}
                >
                  <LogOut size={14} /> {signingOut ? "Saliendo…" : "Cerrar sesión"}
                </button>
              </>
            )}
          </div>

          {error && (
            <p className="builder-provider-settings-error" role="alert">
              <AlertCircle size={15} /> {error}
            </p>
          )}

          <div className="builder-provider-list-heading">
            <div>
              <h3>Providers administrados fuera de CoreX</h3>
              <p>CoreX envía las solicitudes de generación al Router IA configurado para el servidor.</p>
            </div>
            <button
              type="button"
              className="builder-provider-refresh"
              onClick={() => void status.refetch()}
              disabled={status.isFetching}
              aria-label="Actualizar estado de Router IA"
            >
              {status.isFetching
                ? <LoaderCircle size={15} className="builder-spin" />
                : <RefreshCw size={15} />}
            </button>
          </div>

          {status.isLoading && (
            <p className="builder-provider-settings-note" role="status">
              <LoaderCircle size={15} className="builder-spin" /> Consultando el estado…
            </p>
          )}
          {status.isError && (
            <p className="builder-provider-settings-error" role="alert">
              <AlertCircle size={15} /> {apiError(status.error)}
            </p>
          )}

          {!status.isLoading && !status.isError && status.data && (
            <article className="builder-provider-card">
              <div className="builder-provider-card-heading">
                <div>
                  <h4>Router IA</h4>
                  <p>
                    {status.data.connected
                      ? "Token validado"
                      : "Disponibilidad aún no verificada"}
                  </p>
                </div>
                <span className={`builder-provider-status ${status.data.connected ? "" : "is-suspended"}`}>
                  {status.data.connected ? "Token validado" : "Sin verificar"}
                </span>
              </div>
              {status.data.message && (
                <p className="builder-provider-settings-note" role="status">{status.data.message}</p>
              )}
              {status.data.lastTestAt && (
                <p className="builder-provider-settings-note">
                  Última verificación: {new Date(status.data.lastTestAt).toLocaleString("es-AR")}
                  {status.data.lastLatencyMs != null ? ` · ${status.data.lastLatencyMs} ms` : ""}
                </p>
              )}
            </article>
          )}

          {test.isError && (
            <p className="builder-provider-settings-error" role="alert">
              <AlertCircle size={15} /> {apiError(test.error)}
            </p>
          )}
          {notice && (
            <p className="builder-provider-test-result is-passed" role="status">
              <CheckCircle2 size={14} /> {notice}
            </p>
          )}

          <button
            type="button"
            className="builder-provider-test-all"
            onClick={checkRouter}
            disabled={test.isPending}
          >
            {test.isPending
              ? <><LoaderCircle size={15} className="builder-spin" /> Verificando…</>
              : <><CheckCircle2 size={15} /> Verificar disponibilidad</>}
          </button>

          <p className="builder-provider-settings-note">
            <CircleHelp size={14} />
            La verificación autentica el token del servidor en /api/v1/auth/check; no envía prompts ni confirma que haya un proveedor configurado.
            Configurá ROUTER_IA_URL y ROUTER_IA_TOKEN solo en el servidor. Administrá los proveedores desde Router IA;
            CoreX no guarda sus claves.
          </p>
        </div>
      </section>
    </div>
  );
}