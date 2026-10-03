export type WorkspaceFile = {
  name: string;
  content: string;
};

export type PythonWorkspace = {
  projectName: string;
  files: WorkspaceFile[];
};

export type PythonProject = {
  id: string;
  workspace: PythonWorkspace;
};

export type PythonProjectCollection = {
  projects: PythonProject[];
  activeProjectId: string;
};

export type PythonWorkerRequest = {
  type: "run";
  requestId: number;
  files: WorkspaceFile[];
  entry: string;
};

export type PythonWorkerResponse =
  | { type: "status"; status: "loading" | "running"; requestId: number }
  | {
      type: "complete";
      requestId: number;
      stdout: string;
      stderr: string;
      hasError: boolean;
      durationMs: number;
    }
  | { type: "fatal"; requestId: number; message: string };

export const WORKSPACE_STORAGE_KEY = "programa-hablando.python-workspace.v1";
export const MAX_WORKSPACE_FILES = 20;
export const MAX_PROJECT_FILE_BYTES = 500_000;
export const MAX_IMPORTED_FILES_PER_BATCH = 10;
export const MAX_PROJECTS = 12;
export const PROJECTS_STORAGE_KEY = "programa-hablando.python-projects.v1";

const starterCode = `# ¡Hola! Este es tu espacio de Python.
# Cambiá el código y tocá Ejecutar para ver la salida.

nombre = "mundo"
print(f"Hola, {nombre} 👋")
`;

export function createDefaultWorkspace(): PythonWorkspace {
  return {
    projectName: "mi-proyecto",
    files: [{ name: "main.py", content: starterCode }],
  };
}

export function isSupportedWorkspaceFile(name: string): boolean {
  return /\.(py|txt|json|csv)$/i.test(name);
}

export function normalizeWorkspaceFileName(value: string): string | null {
  const baseName = value.trim().replaceAll("\\", "/").split("/").pop() ?? "";
  const safeName = baseName
    .replace(/[^\p{L}\p{N}_.-]/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^\.+|\.+$/g, "");
  if (!safeName) return null;
  const withExtension = safeName.includes(".") ? safeName : `${safeName}.py`;
  return isSupportedWorkspaceFile(withExtension) ? withExtension.slice(0, 96) : null;
}

export function loadSavedWorkspace(): PythonWorkspace {
  try {
    const raw = localStorage.getItem(WORKSPACE_STORAGE_KEY);
    if (!raw) return createDefaultWorkspace();
    return sanitizeWorkspace(JSON.parse(raw) as unknown);
  } catch {
    return createDefaultWorkspace();
  }
}

function sanitizeWorkspace(value: unknown): PythonWorkspace {
  if (!value || typeof value !== "object") return createDefaultWorkspace();
  const candidate = value as Partial<PythonWorkspace>;
  const files = Array.isArray(candidate.files)
    ? candidate.files
        .filter(
          (file): file is WorkspaceFile =>
            Boolean(file) &&
            typeof file === "object" &&
            typeof file.name === "string" &&
            typeof file.content === "string" &&
            isSupportedWorkspaceFile(file.name) &&
            file.name.length <= 96 &&
            file.content.length <= MAX_PROJECT_FILE_BYTES,
        )
        .slice(0, MAX_WORKSPACE_FILES)
    : [];
  if (!files.some((file) => file.name === "main.py")) {
    files.unshift(createDefaultWorkspace().files[0]);
  }
  return {
    projectName:
      typeof candidate.projectName === "string" && candidate.projectName.trim()
        ? candidate.projectName.trim().slice(0, 64)
        : "mi-proyecto",
    files,
  };
}

export function loadProjectCollection(): PythonProjectCollection {
  try {
    const raw = localStorage.getItem(PROJECTS_STORAGE_KEY);
    if (raw) {
      const saved: unknown = JSON.parse(raw);
      if (saved && typeof saved === "object") {
        const candidate = saved as Partial<PythonProjectCollection>;
        const projects: PythonProject[] = [];
        const seenIds = new Set<string>();
        if (Array.isArray(candidate.projects)) {
          for (const value of candidate.projects) {
            if (!value || typeof value !== "object") continue;
            const project = value as Partial<PythonProject>;
            if (typeof project.id !== "string" || !project.id.trim() || !project.workspace) continue;
            const id = project.id.trim().slice(0, 80);
            if (!id || seenIds.has(id)) continue;
            seenIds.add(id);
            projects.push({ id, workspace: sanitizeWorkspace(project.workspace) });
            if (projects.length >= MAX_PROJECTS) break;
          }
        }
        if (projects.length) {
          const activeProjectId =
            typeof candidate.activeProjectId === "string" &&
            projects.some((project) => project.id === candidate.activeProjectId)
              ? candidate.activeProjectId
              : projects[0].id;
          return { projects, activeProjectId };
        }
      }
    }
    const workspace = loadSavedWorkspace();
    const migrated = { id: "proyecto-principal", workspace };
    return { projects: [migrated], activeProjectId: migrated.id };
  } catch {
    const fallback = { id: "proyecto-principal", workspace: createDefaultWorkspace() };
    return { projects: [fallback], activeProjectId: fallback.id };
  }
}

export function createProjectId(): string {
  const id = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return `proyecto-${id}`;
}