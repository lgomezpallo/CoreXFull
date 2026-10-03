import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import {
  AlertCircle,
  ArrowRight,
  Beaker,
  Check,
  CircleHelp,
  Code2,
  Download,
  FileText,
  Globe,
  LoaderCircle,
  Mic,
  MicOff,
  Paperclip,
  Plus,
  ShieldCheck,
  Settings2,
  Send,
  Sparkles,
  Trash2,
  Upload,
} from "lucide-react";
import {
  activateBuilderModule,
  analyzeLabProject,
  createBuilderProjectBuild,
  createBuilderProjectJob,
  extractWebReference,
  getBuilderProjectJob,
  getBuilderProjectJobStatus,
  converseAboutApp,
  generateDiscussedBlueprint,
  reportBuilderProjectRuntimeCheck,
  setAuthTokenGetter,
  type AppBlueprint,
  type AppBuilderExpansionProposal,
  type AppBuilderModuleId,
  type AppBuilderTurn,
  type BuilderProjectJob,
  type LabAnalysisInputSourceKind,
} from "@workspace/api-client-react";
import { RouterSettings } from "@/components/router-settings";
import { useAuthenticatedUser } from "@/components/auth-gate";
import { GeneratedProjectPanel } from "@/components/generated-project-panel";
import { LaboratoryWorkspace } from "@/components/laboratory-workspace";
import { useSpeechRecognition } from "@/hooks/use-speech-recognition";
import {
  BUILDER_PROJECTS_STORAGE_KEY,
  createBuilderProject,
  createDefaultBuilderCollection,
  loadBuilderProjectCollection,
  MAX_BUILDER_SOURCES,
  MAX_BUILDER_PROJECTS,
  sanitizeGeneratedProjectData,
  serializeBuilderProjectCollection,
  type BuilderSource,
  type BuilderProject,
  type BuilderProjectCollection,
  type GeneratedProjectRecovery,
  type LabProjectAnalysis,
  type LabProjectVersion,
} from "@/lib/builder-workspace";
import { buildStandaloneAppHtml, downloadStandaloneApp } from "@/lib/export-blueprint";
import { downloadGeneratedProjectZip } from "@/lib/export-generated-project";
import { saveWorkspaceSnapshot } from "@/lib/cloud-workspaces";
import { supabase } from "@/lib/supabase";
import {
  buildLabEvidenceText,
  collectLabEvidence,
} from "@/lib/lab-static-analysis";
import {
  MAX_REFERENCE_FILES,
  prepareReferenceFile,
  REFERENCE_FILE_ACCEPT,
} from "@/lib/reference-files";

const MAX_PROMPT_LENGTH = 1600;
const MAX_SAVED_TURNS = 60;
type BuilderStage = "sources" | "design" | "assembly";

const routerTaskTypeLabels = {
  chat: "Chat",
  coding: "Código",
  reasoning: "Razonamiento",
  summarization: "Resumen",
  vision: "Visión",
  document: "Documento",
  long_context: "Contexto largo",
  fast: "Rápido",
} as const;

const examplePrompts = [
  "Una app para organizar mis gastos del mes",
  "Un menú digital para mi cafetería",
  "Un planificador de hábitos que me motive",
];

function projectTitle(project: BuilderProject): string {
  return project.blueprint?.title || project.name || "Mi app";
}

function buildLabReconstructionPrompt(project: BuilderProject, request: string): string {
  return [
    project.labGoal.trim() ? `Objetivo de adaptación: ${project.labGoal.trim()}` : "",
    `Cambio solicitado: ${request.trim()}`,
  ].filter(Boolean).join("\n").slice(0, MAX_PROMPT_LENGTH);
}

function buildLabAnalysisContext(project: BuilderProject): AppBuilderTurn | null {
  const analysis = project.labAnalysis;
  if (!analysis) return null;
  return {
    role: "assistant",
    content: [
      `Análisis de referencia de ${analysis.sourceName}. Las observaciones son evidencia estática; las inferencias son hipótesis, no hechos verificados.`,
      `Resumen: ${analysis.summary}`,
      `Arquitectura observada: ${analysis.architecture}`,
      `Capacidades: ${analysis.capabilities.join("; ")}`,
      `Inferencias: ${analysis.inferred.join("; ")}`,
      `Plan de adaptación: ${analysis.adaptationPlan.join("; ")}`,
    ].join("\n").slice(0, MAX_PROMPT_LENGTH),
  };
}

function appendTurn(project: BuilderProject, turn: AppBuilderTurn): BuilderProject {
  return {
    ...project,
    messages: [...project.messages, turn].slice(-MAX_SAVED_TURNS),
  };
}

function updateProject(
  collection: BuilderProjectCollection,
  projectId: string,
  update: (project: BuilderProject) => BuilderProject,
): BuilderProjectCollection {
  return {
    ...collection,
    projects: collection.projects.map((project) =>
      project.id === projectId ? update(project) : project,
    ),
  };
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getApiErrorMessage(error: unknown): string | null {
  if (!isRecord(error) || !isRecord(error.data) || typeof error.data.error !== "string") return null;
  return error.data.error.slice(0, 300);
}

function isMissingGeneratedProjectJob(error: unknown): boolean {
  return isRecord(error) && error.status === 404;
}

function isTransientGeneratedProjectJobError(error: unknown): boolean {
  if (!isRecord(error) || typeof error.status !== "number") return true;
  return error.status === 429 || error.status >= 500;
}

function isTerminalProjectJob(job: BuilderProjectJob): boolean {
  return job.stage === "ready" || job.stage === "error";
}

function ConversationMessage({ turn, index }: { turn: AppBuilderTurn; index: number }) {
  const isUser = turn.role === "user";
  return (
    <article
      className={`builder-message ${isUser ? "is-user" : "is-assistant"}`}
      data-testid={`message-${turn.role}-${index}`}
    >
      {!isUser && (
        <span className="builder-message-avatar" aria-hidden="true">
          <Sparkles size={14} />
        </span>
      )}
      <div className="builder-message-content">
        <span className="builder-message-label">{isUser ? "Vos" : "Tu agente"}</span>
        <p data-testid={`message-content-${index}`}>{turn.content}</p>
      </div>
    </article>
  );
}

function ExpansionProposalCard({
  proposal,
  decision,
  approvedModuleId,
  busy,
  onActivate,
  onKeepPrototype,
}: {
  proposal: AppBuilderExpansionProposal | null;
  decision: BuilderProject["expansionDecision"];
  approvedModuleId: AppBuilderModuleId | null;
  busy: boolean;
  onActivate: (moduleId: AppBuilderModuleId) => void;
  onKeepPrototype: () => void;
}) {
  if (!proposal || proposal.status === "not-needed") return null;

  const activeOption = proposal.options.find((option) => option.moduleId === approvedModuleId);
  const isApproved = decision === "approved" && Boolean(activeOption);
  const isDeclined = decision === "declined";
  const isPending = proposal.status === "approval-required" && decision === "pending";
  const isUnavailable = proposal.status === "unavailable" || decision === "unavailable";
  const showUnavailableAction = isUnavailable && !isDeclined;

  return (
    <section
      className={`builder-expansion-card ${isApproved ? "is-approved" : isUnavailable ? "is-unavailable" : ""}`}
      aria-label="Propuesta de expansión"
      data-testid="builder-expansion-proposal"
      aria-live="polite"
    >
      <div className="builder-expansion-heading">
        <span className="builder-expansion-icon">
          {isApproved ? <Check size={15} /> : isUnavailable ? <CircleHelp size={15} /> : <ShieldCheck size={15} />}
        </span>
        <div>
          <strong>
            {isApproved
              ? `Módulo activado: ${activeOption?.name}`
              : isUnavailable
                ? "No hay un módulo validado para esta idea"
                : isDeclined
                  ? "Se mantiene como prototipo"
                  : "Encontré una opción validada"}
          </strong>
          <p>{isDeclined ? "No activé ningún módulo; podés seguir revisando la propuesta más adelante." : proposal.message}</p>
        </div>
      </div>

      {isApproved && activeOption && (
        <div className="builder-expansion-active">
          <p>{activeOption.summary}</p>
          <span>Implementación local; sin servicios externos ni costo de ejecución del módulo.</span>
        </div>
      )}

      {isPending && (
        <>
          <div className="builder-expansion-options">
            {proposal.options.map((option) => (
              <article className="builder-expansion-option" key={option.moduleId}>
                <div className="builder-expansion-option-heading">
                  <h4>{option.name}</h4>
                  {option.recommended && <span>RECOMENDADO</span>}
                </div>
                <p>{option.reason}</p>
                <strong>{option.summary}</strong>
                <ul>
                  {option.capabilities.map((capability) => <li key={capability}>{capability}</li>)}
                </ul>
                <p className="builder-expansion-limitations">
                  {option.limitations.join(" ")}
                </p>
                <p className="builder-expansion-cost">
                  Ejecución local: $0. No activa servicios externos.
                </p>
                <button
                  type="button"
                  className="builder-expansion-approve"
                  onClick={() => onActivate(option.moduleId)}
                  disabled={busy}
                  data-testid={`button-approve-module-${option.moduleId}`}
                >
                  <ShieldCheck size={14} />
                  {busy ? "Activando…" : "Aprobar y activar"}
                </button>
              </article>
            ))}
          </div>
          <button
            type="button"
            className="builder-expansion-decline"
            onClick={onKeepPrototype}
            disabled={busy}
          >
            Mantener como prototipo
          </button>
        </>
      )}

      {showUnavailableAction && (
        <button
          type="button"
          className="builder-expansion-decline"
          onClick={onKeepPrototype}
          disabled={busy}
        >
          Seguir con el prototipo
        </button>
      )}
    </section>
  );
}

function EmptyPreview() {
  return (
    <div className="builder-preview-empty">
      <div className="builder-preview-orbit builder-orbit-one" />
      <div className="builder-preview-orbit builder-orbit-two" />
      <div className="builder-preview-empty-card">
        <div className="builder-empty-card-top"><span /><span /><span /></div>
        <div className="builder-empty-card-content">
          <div className="builder-empty-card-mark"><Sparkles size={19} /></div>
          <span className="builder-empty-line wide" />
          <span className="builder-empty-line medium" />
          <div className="builder-empty-card-row">
            <span /><span /><span />
          </div>
        </div>
      </div>
      <h3>Tu idea va a tomar forma acá</h3>
      <p>Contame qué querés crear y preparo una primera versión para que la revisemos juntos.</p>
    </div>
  );
}

function PreviewPanel({ blueprint, appNamespace }: { blueprint: AppBlueprint | null; appNamespace: string }) {
  const document = useMemo(
    () => blueprint ? buildStandaloneAppHtml(blueprint, appNamespace) : "",
    [blueprint, appNamespace],
  );

  return (
    <section className="builder-preview-panel" aria-label="Vista previa de la app">
      <header className="builder-preview-header">
        <div className="builder-preview-heading">
          <span className="builder-preview-kicker"><span /> VISTA PREVIA</span>
          <h2>{blueprint?.title ?? "Tu primera versión"}</h2>
        </div>
        {blueprint ? (
          <span className="builder-preview-empty-badge">
            {blueprint.appKind === "prototype" ? "Prototipo visual" : "App funcional"}
          </span>
        ) : (
          <span className="builder-preview-empty-badge">A la espera de tu idea</span>
        )}
        {blueprint && (
          <button
            type="button"
            className="builder-download-button"
            onClick={() => downloadStandaloneApp(blueprint, appNamespace)}
            data-testid="button-download-app"
          >
            <Download size={15} />
            <span>Descargar app</span>
          </button>
        )}
      </header>
      <div className={`builder-preview-stage ${blueprint ? "has-preview" : ""}`}>
        {blueprint ? (
          <iframe
            key={`${blueprint.title}-${blueprint.sections.length}`}
            className="builder-preview-iframe"
            title={`Vista previa de ${blueprint.title}`}
            srcDoc={document}
            sandbox="allow-scripts"
            data-testid="iframe-app-preview"
          />
        ) : (
          <EmptyPreview />
        )}
      </div>
    </section>
  );
}

type SourcesPanelProps = {
  project: BuilderProject;
  reusableSources: Array<{ source: BuilderSource; projectName: string }>;
  busy: boolean;
  url: string;
  error: string | null;
  onUrlChange: (value: string) => void;
  onAddFiles: (files: FileList | null) => void;
  onAddUrl: (event: FormEvent<HTMLFormElement>) => void;
  onRemove: (sourceId: string) => void;
  onToggle: (sourceId: string, included: boolean) => void;
  onModeChange: (source: BuilderSource, useMode: BuilderSource["useMode"]) => void;
  onReuse: (source: BuilderSource) => void;
  onContinue: () => void;
};

function SourcesPanel({
  project,
  reusableSources,
  busy,
  url,
  error,
  onUrlChange,
  onAddFiles,
  onAddUrl,
  onRemove,
  onToggle,
  onModeChange,
  onReuse,
  onContinue,
}: SourcesPanelProps) {
  return (
    <section className="builder-source-page" aria-label="Fuentes del proyecto">
      <header className="builder-stage-heading">
        <span className="builder-conversation-kicker"><span /> ETAPA 1 · FUENTES</span>
        <h1>¿Qué querés tomar como punto de partida?</h1>
        <p>Sumá archivos o una página pública. Podés crear desde cero, inspirarte en una referencia o usar código propio autorizado como contexto.</p>
      </header>

      <div className="builder-source-input-grid">
        <article className="builder-source-input-card">
          <div className="builder-source-card-icon"><Upload size={18} /></div>
          <h2>Subir archivos</h2>
          <p>APK hasta 70 MB, ZIP hasta 15 MB, código, PDF, documentos, planillas o capturas hasta 25 MB. Se admiten hasta {MAX_REFERENCE_FILES} fuentes por app.</p>
          <label className="builder-source-action">
            <input
              type="file"
              accept={REFERENCE_FILE_ACCEPT}
              multiple
              disabled={busy || project.sources.length >= MAX_BUILDER_SOURCES}
              onChange={(event) => {
                onAddFiles(event.currentTarget.files);
                event.currentTarget.value = "";
              }}
              data-testid="input-project-sources"
            />
            {busy ? <LoaderCircle size={15} className="builder-spin" /> : <Upload size={15} />}
            <span>{busy ? "Analizando…" : "Elegir archivos"}</span>
          </label>
        </article>

        <article className="builder-source-input-card">
          <div className="builder-source-card-icon is-web"><Globe size={18} /></div>
          <h2>Leer una página web</h2>
          <p>Extraigo el texto visible de una URL pública. Las páginas que dependen de una sesión o de JavaScript pueden requerir una captura.</p>
          <form className="builder-source-url-form" onSubmit={onAddUrl}>
            <input
              type="url"
              value={url}
              onChange={(event) => onUrlChange(event.target.value)}
              placeholder="https://ejemplo.com/pagina"
              aria-label="Dirección de la página web"
              disabled={busy || project.sources.length >= MAX_BUILDER_SOURCES}
              data-testid="input-source-url"
            />
            <button
              type="submit"
              disabled={!url.trim() || busy || project.sources.length >= MAX_BUILDER_SOURCES}
              aria-label="Agregar página web"
              data-testid="button-add-source-url"
            >
              {busy ? <LoaderCircle size={15} className="builder-spin" /> : <ArrowRight size={15} />}
            </button>
          </form>
        </article>
      </div>

      <div className="builder-source-safety-note">
        <ShieldCheck size={17} />
        <p><strong>Auditoría local:</strong> el APK se analiza en este navegador; el archivo original no se sube ni se ejecuta. Solo se comparte el texto extraído y, como máximo, una imagen de referencia. Las fuentes se tratan como contexto, no como instrucciones.</p>
      </div>

      {error && <p className="builder-inline-message is-error" role="alert"><AlertCircle size={14} />{error}</p>}

      <div className="builder-source-list-heading">
        <div>
          <span className="builder-examples-label">BIBLIOTECA DE ESTE PROYECTO</span>
          <h2>Fuentes agregadas <span>{project.sources.length}/{MAX_BUILDER_SOURCES}</span></h2>
        </div>
        {project.sources.length > 0 && <span className="builder-source-list-hint">Elegí qué fuentes incluir en el próximo diseño</span>}
      </div>

      {project.sources.length ? (
        <div className="builder-source-list">
          {project.sources.map((source) => {
            const canUseAsBase = source.payload.kind === "code" || source.payload.kind === "archive";
            return (
              <article className={`builder-source-entry ${source.included ? "is-included" : ""}`} key={source.id}>
                <div className="builder-source-entry-icon">
                  {source.payload.kind === "document" ? <Globe size={16} /> : <FileText size={16} />}
                </div>
                <div className="builder-source-entry-main">
                  <div className="builder-source-entry-title-row">
                    <strong title={source.name}>{source.name}</strong>
                    <span className={`builder-source-kind kind-${source.payload.kind}`}>{source.payload.kind === "apk" ? "APK · estático" : source.payload.kind}</span>
                  </div>
                  <p>{source.detail}</p>
                  {source.hasVisual && !source.payload.imageDataUrl && (
                    <small className="builder-source-notice">La parte visual no se guarda; volvé a adjuntar el archivo para incluirla.</small>
                  )}
                  {source.wasTextTrimmed && (
                    <small className="builder-source-notice">Se guardó un fragmento del texto. Volvé a adjuntar el archivo para analizarlo completo.</small>
                  )}
                  {source.useMode === "authorized-base" && (
                    <small className="builder-source-notice">Se usa el texto extraído como contexto; esta vista previa todavía no importa ni modifica archivos fuente.</small>
                  )}
                </div>
                <div className="builder-source-entry-controls">
                  <label className="builder-source-include">
                    <input
                      type="checkbox"
                      checked={source.included}
                      onChange={(event) => onToggle(source.id, event.target.checked)}
                      aria-label={`Incluir ${source.name} en el diseño`}
                    />
                    <span>Incluir</span>
                  </label>
                  {canUseAsBase ? (
                    <select
                      value={source.useMode}
                      onChange={(event) => onModeChange(source, event.target.value as BuilderSource["useMode"])}
                      aria-label={`Modo de uso de ${source.name}`}
                    >
                      <option value="reference">Referencia</option>
                      <option value="authorized-base">Base propia autorizada</option>
                    </select>
                  ) : (
                    <span className="builder-source-mode-label">Referencia</span>
                  )}
                  <button
                    type="button"
                    className="builder-source-remove"
                    onClick={() => onRemove(source.id)}
                    aria-label={`Quitar ${source.name}`}
                    title="Quitar fuente"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="builder-source-empty">
          <Paperclip size={19} />
          <strong>Todavía no agregaste fuentes</strong>
          <span>También podés pasar directamente al diseño y conversar desde cero.</span>
        </div>
      )}

      {reusableSources.length > 0 && (
        <section className="builder-reusable-sources" aria-label="Fuentes de otros proyectos">
          <div className="builder-source-list-heading">
            <div>
              <span className="builder-examples-label">REUTILIZAR</span>
              <h2>Fuentes de tus otras apps</h2>
            </div>
          </div>
          <div className="builder-reusable-source-list">
            {reusableSources.map(({ source, projectName }) => (
              <article className="builder-reusable-source" key={`${projectName}-${source.id}`}>
                <div className="builder-source-entry-icon"><FileText size={15} /></div>
                <div>
                  <strong>{source.name}</strong>
                  <span>{projectName} · {source.detail}</span>
                </div>
                <button
                  type="button"
                  onClick={() => onReuse(source)}
                  disabled={busy || project.sources.length >= MAX_BUILDER_SOURCES}
                >
                  <Plus size={13} /> Agregar
                </button>
              </article>
            ))}
          </div>
        </section>
      )}

      <footer className="builder-source-footer">
        <span>Los archivos se procesan para extraer texto e imágenes de referencia. No se ejecutan.</span>
        <button type="button" className="builder-primary-action" onClick={onContinue} data-testid="button-continue-to-design">
          Ir al diseño <ArrowRight size={15} />
        </button>
      </footer>
    </section>
  );
}

function AssemblyPanel({
  blueprint,
  appNamespace,
  sourceCount,
  expansionProposal,
  expansionDecision,
  onBackToDesign,
}: {
  blueprint: AppBlueprint | null;
  appNamespace: string;
  sourceCount: number;
  expansionProposal: AppBuilderExpansionProposal | null;
  expansionDecision: BuilderProject["expansionDecision"];
  onBackToDesign: () => void;
}) {
  const hasTitle = Boolean(blueprint?.title.trim());
  const hasSections = Boolean(blueprint && blueprint.sections.length >= 2);
  const hasContent = Boolean(blueprint?.sections.some((section) => section.items.length > 0));
  const isFunctional = Boolean(blueprint && blueprint.appKind !== "prototype");
  const awaitingApproval = expansionProposal?.status === "approval-required" &&
    expansionDecision === "pending";
  const checks = [
    { label: "Vista previa generada", complete: Boolean(blueprint) },
    { label: "Nombre y secciones disponibles", complete: hasTitle && hasSections },
    { label: "Contenido visible para revisar", complete: h…16338 tokens truncated….blueprint}
                aria-current={activeStage === stage.id ? "step" : undefined}
                title={stage.id === "assembly" && !activeProject.blueprint ? "Primero creá una vista previa" : undefined}
                data-testid={`button-stage-${stage.id}`}
              >
                <span className="builder-stage-number">{index + 1}</span>
                <span>{stage.label}</span>
                {stage.id === "sources" && stage.count > 0 && <small>{stage.count}</small>}
              </button>
            ))}
          </nav>
        )}
        <div className="builder-topbar-right">
          {onOpenPrisma && (
            <button
              type="button"
              className="builder-settings-button"
              onClick={onOpenPrisma}
              aria-label="Abrir el módulo Prisma"
              data-testid="button-open-prisma"
            >
              Prisma
            </button>
          )}
          <div className={`builder-save-status is-${saveStatus}`} aria-live="polite">
            {saveStatus === "saved" ? <Check size={14} /> : saveStatus === "saving" ? <LoaderCircle size={14} className="builder-spin" /> : saveStatus === "preview" ? <Globe size={14} /> : <CircleHelp size={14} />}
            <span>{saveStatus === "saved" ? "Guardado en la nube" : saveStatus === "saving" ? "Guardando" : saveStatus === "preview" ? "Vista previa, sin guardar" : "No se pudo sincronizar"}</span>
          </div>
          <span className="builder-voice-pill"><Mic size={14} /> Por voz</span>
          <button
            type="button"
            className="builder-settings-button"
            onClick={() => setRouterSettingsOpen(true)}
            aria-label="Abrir configuración de Router IA"
            title="Configuración"
            data-testid="button-router-settings"
          >
            <Settings2 size={15} />
            <span>Configuración</span>
          </button>
        </div>
      </header>

      <div className="builder-body">
        <aside className="builder-project-sidebar" aria-label="Tus apps">
          <div className="builder-sidebar-heading">
            <div><span className="builder-sidebar-eyebrow">TU ESPACIO</span><strong>Mis apps</strong></div>
            <button
              type="button"
              className="builder-new-project-button"
              onClick={createNewProject}
              disabled={projectCollection.projects.length >= MAX_BUILDER_PROJECTS}
              aria-label="Crear una app nueva"
              title="Crear una app nueva"
              data-testid="button-new-project"
            >
              <Plus size={16} />
            </button>
          </div>
          <div className="builder-project-list">
            {builderProjects.map((project) => (
              <div className="builder-project-entry" key={project.id}>
                <button
                  type="button"
                  className={`builder-project-option ${project.id === activeProject.id ? "is-active" : ""}`}
                  onClick={() => selectProject(project.id)}
                  aria-current={project.id === activeProject.id ? "page" : undefined}
                  data-testid={`button-project-${project.id}`}
                >
                  <span className="builder-project-icon"><Code2 size={15} /></span>
                  <span className="builder-project-copy">
                    <strong>{projectTitle(project)}</strong>
                    <small>{project.messages.length ? `${project.messages.length} mensajes` : "Nueva idea"}</small>
                  </span>
                </button>
                <button
                  type="button"
                  className="builder-delete-project"
                  onClick={() => deleteProject(project.id)}
                  aria-label={`Eliminar ${projectTitle(project)}`}
                  title={`Eliminar ${projectTitle(project)}`}
                  data-testid={`button-delete-project-${project.id}`}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
          {projectError && <p className="builder-project-error" role="alert">{projectError}</p>}
          <div className="builder-sidebar-footer">
            <span className="builder-local-indicator" />
            <span>Las apps se guardan en este navegador</span>
            <small>{builderProjects.length} de {MAX_BUILDER_PROJECTS}</small>
          </div>
        </aside>

        <main className={`builder-main ${activeStage === "sources" ? "is-source-stage" : activeStage === "assembly" ? "is-assembly-stage" : ""}`}>
          {activeStage === "sources" ? (
            <SourcesPanel
              project={activeProject}
              reusableSources={reusableSources}
              busy={sourceBusy}
              url={sourceUrl}
              error={sourceError}
              onUrlChange={setSourceUrl}
              onAddFiles={(files) => void addFilesAsSources(files)}
              onAddUrl={(event) => void addWebSource(event)}
              onRemove={removeSource}
              onToggle={toggleSource}
              onModeChange={changeSourceMode}
              onReuse={reuseSource}
              onContinue={() => setActiveStage("design")}
            />
          ) : activeStage === "assembly" ? (
            <AssemblyPanel
              blueprint={activeProject.blueprint}
              appNamespace={activeProject.id}
              sourceCount={activeProject.sources.filter((source) => source.included).length}
              expansionProposal={activeProject.expansionProposal}
              expansionDecision={activeProject.expansionDecision}
              onBackToDesign={() => setActiveStage("design")}
            />
          ) : (
          <>
          <section className="builder-conversation-panel" aria-label="Conversación para crear tu app">
            <header className="builder-conversation-header">
              <span className="builder-conversation-kicker"><span /> ETAPA 2 · DISEÑO</span>
              <h1>Hagamos realidad tu idea</h1>
              <p>Contámela hablando; podés sumar fuentes o empezar desde cero.</p>
              <button
                type="button"
                className="builder-selected-sources"
                onClick={() => setActiveStage("sources")}
                data-testid="button-manage-sources"
              >
                <Paperclip size={13} />
                <span>{activeProject.sources.filter((source) => source.included).length
                  ? `${activeProject.sources.filter((source) => source.included).length} fuentes incluidas`
                  : "Agregar fuentes opcionales"}</span>
                <ArrowRight size={13} />
              </button>
            </header>

            <div className={`builder-chat-scroll ${activeProject.messages.length ? "has-messages" : ""}`} aria-live="polite">
              {activeProject.messages.length === 0 ? (
                <div className="builder-welcome">
                  <div className={`builder-welcome-orb ${speech.isListening ? "is-listening" : ""}`}>
                    <Sparkles size={22} />
                    <span className="builder-orb-dot dot-one" />
                    <span className="builder-orb-dot dot-two" />
                  </div>
                  <h2>¿Qué querés crear?</h2>
                  <p>Contame tu idea con tus palabras. Vamos a definirla juntos y vos elegís cuándo armar la primera versión.</p>
                  <span className="builder-examples-label">PARA EMPEZAR</span>
                  <div className="builder-example-list">
                    {examplePrompts.map((example, index) => (
                      <button
                        type="button"
                        key={example}
                        onClick={() => setPrompt(example)}
                        data-testid={`button-example-${index + 1}`}
                      >
                        <span><Sparkles size={13} /></span>{example}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="builder-message-list">
                  {activeProject.messages.map((turn, index) => (
                    <ConversationMessage key={`${turn.role}-${index}`} turn={turn} index={index} />
                  ))}
                  {activeProject.taskPlan.length > 0 && (
                    <section className="builder-task-plan" aria-label="Tareas que generaron la vista previa">
                      <div className="builder-task-plan-heading">
                        <Check size={14} />
                        <strong>Vista previa dividida en {activeProject.taskPlan.length} tareas</strong>
                      </div>
                      <ol>
                        {activeProject.taskPlan.map((task) => (
                          <li key={task.id}>
                            <span>{task.title}</span>
                            <small>
                              Router IA · {routerTaskTypeLabels[task.taskType]}
                            </small>
                          </li>
                        ))}
                      </ol>
                    </section>
                  )}
                  <ExpansionProposalCard
                    proposal={activeProject.expansionProposal}
                    decision={activeProject.expansionDecision}
                    approvedModuleId={activeProject.approvedModuleId}
                    busy={isGenerating || isActivatingModule}
                    onActivate={activateExpansionModule}
                    onKeepPrototype={keepPrototype}
                  />
                  {isGenerating && (
                    <div className="builder-generating" role="status">
                      <span className="builder-message-avatar"><Sparkles size={14} /></span>
                      <div><LoaderCircle size={15} className="builder-spin" /><span>Estoy trabajando en tu pedido…</span></div>
                    </div>
                  )}
                  <div ref={messageEndRef} />
                </div>
              )}
            </div>

            <section className="builder-task-plan" aria-label="Disponibilidad de la primera versión">
              <p>{activeProject.designConversation?.readyToBuild
                ? activeProject.blueprint ? "Ya podemos probar los cambios que conversamos." : "Ya tenemos una base para una primera versión."
                : "Sigamos definiendo la idea. Podés conversar todo lo que necesites."}</p>
              <div className="builder-example-list">
                <button type="button" disabled={isGenerating || isActivatingModule || !activeProject.designConversation?.readyToBuild}
                  data-testid="button-build-discussed-app"
                  onClick={() => void sendPrompt(activeProject.blueprint ? "Aplicá los cambios que acabamos de definir." : "Armá una primera versión con lo que conversamos.", true)}>
                  <Sparkles size={14} />{activeProject.blueprint ? "Aplicar estos cambios" : "Armar una primera versión"}
                </button>
              </div>
            </section>

            <form className="builder-composer-wrap" onSubmit={handleSubmit}>
              {speech.error && <p className="builder-inline-message is-error" role="alert"><AlertCircle size={14} />{speech.error}</p>}
              {requestErrors[activeProject.id] && (
                <p className="builder-inline-message is-error" role="alert"><AlertCircle size={14} />{requestErrors[activeProject.id]}</p>
              )}
              {promptError && <p className="builder-inline-message is-error" role="alert"><AlertCircle size={14} />{promptError}</p>}
              <div className={`builder-composer ${speech.isListening ? "is-listening" : ""}`}>
                <textarea
                  value={prompt}
                  onChange={(event) => {
                    setPrompt(event.target.value);
                    setPromptError(null);
                    speech.clearError();
                  }}
                  onKeyDown={handleComposerKeyDown}
                  placeholder={activeProject.blueprint ? "¿Qué te gustaría cambiar?" : "Describí la app que tenés en mente…"}
                  aria-label="Describí tu app o el cambio que querés"
                  maxLength={MAX_PROMPT_LENGTH}
                  rows={2}
                  data-testid="input-app-prompt"
                />
                <div className="builder-composer-toolbar">
                  <button
                    type="button"
                    className={`builder-mic-button ${speech.isListening ? "is-listening" : ""}`}
                    onClick={() => speech.isListening ? speech.stop() : speech.start(prompt)}
                    aria-label={speech.isListening ? "Terminar dictado" : "Dictar una idea"}
                    aria-pressed={speech.isListening}
                    data-testid="button-microphone"
                  >
                    {speech.isListening ? <MicOff size={16} /> : <Mic size={16} />}
                    <span>{speech.isListening ? "Terminar" : "Hablar"}</span>
                  </button>
                  <span className="builder-composer-hint">
                    {speech.isListening ? <><span className="builder-listening-dot" /> Te escucho…</> : "Podés editar la transcripción"}
                  </span>
                  <span className="builder-character-count">{prompt.length}/{MAX_PROMPT_LENGTH}</span>
                  <button
                    type="submit"
                    className="builder-send-button"
                    disabled={!prompt.trim() || isGenerating}
                    data-testid="button-send-prompt"
                  >
                    {isGenerating ? <LoaderCircle size={15} className="builder-spin" /> : <Send size={15} />}
                    <span>{activeProject.blueprint ? "Pedir cambio" : "Crear app"}</span>
                  </button>
                </div>
              </div>
              <p className="builder-composer-disclaimer">La voz se transcribe antes de enviar. Revisá el texto y tocá {activeProject.blueprint ? "Pedir cambio" : "Crear app"}.</p>
            </form>
          </section>

          {showGeneratedProjectPanel ? (
            <GeneratedProjectPanel
              stage={activeGeneratedJob?.stage ?? (savedGeneratedProject?.status === "ready" ? "ready" : "error")}
              statusMessage={activeGeneratedJob?.statusMessage ?? (
                savedGeneratedProject?.status === "ready"
                  ? "El proyecto está guardado. Preparando una nueva vista previa."
                  : "El proyecto necesita una corrección."
              )}
              files={generatedProjectFiles}
              plannedFiles={activeGeneratedJob?.plannedFiles ?? []}
              generatedFiles={activeGeneratedJob?.generatedFiles ?? []}
              fileProgress={activeGeneratedJob?.fileProgress ?? []}
              correctedFiles={activeGeneratedJob?.correctedFiles ?? []}
              codingFallbackUsed={activeGeneratedJob?.codingFallbackUsed ?? false}
              codingEscalationFiles={activeGeneratedJob?.codingEscalationFiles ?? []}
              diagnostics={activeGeneratedJob?.diagnostics ?? savedGeneratedProject?.diagnostics ?? []}
              previewHtml={activeGeneratedJob?.stage === "ready" ? activeGeneratedJob.previewHtml : null}
              projectId={activeProject.id}
              jobId={activeGeneratedJob?.id ?? `saved-${activeProject.id}`}
              attempt={activeGeneratedJob?.attempt ?? 0}
              onDownload={() => {
                try {
                  downloadGeneratedProjectZip(projectTitle(activeProject), generatedProjectFiles);
                } catch (error) {
                  setRequestErrors((current) => ({
                    ...current,
                    [activeProject.id]: error instanceof Error
                      ? error.message
                      : "No pude exportar el proyecto.",
                  }));
                }
              }}
              onRetry={() => {
                if (!activeProject.blueprint) return;
                const lastPrompt = [...activeProject.messages]
                  .reverse()
                  .find((turn) => turn.role === "user")?.content ?? activeProject.blueprint.description;
                void startGeneratedProjectJobForProject(
                  activeProject.id,
                  lastPrompt,
                  activeProject.blueprint,
                  activeProject.messages,
                );
              }}
              busy={generatedProjectBusyIds.has(activeProject.id)}
            />
          ) : (
            <PreviewPanel blueprint={activeProject.blueprint} appNamespace={activeProject.id} />
          )}
          </>
          )}
        </main>
      </div>
      <RouterSettings
        open={routerSettingsOpen}
        onClose={() => setRouterSettingsOpen(false)}
      />
    </div>
  );
}

export default ConversationalBuilder;
