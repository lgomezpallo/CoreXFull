import {
  BUILDER_PROJECTS_STORAGE_KEY,
  loadBuilderProjectCollection,
  serializeBuilderProjectCollection,
  type BuilderProjectCollection,
} from "@/lib/builder-workspace";
import {
  loadProjectCollection,
  PROJECTS_STORAGE_KEY,
  WORKSPACE_STORAGE_KEY,
  type PythonProjectCollection,
} from "@/lib/python-workspace";
import { supabase } from "@/lib/supabase";

export type WorkspaceKey = "builder-projects" | "python-projects";
type WorkspaceSnapshotClient = NonNullable<typeof supabase>;
type WorkspaceData = BuilderProjectCollection | PythonProjectCollection;
type RawLocalValues = Record<string, string>;

type LocalWorkspace = {
  data: WorkspaceData | null;
  rawValues: RawLocalValues;
  needsBackup: boolean;
};

type RemoteWorkspaceRow = {
  workspace_key: WorkspaceKey;
  data: unknown;
};

export const LOCAL_OWNER_STORAGE_KEY = "programa-hablando.local-owner.v1";
const LOCAL_BACKUP_PREFIX = "programa-hablando.local-backup.v1:";
const WORKSPACE_KEYS: WorkspaceKey[] = ["builder-projects", "python-projects"];
let workspaceBootstrapQueue: Promise<void> = Promise.resolve();

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseJson(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (isRecord(value)) {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function sameJson(left: unknown, right: unknown): boolean {
  return stableStringify(left) === stableStringify(right);
}

function readRawValues(key: WorkspaceKey): RawLocalValues {
  const storageKeys =
    key === "builder-projects"
      ? [BUILDER_PROJECTS_STORAGE_KEY]
      : [PROJECTS_STORAGE_KEY, WORKSPACE_STORAGE_KEY];
  const values: RawLocalValues = {};
  for (const storageKey of storageKeys) {
    const value = window.localStorage.getItem(storageKey);
    if (value !== null) values[storageKey] = value;
  }
  return values;
}

function readLocalWorkspace(key: WorkspaceKey): LocalWorkspace {
  const rawValues = readRawValues(key);
  const hasRawValues = Object.keys(rawValues).length > 0;
  if (!hasRawValues) return { data: null, rawValues, needsBackup: false };

  if (key === "builder-projects") {
    const raw = rawValues[BUILDER_PROJECTS_STORAGE_KEY] ?? null;
    const parsed = parseJson(raw);
    if (!isRecord(parsed) || !Array.isArray(parsed.projects)) {
      return { data: null, rawValues, needsBackup: true };
    }
    const data = JSON.parse(
      serializeBuilderProjectCollection(loadBuilderProjectCollection()),
    ) as BuilderProjectCollection;
    return {
      data,
      rawValues,
      needsBackup: !sameJson(parsed, data),
    };
  }

  const savedProjects = parseJson(rawValues[PROJECTS_STORAGE_KEY] ?? null);
  const savedWorkspace = parseJson(rawValues[WORKSPACE_STORAGE_KEY] ?? null);
  const hasValidProjects =
    isRecord(savedProjects) && Array.isArray(savedProjects.projects);
  const hasValidWorkspace =
    isRecord(savedWorkspace) && Array.isArray(savedWorkspace.files);
  if (!hasValidProjects && !hasValidWorkspace) {
    return { data: null, rawValues, needsBackup: true };
  }

  const data = loadProjectCollection();
  const activeWorkspace = data.projects.find(
    (project) => project.id === data.activeProjectId,
  )?.workspace;
  const projectsNeedBackup =
    rawValues[PROJECTS_STORAGE_KEY] !== undefined &&
    (!hasValidProjects || !sameJson(savedProjects, data));
  const workspaceNeedsBackup =
    rawValues[WORKSPACE_STORAGE_KEY] !== undefined &&
    (!hasValidWorkspace || !sameJson(savedWorkspace, activeWorkspace));

  return {
    data,
    rawValues,
    needsBackup: projectsNeedBackup || workspaceNeedsBackup,
  };
}

function preserveLocalValues(
  ownerId: string,
  workspaceKey: WorkspaceKey,
  rawValues: RawLocalValues,
): void {
  if (!Object.keys(rawValues).length) return;
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  const suffix =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const backupKey = `${LOCAL_BACKUP_PREFIX}${ownerId}:${workspaceKey}:${timestamp}:${suffix}`;
  try {
    window.localStorage.setItem(
      backupKey,
      JSON.stringify({
        ownerId,
        workspaceKey,
        createdAt: new Date().toISOString(),
        localValues: rawValues,
      }),
    );
  } catch {
    throw new Error(
      "No pude crear una copia local de seguridad. Liberá espacio en el navegador y volvé a intentar; tus datos actuales no se reemplazaron.",
    );
  }
}

function clearLocalWorkspace(key: WorkspaceKey): void {
  if (key === "builder-projects") {
    window.localStorage.removeItem(BUILDER_PROJECTS_STORAGE_KEY);
    return;
  }
  window.localStorage.removeItem(PROJECTS_STORAGE_KEY);
  window.localStorage.removeItem(WORKSPACE_STORAGE_KEY);
}

function writeLocalWorkspace(key: WorkspaceKey, data: unknown): void {
  if (key === "builder-projects") {
    window.localStorage.setItem(
      BUILDER_PROJECTS_STORAGE_KEY,
      JSON.stringify(data),
    );
    return;
  }

  const collection = data as PythonProjectCollection;
  window.localStorage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify(collection));
  const activeWorkspace = collection.projects.find(
    (project) => project.id === collection.activeProjectId,
  )?.workspace;
  if (activeWorkspace) {
    window.localStorage.setItem(
      WORKSPACE_STORAGE_KEY,
      JSON.stringify(activeWorkspace),
    );
  } else {
    window.localStorage.removeItem(WORKSPACE_STORAGE_KEY);
  }
}

async function fetchWorkspaceRow(
  userId: string,
  workspaceKey: WorkspaceKey,
  client: WorkspaceSnapshotClient,
): Promise<RemoteWorkspaceRow | null> {
  const { data, error } = await client
    .from("workspace_snapshots")
    .select("workspace_key, data")
    .eq("user_id", userId)
    .eq("workspace_key", workspaceKey)
    .maybeSingle();
  if (error) throw new Error(`No pude leer el espacio guardado: ${error.message}`);
  return data as RemoteWorkspaceRow | null;
}

async function insertWorkspaceRow(
  userId: string,
  workspaceKey: WorkspaceKey,
  data: WorkspaceData,
  client: WorkspaceSnapshotClient,
): Promise<RemoteWorkspaceRow | null> {
  const { error } = await client.from("workspace_snapshots").insert({
    user_id: userId,
    workspace_key: workspaceKey,
    data,
  });
  if (!error) return null;
  if (error.code !== "23505") {
    throw new Error(`No pude importar los datos locales: ${error.message}`);
  }

  // A second signed-in browser may have created the first row during this import.
  return fetchWorkspaceRow(userId, workspaceKey, client);
}

async function bootstrapWorkspaceDataNow(
  userId: string,
  client: WorkspaceSnapshotClient | null,
): Promise<void> {
  if (!client) throw new Error("Falta la configuración de Supabase.");

  const previousOwner = window.localStorage.getItem(LOCAL_OWNER_STORAGE_KEY);
  if (previousOwner && previousOwner !== userId) {
    for (const key of WORKSPACE_KEYS) {
      preserveLocalValues(previousOwner, key, readRawValues(key));
      clearLocalWorkspace(key);
    }
  }

  const localByKey = new Map(
    WORKSPACE_KEYS.map((key) => [key, readLocalWorkspace(key)]),
  );
  const { data: rows, error } = await client
    .from("workspace_snapshots")
    .select("workspace_key, data")
    .eq("user_id", userId)
    .in("workspace_key", WORKSPACE_KEYS);
  if (error) throw new Error(`No pude cargar tus espacios: ${error.message}`);

  const remoteByKey = new Map(
    ((rows ?? []) as RemoteWorkspaceRow[]).map((row) => [
      row.workspace_key,
      row,
    ]),
  );

  for (const key of WORKSPACE_KEYS) {
    const local = localByKey.get(key)!;
    const remote = remoteByKey.get(key);

    if (remote) {
      if (!isRecord(remote.data)) {
        throw new Error(
          `El respaldo remoto de ${key} no tiene un formato válido. No reemplacé los datos locales.`,
        );
      }
      if (
        Object.keys(local.rawValues).length > 0 &&
        (local.needsBackup ||
          local.data === null ||
          !sameJson(local.data, remote.data))
      ) {
        preserveLocalValues(userId, key, local.rawValues);
      }
      writeLocalWorkspace(key, remote.data);
      continue;
    }

    if (local.data) {
      if (local.needsBackup) {
        preserveLocalValues(userId, key, local.rawValues);
      }
      const racedRow = await insertWorkspaceRow(userId, key, local.data, client);
      if (racedRow) {
        if (!isRecord(racedRow.data)) {
          throw new Error(
            `El respaldo remoto de ${key} no tiene un formato válido. No reemplacé los datos locales.`,
          );
        }
        if (
          local.needsBackup ||
          !sameJson(local.data, racedRow.data)
        ) {
          preserveLocalValues(userId, key, local.rawValues);
        }
        writeLocalWorkspace(key, racedRow.data);
      } else {
        writeLocalWorkspace(key, local.data);
      }
      continue;
    }

    if (Object.keys(local.rawValues).length > 0) {
      preserveLocalValues(userId, key, local.rawValues);
      clearLocalWorkspace(key);
    }
  }

  window.localStorage.setItem(LOCAL_OWNER_STORAGE_KEY, userId);
}

export function bootstrapWorkspaceData(
  userId: string,
  client: WorkspaceSnapshotClient | null = supabase,
): Promise<void> {
  const run = workspaceBootstrapQueue.then(() =>
    bootstrapWorkspaceDataNow(userId, client),
  );
  workspaceBootstrapQueue = run.catch(() => undefined);
  return run;
}

export async function saveWorkspaceSnapshot(
  userId: string,
  workspaceKey: WorkspaceKey,
  data: WorkspaceData,
): Promise<void> {
  if (!supabase) throw new Error("Falta la configuración de Supabase.");
  const { error } = await supabase.from("workspace_snapshots").upsert(
    {
      user_id: userId,
      workspace_key: workspaceKey,
      data,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id,workspace_key" },
  );
  if (error) throw new Error(`No pude guardar en Supabase: ${error.message}`);
}

export function getLocalBackupCount(ownerId: string): number {
  const prefix = `${LOCAL_BACKUP_PREFIX}${ownerId}:`;
  let count = 0;
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);
    if (key?.startsWith(prefix)) count += 1;
  }
  return count;
}

export function downloadLocalBackups(ownerId: string): void {
  const prefix = `${LOCAL_BACKUP_PREFIX}${ownerId}:`;
  const backups: unknown[] = [];
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);
    if (!key?.startsWith(prefix)) continue;
    const value = window.localStorage.getItem(key);
    if (value) backups.push(JSON.parse(value) as unknown);
  }
  const blob = new Blob([JSON.stringify(backups, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "corex-copia-local.json";
  link.click();
  URL.revokeObjectURL(url);
}