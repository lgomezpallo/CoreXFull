import assert from "node:assert/strict";
import test from "node:test";
import type { RouterTaskType } from "./router-client";
import {
  attributeProjectDiagnosticDetails,
  findAffectedProjectFiles,
  generatePlannedSourceFile,
  orderGeneratedProjectFilePlan,
  parseGeneratedProjectFilePlan,
  type GeneratedFileResult,
} from "./generated-project-generation";
import type {
  GeneratedProjectFile,
  GeneratedProjectFilePlan,
  GeneratedProjectGenerationInput,
} from "./generated-project-types";

const input: GeneratedProjectGenerationInput = {
  ownerId: "owner",
  userId: "unit-test-user",
  accessToken: "unit-test-access-token",
  projectId: "project",
  mode: "builder",
  prompt: "Crear una lista interactiva.",
  blueprint: {
    title: "Lista",
    subtitle: "Una lista",
    description: "Lista interactiva de tareas.",
    accentColor: "#123456",
    appKind: "prototype",
    sections: [],
  },
  history: [],
  referenceFiles: [],
  files: [],
};

const filePlan: GeneratedProjectFilePlan = {
  path: "src/App.tsx",
  operation: "create",
  purpose: "Renderizar y actualizar la lista.",
  allowedImports: ["react"],
  exports: ["default App"],
  propsInterfaces: [],
  internalDependencies: ["src/components/Row.tsx"],
  acceptanceCriteria: ["La acción principal cambia la lista."],
};

const generatedResponse = JSON.stringify({
  path: "src/App.tsx",
  content: "export default function App() { return null; }",
});

test("orders the file plan by declared internal dependencies", () => {
  const files = [
    {
      path: "src/App.tsx",
      operation: "create",
      purpose: "Render the app.",
      allowedImports: ["react"],
      exports: ["default App"],
      propsInterfaces: [],
      internalDependencies: ["src/components/Row.tsx"],
      acceptanceCriteria: ["Render a row."],
    },
    {
      path: "src/components/Row.tsx",
      operation: "create",
      purpose: "Render a row.",
      allowedImports: ["react"],
      exports: ["Row"],
      propsInterfaces: ["RowProps"],
      internalDependencies: [],
      acceptanceCriteria: ["Show the row title."],
    },
  ];
  const parsed = parseGeneratedProjectFilePlan(JSON.stringify({ files }), []);
  assert.deepEqual(
    orderGeneratedProjectFilePlan(parsed, []).map((file) => file.path),
    ["src/components/Row.tsx", "src/App.tsx"],
  );
});

test("rejects cyclic dependencies in a generated plan", () => {
  const files = [
    {
      path: "src/App.tsx",
      operation: "create",
      purpose: "Render the app.",
      allowedImports: [],
      exports: [],
      propsInterfaces: [],
      internalDependencies: ["src/components/Row.tsx"],
      acceptanceCriteria: [],
    },
    {
      path: "src/components/Row.tsx",
      operation: "create",
      purpose: "Render a row.",
      allowedImports: [],
      exports: [],
      propsInterfaces: [],
      internalDependencies: ["src/App.tsx"],
      acceptanceCriteria: [],
    },
  ];
  const parsed = parseGeneratedProjectFilePlan(JSON.stringify({ files }), []);
  assert.throws(() => orderGeneratedProjectFilePlan(parsed, []), /dependencias circulares/);
});

test("uses reasoning then chat before one bounded coding fallback", async () => {
  const calls: RouterTaskType[] = [];
  const reported: RouterTaskType[] = [];
  const complete = async (taskType: RouterTaskType): Promise<string> => {
    calls.push(taskType);
    if (taskType !== "coding") throw new Error("temporary provider failure");
    return generatedResponse;
  };

  const result: GeneratedFileResult = await generatePlannedSourceFile(
    input,
    filePlan,
    [],
    { onTaskType: (taskType) => reported.push(taskType) },
    complete,
  );

  assert.deepEqual(calls, ["reasoning", "chat", "coding"]);
  assert.deepEqual(reported, calls);
  assert.deepEqual(result.taskTypes, calls);
  assert.equal(result.resolvedTaskType, "coding");
  assert.equal(result.file.path, filePlan.path);
});

test("does not call coding when reasoning returns a valid file", async () => {
  const calls: RouterTaskType[] = [];
  const complete = async (taskType: RouterTaskType): Promise<string> => {
    calls.push(taskType);
    return generatedResponse;
  };

  const result = await generatePlannedSourceFile(input, filePlan, [], {}, complete);
  assert.deepEqual(calls, ["reasoning"]);
  assert.equal(result.resolvedTaskType, "reasoning");
});

test("correction context contains only the target, declared dependencies, and diagnostics", async () => {
  const files: GeneratedProjectFile[] = [
    { path: "src/App.tsx", content: "OLD TARGET" },
    { path: "src/components/Row.tsx", content: "DECLARED DEPENDENCY" },
    { path: "src/features/Unrelated.tsx", content: "UNRELATED FILE" },
  ];
  let userContent = "";
  const complete = async (_taskType: RouterTaskType, messages: Array<{ content: unknown }>) => {
    const content = messages[1]?.content;
    userContent = typeof content === "string" ? content : "";
    return generatedResponse;
  };

  await generatePlannedSourceFile(
    input,
    filePlan,
    files,
    { correction: true, diagnostics: ["TS2322 en src/App.tsx"] },
    complete,
  );

  assert.match(userContent, /OLD TARGET/);
  assert.match(userContent, /DECLARED DEPENDENCY/);
  assert.match(userContent, /TS2322 en src\/App\.tsx/);
  assert.doesNotMatch(userContent, /UNRELATED FILE/);
});

test("maps compiler diagnostics only to paths present in the project", () => {
  const files: GeneratedProjectFile[] = [
    { path: "src/App.tsx", content: "" },
    { path: "src/components/Row.tsx", content: "" },
  ];
  const affected = findAffectedProjectFiles(
    "src/App.tsx(3,1): error TS1005\nsrc/missing.ts(1,1): error",
    files,
  );
  assert.deepEqual(affected, ["src/App.tsx"]);
});

test("assigns only the relevant diagnostics to allowed files", async () => {
  const files: GeneratedProjectFile[] = [
    { path: "src/App.tsx", content: "export default function App() { return null; }" },
    { path: "src/components/Row.tsx", content: "export function Row() { return null; }" },
  ];
  const complete = async (): Promise<string> => JSON.stringify({
    assignments: [
      { path: "src/App.tsx", diagnosticIndexes: [0] },
      { path: "src/components/Row.tsx", diagnosticIndexes: [1] },
    ],
  });

  const assignments = await attributeProjectDiagnosticDetails(
    input,
    [filePlan],
    files,
    ["The App has no primary action.", "RowProps is missing a title."],
    complete,
  );

  assert.deepEqual(assignments, {
    "src/App.tsx": ["The App has no primary action."],
    "src/components/Row.tsx": ["RowProps is missing a title."],
  });
});