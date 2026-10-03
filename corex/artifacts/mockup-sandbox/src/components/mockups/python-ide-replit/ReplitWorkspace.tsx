import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { python } from "@codemirror/lang-python";
import { EditorView } from "@codemirror/view";
import { Check, ChevronDown, CircleHelp, Code2, FileCode2, FilePlus2, FolderOpen, FolderPlus, Play, Plus, ShieldCheck, Terminal, Trash2, X } from "lucide-react";
import "./replit-workspace.css";

const editorTheme = EditorView.theme({
  "&": { color: "#263f36", backgroundColor: "#ffffff" },
  ".cm-content": { caretColor: "#197a59" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "#197a59" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": { backgroundColor: "#d9eee2" },
  ".cm-activeLine": { backgroundColor: "#f5f8f4" },
  ".cm-gutters": { color: "#a8b3ac", backgroundColor: "#fbfcfa", border: "none" },
  ".cm-activeLineGutter": { backgroundColor: "#f5f8f4" },
}, { dark: false });

type WorkspaceFile = { name: string; content: string };
type Project = { id: string; name: string; files: WorkspaceFile[] };
type SavedState = { projects: Project[]; activeProjectId: string };

const STORAGE_KEY = "programa-hablando.replit-workspace.v1";
const firstCode = `# Tu primer programa en Python
# Cambiá el nombre y volvé a ejecutar.

nombre = "Lucía"
print(f"Hola, {nombre}")
print("Ya estás programando.")
`;
const seedProjects: Project[] = [
  {
    id: "primeros-pasos",
    name: "Primeros pasos",
    files: [
      { name: "main.py", content: firstCode },
      { name: "ideas.txt", content: "Probá cambiar el nombre.\nDespués, agregá otro print().\n" },
    ],
  },
  {
    id: "lista-de-tareas",
    name: "Lista de tareas",
    files: [
      { name: "main.py", content: `# Una lista para organizar el día\ntareas = ["Leer un capítulo", "Salir a caminar", "Practicar Python"]\n\nprint("Para hoy:")\nfor tarea in tareas:\n    print("- " + tarea)\n` },
      { name: "ayuda.py", content: `def mostrar_titulo(titulo):\n    print(titulo.upper())\n` },
    ],
  },
  {
    id: "conversor-temperatura",
    name: "Conversor de temperatura",
    files: [
      { name: "main.py", content: `# De grados Celsius a Fahrenheit\ngrados_c = 21\nfahrenheit = grados_c * 9 / 5 + 32\n\nprint(f"{grados_c} °C equivalen a {fahrenheit} °F")\n` },
      { name: "notas.txt", content: "Fórmula: Fahrenheit = Celsius × 9/5 + 32\n" },
    ],
  },
];

function readSavedState(): SavedState {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null") as SavedState | null;
    if (parsed && Array.isArray(parsed.projects) && parsed.projects.length > 0) {
      const projects = parsed.projects.filter((project) => project?.id && project?.name && Array.isArray(project.files));
      if (projects.length) return { projects, activeProjectId: projects.some((project) => project.id === parsed.activeProjectId) ? parsed.activeProjectId : projects[0].id };
    }
  } catch {
    // Start with the local sample projects when saved data is unavailable.
  }
  return { projects: seedProjects, activeProjectId: seedProjects[0].id };
}

function safeFileName(value: string) {
  const name = value.trim().replaceAll("\\", "/").split("/").pop()?.replace(/[^\p{L}\p{N}_.-]/gu, "-").replace(/-+/g, "-").replace(/^\.+|\.+$/g, "");
  if (!name) return null;
  const result = name.includes(".") ? name : `${name}.py`;
  return /\.(py|txt|json|csv)$/i.test(result) ? result.slice(0, 80) : null;
}

function previewOutput(source: string) {
  const variables: Record<string, string> = {};
  const lines: string[] = [];
  for (const line of source.split("\n")) {
    const assignment = line.match(/^\s*([A-Za-z_]\w*)\s*=\s*(?:"([^"]*)"|'([^']*)'|(-?\d+(?:\.\d+)?))\s*$/);
    if (assignment) {
      variables[assignment[1]] = assignment[2] ?? assignment[3] ?? assignment[4] ?? "";
      continue;
    }
    const print = line.match(/^\s*print\((.*)\)\s*(?:#.*)?$/);
    if (!print) continue;
    const expression = print[1].trim();
    const interpolated = expression.match(/^f(["'])(.*)\1$/);
    const quoted = expression.match(/^["'](.*)["']$/);
    const value = interpolated
      ? interpolated[2].replace(/\{([A-Za-z_]\w*)\}/g, (_, key: string) => variables[key] ?? `{${key}}`)
      : quoted
        ? quoted[1]
        : variables[expression] ?? (expression.match(/^-?\d+(?:\.\d+)?$/) ? expression : "");
    if (value) lines.push(value);
  }
  return lines.length ? lines.join("\n") : "El programa terminó sin mostrar texto.";
}

export function ReplitWorkspace() {
  const [saved, setSaved] = useState<SavedState>(readSavedState);
  const [activeFileName, setActiveFileName] = useState("main.py");
  const [openTabs, setOpenTabs] = useState(["main.py"]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [creatingProject, setCreatingProject] = useState(false);
  const [projectNameInput, setProjectNameInput] = useState("");
  const [fileFormOpen, setFileFormOpen] = useState(false);
  const [fileNameInput, setFileNameInput] = useState("");
  const [fileError, setFileError] = useState("");
  const [mobileFilesOpen, setMobileFilesOpen] = useState(false);
  const [saveState, setSaveState] = useState<"saving" | "saved" | "error">("saved");
  const [running, setRunning] = useState(false);
  const [consoleText, setConsoleText] = useState("");
  const [runState, setRunState] = useState<"idle" | "running" | "ready">("idle");
  const [duration, setDuration] = useState<number | null>(null);
  const newProjectInput = useRef<HTMLInputElement>(null);
  const newFileInput = useRef<HTMLInputElement>(null);

  const activeProject = useMemo(
    () => saved.projects.find((project) => project.id === saved.activeProjectId) ?? saved.projects[0],
    [saved],
  );
  const activeFile = useMemo(
    () => activeProject?.files.find((file) => file.name === activeFileName) ?? activeProject?.files[0],
    [activeFileName, activeProject],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSaveState("saving");
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
        setSaveState("saved");
      } catch {
        setSaveState("error");
      }
    }, 300);
    return () => window.clearTimeout(timer);
  }, [saved]);

  useEffect(() => {
    if (creatingProject) newProjectInput.current?.focus();
  }, [creatingProject]);

  useEffect(() => {
    if (fileFormOpen) newFileInput.current?.focus();
  }, [fileFormOpen]);

  const updateFile = useCallback((name: string, content: string) => {
    setSaved((state) => ({
      ...state,
      projects: state.projects.map((project) => project.id !== state.activeProjectId
        ? project
        : { ...project, files: project.files.map((file) => file.name === name ? { ...file, content } : file) }),
    }));
  }, []);

  const selectProject = (id: string) => {
    const project = saved.projects.find((item) => item.id === id);
    if (!project) return;
    setSaved((state) => ({ ...state, activeProjectId: id }));
    setActiveFileName("main.py");
    setOpenTabs(["main.py"]);
    setConsoleText("");
    setDuration(null);
    setRunState("idle");
    setMenuOpen(false);
    setCreatingProject(false);
  };

  const createProject = (event: FormEvent) => {
    event.preventDefault();
    const name = projectNameInput.trim().slice(0, 48);
    if (!name) return;
    const id = `${name.toLocaleLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "proyecto"}-${Date.now().toString(36)}`;
    const project: Project = { id, name, files: [{ name: "main.py", content: firstCode }] };
    setSaved((state) => ({ projects: [...state.projects, project], activeProjectId: id }));
    setProjectNameInput("");
    setCreatingProject(false);
    setActiveFileName("main.py");
    setOpenTabs(["main.py"]);
    setConsoleText("");
    setRunState("idle");
    setMenuOpen(false);
  };

  const openFile = (name: string) => {
    setActiveFileName(name);
    setOpenTabs((tabs) => tabs.includes(name) ? tabs : [...tabs, name]);
    setMobileFilesOpen(false);
  };

  const closeTab = (name: string) => {
    const next = openTabs.filter((tab) => tab !== name);
    const tabs = next.length ? next : ["main.py"];
    setOpenTabs(tabs);
    if (activeFileName === name) setActiveFileName(tabs[tabs.length - 1]);
  };

  const createFile = (event: FormEvent) => {
    event.preventDefault();
    const name = safeFileName(fileNameInput);
    if (!name) return setFileError("Usá un nombre .py, .txt, .json o .csv.");
    if (activeProject.files.some((file) => file.name.toLowerCase() === name.toLowerCase())) return setFileError("Ya existe un archivo con ese nombre.");
    setSaved((state) => ({
      ...state,
      projects: state.projects.map((project) => project.id === state.activeProjectId ? { ...project, files: [...project.files, { name, content: "" }] } : project),
    }));
    setFileNameInput("");
    setFileError("");
    setFileFormOpen(false);
    openFile(name);
  };

  const deleteFile = (name: string) => {
    if (name === "main.py") {
      setFileError("main.py es el archivo de inicio y no se puede borrar.");
      return;
    }
    setSaved((state) => ({
      ...state,
      projects: state.projects.map((project) => project.id === state.activeProjectId ? { ...project, files: project.files.filter((file) => file.name !== name) } : project),
    }));
    setOpenTabs((tabs) => tabs.filter((tab) => tab !== name));
    if (activeFileName === name) setActiveFileName("main.py");
  };

  const runCode = () => {
    if (running) return;
    const mainFile = activeProject?.files.find((file) => file.name === "main.py");
    if (!mainFile) return;
    setRunning(true);
    setRunState("running");
    setDuration(null);
    setConsoleText("Preparando la ejecución…");
    window.setTimeout(() => {
      setConsoleText(previewOutput(mainFile.content));
      setDuration(38);
      setRunning(false);
      setRunState("ready");
    }, 450);
  };

  const clearConsole = () => {
    setConsoleText("");
    setDuration(null);
    setRunState("idle");
  };

  return (
    <main className="replit-workspace">
      <header className="rw-topbar">
        <div className="rw-brand">
          <div className="rw-brand-mark"><Code2 size={17} strokeWidth={2.2} /></div>
          <div><div className="rw-brand-name">CoreX</div><div className="rw-brand-caption">Tu espacio de Python</div></div>
        </div>
        <span className="rw-top-divider" />
        <button type="button" className="rw-mobile-files" aria-label="Abrir archivos" onClick={() => setMobileFilesOpen((open) => !open)}><FolderOpen size={16} /></button>
        <div className="rw-project-picker-wrap">
          <button type="button" className={`rw-project-picker ${menuOpen ? "is-open" : ""}`} onClick={() => setMenuOpen((open) => !open)} aria-expanded={menuOpen}>
            <span className="rw-project-glyph"><Code2 size={14} /></span>
            <span className="rw-project-picker-copy"><strong>{activeProject?.name ?? "Proyecto"}</strong><span>Proyecto local</span></span>
            <ChevronDown size={14} />
          </button>
          {menuOpen && <div className="rw-project-menu">
            <div className="rw-menu-label">Tus proyectos</div>
            {!creatingProject ? <>
              {saved.projects.map((project) => <button type="button" key={project.id} className={`rw-project-option ${project.id === saved.activeProjectId ? "is-selected" : ""}`} onClick={() => selectProject(project.id)}>
                <FolderOpen size={15} />
                <span className="rw-project-option-copy"><strong>{project.name}</strong><span>{project.files.length} {project.files.length === 1 ? "archivo" : "archivos"} · guardado en este navegador</span></span>
                {project.id === saved.activeProjectId && <Check size={14} />}
              </button>)}
              <div className="rw-menu-divider" />
              <button type="button" className="rw-create-project" onClick={() => setCreatingProject(true)}><FolderPlus size={15} /> Crear proyecto</button>
            </> : <form className="rw-project-create-form" onSubmit={createProject}>
              <label htmlFor="rw-new-project">Nombre del proyecto</label>
              <input id="rw-new-project" ref={newProjectInput} value={projectNameInput} onChange={(event) => setProjectNameInput(event.target.value)} placeholder="Por ejemplo, Mi primera idea" maxLength={48} />
              <button type="submit">Crear proyecto</button>
              <button type="button" className="rw-small-icon" onClick={() => setCreatingProject(false)} aria-label="Cancelar"><X size={14} /></button>
            </form>}
          </div>}
        </div>
        <div className="rw-top-spacer" />
        <div className="rw-save-state" aria-live="polite">
          {saveState === "saving" ? <><span className="rw-loading-dots"><i /><i /><i /></span><span>Guardando</span></> : saveState === "saved" ? <><Check size={13} /><span>Guardado en este navegador</span></> : <><CircleHelp size={13} /><span>No se pudo guardar</span></>}
        </div>
        <div className="rw-language"><span className="rw-language-mark">Py</span> Python</div>
        <button type="button" className="rw-run-button" disabled={running} onClick={runCode}>
          {running ? <span className="rw-loading-dots"><i /><i /><i /></span> : <Play size={14} fill="currentColor" />}
          <span>{running ? "Ejecutando" : "Ejecutar"}</span>
        </button>
      </header>

      <div className="rw-workspace-body">
        {mobileFilesOpen && <button className="rw-mobile-backdrop" type="button" aria-label="Cerrar archivos" onClick={() => setMobileFilesOpen(false)} />}
        <nav className="rw-rail" aria-label="Herramientas del espacio">
          <button type="button" className="rw-rail-button is-active" aria-label="Archivos"><FolderOpen size={17} /></button>
          <button type="button" className="rw-rail-button" aria-label="Crear archivo" onClick={() => setFileFormOpen(true)}><FilePlus2 size={16} /></button>
          <div className="rw-rail-bottom"><span className="rw-rail-button" aria-label="Python"><Code2 size={16} /></span></div>
        </nav>

        <aside className={`rw-file-sidebar ${mobileFilesOpen ? "is-mobile-open" : ""}`}>
          <div className="rw-sidebar-head">
            <div className="rw-sidebar-head-title"><FolderOpen size={14} /><span>Archivos</span></div>
            <div className="rw-sidebar-actions">
              <button type="button" className="rw-small-icon" aria-label="Crear archivo" onClick={() => { setFileFormOpen((open) => !open); setFileError(""); }}><FilePlus2 size={15} /></button>
            </div>
          </div>
          <div className="rw-project-note"><strong>{activeProject?.name}</strong><br />Archivos guardados solo en este navegador.</div>
          <div className="rw-files">
            {activeProject?.files.map((file) => <div key={file.name} className={`rw-file-row ${activeFile?.name === file.name ? "is-active" : ""}`}>
              <button type="button" className="rw-file-open" onClick={() => openFile(file.name)}>
                <FileCode2 size={14} className={file.name.endsWith(".py") ? "rw-py-file" : ""} /><span>{file.name}</span>
              </button>
              {file.name !== "main.py" && <button type="button" className="rw-small-icon rw-file-delete" aria-label={`Borrar ${file.name}`} onClick={() => deleteFile(file.name)}><Trash2 size={13} /></button>}
            </div>)}
          </div>
          {fileFormOpen && <form className="rw-new-file-form" onSubmit={createFile}>
            <input ref={newFileInput} value={fileNameInput} onChange={(event) => setFileNameInput(event.target.value)} placeholder="nombre.py" aria-label="Nombre del nuevo archivo" />
            <button type="submit" aria-label="Crear"><Check size={14} /></button>
            <button type="button" aria-label="Cancelar" onClick={() => { setFileFormOpen(false); setFileError(""); }}><X size={14} /></button>
          </form>}
          {fileError && <p className="rw-file-error">{fileError}</p>}
          <div className="rw-sidebar-footer">
            <button type="button" onClick={() => { setMenuOpen(true); setCreatingProject(true); }}><Plus size={15} /> Proyecto nuevo</button>
            <div className="rw-local-note"><ShieldCheck size={13} /> Tus cambios quedan en este dispositivo</div>
          </div>
        </aside>

        <section className="rw-main-column">
          <div className="rw-editor-toolbar">
            <div className="rw-tabs">{openTabs.filter((tab) => activeProject?.files.some((file) => file.name === tab)).map((tab) => <div key={tab} className={`rw-tab ${tab === activeFile?.name ? "is-active" : ""}`}>
              <button type="button" className="rw-tab-open" onClick={() => setActiveFileName(tab)}><FileCode2 size={13} className={tab.endsWith(".py") ? "rw-py-file" : ""} /><span>{tab}</span></button>
              {tab !== "main.py" && <button type="button" className="rw-small-icon rw-tab-close" aria-label={`Cerrar ${tab}`} onClick={() => closeTab(tab)}><X size={12} /></button>}
            </div>)}</div>
            <span className="rw-toolbar-spacer" />
            <div className="rw-editor-context"><ShieldCheck size={13} /> Se guarda automáticamente</div>
          </div>
          <div className="rw-code-area">
            {activeFile ? <CodeMirror
              key={`${activeProject?.id}-${activeFile.name}`}
              value={activeFile.content}
              height="100%"
              theme={editorTheme}
              extensions={[...(activeFile.name.endsWith(".py") ? [python()] : []), EditorView.lineWrapping]}
              onChange={(value) => updateFile(activeFile.name, value)}
              basicSetup={{ lineNumbers: true, foldGutter: true, highlightActiveLine: true, highlightActiveLineGutter: true, bracketMatching: true, closeBrackets: true, autocompletion: true }}
              aria-label={`Editor de ${activeFile.name}`}
            /> : <div className="rw-console-placeholder">Elegí un archivo para empezar.</div>}
          </div>
          <div className="rw-editor-footer">
            <div><span className="rw-line-stat">Lín 1, col 1</span><span>Python</span></div>
            <div><span>UTF-8</span><span>LF</span><span>{activeFile?.name ?? "Sin archivo"}</span></div>
          </div>
          <section className="rw-console">
            <div className="rw-console-header">
              <div className="rw-console-title"><Terminal size={14} /><span>Consola</span></div>
              <div className="rw-console-meta">
                <span className={`rw-console-status ${runState === "ready" ? "is-ready" : running ? "is-running" : ""}`}>{running ? "Preparando" : runState === "ready" ? "Listo" : "Esperando"}</span>
                {duration !== null && <span className="rw-duration">{duration} ms</span>}
                <button type="button" className="rw-small-icon" aria-label="Limpiar consola" onClick={clearConsole}><Trash2 size={13} /></button>
              </div>
            </div>
            <pre className="rw-console-output">{consoleText || <span className="rw-console-placeholder">La salida de main.py aparece acá cuando tocás Ejecutar.</span>}</pre>
          </section>
        </section>
      </div>
      <footer className="rw-statusbar">
        <div className="rw-statusbar-group"><span className="rw-status-dot" /><span>Espacio listo</span><span className="rw-status-sep">·</span><span>Python</span></div>
        <div className="rw-statusbar-group"><span>{activeProject?.name}</span><span className="rw-status-sep">·</span><span>Local</span></div>
      </footer>
    </main>
  );
}

export default ReplitWorkspace;