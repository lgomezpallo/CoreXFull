import type {
  AppBlueprint,
  AppBuilderExpansionProposal,
  AppBuilderModuleId,
  AppBuilderReference,
  AppBuilderTask,
  AppBuilderTurn,
  LabAnalysisInputSourceKind,
  LabAnalysisResult,
} from "@workspace/api-client-react";
import type { ReferenceAttachment } from "./reference-files";

export const BUILDER_PROJECTS_STORAGE_KEY = "programa-hablando.builder-projects.v1";
export const MAX_BUILDER_PROJECTS = 12;
export const MAX_BUILDER_SOURCES = 5;
const MAX_SAVED_TURNS = 60;
const MAX_SAVED_SOURCE_TEXT = 5000;
export const MAX_GENERATED_PROJECT_FILES = 32;
export const MAX_GENERATED_PROJECT_FILE_CHARS = 70_000;
export const MAX_GENERATED_PROJECT_CHARS = 140_000;
export const MAX_GENERATED_PROJECT_DATA_CHARS = 20_000;

export type BuilderSource = ReferenceAttachment & {
  included: boolean;
  useMode: "reference" | "authorized-base";
  hasVisual: boolean;
  wasTextTrimmed: boolean;
};

export type GeneratedProjectFile = {
  path: string;
  content: string;
};

export type GeneratedProjectWorkspace = {
  files: GeneratedProjectFile[];
  status: "ready" | "error";
  diagnostics: string[];
  data: Record<string, unknown>;
};

export type LabProjectAnalysis = LabAnalysisResult & {
  sourceName: string;
  sourceKind: LabAnalysisInputSourceKind;
  analyzedAt: string;
};

export type LabProjectVersion = {
  id: string;
  createdAt: string;
  label: string;
  jobId?: string;
  files: GeneratedProjectFile[];
  observedFrom: string[];
  reconstructed: string[];
  modified: string[];
};

export type GeneratedProjectRecovery = {
  ownerId: string;
  jobId: string | null;
  kind: "generation" | "build";
  stage: "planning" | "blueprint" | "generation" | "build" | "validation" | "correction" | "ready" | "error";
  generationRequest: {
    mode?: BuilderProject["mode"];
    prompt: string;
    blueprint: AppBlueprint;
    history: AppBuilderTurn[];
    referenceFiles: Array<{
      name: string;
      kind: AppBuilderReference["kind"];
      extractedText: string;
    }>;
  } | null;
  files: GeneratedProjectFile[];
  resumeWithBuild: boolean;
};

export type BuilderProject = {
  id: string;
  name: string;
  mode: "builder" | "lab";
  messages: AppBuilderTurn[];
  blueprint: AppBlueprint | null;
  taskPlan: AppBuilderTask[];
  designConversation: { designBrief: string; readyToBuild: boolean } | null;
  expansionProposal: AppBuilderExpansionProposal | null;
  expansionDecision: "pending" | "approved" | "declined" | "unavailable" | null;
  approvedModuleId: AppBuilderModuleId | null;
  sources: BuilderSource[];
  generatedProject: GeneratedProjectWorkspace | null;
  generatedProjectRecovery: GeneratedProjectRecovery | null;
  labGoal: string;
  labAnalysis: LabProjectAnalysis | null;
  labVersions: LabProjectVersion[];
};

export type BuilderProjectCollection = {
  projects: BuilderProject[];
  activeProjectId: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const GENERATED_TEMPLATE_PATHS = new Set([
  "index.html",
  "package.json",
  "README.md",
  "tsconfig.json",
  "vite.config.ts",
  "src/App.tsx",
  "src/main.tsx",
  "src/styles.css",
  "src/lib/corex.ts",
]);

function isSafeGeneratedProjectPath(filePath: string): boolean {
  if (
    !filePath ||
    filePath.length > 180 ||
    filePath.startsWith("/") ||
    filePath.includes("\\") ||
    filePath.split("/").some((part) => !part || part === "." || part === ".." || part.startsWith("."))
  ) return false;
  if (GENERATED_TEMPLATE_PATHS.has(filePath)) return true;
  return /^src\/(?:components|features|lib|types)\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*\.(?:tsx?|css|svg|json)$/.test(filePath);
}

function sanitizeGeneratedFiles(value: unknown): GeneratedProjectFile[] {
  if (!Array.isArray(value)) return [];
  const files: GeneratedProjectFile[] = [];
  const seenPaths = new Set<string>();
  let totalChars = 0;
  for (const item of value) {
    if (
      !isRecord(item) ||
      typeof item.path !== "string" ||
      typeof item.content !== "string" ||
      !isSafeGeneratedProjectPath(item.path) ||
      item.content.length > MAX_GENERATED_PROJECT_FILE_CHARS ||
      seenPaths.has(item.path)
    ) continue;
    if (totalChars + item.content.length > MAX_GENERATED_PROJECT_CHARS) break;
    seenPaths.add(item.path);
    totalChars += item.content.length;
    files.push({ path: item.path, content: item.content });
    if (files.length >= MAX_GENERATED_PROJECT_FILES) break;
  }
  return files;
}

function sanitizeJsonValue(value: unknown, depth = 0): unknown {
  if (depth > 5) return null;
  if (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) return value;
  if (typeof value === "string") return value.slice(0, 4000);
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => sanitizeJsonValue(item, depth + 1));
  }
  if (!isRecord(value)) return null;
  const entries = Object.entries(value)
    .filter(([key]) =>
      key.length > 0 &&
      key.length <= 80 &&
      !["__proto__", "constructor", "prototype"].includes(key),
    )
    .slice(0, 60);
  return Object.fromEntries(
    entries.map(([key, item]) => [key, sanitizeJsonValue(item, depth + 1)]),
  );
}

export function sanitizeGeneratedProjectData(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const sanitized = sanitizeJsonValue(value);
  if (!isRecord(sanitized)) return {};
  let data = sanitized;
  while (JSON.stringify(data).length > MAX_GENERATED_PROJECT_DATA_CHARS) {
    const keys = Object.keys(data);
    if (!keys.length) return {};
    data = Object.fromEntries(keys.slice(0, -1).map((key) => [key, data[key]]));
  }
  return data;
}

function sanitizeGeneratedProject(value: unknown): GeneratedProjectWorkspace | null {
  if (!isRecord(value)) return null;
  const files = sanitizeGeneratedFiles(value.files);
  if (!files.length) return null;
  return {
    files,
    status: value.status === "ready" ? "ready" : "error",
    diagnostics: Array.isArray(value.diagnostics)
      ? value.diagnostics
        .filter((item): item is string => typeof item === "string")
        .slice(0, 12)
        .map((item) => item.slice(0, 1000))
      : [],
    data: sanitizeGeneratedProjectData(value.data),
  };
}

function sanitizeStringList(value: unknown, count: number, length: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .slice(0, count)
    .map((item) => item.trim().slice(0, length));
}

function sanitizeLabAnalysis(value: unknown): LabProjectAnalysis | null {
  if (
    !isRecord(value) ||
    typeof value.sourceName !== "string" ||
    typeof value.analyzedAt !== "string" ||
    !["apk", "archive", "code", "document", "image", "website"].includes(String(value.sourceKind)) ||
    !isRecord(value.observed)
  ) return null;
  const evidence = value.observed;
  return {
    sourceName: value.sourceName.slice(0, 180),
    sourceKind: value.sourceKind as LabAnalysisInputSourceKind,
    analyzedAt: value.analyzedAt.slice(0, 40),
    summary: typeof value.summary === "string" ? value.summary.slice(0, 1600) : "",
    architecture: typeof value.architecture === "string" ? value.architecture.slice(0, 1600) : "",
    capabilities: sanitizeStringList(value.capabilities, 12, 240),
    observed: {
      filePaths: sanitizeStringList(evidence.filePaths, 80, 180),
      dependencies: sanitizeStringList(evidence.dependencies, 80, 160),
      entryPoints: sanitizeStringList(evidence.entryPoints, 40, 180),
      components: sanitizeStringList(evidence.components, 60, 180),
      assets: sanitizeStringList(evidence.assets, 80, 180),
      strings: sanitizeStringList(evidence.strings, 100, 220),
      permissions: sanitizeStringList(evidence.permissions, 60, 180),
      networkCalls: sanitizeStringList(evidence.networkCalls, 60, 220),
      storage: sanitizeStringList(evidence.storage, 40, 180),
    },
    inferred: sanitizeStringList(value.inferred, 12, 240),
    reusableModules: sanitizeStringList(value.reusableModules, 12, 240),
    adaptationPlan: sanitizeStringList(value.adaptationPlan, 10, 300),
    risks: sanitizeStringList(value.risks, 10, 240),
    blockedOperations: sanitizeStringList(value.blockedOperations, 8, 240),
  };
}

function sanitizeLabVersions(value: unknown): LabProjectVersion[] {
  if (!Array.isArray(value)) return [];
  const versions: LabProjectVersion[] = [];
  for (const item of value) {
    if (
      !isRecord(item) ||
      typeof item.id !== "string" ||
      typeof item.createdAt !== "string" ||
      typeof item.label !== "string"
    ) continue;
    const files = sanitizeGeneratedFiles(item.files);
    if (!files.length) continue;
    versions.push({
      id: item.id.slice(0, 80),
      createdAt: item.createdAt.slice(0, 40),
      label: item.label.slice(0, 120),
      ...(typeof item.jobId === "string" ? { jobId: item.jobId.slice(0, 100) } : {}),
      files,
      observedFrom: sanitizeStringList(item.observedFrom, 8, 180),
      reconstructed: sanitizeStringList(item.reconstructed, 12, 240),
      modified: sanitizeStringList(item.modified, 12, 240),
    });
    if (versions.length >= 4) break;
  }
  return versions;
}

function sanitizeGeneratedProjectRecovery(value: unknown): GeneratedProjectRecovery | null {
  if (
    !isRecord(value) ||
    typeof value.ownerId !== "string" ||
    !value.ownerId.trim() ||
    (value.kind !== "generation" && value.kind !== "build")
  ) return null;

  const stages: GeneratedProjectRecovery["stage"][] = [
    "planning",
    "blueprint",
    "generation",
    "build",
    "validation",
    "correction",
    "ready",
    "error",
  ];
  const stage = stages.includes(value.stage as GeneratedProjectRecovery["stage"])
    ? value.stage as GeneratedProjectRecovery["stage"]
    : value.kind === "build" ? "build" : "generation";
  let generationRequest: GeneratedProjectRecovery["generationRequest"] = null;
  if (value.kind === "generation" && isRecord(value.generationRequest)) {
    const request = value.generationRequest;
    const blueprint = normalizeBlueprint(request.blueprint);
    if (
      typeof request.prompt === "string" &&
      blueprint &&
      Array.isArray(request.history) &&
      Array.isArray(request.referenceFiles)
    ) {
      const referenceFiles = request.referenceFiles.flatMap((reference) => {
        if (
          !isRecord(reference) ||
          typeof reference.name !== "string" ||
          typeof reference.extractedText !== "string" ||
          !["image", "document", "code", "archive", "apk", "binary"].includes(String(reference.kind))
        ) return [];
        return [{
          name: reference.name.slice(0, 160),
          kind: reference.kind as AppBuilderReference["kind"],
          extractedText: reference.extractedText.slice(0, 12_000),
        }];
      }).slice(0, MAX_BUILDER_SOURCES);
      generationRequest = {
        ...(request.mode === "lab" ? { mode: "lab" as const } : {}),
        prompt: request.prompt.slice(0, 1600),
        blueprint,
        history: sanitizeMessages(request.history).slice(-12),
        referenceFiles,
      };
    }
  }
  if (value.kind === "generation" && !generationRequest) return null;

  const files = sanitizeGeneratedFiles(value.files);
  if (value.kind === "build" && !files.length) return null;
  return {
    ownerId: value.ownerId.trim().slice(0, 180),
    jobId: typeof value.jobId === "string" && value.jobId.length <= 80 ? value.jobId : null,
    kind: value.kind,
    stage,
    generationRequest,
    files,
    resumeWithBuild: value.resumeWithBuild === true && files.length > 0,
  };
}

function isBlueprint(value: unknown): value is AppBlueprint {
  if (!isRecord(value)) return false;
  if (
    typeof value.title !== "string" ||
    typeof value.subtitle !== "string" ||
    typeof value.description !== "string" ||
    !["violet", "ocean", "mint", "amber"].includes(String(value.accentColor)) ||
    (value.appKind !== undefined && !["tasks", "habits", "expenses", "prototype"].includes(String(value.appKind))) ||
    !Array.isArray(value.sections)
  ) return false;

  return value.sections.every((section) => {
    if (!isRecord(section) || !Array.isArray(section.items)) return false;
    if (
      typeof section.id !== "string" ||
      !["stats", "list", "features", "form", "progress"].includes(String(section.type)) ||
      typeof section.title !== "string" ||
      typeof section.description !== "string" ||
      typeof section.actionLabel !== "string"
    ) return false;
    return section.items.every((item) =>
      isRecord(item) &&
      typeof item.id === "string" &&
      typeof item.title === "string" &&
      typeof item.description === "string" &&
      typeof item.value === "string" &&
      typeof item.checked === "boolean",
    );
  });
}

function normalizeBlueprint(value: unknown): AppBlueprint | null {
  if (!isBlueprint(value)) return null;
  const record = value as unknown as Record<string, unknown>;
  const appKind = ["tasks", "habits", "expenses", "prototype"].includes(String(record.appKind))
    ? record.appKind as AppBlueprint["appKind"]
    : "prototype";
  return { ...value, appKind };
}

const MODULE_KIND_BY_ID: Record<AppBuilderModuleId, Exclude<AppBlueprint["appKind"], "prototype">> = {
  "tasks-v1": "tasks",
  "habits-v1": "habits",
  "expenses-v1": "expenses",
};

function sanitizeExpansionProposal(value: unknown): AppBuilderExpansionProposal | null {
  if (!isRecord(value)) return null;
  const status = value.status;
  if (
    status !== "not-needed" &&
    status !== "approval-required" &&
    status !== "unavailable"
  ) return null;
  if (typeof value.message !== "string" || !Array.isArray(value.options) || value.options.length > 2) {
    return null;
  }
  const options = value.options.flatMap((rawOption) => {
    if (!isRecord(rawOption)) return [];
    const moduleId = rawOption.moduleId;
    if (
      typeof moduleId !== "string" ||
      !Object.hasOwn(MODULE_KIND_BY_ID, moduleId) ||
      rawOption.appKind !== MODULE_KIND_BY_ID[moduleId as AppBuilderModuleId] ||
      rawOption.runtimeCost !== 0 ||
      typeof rawOption.name !== "string" ||
      typeof rawOption.version !== "string" ||
      typeof rawOption.summary !== "string" ||
      typeof rawOption.reason !== "string" ||
      typeof rawOption.recommended !== "boolean" ||
      !Array.isArray(rawOption.capabilities) ||
      !Array.isArray(rawOption.limitations) ||
      !rawOption.capabilities.every((item) => typeof item === "string") ||
      !rawOption.limitations.every((item) => typeof item === "string")
    ) return [];
    return [{
      moduleId: moduleId as AppBuilderModuleId,
      appKind: MODULE_KIND_BY_ID[moduleId as AppBuilderModuleId],
      name: rawOption.name.slice(0, 80),
      version: rawOption.version.slice(0, 24),
      summary: rawOption.summary.slice(0, 240),
      capabilities: rawOption.capabilities.slice(0, 8).map((item) => item.slice(0, 100)),
      limitations: rawOption.limitations.slice(0, 8).map((item) => item.slice(0, 140)),
      reason: rawOption.reason.slice(0, 220),
      recommended: rawOption.recommended,
      runtimeCost: 0 as const,
    }];
  });
  if (status === "approval-required" && options.length === 0) return null;
  return {
    status,
    message: value.message.slice(0, 400),
    options: status === "approval-required" ? options : [],
  };
}

function sanitizeMessages(value: unknown): AppBuilderTurn[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (turn): turn is AppBuilderTurn =>
        isRecord(turn) &&
        (turn.role === "user" || turn.role === "assistant") &&
        typeof turn.content === "string",
    )
    .slice(-MAX_SAVED_TURNS)
    .map((turn) => ({ role: turn.role, content: turn.content.slice(0, 1600) }));
}

function sanitizeTaskPlan(value: unknown): AppBuilderTask[] {
  if (!Array.isArray(value)) return [];
  const validTaskTypes = new Set<AppBuilderTask["taskType"]>([
    "chat",
    "coding",
    "reasoning",
    "summarization",
    "vision",
    "document",
  ]);
  return value
    .filter((task): task is Record<string, unknown> =>
      isRecord(task) &&
      typeof task.id === "string" &&
      typeof task.title === "string" &&
      (task.capability === "planning" || task.capability === "structured-output"),
    )
    .slice(0, 6)
    .map((task): AppBuilderTask => {
      const taskType = typeof task.taskType === "string" && validTaskTypes.has(task.taskType as AppBuilderTask["taskType"])
        ? task.taskType as AppBuilderTask["taskType"]
        : "reasoning";
      return {
        id: (task.id as string).slice(0, 80),
        title: (task.title as string).slice(0, 140),
        capability: task.capability as AppBuilderTask["capability"],
        taskType,
      };
    });
}

function sanitizeSources(value: unknown): BuilderSource[] {
  if (!Array.isArray(value)) return [];
  const sources: BuilderSource[] = [];
  for (const item of value) {
    if (!isRecord(item) || !isRecord(item.payload)) continue;
    const payload = item.payload;
    const kind = payload.kind;
    if (
      typeof item.id !== "string" ||
      typeof item.name !== "string" ||
      typeof item.detail !== "string" ||
      typeof payload.name !== "string" ||
      typeof payload.extractedText !== "string" ||
      !["image", "document", "code", "archive", "apk", "binary"].includes(String(kind))
    ) continue;

    const imageDataUrl = typeof payload.imageDataUrl === "string"
      ? payload.imageDataUrl.slice(0, 1_200_000)
      : undefined;
    const sanitizedPayload: AppBuilderReference = {
      name: payload.name.slice(0, 160),
      kind: kind as AppBuilderReference["kind"],
      extractedText: payload.extractedText.slice(0, 12_000),
      ...(imageDataUrl ? { imageDataUrl } : {}),
    };
    sources.push({
      id: item.id.slice(0, 100),
      name: item.name.slice(0, 180),
      detail: item.detail.slice(0, 240),
      payload: sanitizedPayload,
      included: item.included !== false,
      useMode: item.useMode === "authorized-base" ? "authorized-base" : "reference",
      hasVisual: item.hasVisual === true || Boolean(imageDataUrl),
      wasTextTrimmed: item.wasTextTrimmed === true,
    });
    if (sources.length >= MAX_BUILDER_SOURCES) break;
  }
  return sources;
}

function sanitizeProject(value: unknown): BuilderProject | null {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id.trim()) return null;
  const name = typeof value.name === "string" && value.name.trim()
    ? value.name.trim().slice(0, 64)
    : "Mi app";
  return {
    id: value.id.trim().slice(0, 80),
    name,
    mode: value.mode === "lab" ? "lab" : "builder",
    messages: sanitizeMessages(value.messages),
    blueprint: normalizeBlueprint(value.blueprint),
    taskPlan: sanitizeTaskPlan(value.taskPlan),
    designConversation: isRecord(value.designConversation) && typeof value.designConversation.designBrief === "string"
      ? { designBrief: value.designConversation.designBrief.slice(0, 6000), readyToBuild: value.designConversation.readyToBuild === true }
      : null,
    expansionProposal: sanitizeExpansionProposal(value.expansionProposal),
    expansionDecision:
      value.expansionDecision === "pending" ||
      value.expansionDecision === "approved" ||
      value.expansionDecision === "declined" ||
      value.expansionDecision === "unavailable"
        ? value.expansionDecision
        : null,
    approvedModuleId:
      typeof value.approvedModuleId === "string" &&
      Object.hasOwn(MODULE_KIND_BY_ID, value.approvedModuleId)
        ? value.approvedModuleId as AppBuilderModuleId
        : null,
    sources: sanitizeSources(value.sources),
    generatedProject: sanitizeGeneratedProject(value.generatedProject),
    generatedProjectRecovery: sanitizeGeneratedProjectRecovery(value.generatedProjectRecovery),
    labGoal: typeof value.labGoal === "string" ? value.labGoal.slice(0, 1600) : "",
    labAnalysis: sanitizeLabAnalysis(value.labAnalysis),
    labVersions: sanitizeLabVersions(value.labVersions),
  };
}

export function serializeBuilderProjectCollection(collection: BuilderProjectCollection): string {
  const persisted: BuilderProjectCollection = {
    ...collection,
    projects: collection.projects.map((project) => ({
      ...project,
      generatedProject: sanitizeGeneratedProject(project.generatedProject),
      generatedProjectRecovery: sanitizeGeneratedProjectRecovery(project.generatedProjectRecovery),
      labGoal: project.labGoal.slice(0, 1600),
      labAnalysis: sanitizeLabAnalysis(project.labAnalysis),
      labVersions: sanitizeLabVersions(project.labVersions),
      sources: project.sources.map((source) => {
        const wasTextTrimmed = source.wasTextTrimmed || source.payload.extractedText.length > MAX_SAVED_SOURCE_TEXT;
        return {
          ...source,
          hasVisual: source.hasVisual || Boolean(source.payload.imageDataUrl),
          wasTextTrimmed,
          payload: {
            ...source.payload,
            extractedText: source.payload.extractedText.slice(0, MAX_SAVED_SOURCE_TEXT),
            imageDataUrl: undefined,
          },
        };
      }),
    })),
  };
  return JSON.stringify(persisted);
}

export function createBuilderProjectId(): string {
  const id = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return `app-${id}`;
}

export function createBuilderProject(
  name = "Mi primera app",
  mode: BuilderProject["mode"] = "builder",
): BuilderProject {
  return {
    id: createBuilderProjectId(),
    name: name.trim().slice(0, 64) || "Mi app",
    mode,
    messages: [],
    blueprint: null,
    taskPlan: [],
    designConversation: null,
    expansionProposal: null,
    expansionDecision: null,
    approvedModuleId: null,
    sources: [],
    generatedProject: null,
    generatedProjectRecovery: null,
    labGoal: "",
    labAnalysis: null,
    labVersions: [],
  };
}

export function createDefaultBuilderCollection(): BuilderProjectCollection {
  const project = {
    id: "app-principal",
    name: "Mi primera app",
    mode: "builder" as const,
    messages: [],
    blueprint: null,
    taskPlan: [],
    designConversation: null,
    expansionProposal: null,
    expansionDecision: null,
    approvedModuleId: null,
    sources: [],
    generatedProject: null,
    generatedProjectRecovery: null,
    labGoal: "",
    labAnalysis: null,
    labVersions: [],
  };
  return { projects: [project], activeProjectId: project.id };
}

export function loadBuilderProjectCollection(): BuilderProjectCollection {
  const fallback = createDefaultBuilderCollection();
  if (typeof window === "undefined") return fallback;

  try {
    const raw = window.localStorage.getItem(BUILDER_PROJECTS_STORAGE_KEY);
    if (!raw) return fallback;
    const saved: unknown = JSON.parse(raw);
    if (!isRecord(saved) || !Array.isArray(saved.projects)) return fallback;

    const projects: BuilderProject[] = [];
    const seenIds = new Set<string>();
    for (const value of saved.projects) {
      const project = sanitizeProject(value);
      if (!project || seenIds.has(project.id)) continue;
      seenIds.add(project.id);
      projects.push(project);
      if (projects.length >= MAX_BUILDER_PROJECTS) break;
    }
    if (!projects.length) return fallback;

    const activeProjectId =
      typeof saved.activeProjectId === "string" &&
      projects.some((project) => project.id === saved.activeProjectId)
        ? saved.activeProjectId
        : projects[0].id;
    return { projects, activeProjectId };
  } catch {
    return fallback;
  }
}