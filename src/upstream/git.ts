import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import type { ParsedSource } from "../vendor/skills/types.ts";
import type { Result } from "../operations/errors.ts";
import { operationError } from "../operations/errors.ts";
import { isRealPathInside, removeTempDirectory } from "../operations/containment.ts";

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

/** The one file that makes a folder a skill. */
const SKILL_FILE = "SKILL.md";

/** The only tree the add flow reads outside a skill folder: the plugin manifests. */
const PLUGIN_MANIFEST_DIRECTORY = ".claude-plugin";

/** No prompts, no opportunistic index locks: a clone must never wait on a terminal. */
const GIT_ENV: Readonly<Record<string, string>> = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_OPTIONAL_LOCKS: "0",
};

/** A daemon-inherited repository location must not redirect the clone or its hashes. */
const GIT_UNSET_ENV: readonly string[] = ["GIT_DIR", "GIT_WORK_TREE"];

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
  if (!(await isRealPathInside(tempRoot, directory))) {
    await removeTempDirectory(tempRoot, directory);
    return cloneFailure("The temporary directory is outside the temp root.", signal);
  }

  // Blobless and sparse: the host bounds every command, so the checkout below
  // fetches only the folders a skill lives in instead of a whole working tree.
  const ref = parsed.ref;
  const clone = [
    "clone",
    "--depth",
    "1",
    ...(ref === undefined || FULL_COMMIT.test(ref) ? [] : ["--branch", ref]),
    "--filter=blob:none",
    "--sparse",
    parsed.url,
    directory,
  ];
  const steps: readonly (readonly string[])[] =
    ref !== undefined && FULL_COMMIT.test(ref)
      ? [
          clone,
          ["fetch", "--depth", "1", "origin", ref],
          ["checkout", "--quiet", "--detach", "FETCH_HEAD"],
        ]
      : [clone];

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
  const materialized = await materializeSkillFolders(exec, directory, signal);
  if (!materialized.ok) {
    await removeTempDirectory(tempRoot, directory);
    return materialized;
  }
  return { ok: true, value: directory };
}

/**
 * Check out the folders that hold a SKILL.md, plus the plugin manifests. A large
 * repository transfers far more than the hosting command bound allows, so only
 * those paths are fetched. A SKILL.md at the repository root owns the whole tree.
 */
async function materializeSkillFolders(
  exec: ExecFile,
  directory: string,
  signal: AbortSignal,
): Promise<Result<null>> {
  const listed = await runGit(exec, ["ls-tree", "-r", "-z", "--name-only", "HEAD"], {
    cwd: directory,
    signal,
  });
  if (!listed.ok) return listed;
  const folders = new Set<string>();
  let rootSkill = false;
  for (const path of listed.value.stdout.split("\0")) {
    if (path === SKILL_FILE) rootSkill = true;
    else if (path.endsWith(`/${SKILL_FILE}`)) folders.add(path.slice(0, -SKILL_FILE.length - 1));
    const manifest = path.indexOf(`${PLUGIN_MANIFEST_DIRECTORY}/`);
    if (manifest !== -1) {
      folders.add(path.slice(0, manifest + PLUGIN_MANIFEST_DIRECTORY.length));
    }
  }
  if (rootSkill) {
    const disabled = await runGit(exec, ["sparse-checkout", "disable"], { cwd: directory, signal });
    return disabled.ok ? { ok: true, value: null } : disabled;
  }
  if (folders.size === 0) return { ok: true, value: null };
  const checked = await runGit(exec, ["sparse-checkout", "set", "--cone", ...folders], {
    cwd: directory,
    signal,
  });
  return checked.ok ? { ok: true, value: null } : checked;
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
  const result = await runGit(exec, ["rev-parse", "--verify", "--end-of-options", revision], {
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
      unsetEnv: GIT_UNSET_ENV,
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
  if (/timed out after \d+ms/i.test(detail)) {
    return {
      ok: false,
      error: operationError(
        "clone-failed",
        `${detail}. The server stopped the command before it finished, so this source is too slow to read.`,
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

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
