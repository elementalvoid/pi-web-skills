import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import type { OperationError } from "./errors.ts";
import { operationError } from "./errors.ts";

/** One lock record in the standard global lock shape; unknown fields are kept. */
export type LockEntry = {
  source: string;
  sourceType: string;
  sourceUrl: string;
  ref?: string;
  skillPath?: string;
  skillFolderHash: string;
  installedAt: string;
  updatedAt: string;
  pluginName?: string;
  [field: string]: unknown;
};

/** The whole lockfile; unknown top-level fields are kept as-is. */
export type LockDocument = {
  version: number;
  skills: Record<string, LockEntry>;
  [field: string]: unknown;
};

export type LockReadResult =
  | { readonly ok: true; readonly lock: LockDocument }
  | { readonly ok: false; readonly error: OperationError };

export type LockMutationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: OperationError };

const CURRENT_VERSION = 3;

/** Read the global lock; a missing file is an empty lock, a broken file is lock-unreadable. */
export async function readLockfile(lockfilePath: string): Promise<LockReadResult> {
  let text: string;
  try {
    text = await readFile(lockfilePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: true, lock: emptyLock() };
    }
    return unreadable(lockfilePath, describe(error));
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return unreadable(lockfilePath, "the file is not valid JSON");
  }
  if (!isLockDocument(parsed)) {
    return unreadable(lockfilePath, `expected version ${CURRENT_VERSION} or newer with a skills map`);
  }
  return { ok: true, lock: parsed };
}

/**
 * Atomically replace the lockfile. Unknown fields survive; the schema version is
 * never lowered.
 */
export async function writeLockfile(lockfilePath: string, lock: LockDocument): Promise<void> {
  const directory = dirname(lockfilePath);
  await mkdir(directory, { recursive: true });

  const document: LockDocument = { ...lock, version: Math.max(CURRENT_VERSION, lock.version) };
  const temporaryPath = join(directory, `.${basename(lockfilePath)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, JSON.stringify(document, null, 2), "utf8");
    await rename(temporaryPath, lockfilePath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

/**
 * Re-read the lock, apply one change, and write it back. Concurrent mutations of
 * the same lockfile run one at a time, so none loses another's entry.
 */
export async function mutateLockfile<T>(
  lockfilePath: string,
  mutate: (lock: LockDocument) => T | Promise<T>,
): Promise<LockMutationResult<T>> {
  return serialize(lockfilePath, async () => {
    const read = await readLockfile(lockfilePath);
    if (!read.ok) return read;
    const value = await mutate(read.lock);
    await writeLockfile(lockfilePath, read.lock);
    return { ok: true, value };
  });
}

function emptyLock(): LockDocument {
  return { version: CURRENT_VERSION, skills: {}, dismissed: {} };
}

function isLockDocument(value: unknown): value is LockDocument {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as { version?: unknown; skills?: unknown };
  return (
    typeof candidate.version === "number" &&
    Number.isInteger(candidate.version) &&
    candidate.version >= CURRENT_VERSION &&
    isPlainObject(candidate.skills) &&
    Object.values(candidate.skills).every(isPlainObject)
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unreadable(lockfilePath: string, reason: string): LockReadResult {
  return {
    ok: false,
    error: operationError("lock-unreadable", `Cannot read ${lockfilePath}: ${reason}`),
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const tails = new Map<string, Promise<void>>();

async function serialize<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = tails.get(key) ?? Promise.resolve();
  const current = previous.then(task, task);
  const tail = current.then(ignore, ignore);
  tails.set(key, tail);
  try {
    return await current;
  } finally {
    if (tails.get(key) === tail) tails.delete(key);
  }
}

function ignore(): void {}
