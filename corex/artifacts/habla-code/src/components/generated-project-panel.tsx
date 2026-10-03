import {
  AlertCircle,
  Check,
  Circle,
  CircleAlert,
  Code2,
  Download,
  FileCode2,
  FileText,
  LoaderCircle,
  RotateCcw,
} from "lucide-react";
import type {
  BuilderProjectFilePlan,
  BuilderProjectFileProgress,
} from "@workspace/api-client-react";
import "./generated-project-panel.css";

type GeneratedProjectStage =
  | "planning"
  | "blueprint"
  | "generation"
  | "build"
  | "validation"
  | "correction"
  | "ready"
  | "error";

type GeneratedProjectFile = {
  path: string;
  content: string;
};

type GeneratedProjectPanelProps = {
  stage: GeneratedProjectStage;
  statusMessage: string;
  files: GeneratedProjectFile[];
  plannedFiles: BuilderProjectFilePlan[];
  generatedFiles: string[];
  fileProgress: BuilderProjectFileProgress[];
  correctedFiles: string[];
  codingFallbackUsed: boolean;
  codingEscalationFiles: string[];
  diagnostics: string[];
  previewHtml: string | null;
  projectId: string;
  jobId: string;
  attempt: number;
  onDownload: () => void;
  onRetry: () => void;
  busy: boolean;
};

const stages: Array<{ id: GeneratedProjectStage; label: string; detail: string }> = [
  { id: "planning", label: "Planificación", detail: "Ordenando la idea" },
  { id: "blueprint", label: "Blueprint", detail: "Definiendo la estructura" },
  { id: "generation", label: "Generación", detail: "Escribiendo los archivos" },
  { id: "build", label: "Compilación", detail: "Preparando el proyecto" },
  { id: "validation", label: "Validación", detail: "Revisando el resultado" },
  { id: "correction", label: "Corrección", detail: "Aplicando ajustes" },
  { id: "ready", label: "Lista", detail: "Proyecto disponible" },
  { id: "error", label: "Error", detail: "Necesita atención" },
];

function fileName(path: string): string {
  return path.split("/").pop() || path;
}

function fileLineCount(content: string): number {
  return content ? content.split(/\r?\n/).length : 0;
}

function stageState(
  item: (typeof stages)[number],
  currentIndex: number,
  currentStage: GeneratedProjectStage,
): "complete" | "current" | "pending" | "error" {
  const itemIndex = stages.findIndex((stage) => stage.id === item.id);
  if (currentStage === "error" && item.id === "error") return "error";
  if (currentStage === "ready" && item.id !== "error") {
    return itemIndex <= currentIndex ? "complete" : "pending";
  }
  if (item.id === currentStage) return "current";
  if (item.id !== "error" && itemIndex < currentIndex) return "complete";
  return "pending";
}

function StageIcon({ state }: { state: ReturnType<typeof stageState> }) {
  if (state === "complete") return <Check size={14} strokeWidth={2.5} aria-hidden="true" />;
  if (state === "current") return <LoaderCircle size={14} className="generated-project-panel__spin" aria-hidden="true" />;
  if (state === "error") return <CircleAlert size={14} aria-hidden="true" />;
  return <Circle size={11} aria-hidden="true" />;
}

export function GeneratedProjectPanel({
  stage,
  statusMessage,
  files,
  plannedFiles,
  generatedFiles,
  fileProgress,
  correctedFiles,
  codingFallbackUsed,
  codingEscalationFiles,
  diagnostics,
  previewHtml,
  projectId,
  jobId,
  attempt,
  onDownload,
  onRetry,
  busy,
}: GeneratedProjectPanelProps) {
  const currentIndex = stages.findIndex((item) => item.id === stage);
  const hasError = stage === "error";
  const isReady = stage === "ready";
  const announcement = statusMessage || (hasError ? "La generación necesita atención." : "Preparando tu proyecto.");

  return (
    <section
      className={`generated-project-panel ${hasError ? "is-error" : ""} ${isReady ? "is-ready" : ""}`}
      aria-label="Progreso del proyecto generado"
      aria-busy={busy}
      data-testid="generated-project-panel"
    >
      <header className="generated-project-panel__header">
        <div>
          <span className="generated-project-panel__eyebrow">
            <span aria-hidden="true" />
            WORKFLOW COREX
          </span>
          <h2>Tu proyecto está tomando forma</h2>
          <p>Seguimos cada paso para que puedas revisar qué se generó y cómo quedó.</p>
        </div>
        {previewHtml && !hasError && (
          <span className="generated-project-panel__sandbox">
            <span aria-hidden="true" />
            Sandbox enlazado
          </span>
        )}
      </header>

      <div
        className="generated-project-panel__announcement"
        role={hasError ? "alert" : "status"}
        aria-live={hasError ? "assertive" : "polite"}
      >
        <span className="generated-project-panel__announcement-icon" aria-hidden="true">
          {hasError ? <AlertCircle size={15} /> : isReady ? <Check size={15} /> : <Code2 size={15} />}
        </span>
        <span>{announcement}</span>
      </div>

      <ol className="generated-project-panel__stages" aria-label="Etapas de generación">
        {stages.map((item, index) => {
          const state = stageState(item, currentIndex, stage);
          const isCurrent = item.id === stage;
          const stateLabel =
            state === "complete"
              ? "completada"
              : state === "current"
                ? "en curso"
                : state === "error"
                  ? "con error"
                  : "pendiente";

          return (
            <li
              className={`generated-project-panel__stage is-${state}`}
              key={item.id}
              aria-current={isCurrent ? "step" : undefined}
              aria-label={`${item.label}: ${stateLabel}`}
              data-testid={`generated-project-stage-${item.id}`}
            >
              <span className="generated-project-panel__stage-marker">
                <StageIcon state={state} />
              </span>
              <span className="generated-project-panel__stage-copy">
                <strong>{item.label}</strong>
                <small>{state === "current" ? announcement : item.detail}</small>
              </span>
              {index < stages.length - 1 && (
                <span className="generated-project-panel__stage-connector" aria-hidden="true" />
              )}
            </li>
          );
        })}
      </ol>

      <section className="generated-project-panel__tasks" aria-label="Plan de archivos y tareas">
        <div className="generated-project-panel__tasks-heading">
          <div>
            <span className="generated-project-panel__section-label">GENERACIÓN DISTRIBUIDA</span>
            <h3>Plan y tareas por archivo</h3>
          </div>
          <span className="generated-project-panel__count" aria-label={`${plannedFiles.length} archivos planificados`}>
            {plannedFiles.length}
          </span>
        </div>
        <div className="generated-project-panel__task-summary">
          <span>{plannedFiles.length} planificados</span>
          <span>{generatedFiles.length} generados</span>
          <span>{correctedFiles.length} corregidos</span>
        </div>
        <p className={`generated-project-panel__coding-status ${codingFallbackUsed ? "is-escalated" : ""}`}>
          {codingFallbackUsed
            ? `Escaló a coding para: ${codingEscalationFiles.join(", ") || "una tarea de archivo"}.`
            : "Hasta ahora no fue necesario escalar a coding."}
        </p>
        {plannedFiles.length > 0 ? (
          <ul className="generated-project-panel__task-list">
            {plannedFiles.map((plan) => {
              const progress = fileProgress.find((item) => item.path === plan.path);
              const generated = generatedFiles.includes(plan.path);
              const corrected = correctedFiles.includes(plan.path);
              const generationTypes = progress?.generationTaskTypes ?? [];
              const correctionTypes = progress?.correctionTaskTypes ?? [];
              const resolvedCorrectionTypes = progress?.resolvedCorrectionTaskTypes ?? [];
              const fileStatus = progress?.status ?? "planned";
              return (
                <li className="generated-project-panel__task" key={plan.path}>
                  <div className="generated-project-panel__task-top">
                    <strong title={plan.path}>{plan.path}</strong>
                    <span className={`generated-project-panel__task-state is-${fileStatus}`}>
                      {corrected ? "Corregido" : generated ? "Generado" : fileStatus === "generating" ? "En curso" : fileStatus === "error" ? "Error" : fileStatus === "correcting" ? "Corrigiendo" : "Planificado"}
                    </span>
                  </div>
                  <p>{plan.purpose}</p>
                  <div className="generated-project-panel__task-types">
                    <span>Generación: {generationTypes.length ? generationTypes.join(" → ") : "pendiente"}</span>
                    <span>Resuelto: {progress?.resolvedGenerationTaskType ?? "pendiente"}</span>
                    {correctionTypes.length > 0 && (
                      <span>Corrección: {correctionTypes.join(" → ")}</span>
                    )}
                    {resolvedCorrectionTypes.length > 0 && (
                      <span>Corrección resuelta: {resolvedCorrectionTypes.join(" → ")}</span>
                    )}
                  </div>
                  <details className="generated-project-panel__task-contract">
                    <summary>Ver contrato del archivo</summary>
                    <dl>
                      <dt>Imports permitidos</dt>
                      <dd>{plan.allowedImports.join(", ") || "Ninguno declarado"}</dd>
                      <dt>Exports</dt>
                      <dd>{plan.exports.join(", ") || "Ninguno declarado"}</dd>
                      <dt>Props e interfaces</dt>
                      <dd>{plan.propsInterfaces.join("; ") || "Ninguna declarada"}</dd>
                      <dt>Dependencias internas</dt>
                      <dd>{plan.internalDependencies.join(", ") || "Ninguna"}</dd>
                      <dt>Criterios de aceptación</dt>
                      <dd>{plan.acceptanceCriteria.join("; ") || "Sin criterios declarados"}</dd>
                    </dl>
                  </details>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="generated-project-panel__tasks-empty">
            {stage === "planning"
              ? "El plan aparecerá cuando termine el análisis del pedido."
              : "Este trabajo no generó archivos nuevos; se mantienen los archivos guardados."}
          </p>
        )}
      </section>

      {isReady && previewHtml && (
        <section className="generated-project-panel__preview" aria-label="Vista previa funcional">
          <div className="generated-project-panel__preview-heading">
            <span className="generated-project-panel__section-label">APP EN FUNCIONAMIENTO</span>
            <strong>Probá la acción principal antes de descargar</strong>
          </div>
          <iframe
            key={`${jobId}-${attempt}-ready`}
            className="generated-project-panel__preview-frame"
            title={`Vista previa de ${projectId}`}
            srcDoc={previewHtml}
            sandbox="allow-scripts"
            data-generated-project-frame="true"
            data-generated-project-id={projectId}
            data-generated-project-job={jobId}
            data-generated-project-attempt={attempt}
            data-testid="generated-project-preview-frame"
          />
        </section>
      )}

      <div className="generated-project-panel__details">
        <section className="generated-project-panel__card" aria-labelledby="generated-project-files-title">
          <div className="generated-project-panel__card-heading">
            <div>
              <span className="generated-project-panel__section-label">ARCHIVOS</span>
              <h3 id="generated-project-files-title">Lo que se generó</h3>
            </div>
            <span className="generated-project-panel__count" aria-label={`${files.length} archivos`}>
              {files.length}
            </span>
          </div>

          {files.length > 0 ? (
            <ul className="generated-project-panel__file-list">
              {files.map((file) => (
                <li className="generated-project-panel__file" key={file.path} title={file.path}>
                  <span className="generated-project-panel__file-icon" aria-hidden="true">
                    {file.path.match(/\.(tsx?|jsx?|css|html?)$/i) ? <FileCode2 size={14} /> : <FileText size={14} />}
                  </span>
                  <span className="generated-project-panel__file-copy">
                    <strong>{fileName(file.path)}</strong>
                    <small>{file.path.includes("/") ? file.path : "raíz del proyecto"}</small>
                  </span>
                  <span className="generated-project-panel__file-lines">
                    {fileLineCount(file.content)} líneas
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="generated-project-panel__empty">
              <FileText size={16} aria-hidden="true" />
              <span>Los archivos aparecerán cuando empiece la generación.</span>
            </div>
          )}
        </section>

        <section
          className={`generated-project-panel__card generated-project-panel__diagnostics ${diagnostics.length ? "has-items" : ""}`}
          aria-labelledby="generated-project-diagnostics-title"
        >
          <div className="generated-project-panel__card-heading">
            <div>
              <span className="generated-project-panel__section-label">CONTROL DE CALIDAD</span>
              <h3 id="generated-project-diagnostics-title">Diagnósticos</h3>
            </div>
            <span className="generated-project-panel__count" aria-label={`${diagnostics.length} diagnósticos`}>
              {diagnostics.length}
            </span>
          </div>
          {diagnostics.length > 0 ? (
            <ul className="generated-project-panel__diagnostic-list">
              {diagnostics.map((diagnostic, index) => (
                <li key={`${diagnostic}-${index}`}>
                  <CircleAlert size={14} aria-hidden="true" />
                  <span>{diagnostic}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="generated-project-panel__diagnostics-empty">
              {isReady ? "No encontramos observaciones pendientes." : "Las comprobaciones aparecerán durante la validación."}
            </p>
          )}
        </section>
      </div>

      {(isReady || hasError) && (
        <footer className="generated-project-panel__actions">
          {isReady && (
            <button
              type="button"
              className="generated-project-panel__download"
              onClick={onDownload}
              disabled={busy}
              data-testid="generated-project-download"
            >
              <Download size={15} aria-hidden="true" />
              {busy ? "Preparando descarga…" : "Descargar proyecto"}
            </button>
          )}
          {hasError && (
            <button
              type="button"
              className="generated-project-panel__retry"
              onClick={onRetry}
              disabled={busy}
              data-testid="generated-project-retry"
            >
              <RotateCcw size={15} aria-hidden="true" />
              {busy ? "Reintentando…" : "Reintentar generación"}
            </button>
          )}
        </footer>
      )}
    </section>
  );
}