import type { loadPyodide } from "pyodide";
import type {
  PythonWorkerRequest,
  PythonWorkerResponse,
  WorkspaceFile,
} from "@/lib/python-workspace";

type PythonWorkerScope = {
  addEventListener: (
    type: "message",
    listener: (event: MessageEvent<PythonWorkerRequest>) => void,
  ) => void;
  postMessage: (message: PythonWorkerResponse) => void;
};

const workerScope = self as unknown as PythonWorkerScope;
const PYODIDE_VERSION = "0.29.4";
const PYODIDE_INDEX_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;
const RUN_SCRIPT = `
import contextlib
import io
import json
import os
import pathlib
import shutil
import sys
import traceback

payload = json.loads(__workspace_payload)
workspace = pathlib.Path("/workspace")
workspace.mkdir(parents=True, exist_ok=True)

for child in workspace.iterdir():
    if child.is_dir():
        shutil.rmtree(child)
    else:
        child.unlink()

for file_name, contents in payload["files"].items():
    if "/" in file_name or "\\\\" in file_name:
        continue
    if not file_name.lower().endswith((".py", ".txt", ".json", ".csv")):
        continue
    (workspace / file_name).write_text(contents, encoding="utf-8")

entry = payload["entry"]
entry_path = workspace / entry
if not entry_path.is_file():
    raise FileNotFoundError(f"No existe el archivo de inicio: {entry}")

os.chdir(workspace)
if str(workspace) not in sys.path:
    sys.path.insert(0, str(workspace))
sys.argv = [entry]

for file_name in payload["files"]:
    module_name = pathlib.Path(file_name).stem
    if module_name in sys.modules:
        del sys.modules[module_name]

captured_stdout = io.StringIO()
captured_stderr = io.StringIO()
has_error = False
namespace = {
    "__name__": "__main__",
    "__file__": entry,
    "__builtins__": __builtins__,
}

try:
    source = entry_path.read_text(encoding="utf-8")
    with contextlib.redirect_stdout(captured_stdout), contextlib.redirect_stderr(captured_stderr):
        exec(compile(source, entry, "exec"), namespace)
except SystemExit as error:
    if error.code not in (None, 0):
        has_error = True
        print(f"El programa terminó con código {error.code}.", file=captured_stderr)
except BaseException:
    has_error = True
    traceback.print_exc(file=captured_stderr)

json.dumps({
    "stdout": captured_stdout.getvalue(),
    "stderr": captured_stderr.getvalue(),
    "hasError": has_error,
})
`;

type PyodideLoader = typeof loadPyodide;
let pyodidePromise: ReturnType<PyodideLoader> | null = null;

async function getPyodide() {
  if (!pyodidePromise) {
    const moduleUrl = `${PYODIDE_INDEX_URL}pyodide.mjs`;
    const pyodideModule = await import(
      /* @vite-ignore */ moduleUrl
    ) as { loadPyodide: PyodideLoader };
    pyodidePromise = pyodideModule.loadPyodide({ indexURL: PYODIDE_INDEX_URL });
  }
  return pyodidePromise;
}

function respond(message: PythonWorkerResponse) {
  workerScope.postMessage(message);
}

function resultAsString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "toJs" in value) {
    const proxy = value as { toJs: () => unknown; destroy?: () => void };
    const converted = proxy.toJs();
    proxy.destroy?.();
    if (typeof converted === "string") return converted;
  }
  return String(value);
}

async function run(request: PythonWorkerRequest): Promise<void> {
  const startedAt = performance.now();
  try {
    respond({
      type: "status",
      status: pyodidePromise ? "running" : "loading",
      requestId: request.requestId,
    });
    const pyodide = await getPyodide();
    respond({ type: "status", status: "running", requestId: request.requestId });

    const fileMap = Object.fromEntries(
      request.files.map((file: WorkspaceFile) => [file.name, file.content]),
    );
    pyodide.globals.set(
      "__workspace_payload",
      JSON.stringify({ files: fileMap, entry: request.entry }),
    );
    const result = await pyodide.runPythonAsync(RUN_SCRIPT);
    const parsed = JSON.parse(resultAsString(result)) as {
      stdout: string;
      stderr: string;
      hasError: boolean;
    };

    respond({
      type: "complete",
      requestId: request.requestId,
      stdout: parsed.stdout,
      stderr: parsed.stderr,
      hasError: parsed.hasError,
      durationMs: Math.round(performance.now() - startedAt),
    });
  } catch (error) {
    respond({
      type: "fatal",
      requestId: request.requestId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

workerScope.addEventListener("message", (event: MessageEvent<PythonWorkerRequest>) => {
  if (event.data.type === "run") void run(event.data);
});