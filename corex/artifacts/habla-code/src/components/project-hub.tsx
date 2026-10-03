import { useState } from "react";
import { ArrowRight, Beaker, Check, Code2, FileArchive, FolderOpen, LoaderCircle, Plus, Upload } from "lucide-react";
import { useAuthenticatedUser } from "@/components/auth-gate";
import {
  BUILDER_PROJECTS_STORAGE_KEY,
  createBuilderProject,
  loadBuilderProjectCollection,
  MAX_BUILDER_PROJECTS,
  MAX_BUILDER_SOURCES,
  serializeBuilderProjectCollection,
  type BuilderProject,
  type BuilderProjectCollection,
  type BuilderSource,
} from "@/lib/builder-workspace";
import { saveWorkspaceSnapshot } from "@/lib/cloud-workspaces";
import { prepareReferenceFile, REFERENCE_FILE_ACCEPT } from "@/lib/reference-files";
import "./project-hub.css";

function titleFor(project: BuilderProject): string {
  return project.blueprint?.title || project.name || "Proyecto sin nombre";
}

function projectState(project: BuilderProject): { label: string; progress: number; next: string } {
  if (project.generatedProject?.status === "ready") {
    return { label: "Listo para revisar", progress: 100, next: "Revisar, probar o seguir mejorando" };
  }
  if (project.generatedProjectRecovery) {
    return { label: "Trabajo en curso", progress: 80, next: "Retomar el proceso pendiente" };
  }
  if (project.blueprint) {
    return { label: "En desarrollo", progress: 65, next: "Continuar el desarrollo" };
  }
  if (project.messages.length > 0) {
    return { label: "Definiendo", progress: 35, next: "Seguir definiendo la app" };
  }
  if (project.sources.length > 0) {
    return { label: "Importado", progress: 25, next: "Describir qué querés conservar y completar" };
  }
  return { label: "Idea", progress: 10, next: "Agregar una idea o material de trabajo" };
}

function importedProjectName(files: File[]): string {
  if (files.length === 1) {
    return files[0].name.replace(/\.(zip|apk|tar|gz|7z)$/i, "").slice(0, 64) || "Proyecto importado";
  }
  return "Proyecto importado";
}

export function ProjectHub({ onOpenProject }: { onOpenProject: (project: BuilderProject) => void }) {
  const { user, previewMode } = useAuthenticatedUser();
  const [collection, setCollection] = useState<BuilderProjectCollection>(() => loadBuilderProjectCollection());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const persist = async (next: BuilderProjectCollection) => {
    const serialized = serializeBuilderProjectCollection(next);
    window.localStorage.setItem(BUILDER_PROJECTS_STORAGE_KEY, serialized);
    setCollection(next);
    if (!previewMode && user) {
      const snapshot = JSON.parse(serialized) as BuilderProjectCollection;
      await saveWorkspaceSnapshot(user.id, "builder-projects", snapshot);
    }
  };

  const openProject = async (project: BuilderProject) => {
    let projects = collection.projects;
    if (project.mode === "lab") {
      projects = [project, ...collection.projects.filter((item) => item.id !== project.id)];
    }
    const next = { projects, activeProjectId: project.id };
    try {
      await persist(next);
    } catch {
      window.localStorage.setItem(BUILDER_PROJECTS_STORAGE_KEY, serializeBuilderProjectCollection(next));
    }
    onOpenProject(project);
  };

  const createNew = async () => {
    if (collection.projects.length >= MAX_BUILDER_PROJECTS || busy) return;
    const project = createBuilderProject(`Mi app ${collection.projects.filter((item) => item.mode === "builder").length + 1}`);
    const next = {
      projects: [...collection.projects, project],
      activeProjectId: project.id,
    };
    setBusy(true);
    setError(null);
    try {
      await persist(next);
      onOpenProject(project);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No pude crear el proyecto.");
    } finally {
      setBusy(false);
    }
  };

  const importProject = async (files: FileList | null) => {
    if (!files?.length || busy) return;
    if (collection.projects.length >= MAX_BUILDER_PROJECTS) {
      setError(`CoreX admite hasta ${MAX_BUILDER_PROJECTS} proyectos.`);
      return;
    }

    const selected = Array.from(files).slice(0, MAX_BUILDER_SOURCES);
    setBusy(true);
    setError(null);
    setMessage("Leyendo el proyecto…");
    const sources: BuilderSource[] = [];
    const failures: string[] = [];

    for (const file of selected) {
      try {
        const attachment = await prepareReferenceFile(file);
        sources.push({
          ...attachment,
          included: true,
          useMode: "authorized-base",
          hasVisual: Boolean(attachment.payload.imageDataUrl),
          wasTextTrimmed: false,
        });
      } catch (cause) {
        failures.push(`${file.name}: ${cause instanceof Error ? cause.message : "no pude leerlo"}`);
      }
    }

    if (!sources.length) {
      setBusy(false);
      setMessage(null);
      setError(failures.join(" ") || "No pude leer los archivos seleccionados.");
      return;
    }

    const project = {
      ...createBuilderProject(importedProjectName(selected)),
      sources,
      messages: [{
        role: "assistant" as const,
        content: "Proyecto existente importado. CoreX conservó el material como base propia autorizada para analizar qué está hecho, qué falta y continuar desde ahí.",
      }],
    };
    const next = {
      projects: [...collection.projects, project],
      activeProjectId: project.id,
    };

    try {
      await persist(next);
      setMessage(failures.length ? `Proyecto agregado. Algunos archivos no pudieron leerse: ${failures.join(" ")}` : "Proyecto agregado y listo para continuar.");
      onOpenProject(project);
    } catch (cause) {
      setMessage(null);
      setError(cause instanceof Error ? cause.message : "No pude guardar el proyecto importado.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="project-hub" data-testid="project-hub">
      <header className="project-hub-heading">
        <div>
          <span className="project-hub-eyebrow">SEGUIMIENTO</span>
          <h1>Proyectos</h1>
          <p>Todo lo que CoreX está construyendo, en un solo lugar.</p>
        </div>
        <div className="project-hub-actions">
          <button type="button" onClick={() => void createNew()} disabled={busy || collection.projects.length >= MAX_BUILDER_PROJECTS}>
            <Plus size={16} /> Nuevo proyecto
          </button>
          <label className={busy ? "is-disabled" : ""}>
            <input
              type="file"
              accept={REFERENCE_FILE_ACCEPT}
              multiple
              disabled={busy || collection.projects.length >= MAX_BUILDER_PROJECTS}
              onChange={(event) => {
                void importProject(event.currentTarget.files);
                event.currentTarget.value = "";
              }}
              data-testid="input-import-existing-project"
            />
            {busy ? <LoaderCircle size={16} className="project-hub-spin" /> : <Upload size={16} />}
            Importar proyecto existente
          </label>
        </div>
      </header>

      {message && <p className="project-hub-message"><Check size={15} />{message}</p>}
      {error && <p className="project-hub-error" role="alert">{error}</p>}

      <section className="project-hub-summary" aria-label="Resumen de proyectos">
        <div><strong>{collection.projects.length}</strong><span>proyectos</span></div>
        <div><strong>{collection.projects.filter((project) => project.blueprint || project.generatedProject).length}</strong><span>en desarrollo o listos</span></div>
        <div><strong>{collection.projects.filter((project) => project.sources.length > 0).length}</strong><span>con material asociado</span></div>
      </section>

      <section className="project-hub-grid" aria-label="Listado de proyectos">
        {collection.projects.map((project) => {
          const state = projectState(project);
          const isLab = project.mode === "lab";
          return (
            <article className="project-hub-card" key={project.id} data-testid={`project-card-${project.id}`}>
              <div className="project-hub-card-top">
                <span className={`project-hub-icon ${isLab ? "is-lab" : ""}`}>
                  {isLab ? <Beaker size={18} /> : project.sources.some((source) => source.payload.kind === "archive") ? <FileArchive size={18} /> : <Code2 size={18} />}
                </span>
                <span className="project-hub-kind">{isLab ? "Laboratorio" : "Builder"}</span>
              </div>
              <h2>{titleFor(project)}</h2>
              <div className="project-hub-meta">
                <span>{project.messages.length} mensajes</span>
                <span>{project.sources.length} fuentes</span>
                {project.generatedProject?.files.length ? <span>{project.generatedProject.files.length} archivos generados</span> : null}
              </div>
              <div className="project-hub-progress-copy">
                <strong>{state.label}</strong><span>{state.progress}%</span>
              </div>
              <div className="project-hub-progress"><span style={{ width: `${state.progress}%` }} /></div>
              <p><FolderOpen size={14} /> Próximo paso: {state.next}</p>
              <button type="button" className="project-hub-continue" onClick={() => void openProject(project)}>
                Continuar <ArrowRight size={15} />
              </button>
            </article>
          );
        })}
      </section>
    </main>
  );
}
