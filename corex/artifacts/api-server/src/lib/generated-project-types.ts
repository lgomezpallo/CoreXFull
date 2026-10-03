import type { RouterTaskType } from "./router-client";

export type GeneratedProjectFile = {
  path: string;
  content: string;
};

export type GeneratedProjectFilePlan = {
  path: string;
  operation: "create" | "update";
  purpose: string;
  allowedImports: string[];
  exports: string[];
  propsInterfaces: string[];
  internalDependencies: string[];
  acceptanceCriteria: string[];
};

export type GeneratedProjectFileProgress = {
  path: string;
  status: "planned" | "generating" | "generated" | "correcting" | "corrected" | "error";
  generationTaskTypes: RouterTaskType[];
  resolvedGenerationTaskType: RouterTaskType | null;
  correctionTaskTypes: RouterTaskType[];
  resolvedCorrectionTaskTypes: RouterTaskType[];
};

export type GeneratedProjectBlueprint = {
  title: string;
  subtitle: string;
  description: string;
  accentColor: string;
  appKind: string;
  sections: Array<{
    id: string;
    type: string;
    title: string;
    description: string;
    actionLabel: string;
    items: Array<{
      id: string;
      title: string;
      description: string;
      value: string;
      checked: boolean;
    }>;
  }>;
};

export type GeneratedProjectTurn = {
  role: "user" | "assistant";
  content: string;
};

export type GeneratedProjectReference = {
  name: string;
  kind: "image" | "document" | "code" | "archive" | "apk" | "binary";
  extractedText: string;
  imageDataUrl?: string;
};

export type GeneratedProjectJobStage =
  | "planning"
  | "blueprint"
  | "generation"
  | "build"
  | "validation"
  | "correction"
  | "ready"
  | "error";

export type GeneratedProjectJob = {
  id: string;
  projectId: string;
  stage: GeneratedProjectJobStage;
  statusMessage: string;
  files: GeneratedProjectFile[];
  plannedFiles: GeneratedProjectFilePlan[];
  generatedFiles: string[];
  fileProgress: GeneratedProjectFileProgress[];
  correctedFiles: string[];
  codingFallbackUsed: boolean;
  codingEscalationFiles: string[];
  diagnostics: string[];
  previewHtml: string | null;
  error: string | null;
  attempt: number;
  updatedAt: string;
};

export type GeneratedProjectJobStatus = Omit<GeneratedProjectJob, "files" | "previewHtml"> & {
  previewReady: boolean;
};

export type GeneratedProjectGenerationInput = {
  ownerId: string;
  userId: string;
  accessToken: string;
  projectId: string;
  mode?: "builder" | "lab";
  prompt: string;
  blueprint: GeneratedProjectBlueprint;
  history: GeneratedProjectTurn[];
  referenceFiles: GeneratedProjectReference[];
  files: GeneratedProjectFile[];
};

export type GeneratedProjectBuildInput = {
  ownerId: string;
  userId: string;
  accessToken: string;
  projectId: string;
  blueprint: GeneratedProjectBlueprint;
  files: GeneratedProjectFile[];
};