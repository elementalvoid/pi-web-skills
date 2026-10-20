import type { Dirent } from "node:fs";
import { lstat, readdir, rm } from "node:fs/promises";
import type { OperationContext } from "./context.ts";
import { assertSafeSkillDirectory } from "./containment.ts";
import type { JsonValue, OperationError, OperationErrorCode, Result } from "./errors.ts";
import { operationError } from "./errors.ts";
import { mutateLockfile, readLockfile } from "./lockfile.ts";
import type { MatchInput } from "./matching.ts";
import { matchSkillName, sanitizeName } from "./matching.ts";

/** Most names one remove request may carry; keeps one request JSON comfortably bounded. */
const MAX_NAMES = 100;
const MAX_NAME_LENGTH = 255;

export type RemoveResult =
  | {
      readonly name: string;
      readonly ok: true;
      readonly state: "managed" | "broken";
      readonly directory: "removed" | "absent";
    }
  | { readonly name: string; readonly ok: false; readonly error: OperationError };

export type RemovePayload = { readonly results: readonly RemoveResult[] };

/** Validate a remove request input; null means malformed input. */
export function readRemoveNames(input: JsonValue): string[] | null {
  if (!isRecord(input)) return null;
  const names = input["names"];
  if (!Array.isArray(names) || names.length === 0 || names.length > MAX_NAMES) return null;
  const requested: string[] = [];
  for (const name of names) {
    if (typeof name !== "string" || name === "" || name.length > MAX_NAME_LENGTH) return null;
    if (!requested.includes(name)) requested.push(name);
  }
  return requested;
}

/**
 * Remove each named skill: a managed install loses its directory and lock entry,
 * a broken entry loses only the entry. Unmanaged directories are refused, every
 * path is contained and symlink-checked, and only the named entry is written.
 */
export async function removeSkills(
  context: OperationContext,
  names: readonly string[],
): Promise<Result<RemovePayload>> {
  const { managedDirectory, lockfilePath } = context.paths;
  const lock = await readLockfile(lockfilePath);
  context.signal.throwIfAborted();
  // Without a readable lock nothing can be classified, and a mutation would
  // drop unknown entries: refuse the whole request before touching any file.
  if (!lock.ok) return lock;

  const matchInput: MatchInput = {
    lockKeys: Object.keys(lock.value.skills),
    folderNames: await presentFolderNames(managedDirectory),
  };
  context.signal.throwIfAborted();

  const results: RemoveResult[] = [];
  for (const name of names) {
    results.push(await removeOne(context, name, matchInput));
  }
  return { ok: true, value: { results } };
}

async function removeOne(
  context: OperationContext,
  name: string,
  matchInput: MatchInput,
): Promise<RemoveResult> {
  const match = matchSkillName(name, matchInput);
  if (match === null) {
    return failure(
      name,
      "not-found",
      `No skill named ${JSON.stringify(name)} is present or recorded in the lockfile.`,
    );
  }
  if (match.lockKey === null) {
    return failure(
      name,
      "not-managed",
      `${JSON.stringify(name)} is not tracked by the lockfile; unmanaged skills are never removed.`,
    );
  }

  const lockKey = match.lockKey;
  const folderName = match.folderName ?? sanitizeName(lockKey);
  const safe = await assertSafeSkillDirectory(context.paths.managedDirectory, folderName);
  if (!safe.ok) return { name, ok: false, error: safe.error };

  const present = await exists(safe.value);
  if (present) {
    try {
      await rm(safe.value, { recursive: true, force: true });
    } catch (error) {
      return failure(name, "remove-failed", `Cannot remove ${safe.value}: ${describe(error)}`);
    }
  }

  const mutated = await mutateLockfile(context.paths.lockfilePath, (lock) => {
    if (Object.hasOwn(lock.skills, lockKey)) delete lock.skills[lockKey];
    return { ok: true, value: null };
  });
  if (!mutated.ok) return { name, ok: false, error: mutated.error };

  return {
    name,
    ok: true,
    state: present ? "managed" : "broken",
    directory: present ? "removed" : "absent",
  };
}

/** Folder names at the top of the managed directory; a missing directory is empty. */
async function presentFolderNames(managedDirectory: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(managedDirectory, { withFileTypes: true });
  } catch {
    return [];
  }
  const names: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory() || entry.isSymbolicLink()) names.push(entry.name);
  }
  return names;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

function failure(name: string, code: OperationErrorCode, message: string): RemoveResult {
  return { name, ok: false, error: operationError(code, message) };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
