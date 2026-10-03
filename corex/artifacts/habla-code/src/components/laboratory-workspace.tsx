import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  AlertCircle,
  Archive,
  ArrowLeft,
  ArrowRight,
  Beaker,
  Check,
  ChevronDown,
  CircleAlert,
  Clock3,
  Code2,
  Database,
  Download,
  FileArchive,
  FileCode2,
  FileText,
  FolderSearch,
  Globe2,
  KeyRound,
  Layers3,
  Link2,
  LoaderCircle,
  LockKeyhole,
  Network,
  PencilLine,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  Upload,
} from "lucide-react";
import type { BuilderProjectJob } from "@workspace/api-client-react";
import { REFERENCE_FILE_ACCEPT } from "@/lib/reference-files";
import type {
  BuilderProject,
  BuilderSource,
  LabProjectAnalysis,
  LabProjectVersion,
} from "@/lib/builder-workspace";
import "./laboratory-workspace.css";

export type LaboratoryWorkspaceProps = {
  projects: BuilderProject[];
  activeProject: BuilderProject | null;
  job: BuilderProjectJob | null;
  busy: boolean;
  analysisBusy: boolean;
  sourceBusy: boolean;
  sourceError: string | null;
  requestError: string | null;
  onCreate: () => void;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onUpdateProject: (
    id: string,
    updater: (project: BuilderProject) => BuilderProject,
  ) => void;
  onAddFiles: (files: FileList | null) => void;
  onAddWeb: (url: string) => void;
  onAnalyze: () => void;
  onGenerate: (prompt: string) => void;
  onRetry: () => void;
  onExport: () => void;
  onRestoreVersion: (version: LabProjectVersion) => void;
  onShowBuilder: () => void;
};

const jobStages: Array<{ id: BuilderProjectJob["stage"]; label: string }> = [
  { id: "planning", label: "Planificación" },
  { id: "blueprint", label: "Blueprint" },
  { id: "generation", label: "Reconstrucción" },
  { id: "build", label: "Compilación" },
  { id: "validation", label: "Validación" },
  { id: "correction", label: "Corrección" },
  { id: "ready", label: "Lista" },
];

const observedGroups: Array<{
  key: keyof LabProjectAnalysis["observed"];
  label: string;
  icon: typeof FileText;
}> = [
  { key: "filePaths", label: "Rutas de archivo", icon: FileCode2 },
  { key: "dependencies", label: "Dependencias", icon: Archive },
  { key: "entryPoints", label: "Puntos de entrada", icon: ArrowRight },
  { key: "components", label: "Componentes", icon: Layers3 },
  { key: "assets", label: "Recursos", icon: FolderSearch },
  { key: "strings", label: "Cadenas detectadas", icon: FileText },
  { key: "permissions", label: "Permisos", icon: KeyRound },
  { key: "networkCalls", label: "Llamadas de red", icon: Network },
  { key: "storage", label: "Almacenamiento", icon: Database },
];

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("es-AR", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function sourceKindLabel(source: BuilderSource): string {
  const labels: Record<string, string> = {
    apk: "APK · estático",
    archive: "Archivo",
    code: "Código",
    document: "Documento",
    image: "Imagen",
  };
  return labels[source.payload.kind] ?? source.payload.kind;
}

function sourceIcon(source: BuilderSource) {
  if (source.payload.kind === "apk" || source.payload.kind === "archive") return <FileArchive size={17} />;
  if (source.payload.kind === "code") return <Code2 size={17} />;
  if (source.payload.kind === "image") return <Search size={17} />;
  return <FileText size={17} />;
}

function listCount(project: BuilderProject): number {
  return project.sources.length;
}

function updateSources(
  project: BuilderProject,
  updater: (sources: BuilderSource[]) => BuilderSource[],
): BuilderProject {
  return { ...project, sources: updater(project.sources) };
}

function EmptyLaboratory({ onCreate }: { onCreate: () => void }) {
  return (
    <section className="laboratory-empty" data-testid="laboratory-empty-state">
      <div className="laboratory-empty-orbit" aria-hidden="true">
        <span />
        <span />
        <Beaker size={30} />
      </div>
      <span className="laboratory-eyebrow">LABORATORIO COREX</span>
      <h1>Un espacio para entender antes de reconstruir</h1>
      <p>
        Reuní una referencia, hacé visible la evidencia y definí con precisión
        qué querés adaptar.
      </p>
      <button
        type="button"
        className="laboratory-button laboratory-button--primary"
        onClick={onCreate}
        data-testid="button-create-laboratory-project-empty"
      >
        <Plus size={16} />
        Crear proyecto de laboratorio
      </button>
    </section>
  );
}

function SourceCard({
  source,
  onRemove,
  onToggleIncluded,
  onToggleMode,
}: {
  source: BuilderSource;
  onRemove: () => void;
  onToggleIncluded: (included: boolean) => void;
  onToggleMode: (mode: BuilderSource["useMode"]) => void;
}) {
  return (
    <details
      className={`laboratory-source ${source.included ? "is-included" : ""}`}
      data-testid={`source-card-${source.id}`}
    >
      <summary data-testid={`button-inspect-source-${source.id}`}>
        <span className="laboratory-source-icon" aria-hidden="true">{sourceIcon(source)}</span>
        <span className="laboratory-source-copy">
          <strong data-testid={`text-source-name-${source.id}`}>{source.name}</strong>
          <small>{source.detail}</small>
        </span>
        <span className="laboratory-source-kind">{sourceKindLabel(source)}</span>
        <ChevronDown className="laboratory-source-chevron" size={15} aria-hidden="true" />
      </summary>
      <div className="laboratory-source-detail">
        <div className="laboratory-source-detail-row">
          <span>Tratamiento</span>
          <strong>{source.useMode === "authorized-base" ? "Base propia autorizada" : "Referencia"}</strong>
        </div>
        <p>{source.payload.extractedText || "No hay texto extraído para inspeccionar."}</p>
        {source.wasTextTrimmed && (
          <small className="laboratory-source-note">El texto guardado es un fragmento acotado.</small>
        )}
        <div className="laboratory-source-actions">
          <label className="laboratory-checkbox">
            <input
              type="checkbox"
              checked={source.included}
              onChange={(event) => onToggleIncluded(event.target.checked)}
              data-testid={`checkbox-include-source-${source.id}`}
            />
            <span>Incluir en análisis</span>
          </label>
          {(source.payload.kind === "code" || source.payload.kind === "archive" || source.payload.kind === "apk") && (
            <select
              value={source.useMode}
              onChange={(event) => onToggleMode(event.target.value as BuilderSource["useMode"])}
              aria-label={`Modo de uso de ${source.name}`}
              data-testid={`select-source-mode-${source.id}`}
            >
              <option value="reference">Referencia</option>
              <option value="authorized-base">Base propia autorizada</option>
            </select>
          )}
          <button
            type="button"
            className="laboratory-icon-button laboratory-icon-button--danger"
            onClick={onRemove}
            aria-label={`Quitar fuente ${source.name}`}
            title="Quitar fuente"
            data-testid={`button-remove-source-${source.id}`}
          >
            <Trash2 size={15} />
          </button>
        </div>
      </div>
    </details>
  );
}

function SourcePanel({
  project,
  sourceBusy,
  sourceError,
  onAddFiles,
  onAddWeb,
  onUpdateProject,
}: {
  project: BuilderProject;
  sourceBusy: boolean;
  sourceError: string | null;
  onAddFiles: (files: FileList | null) => void;
  onAddWeb: (url: string) => void;
  onUpdateProject: LaboratoryWorkspaceProps["onUpdateProject"];
}) {
  const [url, setUrl] = useState("");

  const removeSource = (sourceId: string) => {
    onUpdateProject(project.id, (current) =>
      updateSources(current, (sources) => sources.filter((source) => source.id !== sourceId)),
    );
  };

  const setSourceIncluded = (sourceId: string, included: boolean) => {
    onUpdateProject(project.id, (current) =>
      updateSources(current, (sources) =>
        sources.map((source) => source.id === sourceId ? { ...source, included } : source),
      ),
    );
  };

  const setSourceMode = (sourceId: string, useMode: BuilderSource["useMode"]) => {
    onUpdateProject(project.id, (current) =>
      updateSources(current, (sources) =>
        sources.map((source) => source.id === sourceId ? { ...source, useMode } : source),
      ),
    );
  };

  const submitUrl = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = url.trim();
    if (!value || sourceBusy) return;
    onAddWeb(value);
    setUrl("");
  };

  return (
    <section className="laboratory-card laboratory-sources-card" aria-labelledby="laboratory-sources-title">
      <div className="laboratory-card-heading">
        <div>
          <span className="laboratory-section-label">01 · EVIDENCIA</span>
          <h2 id="laboratory-sources-title">Fuentes de trabajo</h2>
        </div>
        <span className="laboratory-count-badge" data-testid="text-source-count">
          {listCount(project)} / 5
        </span>
      </div>
      <p className="laboratory-card-intro">
        Agregá archivos o una URL pública. El análisis usa únicamente las fuentes incluidas.
      </p>

      <div className="laboratory-source-inputs">
        <label className="laboratory-dropzone">
          <input
            type="file"
            accept={REFERENCE_FILE_ACCEPT}
            multiple
            disabled={sourceBusy || project.sources.length >= 5}
            onChange={(event) => {
              onAddFiles(event.currentTarget.files);
              event.currentTarget.value = "";
            }}
            data-testid="input-laboratory-files"
          />
          <span className="laboratory-dropzone-icon"><Upload size={17} /></span>
          <strong>{sourceBusy ? "Procesando fuente…" : "Importar archivos"}</strong>
          <small>APK, ZIP, código, documentos, imágenes</small>
        </label>
        <form className="laboratory-url-form" onSubmit={submitUrl}>
          <span className="laboratory-input-label"><Globe2 size={14} /> URL pública</span>
          <div>
            <input
              type="url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://sitio-publico.com"
              disabled={sourceBusy || project.sources.length >= 5}
              aria-label="URL pública de referencia"
              data-testid="input-laboratory-web-url"
            />
            <button
              type="submit"
              className="laboratory-icon-button laboratory-icon-button--accent"
              disabled={!url.trim() || sourceBusy || project.sources.length >= 5}
              aria-label="Agregar URL pública"
              data-testid="button-add-laboratory-web-url"
            >
              {sourceBusy ? <LoaderCircle size={16} className="laboratory-spin" /> : <Plus size={16} />}
            </button>
          </div>
          <small>Se extrae el contenido visible sin requerir una sesión.</small>
        </form>
      </div>

      {sourceError && (
        <p className="laboratory-inline-message laboratory-inline-message--error" role="alert" data-testid="error-laboratory-source">
          <CircleAlert size={15} /> {sourceError}
        </p>
      )}

      <div className="laboratory-source-list">
        {project.sources.length > 0 ? project.sources.map((source) => (
          <SourceCard
            key={source.id}
            source={source}
            onRemove={() => removeSource(source.id)}
            onToggleIncluded={(included) => setSourceIncluded(source.id, included)}
            onToggleMode={(mode) => setSourceMode(source.id, mode)}
          />
        )) : (
          <div className="laboratory-empty-list" data-testid="empty-laboratory-sources">
            <Link2 size={18} />
            <span>Todavía no hay fuentes. Importá una referencia para comenzar.</span>
          </div>
        )}
      </div>

      <div className="laboratory-safety-note">
        <ShieldCheck size={16} />
        <span>
          Los APK y binarios se analizan de forma estática: nunca se ejecutan. Se pueden describir DRM,
          licencias, autenticación y pagos, pero no evadirlos.
        </span>
      </div>
    </section>
  );
}

function EvidenceList({
  label,
  items,
  icon: Icon,
  testId,
}: {
  label: string;
  items: string[];
  icon: typeof FileText;
  testId: string;
}) {
  return (
    <article className="laboratory-evidence-group" data-testid={testId}>
      <div className="laboratory-evidence-group-heading">
        <Icon size={15} />
        <strong>{label}</strong>
        <span>{items.length}</span>
      </div>
      {items.length > 0 ? (
        <ul>
          {items.map((item, index) => (
            <li key={`${item}-${index}`} data-testid={`${testId}-item-${index}`}>{item}</li>
          ))}
        </ul>
      ) : (
        <p className="laboratory-muted-list">Sin evidencia detectada en esta categoría.</p>
      )}
    </article>
  );
}

function AnalysisPanel({ project }: { project: BuilderProject }) {
  const analysis = project.labAnalysis;
  const [activeTab, setActiveTab] = useState<"observed" | "strategy">("observed");

  if (!analysis) {
    return (
      <section className="laboratory-card laboratory-analysis-card laboratory-analysis-empty" data-testid="empty-laboratory-analysis">
        <div className="laboratory-analysis-mark"><FolderSearch size={22} /></div>
        <span className="laboratory-section-label">02 · MAPA DE EVIDENCIA</span>
        <h2>La estructura aparece después de inspeccionar</h2>
        <p>
          El laboratorio separa lo que se encontró en las fuentes de lo que se infiere
          para una posible adaptación.
        </p>
      </section>
    );
  }

  return (
    <section className="laboratory-card laboratory-analysis-card" aria-labelledby="laboratory-analysis-title" data-testid="laboratory-analysis">
      <div className="laboratory-card-heading laboratory-analysis-heading">
        <div>
          <span className="laboratory-section-label">02 · MAPA DE EVIDENCIA</span>
          <h2 id="laboratory-analysis-title">Lectura de {analysis.sourceName}</h2>
        </div>
        <span className="laboratory-analysis-date" data-testid="text-analysis-date">
          <Clock3 size={13} /> {formatDate(analysis.analyzedAt)}
        </span>
      </div>
      <div className="laboratory-analysis-summary">
        <div>
          <span className="laboratory-mini-label">RESUMEN</span>
          <p data-testid="text-analysis-summary">{analysis.summary}</p>
        </div>
        <div>
          <span className="laboratory-mini-label">ARQUITECTURA OBSERVADA</span>
          <p data-testid="text-analysis-architecture">{analysis.architecture}</p>
        </div>
      </div>
      <div className="laboratory-capability-line">
        <span className="laboratory-mini-label">CAPACIDADES DETECTADAS</span>
        <div>
          {analysis.capabilities.map((capability, index) => (
            <span key={`${capability}-${index}`} data-testid={`capability-${index}`}>{capability}</span>
          ))}
        </div>
      </div>
      <div className="laboratory-tabs" role="tablist" aria-label="Vistas del análisis">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "observed"}
          className={activeTab === "observed" ? "is-active" : ""}
          onClick={() => setActiveTab("observed")}
          data-testid="tab-static-observations"
        >
          <Search size={14} /> Observaciones estáticas
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "strategy"}
          className={activeTab === "strategy" ? "is-active" : ""}
          onClick={() => setActiveTab("strategy")}
          data-testid="tab-inferences-strategy"
        >
          <SlidersHorizontal size={14} /> Inferencias y estrategia
        </button>
      </div>

      {activeTab === "observed" ? (
        <div className="laboratory-evidence-grid" data-testid="static-observations-panel">
          {observedGroups.map(({ key, label, icon }) => (
            <EvidenceList
              key={key}
              label={label}
              items={analysis.observed[key]}
              icon={icon}
              testId={`evidence-${key}`}
            />
          ))}
        </div>
      ) : (
        <div className="laboratory-strategy-grid" data-testid="inferences-strategy-panel">
          <StrategyList title="Inferencias" items={analysis.inferred} tone="neutral" testId="list-inferences" />
          <StrategyList title="Módulos reutilizables" items={analysis.reusableModules} tone="accent" testId="list-reusable-modules" />
          <StrategyList title="Plan de adaptación" items={analysis.adaptationPlan} tone="accent" numbered testId="list-adaptation-plan" />
          <StrategyList title="Riesgos visibles" items={analysis.risks} tone="warning" testId="list-analysis-risks" />
          <StrategyList title="Operaciones bloqueadas" items={analysis.blockedOperations} tone="danger" testId="list-blocked-operations" />
        </div>
      )}
    </section>
  );
}

function StrategyList({
  title,
  items,
  tone,
  testId,
  numbered = false,
}: {
  title: string;
  items: string[];
  tone: "neutral" | "accent" | "warning" | "danger";
  testId: string;
  numbered?: boolean;
}) {
  return (
    <article className={`laboratory-strategy-list is-${tone}`} data-testid={testId}>
      <h3>{title}<span>{items.length}</span></h3>
      {items.length > 0 ? (
        <ol className={numbered ? "is-numbered" : ""}>
          {items.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}
        </ol>
      ) : (
        <p>Sin elementos registrados.</p>
      )}
    </article>
  );
}

function JobPanel({
  job,
  busy,
  onRetry,
  onExport,
}: {
  job: BuilderProjectJob | null;
  busy: boolean;
  onRetry: () => void;
  onExport: () => void;
}) {
  if (!job) return null;
  const isError = job.stage === "error";
  const isReady = job.stage === "ready";
  const activeIndex = jobStages.findIndex((stage) => stage.id === job.stage);

  return (
    <section className={`laboratory-card laboratory-job-card ${isError ? "is-error" : isReady ? "is-ready" : ""}`} aria-labelledby="laboratory-job-title" data-testid="laboratory-job-status">
      <div className="laboratory-card-heading">
        <div>
          <span className="laboratory-section-label">03 · RECONSTRUCCIÓN</span>
          <h2 id="laboratory-job-title">Estado del trabajo</h2>
        </div>
        <span className={`laboratory-status-pill is-${job.stage}`} data-testid="status-laboratory-job">
          {isError ? "Requiere atención" : isReady ? "Disponible" : "En curso"}
        </span>
      </div>
      <div className="laboratory-job-message" role={isError ? "alert" : "status"} data-testid="text-job-status-message">
        {isError ? <CircleAlert size={16} /> : isReady ? <Check size={16} /> : <LoaderCircle size={16} className="laboratory-spin" />}
        <span>{job.error || job.statusMessage || "Preparando reconstrucción…"}</span>
      </div>
      <ol className="laboratory-job-stages" aria-label="Etapas de reconstrucción">
        {jobStages.map((stage, index) => {
          const completed = !isError && (isReady || index < activeIndex);
          const current = !isError && !isReady && index === activeIndex;
          return (
            <li key={stage.id} className={completed ? "is-complete" : current ? "is-current" : ""} data-testid={`job-stage-${stage.id}`}>
              <span>{completed ? <Check size={12} /> : current ? <LoaderCircle size={12} className="laboratory-spin" /> : index + 1}</span>
              <small>{stage.label}</small>
            </li>
          );
        })}
      </ol>
      {(job.files.length > 0 || job.diagnostics.length > 0) && (
        <div className="laboratory-job-details">
          <div>
            <span className="laboratory-mini-label">ARCHIVOS</span>
            <strong data-testid="text-job-file-count">{job.files.length}</strong>
          </div>
          <div>
            <span className="laboratory-mini-label">DIAGNÓSTICOS</span>
            <strong data-testid="text-job-diagnostic-count">{job.diagnostics.length}</strong>
          </div>
          <div>
            <span className="laboratory-mini-label">INTENTO</span>
            <strong data-testid="text-job-attempt">{job.attempt}</strong>
          </div>
        </div>
      )}
      {job.diagnostics.length > 0 && (
        <ul className="laboratory-diagnostics" data-testid="list-job-diagnostics">
          {job.diagnostics.map((diagnostic, index) => <li key={`${diagnostic}-${index}`}><CircleAlert size={14} />{diagnostic}</li>)}
        </ul>
      )}
      {(isError || isReady) && (
        <div className="laboratory-job-actions">
          {isError && (
            <button type="button" className="laboratory-button laboratory-button--secondary" onClick={onRetry} disabled={busy} data-testid="button-retry-laboratory-job">
              <RefreshCw size={15} /> {busy ? "Reintentando…" : "Reintentar"}
            </button>
          )}
          {isReady && (
            <button type="button" className="laboratory-button laboratory-button--primary" onClick={onExport} disabled={busy} data-testid="button-export-laboratory-project">
              <Download size={15} /> Exportar reconstrucción
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function VersionsPanel({
  versions,
  busy,
  onRestoreVersion,
}: {
  versions: LabProjectVersion[];
  busy: boolean;
  onRestoreVersion: (version: LabProjectVersion) => void;
}) {
  return (
    <section className="laboratory-card laboratory-versions-card" aria-labelledby="laboratory-versions-title">
      <div className="laboratory-card-heading">
        <div>
          <span className="laboratory-section-label">HISTORIAL</span>
          <h2 id="laboratory-versions-title">Versiones verificables</h2>
        </div>
        <span className="laboratory-count-badge" data-testid="text-version-count">{versions.length}</span>
      </div>
      {versions.length > 0 ? (
        <div className="laboratory-version-list">
          {versions.map((version) => (
            <article className="laboratory-version" key={version.id} data-testid={`version-card-${version.id}`}>
              <div className="laboratory-version-mark"><Archive size={15} /></div>
              <div className="laboratory-version-copy">
                <strong>{version.label}</strong>
                <small>{formatDate(version.createdAt)} · {version.files.length} archivos</small>
                <span>{version.reconstructed.length} reconstruidos · {version.modified.length} modificados</span>
              </div>
              <button
                type="button"
                className="laboratory-icon-button"
                onClick={() => onRestoreVersion(version)}
                disabled={busy}
                aria-label={`Restaurar ${version.label}`}
                title="Restaurar versión"
                data-testid={`button-restore-version-${version.id}`}
              >
                <RefreshCw size={15} />
              </button>
            </article>
          ))}
        </div>
      ) : (
        <div className="laboratory-empty-list"><Clock3 size={17} /><span>Las versiones aparecen después de una reconstrucción.</span></div>
      )}
    </section>
  );
}

export function LaboratoryWorkspace({
  projects,
  activeProject,
  job,
  busy,
  analysisBusy,
  sourceBusy,
  sourceError,
  requestError,
  onCreate,
  onSelect,
  onDelete,
  onUpdateProject,
  onAddFiles,
  onAddWeb,
  onAnalyze,
  onGenerate,
  onRetry,
  onExport,
  onRestoreVersion,
  onShowBuilder,
}: LaboratoryWorkspaceProps) {
  const [goalDraft, setGoalDraft] = useState(activeProject?.labGoal ?? "");
  const [generatePrompt, setGeneratePrompt] = useState("");

  const activeId = activeProject?.id ?? null;
  const includedSources = useMemo(
    () => activeProject?.sources.filter((source) => source.included).length ?? 0,
    [activeProject],
  );

  useEffect(() => {
    if (activeProject) setGoalDraft(activeProject.labGoal);
  }, [activeProject?.id]);

  if (!activeProject) {
    return (
      <main className="laboratory-workspace" data-testid="laboratory-workspace">
        <LaboratoryTopbar onCreate={onCreate} onShowBuilder={onShowBuilder} />
        <div className="laboratory-layout">
          <LaboratorySidebar projects={projects} activeId={null} busy={busy} onCreate={onCreate} onSelect={onSelect} onDelete={onDelete} />
          <EmptyLaboratory onCreate={onCreate} />
        </div>
      </main>
    );
  }

  const saveGoal = () => {
    const nextGoal = goalDraft.trim();
    if (nextGoal === activeProject.labGoal) return;
    onUpdateProject(activeProject.id, (project) => ({ ...project, labGoal: nextGoal }));
  };

  const submitGeneration = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const prompt = generatePrompt.trim();
    if (!prompt || busy) return;
    onGenerate(prompt);
    setGeneratePrompt("");
  };

  return (
    <main className="laboratory-workspace" data-testid="laboratory-workspace">
      <LaboratoryTopbar onCreate={onCreate} onShowBuilder={onShowBuilder} />
      <div className="laboratory-layout">
        <LaboratorySidebar projects={projects} activeId={activeProject.id} busy={busy} onCreate={onCreate} onSelect={onSelect} onDelete={onDelete} />
        <div className="laboratory-main">
          <header className="laboratory-project-header">
            <div className="laboratory-project-heading">
              <span className="laboratory-eyebrow"><span /> PROYECTO DE LABORATORIO</span>
              <h1 data-testid="text-active-laboratory-project">{activeProject.name}</h1>
              <p>Evidencia, hipótesis y cambios en un mismo registro.</p>
            </div>
            <div className="laboratory-header-actions">
              <span className="laboratory-local-status"><span /> Registro local</span>
              <button type="button" className="laboratory-button laboratory-button--quiet" onClick={onShowBuilder} data-testid="button-show-builder">
                <ArrowLeft size={15} /> Abrir Builder
              </button>
            </div>
          </header>

          {requestError && (
            <div className="laboratory-request-error" role="alert" data-testid="error-laboratory-request">
              <AlertCircle size={16} /><span>{requestError}</span>
            </div>
          )}

          <div className="laboratory-goal-strip">
            <div className="laboratory-goal-label"><PencilLine size={16} /><span>OBJETIVO DE ADAPTACIÓN</span></div>
            <input
              value={goalDraft}
              onChange={(event) => setGoalDraft(event.target.value)}
              onBlur={saveGoal}
              placeholder="Describí qué querés crear o adaptar a partir de esta evidencia…"
              aria-label="Objetivo de adaptación"
              data-testid="input-laboratory-goal"
            />
            <button type="button" className="laboratory-button laboratory-button--small" onClick={saveGoal} disabled={goalDraft.trim() === activeProject.labGoal} data-testid="button-save-laboratory-goal">
              <Check size={14} /> Guardar objetivo
            </button>
          </div>

          <div className="laboratory-content-grid">
            <div className="laboratory-column">
              <SourcePanel project={activeProject} sourceBusy={sourceBusy} sourceError={sourceError} onAddFiles={onAddFiles} onAddWeb={onAddWeb} onUpdateProject={onUpdateProject} />
              <section className="laboratory-analysis-action">
                <div>
                  <span className="laboratory-section-label">LECTURA CONTROLADA</span>
                  <strong>{includedSources ? `${includedSources} fuente${includedSources === 1 ? "" : "s"} incluida${includedSources === 1 ? "" : "s"}` : "Elegí al menos una fuente"}</strong>
                  <p>El análisis conserva por separado lo observado y lo inferido.</p>
                </div>
                <button type="button" className="laboratory-button laboratory-button--primary" onClick={onAnalyze} disabled={analysisBusy || !includedSources} data-testid="button-analyze-laboratory">
                  {analysisBusy ? <LoaderCircle size={16} className="laboratory-spin" /> : <FolderSearch size={16} />}
                  {analysisBusy ? "Analizando…" : "Inspeccionar evidencia"}
                </button>
              </section>
            </div>
            <div className="laboratory-column">
              <AnalysisPanel project={activeProject} />
              <JobPanel job={job} busy={busy} onRetry={onRetry} onExport={onExport} />
              <VersionsPanel versions={activeProject.labVersions} busy={busy} onRestoreVersion={onRestoreVersion} />
            </div>
          </div>

          <section className="laboratory-reconstruct-card" aria-labelledby="laboratory-reconstruct-title">
            <div className="laboratory-reconstruct-mark"><Code2 size={20} /></div>
            <div className="laboratory-reconstruct-copy">
              <span className="laboratory-section-label">RECONSTRUIR CON CONTROL</span>
              <h2 id="laboratory-reconstruct-title">Pedí una primera implementación trazable</h2>
              <p>El pedido se procesa sobre las fuentes y el análisis guardados en este proyecto.</p>
            </div>
            <form onSubmit={submitGeneration} className="laboratory-reconstruct-form">
              <input
                value={generatePrompt}
                onChange={(event) => setGeneratePrompt(event.target.value)}
                placeholder="Qué querés que reconstruyamos…"
                aria-label="Instrucción para reconstrucción"
                disabled={busy}
                data-testid="input-laboratory-generation-prompt"
              />
              <button type="submit" className="laboratory-button laboratory-button--primary" disabled={!generatePrompt.trim() || busy} data-testid="button-generate-laboratory-project">
                {busy ? <LoaderCircle size={16} className="laboratory-spin" /> : <ArrowRight size={16} />}
                {busy ? "Preparando…" : "Pedir reconstrucción"}
              </button>
            </form>
          </section>

          <footer className="laboratory-footer-note">
            <LockKeyhole size={14} />
            <span>El laboratorio documenta límites: no ejecuta binarios ni intenta evadir DRM, licencias, autenticación o pagos.</span>
            <span className="laboratory-footer-id" data-testid="text-active-project-id">{activeProject.id}</span>
          </footer>
        </div>
      </div>
    </main>
  );
}

function LaboratoryTopbar({ onCreate, onShowBuilder }: { onCreate: () => void; onShowBuilder: () => void }) {
  return (
    <header className="laboratory-topbar">
      <div className="laboratory-brand">
        <span className="laboratory-brand-mark"><Beaker size={18} /></span>
        <span><strong>CoreX</strong><small>Laboratorio</small></span>
      </div>
      <div className="laboratory-topbar-center"><span className="laboratory-topbar-dot" /> Evidencia visible · reconstrucción responsable</div>
      <div className="laboratory-topbar-actions">
        <button type="button" className="laboratory-button laboratory-button--quiet" onClick={onShowBuilder} data-testid="button-topbar-builder"><ArrowLeft size={14} /> Builder</button>
        <button type="button" className="laboratory-button laboratory-button--small" onClick={onCreate} data-testid="button-create-laboratory-project"><Plus size={15} /> Nuevo proyecto</button>
      </div>
    </header>
  );
}

function LaboratorySidebar({
  projects,
  activeId,
  busy,
  onCreate,
  onSelect,
  onDelete,
}: {
  projects: BuilderProject[];
  activeId: string | null;
  busy: boolean;
  onCreate: () => void;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <aside className="laboratory-sidebar" aria-label="Proyectos de laboratorio">
      <div className="laboratory-sidebar-heading">
        <div><span className="laboratory-section-label">ESPACIOS</span><strong>Mis proyectos</strong></div>
        <button type="button" className="laboratory-icon-button" onClick={onCreate} disabled={busy} aria-label="Crear proyecto" data-testid="button-create-laboratory-project-sidebar"><Plus size={16} /></button>
      </div>
      <div className="laboratory-project-list">
        {projects.length > 0 ? projects.map((project) => (
          <div className={`laboratory-project-entry ${project.id === activeId ? "is-active" : ""}`} key={project.id}>
            <button type="button" onClick={() => onSelect(project.id)} className="laboratory-project-option" data-testid={`button-select-laboratory-project-${project.id}`}>
              <span className="laboratory-project-icon">{project.mode === "lab" ? <Beaker size={15} /> : <Code2 size={15} />}</span>
              <span><strong>{project.name}</strong><small>{project.mode === "lab" ? "Laboratorio" : "Builder"} · {project.sources.length} fuentes</small></span>
            </button>
            <button type="button" className="laboratory-project-delete" onClick={() => onDelete(project.id)} disabled={busy} aria-label={`Eliminar ${project.name}`} data-testid={`button-delete-laboratory-project-${project.id}`}><Trash2 size={14} /></button>
          </div>
        )) : <p className="laboratory-sidebar-empty">No hay proyectos guardados.</p>}
      </div>
      <div className="laboratory-sidebar-footer"><span /><span>Los cambios se guardan en el workspace</span></div>
    </aside>
  );
}