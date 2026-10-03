import assert from "node:assert/strict";
import test from "node:test";
import {
  createBuilderProject,
  serializeBuilderProjectCollection,
  type GeneratedProjectRecovery,
  type LabProjectVersion,
} from "./builder-workspace";

test("persists owner-scoped generated-project recovery metadata", () => {
  const project = createBuilderProject("Recovery test");
  const recovery: GeneratedProjectRecovery = {
    ownerId: "owner-a",
    jobId: "job-a",
    kind: "generation",
    stage: "build",
    generationRequest: {
      prompt: "Build an app",
      blueprint: {
        title: "Test",
        subtitle: "Test app",
        description: "A test project",
        accentColor: "ocean",
        appKind: "prototype",
        sections: [],
      },
      history: [{ role: "user", content: "Build an app" }],
      referenceFiles: [],
    },
    files: [{ path: "src/App.tsx", content: "export default function App() { return null; }" }],
    resumeWithBuild: true,
  };
  project.generatedProjectRecovery = recovery;

  const saved = JSON.parse(serializeBuilderProjectCollection({
    projects: [project],
    activeProjectId: project.id,
  })) as { projects: Array<{ generatedProjectRecovery: GeneratedProjectRecovery | null }> };

  assert.deepEqual(saved.projects[0]?.generatedProjectRecovery, recovery);
});

test("drops unsafe recovery files and malformed owner metadata", () => {
  const project = createBuilderProject("Recovery test");
  const validRequest: NonNullable<GeneratedProjectRecovery["generationRequest"]> = {
    prompt: "Build an app",
    blueprint: {
      title: "Test",
      subtitle: "Test app",
      description: "A test project",
      accentColor: "ocean",
      appKind: "prototype",
      sections: [],
    },
    history: [],
    referenceFiles: [],
  };
  project.generatedProjectRecovery = {
    ownerId: "owner-a",
    jobId: null,
    kind: "generation",
    stage: "generation",
    generationRequest: validRequest,
    files: [
      { path: "../../secrets.txt", content: "ignore" },
      { path: "src/App.tsx", content: "safe source" },
    ],
    resumeWithBuild: true,
  };

  const saved = JSON.parse(serializeBuilderProjectCollection({
    projects: [project],
    activeProjectId: project.id,
  })) as { projects: Array<{ generatedProjectRecovery: GeneratedProjectRecovery | null }> };
  const recovery = saved.projects[0]?.generatedProjectRecovery;
  assert.deepEqual(recovery?.files, [{ path: "src/App.tsx", content: "safe source" }]);
  assert.equal(recovery?.resumeWithBuild, true);

  project.generatedProjectRecovery = { ...project.generatedProjectRecovery, ownerId: " " };
  const malformed = JSON.parse(serializeBuilderProjectCollection({
    projects: [project],
    activeProjectId: project.id,
  })) as { projects: Array<{ generatedProjectRecovery: GeneratedProjectRecovery | null }> };
  assert.equal(malformed.projects[0]?.generatedProjectRecovery, null);
});

test("persists laboratory mode, goal, and reconstruction provenance", () => {
  const project = createBuilderProject("Laboratorio", "lab");
  project.labGoal = "Adaptar un catálogo a una app local";
  const version: LabProjectVersion = {
    id: "lab-version-1",
    jobId: "job-lab-1",
    createdAt: "2026-09-28T12:00:00.000Z",
    label: "Reconstrucción 1",
    files: [{ path: "src/App.tsx", content: "export default function App() { return null; }" }],
    observedFrom: ["catalogo.zip"],
    reconstructed: ["src/App.tsx"],
    modified: [],
  };
  project.labVersions = [version];

  const saved = JSON.parse(serializeBuilderProjectCollection({
    projects: [project],
    activeProjectId: project.id,
  })) as { projects: Array<{ mode: string; labGoal: string; labVersions: LabProjectVersion[] }> };

  assert.equal(saved.projects[0]?.mode, "lab");
  assert.equal(saved.projects[0]?.labGoal, project.labGoal);
  assert.deepEqual(saved.projects[0]?.labVersions, [version]);
});

test("persists the accumulated design conversation before a blueprint exists", () => {
  const project = createBuilderProject("Idea en conversación");
  project.designConversation = { designBrief: "App para el encargado de una cafetería: registrar pedidos y entregas.", readyToBuild: true };
  const saved = JSON.parse(serializeBuilderProjectCollection({ projects: [project], activeProjectId: project.id }));
  assert.deepEqual(saved.projects[0].designConversation, project.designConversation);
  assert.equal(saved.projects[0].blueprint, null);
});
