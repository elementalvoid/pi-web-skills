import { lstat, realpath, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Result } from "./errors.ts";
import { operationError } from "./errors.ts";

export type PathCheck = Result<string>;

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
  return { ok: true, value: path };
}

/**
 * Resolve a skill folder through symlinks and refuse anything that leaves the
 * real managed directory. A missing folder is accepted: a broken entry still
 * needs its stale lock entry cleaned up. A managed directory that is itself a
 * symlink is allowed; the returned path is the real one removal must use.
 */
export async function assertSafeSkillDirectory(
  managedDirectory: string,
  folderName: string,
): Promise<PathCheck> {
  const lexical = resolveManagedPath(managedDirectory, folderName);
  if (!lexical.ok) return lexical;

  let root: string;
  let target: string;
  try {
    root = await resolveRealPath(resolve(managedDirectory));
    target = await resolveRealPath(lexical.value);
  } catch (error) {
    return unsafePath(`Cannot resolve ${lexical.value}: ${String(error)}`);
  }
  if (!isStrictlyInside(root, target)) {
    return unsafePath(`${lexical.value} resolves to ${target}, outside ${root}`);
  }

  try {
    if ((await lstat(lexical.value)).isSymbolicLink()) {
      return unsafePath(`${lexical.value} is a symlink`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return unsafePath(`Cannot inspect ${lexical.value}: ${String(error)}`);
    }
  }
  return { ok: true, value: target };
}

/** True when `candidate` resolves to a real path strictly inside the real `root`. */
export async function isRealPathInside(root: string, candidate: string): Promise<boolean> {
  try {
    return isStrictlyInside(
      await resolveRealPath(resolve(root)),
      await resolveRealPath(resolve(candidate)),
    );
  } catch {
    return false;
  }
}

/** Delete a temp directory only when its real path stays inside the real temp root. */
export async function removeTempDirectory(tempRoot: string, candidate: string): Promise<boolean> {
  if (!(await isRealPathInside(tempRoot, candidate))) return false;
  await rm(resolve(candidate), { recursive: true, force: true });
  return true;
}

/**
 * Resolve an existing path with `realpath`; for a missing path, resolve the
 * nearest existing ancestor and reattach the missing segments.
 */
async function resolveRealPath(path: string): Promise<string> {
  const missing: string[] = [];
  let current = resolve(path);
  for (;;) {
    try {
      return join(await realpath(current), ...missing);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      missing.unshift(basename(current));
      current = parent;
    }
  }
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
