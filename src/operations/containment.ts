import { lstat, rm } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { OperationError } from "./errors.ts";
import { operationError } from "./errors.ts";

export type PathCheck =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly error: OperationError };

/** Resolve one skill folder name inside the managed directory; escapes are unsafe-path. */
export function resolveManagedPath(managedDirectory: string, folderName: string): PathCheck {
  if (!isSingleSegment(folderName)) {
    return unsafePath(`${JSON.stringify(folderName)} is not a single path segment`);
  }
  const root = resolve(managedDirectory);
  const path = resolve(root, folderName);
  if (!isStrictlyInside(root, path)) {
    return unsafePath(`${path} is outside ${root}`);
  }
  return { ok: true, path };
}

/**
 * Resolve a skill folder and refuse a symlinked entry. A missing folder is
 * accepted: a broken entry still needs its stale lock entry cleaned up.
 */
export async function assertSafeSkillDirectory(
  managedDirectory: string,
  folderName: string,
): Promise<PathCheck> {
  const resolved = resolveManagedPath(managedDirectory, folderName);
  if (!resolved.ok) return resolved;
  try {
    if ((await lstat(resolved.path)).isSymbolicLink()) {
      return unsafePath(`${resolved.path} is a symlink`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return unsafePath(`Cannot inspect ${resolved.path}: ${String(error)}`);
    }
  }
  return resolved;
}

/** Delete a temp directory only when it resolves strictly inside the temp root. */
export async function removeTempDirectory(tempRoot: string, candidate: string): Promise<boolean> {
  const root = resolve(tempRoot);
  const target = resolve(candidate);
  if (!isStrictlyInside(root, target)) return false;
  await rm(target, { recursive: true, force: true });
  return true;
}

function isSingleSegment(folderName: string): boolean {
  return (
    folderName !== "" &&
    folderName !== "." &&
    folderName !== ".." &&
    !isAbsolute(folderName) &&
    !folderName.includes("/") &&
    !folderName.includes("\\") &&
    !folderName.includes("\0")
  );
}

function isStrictlyInside(root: string, target: string): boolean {
  const relativePath = relative(root, target);
  return (
    relativePath !== "" &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
}

function unsafePath(message: string): PathCheck {
  return { ok: false, error: operationError("unsafe-path", message) };
}
