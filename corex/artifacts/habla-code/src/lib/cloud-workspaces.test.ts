import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import {
  createBuilderProject,
  serializeBuilderProjectCollection,
  type BuilderProjectCollection,
} from "@/lib/builder-workspace";
import {
  bootstrapWorkspaceData,
  downloadLocalBackups,
  getLocalBackupCount,
  LOCAL_OWNER_STORAGE_KEY,
} from "@/lib/cloud-workspaces";
import {
  PROJECTS_STORAGE_KEY,
  WORKSPACE_STORAGE_KEY,
  type PythonProjectCollection,
  type PythonWorkspace,
} from "@/lib/python-workspace";

type Snapshot = { workspace_key: string; data: unknown };
type InsertPayload = {
  user_id: string;
  workspace_key: string;
  data: unknown;
};

class MemoryStorage {
  private values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, String(value));
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }
}

class SnapshotClient {
  readonly snapshots = new Map<string, unknown>();
  readonly inserts: InsertPayload[] = [];
  conflictOnInsert = new Map<string, unknown>();

  from(table: string) {
    assert.equal(table, "workspace_snapshots");
    const filters = new Map<string, unknown>();
    const query = {
      select: (_columns: string) => query,
      eq: (column: string, value: unknown) => {
        filters.set(column, value);
        return query;
      },
      in: async (column: string, values: readonly unknown[]) => {
        const userId = String(filters.get("user_id"));
        const rows: Snapshot[] = [];
        for (const workspaceKey of values) {
          const snapshot = this.snapshots.get(
            this.key(userId, String(workspaceKey)),
          );
          if (snapshot !== undefined)
            rows.push({ workspace_key: String(workspaceKey), data: snapshot });
        }
        filters.set(column, values);
        return { data: rows, error: null };
      },
      maybeSingle: async () => {
        const snapshot = this.snapshots.get(
          this.key(
            String(filters.get("user_id")),
            String(filters.get("workspace_key")),
          ),
        );
        return {
          data:
            snapshot === undefined
              ? null
              : { workspace_key: filters.get("workspace_key"), data: snapshot },
          error: null,
        };
      },
      insert: async (payload: InsertPayload) => {
        this.inserts.push(payload);
        const key = this.key(payload.user_id, payload.workspace_key);
        if (this.snapshots.has(key)) {
          return { error: { code: "23505", message: "duplicate key" } };
        }
        if (this.conflictOnInsert.has(payload.workspace_key)) {
          this.snapshots.set(
            key,
            this.conflictOnInsert.get(payload.workspace_key),
          );
          this.conflictOnInsert.delete(payload.workspace_key);
          return { error: { code: "23505", message: "duplicate key" } };
        }
        this.snapshots.set(key, payload.data);
        return { error: null };
      },
    };
    return query;
  }

  seed(userId: string, workspaceKey: string, data: unknown): void {
    this.snapshots.set(this.key(userId, workspaceKey), data);
  }

  private key(userId: string, workspaceKey: string): string {
    return `${userId}:${workspaceKey}`;
  }
}

const storage = new MemoryStorage();
const originalDocument = globalThis.document;

function makeBuilderCollection(projectId: string): BuilderProjectCollection {
  const project = { ...createBuilderProject(projectId), id: projectId };
  return { projects: [project], activeProjectId: projectId };
}

function makePythonCollection(projectId: string): PythonProjectCollection {
  const workspace: PythonWorkspace = {
    projectName: projectId,
    files: [{ name: "main.py", content: `print("${projectId}")` }],
  };
  return {
    projects: [{ id: projectId, workspace }],
    activeProjectId: projectId,
  };
}

function setLocalWorkspaces(
  builder: BuilderProjectCollection,
  python: PythonProjectCollection,
): void {
  storage.setItem(
    "programa-hablando.builder-projects.v1",
    serializeBuilderProjectCollection(builder),
  );
  storage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify(python));
  storage.setItem(
    WORKSPACE_STORAGE_KEY,
    JSON.stringify(
      python.projects.find(({ id }) => id === python.activeProjectId)
        ?.workspace,
    ),
  );
}

function parseStored<T>(key: string): T {
  const raw = storage.getItem(key);
  assert.ok(raw, `Expected local storage to contain ${key}`);
  return JSON.parse(raw) as T;
}

function makeTestClient(client: SnapshotClient) {
  return client as unknown as NonNullable<
    Parameters<typeof bootstrapWorkspaceData>[1]
  >;
}

beforeEach(() => {
  for (let index = storage.length - 1; index >= 0; index -= 1) {
    const key = storage.key(index);
    if (key) storage.removeItem(key);
  }
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { localStorage: storage },
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: storage,
  });
});

afterEach(() => {
  if (originalDocument === undefined) {
    Reflect.deleteProperty(globalThis, "document");
  } else {
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: originalDocument,
    });
  }
});

test("imports local builder and Python projects when the owner has no cloud snapshot", async () => {
  const localBuilder = makeBuilderCollection("local-builder");
  const localPython = makePythonCollection("local-python");
  const client = new SnapshotClient();
  setLocalWorkspaces(localBuilder, localPython);

  await bootstrapWorkspaceData("owner-a", makeTestClient(client));

  assert.deepEqual(
    client.inserts.map(({ workspace_key }) => workspace_key).sort(),
    ["builder-projects", "python-projects"],
  );
  assert.deepEqual(
    client.snapshots.get("owner-a:builder-projects"),
    localBuilder,
  );
  assert.deepEqual(
    client.snapshots.get("owner-a:python-projects"),
    localPython,
  );
  assert.equal(storage.getItem(LOCAL_OWNER_STORAGE_KEY), "owner-a");
  assert.equal(getLocalBackupCount("owner-a"), 0);
});

test("backs up different local projects before applying cloud data and keeps the backup downloadable", async () => {
  const localBuilder = makeBuilderCollection("local-builder");
  const localPython = makePythonCollection("local-python");
  const remoteBuilder = makeBuilderCollection("cloud-builder");
  const remotePython = makePythonCollection("cloud-python");
  const client = new SnapshotClient();
  setLocalWorkspaces(localBuilder, localPython);
  client.seed("owner-a", "builder-projects", remoteBuilder);
  client.seed("owner-a", "python-projects", remotePython);

  await bootstrapWorkspaceData("owner-a", makeTestClient(client));

  assert.deepEqual(
    parseStored<BuilderProjectCollection>(
      "programa-hablando.builder-projects.v1",
    ),
    remoteBuilder,
  );
  assert.deepEqual(
    parseStored<PythonProjectCollection>(PROJECTS_STORAGE_KEY),
    remotePython,
  );
  assert.equal(getLocalBackupCount("owner-a"), 2);

  let downloadedBlob: Blob | null = null;
  let downloadClicked = false;
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      createElement: () => ({
        href: "",
        download: "",
        click: () => {
          downloadClicked = true;
        },
      }),
    },
  });
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  URL.createObjectURL = (blob: Blob) => {
    downloadedBlob = blob;
    return "blob:test-backup";
  };
  URL.revokeObjectURL = () => {};
  try {
    downloadLocalBackups("owner-a");
    assert.equal(downloadClicked, true);
    assert.ok(downloadedBlob);
    const downloaded = JSON.parse(await downloadedBlob.text()) as Array<{
      localValues: Record<string, string>;
    }>;
    assert.equal(downloaded.length, 2);
    const backedUpProjects = downloaded.flatMap((backup) =>
      Object.values(backup.localValues).flatMap((raw) => {
        const value = JSON.parse(raw) as { projects?: Array<{ id: string }> };
        return value.projects?.map(({ id }) => id) ?? [];
      }),
    );
    assert.ok(backedUpProjects.includes("local-builder"));
    assert.ok(backedUpProjects.includes("local-python"));
  } finally {
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
  }
});

test("backs up the previous owner's workspace before switching to the next owner's cloud data", async () => {
  const previousBuilder = makeBuilderCollection("previous-builder");
  const previousPython = makePythonCollection("previous-python");
  const nextBuilder = makeBuilderCollection("next-builder");
  const nextPython = makePythonCollection("next-python");
  const client = new SnapshotClient();
  storage.setItem(LOCAL_OWNER_STORAGE_KEY, "owner-old");
  setLocalWorkspaces(previousBuilder, previousPython);
  client.seed("owner-new", "builder-projects", nextBuilder);
  client.seed("owner-new", "python-projects", nextPython);

  await bootstrapWorkspaceData("owner-new", makeTestClient(client));

  assert.equal(getLocalBackupCount("owner-old"), 2);
  assert.equal(getLocalBackupCount("owner-new"), 0);
  assert.deepEqual(
    parseStored<BuilderProjectCollection>(
      "programa-hablando.builder-projects.v1",
    ),
    nextBuilder,
  );
  assert.deepEqual(
    parseStored<PythonProjectCollection>(PROJECTS_STORAGE_KEY),
    nextPython,
  );
  assert.equal(storage.getItem(LOCAL_OWNER_STORAGE_KEY), "owner-new");
});

test("uses a snapshot created by a concurrent first save and preserves the local projects", async () => {
  const localBuilder = makeBuilderCollection("local-builder");
  const racedBuilder = makeBuilderCollection("raced-builder");
  const localPython = makePythonCollection("local-python");
  const client = new SnapshotClient();
  client.conflictOnInsert.set("builder-projects", racedBuilder);
  setLocalWorkspaces(localBuilder, localPython);

  await bootstrapWorkspaceData("owner-a", makeTestClient(client));

  assert.deepEqual(
    parseStored<BuilderProjectCollection>(
      "programa-hablando.builder-projects.v1",
    ),
    racedBuilder,
  );
  assert.deepEqual(
    client.snapshots.get("owner-a:builder-projects"),
    racedBuilder,
  );
  assert.equal(getLocalBackupCount("owner-a"), 1);
  const backupKey = Array.from({ length: storage.length }, (_, index) =>
    storage.key(index),
  ).find((key) =>
    key?.startsWith(
      "programa-hablando.local-backup.v1:owner-a:builder-projects:",
    ),
  );
  assert.ok(backupKey);
  const backup = JSON.parse(storage.getItem(backupKey)!) as {
    localValues: Record<string, string>;
  };
  assert.equal(
    JSON.parse(backup.localValues["programa-hablando.builder-projects.v1"])
      .projects[0].id,
    "local-builder",
  );
  assert.deepEqual(
    client.snapshots.get("owner-a:python-projects"),
    localPython,
  );
});
