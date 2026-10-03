import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { python } from "@codemirror/lang-python";
import { EditorView } from "@codemirror/view";
import { useAuthenticatedUser } from "@/components/auth-gate";
import {
  Bot,
  Check,
  ChevronDown,
  CircleHelp,
  Code2,
  Eye,
  FileCode2,
  FilePlus2,
  FolderOpen,
  FolderPlus,
  LoaderCircle,
  MessageCircle,
  Play,
  Plus,
  Save,
  Square,
  Terminal,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import {
  createProjectId,
  createDefaultWorkspace,
  loadProjectCollection,
  isSupportedWorkspaceFile,
  MAX_IMPORTED_FILES_PER_BATCH,
  MAX_PROJECT_FILE_BYTES,
  MAX_WORKSPACE_FILES,
  MAX_PROJECTS,
  normalizeWorkspaceFileName,
  type PythonWorkerResponse,
  type PythonWorkerRequest,
  type PythonWorkspace,
  type WorkspaceFile,
  WORKSPACE_STORAGE_KEY,
  PROJECTS_STORAGE_KEY,
  type PythonProjectCollection,
} from "@/lib/python-workspace";
import { saveWorkspaceSnapshot } from "@/lib/cloud-workspaces";

const RUN_TIMEOUT_MS = 15_000;
type WorkspaceUpdate = PythonWorkspace | ((workspace: PythonWorkspace) => PythonWorkspace);

function formatFileSize(bytes: number): string {
  return bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function PythonIDE() {
  const { user, previewMode } = useAuthenticatedUser();
  const [projectCollection, setProjectCollection] = useState<PythonProjectCollection>(() => {
    if (!previewMode) return loadProjectCollection();
    const id = "preview-proyecto";
    return {
      projects: [{ id, workspace: createDefaultWorkspace() }],
      activeProjectId: id,
    };
  });
  const activeProject = projectCollection.projects.find((project) => project.id === projectCollection.activeProjectId)
    ?? projectCollection.projects[0];
  const workspace = activeProject?.workspace ?? createDefaultWorkspace();
  const activeProjectId = projectCollection.activeProjectId;
  const setWorkspace = useCallback((update: WorkspaceUpdate) => {
    setProjectCollection((current) => {
      const project = current.projects.find((item) => item.id === current.activeProjectId);
      if (!project) return current;
      const nextWorkspace = typeof update === "function" ? update(project.workspace) : update;
      return {
        ...current,
        projects: current.projects.map((item) =>
          item.id === project.id ? { ...item, workspace: nextWorkspace } : item,
        ),
      };
    });
  }, []);
  const [activeFileName, setActiveFileName] = useState("main.py");
  const [openTabs, setOpenTabs] = useState(["main.py"]);
  const [saveStatus, setSaveStatus] = useState<"saving" | "saved" | "error" | "preview">(
    previewMode ? "preview" : "saved",
  );
  const [showFileSidebar, setShowFileSidebar] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [showProjectMenu, setShowProjectMenu] = useState(false);
  const [showNewProjectForm, setShowNewProjectForm] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [projectError, setProjectError] = useState<string | null>(null);
  const [showNewFileForm, setShowNewFileForm] = useState(false);
  const [newFileName, setNewFileName] = useState("");
  const [fileError, setFileError] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [runtimeState, setRuntimeState] = useState<"idle" | "loading" | "running" | "ready" | "error">("idle");
  const [consoleOutput, setConsoleOutput] = useState("");
  const [consoleHasError, setConsoleHasError] = useState(false);
  const [runDuration, setRunDuration] = useState<number | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const workspaceRef = useRef(workspace);
  const timeoutRef = useRef<number | null>(null);
  const requestIdRef = useRef(0);
  const activeRequestIdRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const newFileInputRef = useRef<HTMLInputElement>(null);
  const newProjectInputRef = useRef<HTMLInputElement>(null);
  const projectMenuRef = useRef<HTMLDivElement>(null);
  const activeProjectIdRef = useRef(activeProjectId);
  activeProjectIdRef.current = activeProjectId;
  workspaceRef.current = workspace;

  const activeFile = useMemo(
    () => workspace.files.find((file) => file.name === activeFileName) ?? workspace.files[0],
    [activeFileName, workspace.files],
  );

  useEffect(() => {
    if (previewMode || !user) {
      setSaveStatus("preview");
      return;
    }
    let active = true;
    const timeout = window.setTimeout(() => {
      setSaveStatus("saving");
      try {
        const activeWorkspace = projectCollection.projects.find((project) => project.id === activeProjectId)?.workspace
          ?? workspace;
        window.localStorage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify(projectCollection));
        window.localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(activeWorkspace));
        void saveWorkspaceSnapshot(user.id, "python-projects", projectCollection)
          .then(() => {
            if (active) setSaveStatus("saved");
          })
          .catch(() => {
            if (active) setSaveStatus("error");
          });
      } catch {
        if (active) setSaveStatus("error");
      }
    }, 250);
    return () => {
      active = false;
      window.clearTimeout(timeout);
    };
  }, [activeProjectId, projectCollection, previewMode, user?.id, workspace]);

  const clearRunTimeout = useCallback(() => {
    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const handleWorkerMessage = useCallback((event: MessageEvent<PythonWorkerResponse>) => {
    const message = event.data;
    if (message.requestId !== activeRequestIdRef.current) return;

    if (message.type === "status") {
      setRuntimeState(message.status);
      setConsoleOutput(
        message.status === "loading"
          ? "Preparando Python por primera vez…"
          : "Ejecutando main.py…",
      );
      return;
    }

    clearRunTimeout();
    setIsRunning(false);
    if (message.type === "complete") {
      const output = [message.stdout.trimEnd(), message.stderr.trimEnd()]
        .filter(Boolean)
        .join("\n");
      setConsoleOutput(output || "El programa terminó sin mostrar texto.");
      setConsoleHasError(message.hasError);
      setRunDuration(message.durationMs);
      setRuntimeState(message.hasError ? "error" : "ready");
      return;
    }

    setConsoleOutput(`No pude iniciar Python: ${message.message}`);
    setConsoleHasError(true);
    setRuntimeState("error");
  }, [clearRunTimeout]);

  const createWorker = useCallback(() => {
    const worker = new Worker(new URL("../workers/python.worker.ts", import.meta.url), {
      type: "module",
      name: "programa-hablando-python",
    });
    worker.onmessage = handleWorkerMessage;
    worker.onerror = (event) => {
      clearRunTimeout();
      setIsRunning(false);
      setRuntimeState("error");
      setConsoleHasError(true);
      setConsoleOutput(`Falló el entorno de Python: ${event.message || "error desconocido"}`);
    };
    workerRef.current = worker;
    return worker;
  }, [clearRunTimeout, handleWorkerMessage]);

  useEffect(() => () => {
    clearRunTimeout();
    workerRef.current?.terminate();
    workerRef.current = null;
  }, [clearRunTimeout]);

  useEffect(() => {
    if (showNewFileForm) newFileInputRef.current?.focus();
  }, [showNewFileForm]);

  useEffect(() => {
    if (!showNewProjectForm) return;
    newProjectInputRef.current?.focus();
  }, [showNewProjectForm]);

  useEffect(() => {
    if (!showProjectMenu) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !projectMenuRef.current?.contains(event.target)) {
        setShowProjectMenu(false);
        setShowNewProjectForm(false);
        setProjectError(null);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setShowProjectMenu(false);
        setShowNewProjectForm(false);
        setProjectError(null);
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [showProjectMenu]);

  const updateFileContents = useCallback((name: string, content: string) => {
    setWorkspace((current) => ({
      ...current,
      files: current.files.map((file) => file.name === name ? { ...file, content } : file),
    }));
  }, []);

  const openFile = (name: string) => {
    setActiveFileName(name);
    setOpenTabs((current) => current.includes(name) ? current : [...current, name]);
    setShowFileSidebar(false);
  };

  const closeTab = (name: string) => {
    const remaining = openTabs.filter((tab) => tab !== name);
    const nextTabs = remaining.length ? remaining : ["main.py"];
    setOpenTabs(nextTabs);
    if (activeFileName === name) {
      setActiveFileName(nextTabs[nextTabs.length - 1]);
    }
  };

  const createFile = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = normalizeWorkspaceFileName(newFileName);
    if (!name) {
      setFileError("Usá un nombre de archivo .py, .txt, .json o .csv.");
      return;
    }
    if (workspace.files.some((file) => file.name.toLowerCase() === name.toLowerCase())) {
      setFileError("Ya existe un archivo con ese nombre.");
      return;
    }
    if (workspace.files.length >= MAX_WORKSPACE_FILES) {
      setFileError(`El proyecto puede tener hasta ${MAX_WORKSPACE_FILES} archivos.`);
      return;
    }
    const newFile = { name, content: "" };
    setWorkspace((current) => ({ ...current, files: [...current.files, newFile] }));
    setFileError(null);
    setNewFileName("");
    setShowNewFileForm(false);
    openFile(name);
  };

  const importFiles = async (fileList: FileList | null) => {
    const incoming = fileList ? Array.from(fileList) : [];
    if (!incoming.length) return;
    const importProjectId = activeProjectIdRef.current;
    const errors: string[] = [];
    const selected = incoming.slice(0, MAX_IMPORTED_FILES_PER_BATCH);
    if (incoming.length > selected.length) {
      errors.push(`Se pueden importar hasta ${MAX_IMPORTED_FILES_PER_BATCH} archivos por vez.`);
    }

    const imported: WorkspaceFile[] = [];
    for (const file of selected) {
      const name = normalizeWorkspaceFileName(file.name);
      if (!name || !isSupportedWorkspaceFile(name)) {
        errors.push(`${file.name}: formato no compatible.`);
        continue;
      }
      if (file.size > MAX_PROJECT_FILE_BYTES) {
        errors.push(`${file.name}: supera el límite de ${formatFileSize(MAX_PROJECT_FILE_BYTES)}.`);
        continue;
      }
      try {
        imported.push({ name, content: await file.text() });
      } catch {
        errors.push(`${file.name}: no pude leerlo.`);
      }
    }

    if (activeProjectIdRef.current !== importProjectId) {
      setFileError("El proyecto cambió mientras se importaban los archivos. Volvé a intentarlo.");
      return;
    }
    const currentWorkspace = workspaceRef.current;
    const nextFiles = [...currentWorkspace.files];
    let firstImportedName: string | null = null;
    for (const file of imported) {
      const existingIndex = nextFiles.findIndex(
        (existing) => existing.name.toLowerCase() === file.name.toLowerCase(),
      );
      if (existingIndex >= 0) {
        nextFiles[existingIndex] = file;
        firstImportedName ??= file.name;
        continue;
      }
      if (nextFiles.length >= MAX_WORKSPACE_FILES) {
        errors.push(`El proyecto puede tener hasta ${MAX_WORKSPACE_FILES} archivos.`);
        continue;
      }
      nextFiles.push(file);
      firstImportedName ??= file.name;
    }
    const updatedWorkspace = { ...currentWorkspace, files: nextFiles };
    workspaceRef.current = updatedWorkspace;
    setWorkspace(updatedWorkspace);
    if (firstImportedName) openFile(firstImportedName);
    setFileError(errors.length ? errors.join(" ") : null);
  };

  const deleteFile = (name: string) => {
    if (name === "main.py") {
      setFileError("main.py es el archivo de inicio y no se puede borrar.");
      return;
    }
    setWorkspace((current) => ({
      ...current,
      files: current.files.filter((file) => file.name !== name),
    }));
    setOpenTabs((current) => current.filter((tab) => tab !== name));
    if (activeFileName === name) setActiveFileName("main.py");
    setFileError(null);
  };

  const runCode = () => {
    if (isRunning || !activeFile) return;
    const worker = workerRef.current ?? createWorker();
    const requestId = ++requestIdRef.current;
    activeRequestIdRef.current = requestId;
    clearRunTimeout();
    setIsRunning(true);
    setRuntimeState("loading");
    setConsoleHasError(false);
    setConsoleOutput("Preparando Python…");
    setRunDuration(null);
    timeoutRef.current = window.setTimeout(() => {
      worker.terminate();
      workerRef.current = null;
      setIsRunning(false);
      setRuntimeState("error");
      setConsoleHasError(true);
      setConsoleOutput("La ejecución se detuvo automáticamente después de 15 segundos.");
    }, RUN_TIMEOUT_MS);

    const request: PythonWorkerRequest = {
      type: "run",
      requestId,
      files: workspace.files,
      entry: "main.py",
    };
    worker.postMessage(request);
  };

  const stopCode = () => {
    if (!isRunning) return;
    clearRunTimeout();
    activeRequestIdRef.current = ++requestIdRef.current;
    workerRef.current?.terminate();
    workerRef.current = null;
    setIsRunning(false);
    setRuntimeState("ready");
    setConsoleHasError(false);
    setConsoleOutput("Ejecución detenida.");
  };

  const resetRuntime = useCallback(() => {
    clearRunTimeout();
    workerRef.current?.terminate();
    workerRef.current = null;
    activeRequestIdRef.current = ++requestIdRef.current;
    setIsRunning(false);
    setRuntimeState("idle");
    setConsoleOutput("");
    setConsoleHasError(false);
    setRunDuration(null);
  }, [clearRunTimeout]);

  const switchProject = (projectId: string) => {
    const nextProject = projectCollection.projects.find((project) => project.id === projectId);
    if (!nextProject || nextProject.id === activeProjectId) return;
    activeProjectIdRef.current = nextProject.id;
    workspaceRef.current = nextProject.workspace;
    resetRuntime();
    setProjectCollection((current) => current.projects.some((project) => project.id === nextProject.id)
      ? { ...current, activeProjectId: nextProject.id }
      : current);
    setActiveFileName("main.py");
    setOpenTabs(["main.py"]);
    setFileError(null);
    setShowNewFileForm(false);
    setShowProjectMenu(false);
    setShowNewProjectForm(false);
    setProjectError(null);
  };

  const startNewProject = () => {
    setShowFileSidebar(false);
    if (projectCollection.projects.length >= MAX_PROJECTS) {
      setProjectError(`Podés guardar hasta ${MAX_PROJECTS} proyectos en este navegador.`);
      setShowProjectMenu(true);
      setShowNewProjectForm(false);
      return;
    }
    setProjectError(null);
    setNewProjectName(`mi-proyecto-${projectCollection.projects.length + 1}`);
    setShowProjectMenu(true);
    setShowNewProjectForm(true);
  };

  const createProject = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (projectCollection.projects.length >= MAX_PROJECTS) {
      setProjectError(`Podés guardar hasta ${MAX_PROJECTS} proyectos en este navegador.`);
      return;
    }
    const projectName = newProjectName.trim().slice(0, 64)
      || `mi-proyecto-${projectCollection.projects.length + 1}`;
    const freshWorkspace = { ...createDefaultWorkspace(), projectName };
    const freshProject = {
      id: createProjectId(),
      workspace: freshWorkspace,
    };
    activeProjectIdRef.current = freshProject.id;
    workspaceRef.current = freshWorkspace;
    resetRuntime();
    setProjectCollection((current) => ({
      ...current,
      projects: [...current.projects, freshProject],
      activeProjectId: freshProject.id,
    }));
    setActiveFileName("main.py");
    setOpenTabs(["main.py"]);
    setFileError(null);
    setProjectError(null);
    setNewProjectName("");
    setShowNewProjectForm(false);
    setShowProjectMenu(false);
  };

  const runLabel = runtimeState === "loading" ? "Iniciando Python…" : "Ejecutar";

  return (
    <main className="python-ide">
      <header className="ide-topbar">
        <div className="ide-brand">
          <div className="ide-brand-mark"><Code2 size={19} strokeWidth={2.5} /></div>
          <div className="ide-brand-copy">
            <span>CoreX</span>
            <small>tu espacio de Python</small>
          </div>
        </div>

        <button
          type="button"
          className="ide-icon-button ide-mobile-files"
          onClick={() => setShowFileSidebar((open) => !open)}
          aria-label={showFileSidebar ? "Cerrar archivos" : "Abrir archivos"}
        >
          <FolderOpen size={17} />
        </button>

        <div className="ide-project-area" ref={projectMenuRef}>
          <div className="ide-project-title">
            <span className="ide-project-mark"><Code2 size={14} /></span>
            <input
              value={workspace.projectName}
              onChange={(event) => setWorkspace((current) => ({
                ...current,
                projectName: event.target.value.slice(0, 64),
              }))}
              aria-label="Nombre del proyecto"
              title="Cambiar nombre del proyecto"
              maxLength={64}
            />
            <button
              type="button"
              className={`ide-project-menu-toggle ${showProjectMenu ? "is-open" : ""}`}
              onClick={() => {
                setShowProjectMenu((open) => !open);
                setShowNewProjectForm(false);
                setProjectError(null);
              }}
              aria-label={showProjectMenu ? "Cerrar selector de proyectos" : "Abrir selector de proyectos"}
              aria-expanded={showProjectMenu}
              aria-haspopup="dialog"
            >
              <ChevronDown size={15} />
            </button>
          </div>
          {showProjectMenu && (
            <div className="ide-project-menu" role="dialog" aria-label="Proyectos locales">
              <div className="ide-project-menu-heading">
                <div><strong>{showNewProjectForm ? "Crear proyecto" : "Tus proyectos"}</strong><span>Guardados en este navegador</span></div>
                <button type="button" onClick={() => { setShowProjectMenu(false); setShowNewProjectForm(false); }} aria-label="Cerrar selector">
                  <X size={15} />
                </button>
              </div>
              {showNewProjectForm ? (
                <form className="ide-project-create-form" onSubmit={createProject}>
                  <label htmlFor="ide-new-project-name">Nombre del proyecto</label>
                  <input
                    id="ide-new-project-name"
                    ref={newProjectInputRef}
                    value={newProjectName}
                    onChange={(event) => setNewProjectName(event.target.value)}
                    placeholder="Mi primer programa"
                    maxLength={64}
                  />
                  <div>
                    <button type="button" className="ide-project-cancel" onClick={() => { setShowNewProjectForm(false); setProjectError(null); }}>Volver</button>
                    <button type="submit" className="ide-project-create-submit"><FolderPlus size={14} /> Crear</button>
                  </div>
                </form>
              ) : (
                <>
                  <div className="ide-project-list">
                    {projectCollection.projects.map((project) => (
                      <button
                        type="button"
                        key={project.id}
                        className={`ide-project-option ${project.id === activeProjectId ? "is-active" : ""}`}
                        onClick={() => switchProject(project.id)}
                        aria-pressed={project.id === activeProjectId}
                      >
                        <span className="ide-project-option-icon"><Code2 size={14} /></span>
                        <span className="ide-project-option-copy">
                          <strong>{project.workspace.projectName || "Sin nombre"}</strong>
                          <small>{project.workspace.files.length} {project.workspace.files.length === 1 ? "archivo" : "archivos"}</small>
                        </span>
                        {project.id === activeProjectId && <Check size={15} />}
                      </button>
                    ))}
                  </div>
                  <button type="button" className="ide-project-new" onClick={startNewProject} disabled={projectCollection.projects.length >= MAX_PROJECTS}>
                    <Plus size={15} /><span>Nuevo proyecto</span>
                  </button>
                </>
              )}
              {projectError && <p className="ide-project-error" role="alert">{projectError}</p>}
              <div className="ide-project-menu-footer">{projectCollection.projects.length} de {MAX_PROJECTS} proyectos</div>
            </div>
          )}
        </div>
        <div className="ide-save-status" title="El proyecto se guarda en Supabase y en este navegador">
          {saveStatus === "saving" ? <Save size={14} /> : saveStatus === "saved" ? <Check size={14} /> : saveStatus === "preview" ? <Eye size={14} /> : <CircleHelp size={14} />}
          <span>{saveStatus === "saving" ? "Guardando" : saveStatus === "saved" ? "Guardado en la nube" : saveStatus === "preview" ? "Vista previa, sin guardar" : "No se pudo sincronizar"}</span>
        </div>

        <div className="ide-topbar-actions">
          <span className="ide-language-badge"><span /> Python</span>
          <button
            type="button"
            className={`ide-assistant-toggle ${assistantOpen ? "is-active" : ""}`}
            onClick={() => setAssistantOpen((open) => !open)}
            aria-expanded={assistantOpen}
            aria-label={assistantOpen ? "Cerrar asistente" : "Abrir asistente"}
          >
            <Bot size={15} /> <span>Asistente</span>
          </button>
          {isRunning ? (
            <button
              type="button"
              className="ide-run-button is-stop"
              onClick={stopCode}
              aria-label="Detener ejecución"
            >
              <Square size={13} fill="currentColor" /> <span>Detener</span>
            </button>
          ) : (
            <button type="button" className="ide-run-button" onClick={runCode} aria-label={runLabel}>
              <Play size={14} fill="currentColor" /> <span>{runLabel}</span>
            </button>
          )}
        </div>
      </header>

      <div className="ide-body">
        {showFileSidebar && (
          <button
            type="button"
            className="ide-mobile-backdrop"
            onClick={() => setShowFileSidebar(false)}
            aria-label="Cerrar panel de archivos"
          />
        )}
        <aside className={`ide-file-sidebar ${showFileSidebar ? "is-mobile-open" : ""}`}>
          <div className="ide-sidebar-heading">
            <div><FolderOpen size={14} /><span>Archivos</span></div>
            <div className="ide-sidebar-actions">
              <button
                type="button"
                onClick={() => { setShowNewFileForm((open) => !open); setFileError(null); }}
                title="Crear archivo"
                aria-label="Crear archivo"
              ><FilePlus2 size={15} /></button>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                title="Importar archivos"
                aria-label="Importar archivos"
              ><Upload size={14} /></button>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept=".py,.txt,.json,.csv"
                className="sr-only"
                onChange={(event) => {
                  void importFiles(event.currentTarget.files);
                  event.currentTarget.value = "";
                }}
              />
            </div>
          </div>

          <div className="ide-file-list">
            {workspace.files.map((file) => (
              <div
                key={file.name}
                className={`ide-file-row ${activeFile?.name === file.name ? "is-active" : ""}`}
              >
                <button type="button" onClick={() => openFile(file.name)} title={file.name}>
                  <FileCode2 size={14} className={file.name.endsWith(".py") ? "ide-python-file" : ""} />
                  <span>{file.name}</span>
                </button>
                {file.name !== "main.py" && (
                  <button
                    type="button"
                    className="ide-file-delete"
                    onClick={() => deleteFile(file.name)}
                    aria-label={`Borrar ${file.name}`}
                    title={`Borrar ${file.name}`}
                  ><Trash2 size={13} /></button>
                )}
              </div>
            ))}
          </div>

          {showNewFileForm && (
            <form className="ide-new-file-form" onSubmit={createFile}>
              <input
                ref={newFileInputRef}
                value={newFileName}
                onChange={(event) => setNewFileName(event.target.value)}
                placeholder="nombre.py"
                aria-label="Nombre del nuevo archivo"
                maxLength={96}
              />
              <button type="submit" aria-label="Confirmar nuevo archivo"><Check size={14} /></button>
              <button type="button" onClick={() => setShowNewFileForm(false)} aria-label="Cancelar"><X size={14} /></button>
            </form>
          )}
          {fileError && <p className="ide-file-error" role="alert">{fileError}</p>}

          <div className="ide-sidebar-bottom">
            <button type="button" onClick={startNewProject}>
              <FolderPlus size={15} /><span>Nuevo proyecto</span>
            </button>
            <div className="ide-python-runtime"><span className="ide-status-dot" /> Python se ejecuta en tu navegador</div>
          </div>
        </aside>

        <section className="ide-main-column">
          <div className="ide-editor-tabs">
            {openTabs.filter((tab) => workspace.files.some((file) => file.name === tab)).map((tab) => (
              <div key={tab} className={`ide-editor-tab ${tab === activeFile?.name ? "is-active" : ""}`}>
                <button type="button" onClick={() => setActiveFileName(tab)}>
                  <FileCode2 size={13} className="ide-python-file" /> {tab}
                </button>
                {tab !== "main.py" && (
                  <button type="button" onClick={() => closeTab(tab)} aria-label={`Cerrar ${tab}`}>
                    <X size={12} />
                  </button>
                )}
              </div>
            ))}
            <span className="ide-editor-tab-space" />
            <button type="button" className="ide-clear-console" onClick={() => { setConsoleOutput(""); setConsoleHasError(false); }}>
              <Terminal size={14} /> <span>Consola</span>
            </button>
          </div>

          <div
            className="ide-code-area"
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                runCode();
              }
            }}
          >
            {activeFile ? (
              <CodeMirror
                key={activeFile.name}
                value={activeFile.content}
                height="100%"
                theme="light"
                extensions={[...(activeFile.name.endsWith(".py") ? [python()] : []), EditorView.lineWrapping]}
                onChange={(value) => updateFileContents(activeFile.name, value)}
                basicSetup={{
                  lineNumbers: true,
                  foldGutter: true,
                  highlightActiveLine: true,
                  highlightActiveLineGutter: true,
                  bracketMatching: true,
                  closeBrackets: true,
                  autocompletion: true,
                }}
                aria-label={`Editor de ${activeFile.name}`}
              />
            ) : (
              <div className="ide-empty-editor">
                <FileCode2 size={24} />
                <p>Elegí un archivo para empezar.</p>
              </div>
            )}
          </div>

          <section className="ide-console" aria-label="Consola de Python">
            <div className="ide-console-heading">
              <div><Terminal size={15} /><span>Consola</span></div>
              <div className="ide-console-meta">
                <span className={`ide-run-status ${runtimeState === "error" ? "has-error" : runtimeState === "running" || runtimeState === "loading" ? "is-running" : ""}`}>
                  {isRunning && <LoaderCircle size={12} className="ide-spin" />}
                  {runtimeState === "loading" ? "Preparando" : runtimeState === "running" ? "Ejecutando" : runtimeState === "error" ? "Con error" : runtimeState === "ready" ? "Listo" : "Esperando"}
                </span>
                {runDuration !== null && <span>{runDuration} ms</span>}
                <button type="button" onClick={() => { setConsoleOutput(""); setConsoleHasError(false); setRunDuration(null); }} aria-label="Limpiar consola" title="Limpiar consola">
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
            <pre className={`ide-console-output ${consoleHasError ? "has-error" : ""}`} aria-live="polite">
              {consoleOutput || <span className="ide-console-placeholder">Tocá Ejecutar para ver la salida de main.py.</span>}
            </pre>
          </section>
        </section>

        {assistantOpen && (
          <aside className="ide-assistant-panel">
            <div className="ide-assistant-heading">
              <div><Bot size={17} /><span>Asistente</span></div>
              <button type="button" onClick={() => setAssistantOpen(false)} aria-label="Cerrar asistente"><X size={16} /></button>
            </div>
            <div className="ide-assistant-empty">
              <div className="ide-assistant-icon"><MessageCircle size={20} /></div>
              <h2>Asistente opcional</h2>
              <p>El editor y la ejecución de Python funcionan sin IA.</p>
              <div className="ide-provider-note">
                <strong>Este panel todavía no está conectado</strong>
                <span>Podés crear proyectos, editar archivos y ejecutar Python sin activar un asistente.</span>
              </div>
            </div>
            <div className="ide-assistant-footer">
              <span>El asistente no afecta el guardado ni la ejecución del código.</span>
            </div>
          </aside>
        )}
      </div>

      <footer className="ide-statusbar">
        <div><span className="ide-status-dot" /> <span>Listo</span><span className="ide-status-separator">·</span><span>Python</span></div>
        <div><span>UTF-8</span><span className="ide-status-separator">·</span><span>LF</span><span className="ide-status-separator">·</span><span>{activeFile?.name ?? "sin archivo"}</span></div>
      </footer>
    </main>
  );
}

export default PythonIDE;