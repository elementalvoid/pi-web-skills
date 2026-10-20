import { readFile, stat } from "node:fs/promises";
import type { OperationContext } from "./context.ts";

export type StatusPayload = {
  readonly managedDirectory: string;
  readonly lockfilePath: string;
  readonly managedDirectoryExists: boolean;
  readonly lockfileExists: boolean;
  readonly lockReadable: boolean;
};

/** Read-only existence report; never creates either location. */
export async function getStatus(context: OperationContext): Promise<StatusPayload> {
  const { managedDirectory, lockfilePath } = context.paths;
  const [managedDirectoryExists, lockfileExists] = await Promise.all([
    exists(managedDirectory),
    exists(lockfilePath),
  ]);
  context.signal.throwIfAborted();
  const lockReadable = lockfileExists && (await isReadableFile(lockfilePath));
  return { managedDirectory, lockfilePath, managedDirectoryExists, lockfileExists, lockReadable };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function isReadableFile(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}
