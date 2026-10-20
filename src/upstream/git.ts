import { mkdtemp } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import type { ParsedSource } from "../vendor/skills/types.ts";
import type { Result } from "../operations/errors.ts";
import { operationError } from "../operations/errors.ts";
import { removeTempDirectory } from "../operations/containment.ts";

/** The host's bounded `execFile` adapter, narrowed to what git operations need. */
export type ExecFileRequest = {
  file: string;
  args?: readonly string[];
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  unsetEnv?: readonly string[];
  timeoutMs?: number;
  signal: AbortSignal;
};

export type ExecFileResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

export type ExecFile = (request: ExecFileRequest) => Promise<ExecFileResult>;

/** Requested clone bound; the host may lower it. */
export const CLONE_TIMEOUT_MS = 120_000;

/** No prompts, no opportunistic index locks: a clone must never wait on a terminal. */
const GIT_ENV: Readonly<Record<string, string>> = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_OPTIONAL_LOCKS: "0",
};

const FULL_COMMIT = /^[0-9a-f]{40}$/;
const TREE_SHA = /^[0-9a-f]{40}$/;

/**
 * Clone a source into a fresh directory under the OS temp root. The directory is
 * removed again when the clone fails, so a caller only ever owns a complete clone.
 */
export async function cloneSource(
  exec: ExecFile,
  parsed: ParsedSource,
  tempRoot: string,
  signal: AbortSignal,
): Promise<Result<string>> {
  let directory: string;
  try {
    directory = await mkdtemp(join(tempRoot, "pi-web-skills-add-"));
  } catch (error) {
    return cloneFailure(`Cannot create a temporary directory: ${describe(error)}`, signal);
  }
  if (!isInside(tempRoot, directory)) {
    await removeTempDirectory(tempRoot, directory);
    return cloneFailure("The temporary directory is outside the temp root.", signal);
  }

  const steps: readonly (readonly string[])[] =
    parsed.ref !== undefined && FULL_COMMIT.test(parsed.ref)
      ? [
          ["clone", "--depth", "1", parsed.url, directory],
          ["fetch", "--depth", "1", "origin", parsed.ref],
          ["checkout", "--quiet", "--detach", "FETCH_HEAD"],
        ]
      : [
          [
            "clone",
            "--depth",
            "1",
            ...(parsed.ref === undefined ? [] : ["--branch", parsed.ref]),
            parsed.url,
            directory,
          ],
        ];

  for (const args of steps) {
    const result = await runGit(exec, args, {
      ...(args[0] === "clone" ? {} : { cwd: directory }),
      signal,
    });
    if (!result.ok) {
      await removeTempDirectory(tempRoot, directory);
      return result;
    }
  }
  return { ok: true, value: directory };
}

/**
 * The git tree object SHA of a skill folder, or of the repository tree for a
 * root-level skill. A non-40-hex answer is an error: Update treats 40-hex as
 * "checkable", so this shape is never silently replaced with a content hash.
 */
export async function computeGitFolderHash(
  exec: ExecFile,
  cloneDirectory: string,
  folderPath: string,
  signal: AbortSignal,
): Promise<Result<string>> {
  const revision = folderPath === "" ? "HEAD^{tree}" : `HEAD:${folderPath}`;
  const result = await runGit(exec, ["rev-parse", "--verify", revision], {
    cwd: cloneDirectory,
    signal,
  });
  if (!result.ok) {
    return {
      ok: false,
      error: operationError("folder-hash-failed", result.error.message),
    };
  }
  const hash = result.value.stdout.trim();
  if (!TREE_SHA.test(hash)) {
    return {
      ok: false,
      error: operationError(
        "folder-hash-failed",
        `git returned ${JSON.stringify(hash.slice(0, 80))} instead of a tree SHA for ${folderPath || "the repository root"}`,
      ),
    };
  }
  return { ok: true, value: hash };
}

async function runGit(
  exec: ExecFile,
  args: readonly string[],
  options: { readonly cwd?: string; readonly signal: AbortSignal },
): Promise<Result<{ stdout: string }>> {
  let result: ExecFileResult;
  try {
    result = await exec({
      file: "git",
      args,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      env: GIT_ENV,
      timeoutMs: CLONE_TIMEOUT_MS,
      signal: options.signal,
    });
  } catch (error) {
    return cloneFailure(`git ${args[0]} failed: ${describe(error)}`, options.signal);
  }
  if (result.exitCode !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    return cloneFailure(`git ${args[0]} failed: ${detail || `exit code ${result.exitCode}`}`, options.signal);
  }
  return { ok: true, value: { stdout: result.stdout } };
}

function cloneFailure(message: string, signal: AbortSignal): Result<never> {
  const detail = message.length > 400 ? `${message.slice(0, 400)}…` : message;
  if (/authentication failed|could not read username|permission denied|terminal prompts disabled/i.test(detail)) {
    return {
      ok: false,
      error: operationError(
        "auth-required",
        `${detail}. Provide GITHUB_TOKEN or GH_TOKEN in the daemon environment for a private source.`,
      ),
    };
  }
  return {
    ok: false,
    error: operationError(
      "clone-failed",
      signal.aborted ? "The clone was cancelled." : `${detail}. Check the source and retry.`,
    ),
  };
}

function isInside(root: string, candidate: string): boolean {
  const relativePath = relative(resolve(root), resolve(candidate));
  return relativePath !== "" && relativePath !== ".." && !relativePath.startsWith(`..${sep}`);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
