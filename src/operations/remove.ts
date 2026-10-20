import { rm } from "node:fs/promises";
import type { OperationContext } from "./context.ts";
import { assertSafePresentDirectory } from "./containment.ts";
import type { JsonValue, OperationError, OperationErrorCode, Result } from "./errors.ts";
import { operationError } from "./errors.ts";
import type { PresentSkillDirectory } from "./list.ts";
import { discoverSkillDirectories } from "./list.ts";
import { mutateLockfile, readLockfile } from "./lockfile.ts";
import type { MatchInput } from "./matching.ts";
import { matchSkillName } from "./matching.ts";

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
  | {
      readonly name: string;
      readonly ok: false;
      /** Present when the directory was already deleted before the failure. */
      readonly directory?: "removed";
      readonly error: OperationError;
    };

export type RemovePayload = { readonly results: readonly RemoveResult[] };

export type RemoveContext = OperationContext & {
  /** Replaces the atomic lock mutation; a test uses it to fail the write after the delete. */
  readonly mutateLock?: typeof mutateLockfile;
};

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
 * A failure for one name is a result for that name, never a thrown error that
 * would stop the remaining names.
 */
export async function removeSkills(
  context: RemoveContext,
  names: readonly string[],
): Promise<Result<RemovePayload>> {
  const { managedDirectory, lockfilePath } = context.paths;
  const lock = await readLockfile(lockfilePath);
  context.signal.throwIfAborted();
  // Without a readable lock nothing can be classified, and a mutation would
  // drop unknown entries: refuse the whole request before touching any file.
  if (!lock.ok) return lock;

  const present = await discoverSkillDirectories(managedDirectory);
  context.signal.throwIfAborted();
  const matchInput: MatchInput = {
    lockKeys: Object.keys(lock.value.skills),
    folderNames: present.map((directory) => directory.folderName),
  };

  const results: RemoveResult[] = [];
  for (const name of names) {
    try {
      results.push(await removeOne(context, name, matchInput, present));
    } catch (error) {
      results.push({
        name,
        ok: false,
        error: operationError(
          "remove-failed",
          `Removing ${JSON.stringify(name)} failed.`,
          { reason: describe(error) },
        ),
      });
    }
  }
  return { ok: true, value: { results } };
}

async function removeOne(
  context: RemoveContext,
  name: string,
  matchInput: MatchInput,
  present: readonly PresentSkillDirectory[],
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

  // Only a real present skill directory is deleted. A lock key with no present
  // skill is broken; a symlink with that name is not a present skill, so its
  // entry is cleaned up and the link is never followed or deleted.
  const folder =
    match.folderName === null
      ? null
      : (present.find((directory) => directory.folderName === match.folderName) ?? null);
  let removedDirectory = false;
  if (folder !== null) {
    const safe = await assertSafePresentDirectory(
      context.paths.managedDirectory,
      folder.relativePath,
    );
    if (!safe.ok) return { name, ok: false, error: safe.error };
    try {
      await rm(safe.value, { recursive: true, force: true });
      removedDirectory = true;
    } catch (error) {
      return failure(name, "remove-failed", `Cannot remove ${safe.value}: ${describe(error)}`);
    }
  }

  const mutated = await removeLockEntry(context, match.lockKey);
  if (!mutated.ok) {
    if (!removedDirectory) return { name, ok: false, error: mutated.error };
    return {
      name,
      ok: false,
      directory: "removed",
      error: operationError(
        "remove-failed",
        `Removed the directory for ${JSON.stringify(name)} but could not update the lockfile; its entry remains.`,
        mutated.error.details,
      ),
    };
  }

  return {
    name,
    ok: true,
    state: removedDirectory ? "managed" : "broken",
    directory: removedDirectory ? "removed" : "absent",
  };
}

async function removeLockEntry(
  context: RemoveContext,
  lockKey: string,
): Promise<Result<null>> {
  const mutate = context.mutateLock ?? mutateLockfile;
  try {
    return await mutate(context.paths.lockfilePath, (lock) => {
      if (Object.hasOwn(lock.skills, lockKey)) delete lock.skills[lockKey];
      return { ok: true, value: null };
    });
  } catch (error) {
    return {
      ok: false,
      error: operationError("remove-failed", "Cannot write the lockfile.", {
        reason: describe(error),
      }),
    };
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
