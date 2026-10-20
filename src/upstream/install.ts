import { randomUUID } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, readdir, realpath, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { assertSafeSkillDirectory } from "../operations/containment.ts";
import type { Result } from "../operations/errors.ts";
import { operationError } from "../operations/errors.ts";

const SKIP_DIRECTORIES = new Set([".git", "node_modules"]);
const TEMP_PREFIX = ".pi-web-skills-";

export type InstallCopy = { readonly replaced: boolean };

/** Runs after the swap and before the backup is discarded; a failure rolls the swap back. */
export type InstallCommit = () => Promise<Result<unknown>>;

/**
 * Copy a skill directory to `<managedDirectory>/<folderName>` by staging a temp
 * sibling and swapping it in. Regular files and directories keep their modes;
 * symlinks, `.git`, and `node_modules` are skipped. A failure leaves any
 * previous install untouched.
 */
export async function installSkillDirectory(
  managedDirectory: string,
  folderName: string,
  sourceDirectory: string,
  signal: AbortSignal,
  commit: InstallCommit = async () => ({ ok: true, value: null }),
): Promise<Result<InstallCopy>> {
  const checked = await assertSafeSkillDirectory(managedDirectory, folderName);
  if (!checked.ok) return checked;
  const destination = checked.value;

  let sourceRoot: string;
  let rootMode: number;
  try {
    sourceRoot = await realpath(resolve(sourceDirectory));
    const root = await lstat(sourceRoot);
    if (!root.isDirectory()) {
      return copyFailure(`Cannot copy ${sourceDirectory}: it is not a directory.`, signal);
    }
    rootMode = root.mode & 0o7777;
  } catch (error) {
    return copyFailure(`Cannot read ${sourceDirectory}: ${describe(error)}`, signal);
  }

  const parent = dirname(destination);
  const staging = join(parent, `${TEMP_PREFIX}${randomUUID()}.tmp`);
  try {
    await mkdir(parent, { recursive: true });
    await mkdir(staging, { mode: 0o700 });
    await copyTree(sourceRoot, staging, signal);
    await chmod(staging, rootMode);
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    return copyFailure(`Cannot copy ${sourceDirectory}: ${describe(error)}`, signal);
  }

  const swap = await swapIntoPlace(staging, destination, parent, signal);
  if (!swap.ok) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    return swap;
  }

  let committed: Result<unknown>;
  try {
    committed = await commit();
  } catch (error) {
    committed = copyFailure(`Cannot record the install in ${destination}: ${describe(error)}`, signal);
  }
  if (!committed.ok) {
    await rollbackSwap(destination, swap.value.backup);
    return committed;
  }
  if (swap.value.backup !== null) {
    await rm(swap.value.backup, { recursive: true, force: true }).catch(() => undefined);
  }
  return { ok: true, value: { replaced: swap.value.replaced } };
}

async function copyTree(source: string, target: string, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    if (SKIP_DIRECTORIES.has(entry.name)) continue;
    const from = join(source, entry.name);
    // Symlinks are never followed, so a copied entry cannot resolve outside the skill.
    if (entry.isSymbolicLink()) continue;
    const to = join(target, entry.name);
    if (entry.isDirectory()) {
      await mkdir(to, { mode: 0o700 });
      await copyTree(from, to, signal);
      await chmod(to, (await lstat(from)).mode & 0o7777);
    } else if (entry.isFile()) {
      await copyFile(from, to);
      await chmod(to, (await lstat(from)).mode & 0o7777);
    }
  }
}

type Swapped = {
  readonly replaced: boolean;
  /** The previous install, kept until the commit succeeds. */
  readonly backup: string | null;
};

async function swapIntoPlace(
  staging: string,
  destination: string,
  parent: string,
  signal: AbortSignal,
): Promise<Result<Swapped>> {
  let backup: string | null = null;
  let replaced = false;
  let movedNew = false;
  try {
    try {
      await lstat(destination);
      const previous = join(parent, `${TEMP_PREFIX}${randomUUID()}.old`);
      await rename(destination, previous);
      backup = previous;
      replaced = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    await rename(staging, destination);
    movedNew = true;
    return { ok: true, value: { replaced, backup } };
  } catch (error) {
    // Touch the destination only when this call moved something there.
    if (backup !== null || movedNew) await rollbackSwap(destination, backup);
    return copyFailure(`Cannot install into ${destination}: ${describe(error)}`, signal);
  }
}

/** Put the previous install back, or remove the new one when there was none. */
async function rollbackSwap(destination: string, backup: string | null): Promise<void> {
  await rm(destination, { recursive: true, force: true }).catch(() => undefined);
  if (backup !== null) await rename(backup, destination).catch(() => undefined);
}

function copyFailure(message: string, signal: AbortSignal): Result<never> {
  if (signal.aborted) {
    return { ok: false, error: operationError("install-failed", "The install was cancelled.") };
  }
  return { ok: false, error: operationError("install-failed", message) };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
