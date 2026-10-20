import { readdir } from "node:fs/promises";
import { basename, relative, sep } from "node:path";
import { getOwnerRepo, parseSource } from "../vendor/skills/source-parser.ts";
import { computeSkillFolderHash } from "../vendor/skills/local-lock.ts";
import { sanitizeMetadata } from "../vendor/skills/sanitize.ts";
import { discoverSkills } from "../vendor/skills/skills.ts";
import type { ParsedSource } from "../vendor/skills/types.ts";
import { cloneSource, computeGitFolderHash } from "../upstream/git.ts";
import type { ExecFile } from "../upstream/git.ts";
import { installSkillDirectory } from "../upstream/install.ts";
import { removeTempDirectory } from "./containment.ts";
import type { OperationContext } from "./context.ts";
import type { OperationError, Result } from "./errors.ts";
import { operationError } from "./errors.ts";
import type { InstallTarget } from "./matching.ts";
import { resolveInstallTarget, sanitizeName } from "./matching.ts";
import type { LockEntry } from "./lockfile.ts";
import { mutateLockfile, readLockfile } from "./lockfile.ts";

/** Candidates per channel frame; keeps every frame far below the host's 64 KiB bound. */
export const CANDIDATE_PAGE_SIZE = 25;

/**
 * Per-field byte caps. With 25 candidates per page and JSON escaping at worst
 * doubling a byte, the largest possible page is under 50 KiB.
 */
const NAME_LIMIT = 80;
const DESCRIPTION_LIMIT = 400;
const SOURCE_PATH_LIMIT = 300;

/** One skill discovered in a resolved source, before anything is installed. */
export type AddCandidate = {
  readonly name: string;
  readonly description: string;
  readonly sourcePath: string;
  readonly folderName: string;
  readonly folderHash: string;
  readonly existing: "none" | "managed" | "unmanaged";
};

/** A skill that install can copy; the source path and folder name are uncapped. */
type InstallableCandidate = {
  readonly name: string;
  readonly folderName: string;
  readonly folderHash: string;
  readonly skillPath: string;
  readonly directory: string;
};

export type AddFailure = { readonly name: string; readonly message: string };

/** Frames the add session streams to its channel. */
export type AddFrame =
  | {
      readonly type: "candidates";
      readonly candidates: readonly AddCandidate[];
      readonly index: number;
      readonly total: number;
    }
  | { readonly type: "candidates-end"; readonly total: number }
  | {
      readonly type: "progress";
      readonly phase: "installing" | "installed";
      readonly name: string;
      readonly index: number;
      readonly total: number;
    }
  | {
      readonly type: "done";
      readonly installed: readonly string[];
      readonly replaced: readonly string[];
      readonly failed: readonly AddFailure[];
    }
  | { readonly type: "error"; readonly error: OperationError };

export type AddContext = OperationContext & {
  readonly source: string;
  readonly exec: ExecFile;
  readonly tempRoot: string;
};

/**
 * Drives one add channel: resolve, clone, discover, and stream candidates. The
 * clone stays open afterwards so a later install can copy from it.
 */
export type AddSession = {
  readonly start: () => void;
  readonly settled: Promise<void>;
  readonly install: (names: readonly string[]) => void;
  readonly cancel: () => void;
  readonly dispose: () => Promise<void>;
  readonly cloneDirectory: () => string | null;
};

export function createAddSession(
  context: AddContext,
  onFrame: (frame: AddFrame) => void,
): AddSession {
  const controller = new AbortController();
  const signal = controller.signal;
  let cloneDirectory: string | null = null;
  let resolvedSource: {
    readonly parsed: ParsedSource;
    readonly installable: readonly InstallableCandidate[];
  } | null = null;
  let installing = false;
  let installPromise: Promise<void> | null = null;
  let runPromise: Promise<void> | null = null;
  let settle: () => void = () => {};
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });

  const abort = () => controller.abort();
  context.signal.addEventListener("abort", abort, { once: true });
  if (context.signal.aborted) controller.abort();

  const emit = (frame: AddFrame): void => {
    try {
      onFrame(frame);
    } catch {
      controller.abort();
    }
  };

  const cleanup = async (): Promise<void> => {
    const directory = cloneDirectory;
    cloneDirectory = null;
    if (directory !== null) await removeTempDirectory(context.tempRoot, directory);
  };

  async function run(): Promise<void> {
    let keepClone = false;
    try {
      const parsed = resolveAddSource(context.source);
      if (!parsed.ok) {
        if (!signal.aborted) emit({ type: "error", error: parsed.error });
        return;
      }
      const cloned = await cloneSource(context.exec, parsed.value, context.tempRoot, signal);
      if (!cloned.ok) {
        if (!signal.aborted) emit({ type: "error", error: cloned.error });
        return;
      }
      cloneDirectory = cloned.value;

      const discovered = await discoverCandidates(context, parsed.value, cloned.value, signal);
      if (!discovered.ok) {
        if (!signal.aborted) emit({ type: "error", error: discovered.error });
        return;
      }
      if (signal.aborted) return;

      const { candidates } = discovered.value;
      for (let index = 0; index < candidates.length; index += CANDIDATE_PAGE_SIZE) {
        emit({
          type: "candidates",
          candidates: candidates.slice(index, index + CANDIDATE_PAGE_SIZE),
          index: index / CANDIDATE_PAGE_SIZE,
          total: candidates.length,
        });
      }
      emit({ type: "candidates-end", total: candidates.length });
      resolvedSource = { parsed: parsed.value, installable: discovered.value.installable };
      keepClone = true;
    } catch (error) {
      if (!signal.aborted) {
        emit({
          type: "error",
          error: operationError("discovery-failed", `Cannot read the source: ${describe(error)}`),
        });
      }
    } finally {
      context.signal.removeEventListener("abort", abort);
      if (!keepClone) await cleanup();
    }
  }

  return {
    start() {
      if (runPromise !== null) return;
      runPromise = run().finally(() => settle());
    },
    settled,
    install(names) {
      if (signal.aborted) return;
      if (!Array.isArray(names) || names.some((name) => typeof name !== "string")) {
        emit({
          type: "error",
          error: operationError("invalid-input", "install takes a list of skill names."),
        });
        return;
      }
      if (names.length === 0) {
        emit({
          type: "error",
          error: operationError("invalid-input", "Select at least one skill to install."),
        });
        return;
      }
      const resolved = resolvedSource;
      if (resolved === null) {
        emit({
          type: "error",
          error: operationError("invalid-input", "Resolve the source before installing skills."),
        });
        return;
      }
      if (installing) {
        emit({
          type: "error",
          error: operationError("invalid-input", "An install is already running."),
        });
        return;
      }
      installing = true;
      installPromise = runInstall(context, signal, resolved, names, emit).finally(() => {
        installing = false;
      });
    },
    cancel() {
      controller.abort();
    },
    async dispose() {
      controller.abort();
      if (runPromise !== null) await runPromise.catch(() => {});
      else settle();
      if (installPromise !== null) await installPromise.catch(() => {});
      await cleanup();
    },
    cloneDirectory() {
      return cloneDirectory;
    },
  };
}

async function discoverCandidates(
  context: AddContext,
  parsed: ParsedSource,
  cloneDirectory: string,
  signal: AbortSignal,
): Promise<Result<{ readonly candidates: readonly AddCandidate[]; readonly installable: readonly InstallableCandidate[] }>> {
  let skills;
  try {
    skills = await discoverSkills(cloneDirectory, parsed.subpath, {
      fullDepth: true,
      includeDuplicateNames: true,
    });
  } catch (error) {
    return discoveryFailure(`Cannot discover skills: ${describe(error)}`);
  }

  const filter = parsed.skillFilter;
  const selected =
    filter === undefined
      ? skills
      : skills.filter(
          (skill) =>
            skill.name === filter ||
            basename(skill.path) === filter ||
            sanitizeName(skill.name) === sanitizeName(filter),
        );
  if (selected.length === 0) {
    return filter === undefined
      ? discoveryFailure("No skills with a valid SKILL.md were found in the source.")
      : {
          ok: false,
          error: operationError(
            "skill-not-found",
            `The source has no skill named ${JSON.stringify(filter)}.`,
          ),
        };
  }

  const lock = await readLockfile(context.paths.lockfilePath);
  // An unreadable lock blocks the whole add: without it, an existing managed
  // install would be mislabelled and a later write would drop other entries.
  if (!lock.ok) return lock;
  const lockKeys = Object.keys(lock.value.skills);
  const folderNames = await presentFolders(context.paths.managedDirectory);
  const candidates: AddCandidate[] = [];
  const installable: InstallableCandidate[] = [];
  for (const skill of selected) {
    if (signal.aborted) return discoveryFailure("The add operation was cancelled.");
    const relativeFolder = relative(cloneDirectory, skill.path).split(sep).join("/");
    const hashed =
      parsed.type === "github" || parsed.type === "gitlab"
        ? await computeGitFolderHash(context.exec, cloneDirectory, relativeFolder, signal)
        : await contentFolderHash(skill.path);
    if (!hashed.ok) return hashed;

    // The same exact/sanitised-key/sanitised-folder rung List uses. A lock key
    // without a present folder is a broken entry, not a target this replaces.
    const target = resolveInstallTarget(skill.name, { lockKeys, folderNames });
    const skillPath = relativeFolder === "" ? "SKILL.md" : `${relativeFolder}/SKILL.md`;
    candidates.push({
      name: candidateText(skill.name, NAME_LIMIT),
      description: candidateText(skill.description, DESCRIPTION_LIMIT),
      sourcePath: candidateText(skillPath, SOURCE_PATH_LIMIT),
      folderName: candidateText(target.folderName, NAME_LIMIT),
      folderHash: hashed.value,
      existing: target.existing,
    });
    installable.push({
      name: skill.name,
      folderName: target.folderName,
      folderHash: hashed.value,
      skillPath,
      directory: skill.path,
    });
  }
  return { ok: true, value: { candidates, installable } };
}

/**
 * Install the selected skills on the session signal. Each skill is copied, then
 * recorded, so an earlier success survives a later failure. Reading the lock and
 * the managed directory again keeps the destination rule current.
 */
async function runInstall(
  context: AddContext,
  signal: AbortSignal,
  resolved: { readonly parsed: ParsedSource; readonly installable: readonly InstallableCandidate[] },
  names: readonly string[],
  emit: (frame: AddFrame) => void,
): Promise<void> {
  const failed: AddFailure[] = [];
  const selected: InstallableCandidate[] = [];
  for (const name of names) {
    const candidate = resolved.installable.find((item) => item.name === name);
    if (candidate === undefined) {
      failed.push({ name, message: "The resolved source provides no skill with this name." });
    } else {
      selected.push(candidate);
    }
  }
  if (selected.length === 0) {
    emit({ type: "done", installed: [], replaced: [], failed });
    return;
  }
  const duplicate = duplicateFolder(selected);
  if (duplicate !== null) {
    emit({
      type: "error",
      error: operationError(
        "invalid-input",
        `Two selected skills share the install folder ${JSON.stringify(duplicate)}; install them in separate runs.`,
      ),
    });
    return;
  }

  const lock = await readLockfile(context.paths.lockfilePath);
  if (!lock.ok) {
    emit({ type: "error", error: lock.error });
    return;
  }
  const folderNames = await presentFolders(context.paths.managedDirectory);
  const lockKeys = Object.keys(lock.value.skills);
  const targets: { readonly candidate: InstallableCandidate; readonly target: InstallTarget }[] =
    selected.map((candidate) => ({
      candidate,
      target: resolveInstallTarget(candidate.name, { lockKeys, folderNames }),
    }));
  const sharedFolder = duplicateValue(targets.map(({ target }) => target.folderName));
  if (sharedFolder !== null) {
    emit({
      type: "error",
      error: operationError(
        "invalid-input",
        `Two selected skills share the install folder ${JSON.stringify(sharedFolder)}; install them in separate runs.`,
      ),
    });
    return;
  }
  const sharedKey = duplicateValue(targets.map(({ target }) => target.key));
  if (sharedKey !== null) {
    emit({
      type: "error",
      error: operationError(
        "invalid-input",
        `Two selected skills share the lock entry ${JSON.stringify(sharedKey)}; install them in separate runs.`,
      ),
    });
    return;
  }

  const installed: string[] = [];
  const replaced: string[] = [];
  for (let index = 0; index < targets.length; index += 1) {
    if (signal.aborted) return;
    const { candidate, target } = targets[index]!;
    emit({ type: "progress", phase: "installing", name: candidate.name, index, total: targets.length });
    const copied = await installSkillDirectory(
      context.paths.managedDirectory,
      target.folderName,
      candidate.directory,
      signal,
    );
    if (!copied.ok) {
      if (signal.aborted) return;
      failed.push({ name: candidate.name, message: copied.error.message });
      continue;
    }
    const written = await writeLockEntry(context.paths.lockfilePath, resolved.parsed, candidate, target.key);
    if (!written.ok) {
      if (signal.aborted) return;
      // shortcut: a lock write that fails after the copy leaves an unmanaged install; a retry records it.
      failed.push({ name: candidate.name, message: written.error.message });
      continue;
    }
    if (copied.value.replaced) replaced.push(candidate.name);
    else installed.push(candidate.name);
    emit({ type: "progress", phase: "installed", name: candidate.name, index, total: targets.length });
  }
  emit({ type: "done", installed, replaced, failed });
}

function duplicateFolder(candidates: readonly InstallableCandidate[]): string | null {
  return duplicateValue(candidates.map((candidate) => sanitizeName(candidate.name)));
}

function duplicateValue(values: readonly string[]): string | null {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }
  return null;
}

/** One standard entry per install; `installedAt` survives a replace, unknown fields survive too. */
async function writeLockEntry(
  lockfilePath: string,
  parsed: ParsedSource,
  candidate: InstallableCandidate,
  key: string,
): Promise<Result<null>> {
  return mutateLockfile(lockfilePath, (lock) => {
    const previous = lock.skills[key];
    const now = new Date().toISOString();
    const next: LockEntry = {
      ...previous,
      source: normalizedSource(parsed),
      sourceType: parsed.type,
      sourceUrl: parsed.url,
      skillPath: candidate.skillPath,
      skillFolderHash: candidate.folderHash,
      installedAt: previous?.installedAt ?? now,
      updatedAt: now,
    };
    if (parsed.ref === undefined) delete next.ref;
    else next.ref = parsed.ref;
    lock.skills[key] = next;
    return { ok: true, value: null };
  });
}

/** `owner/repo` for GitHub and GitLab; the clone URL for a generic git source. */
function normalizedSource(parsed: ParsedSource): string {
  if (parsed.type !== "github" && parsed.type !== "gitlab") return parsed.url;
  return getOwnerRepo(parsed) ?? parsed.url;
}

/** Names of the directories present in the managed directory; a missing directory is empty. */
async function presentFolders(managedDirectory: string): Promise<string[]> {
  try {
    const entries = await readdir(managedDirectory, { withFileTypes: true });
    const names: string[] = [];
    for (const entry of entries) if (entry.isDirectory()) names.push(entry.name);
    return names;
  } catch {
    return [];
  }
}

async function contentFolderHash(skillDirectory: string): Promise<Result<string>> {
  try {
    const hash = await computeSkillFolderHash(skillDirectory);
    if (!/^[0-9a-f]{64}$/.test(hash)) {
      return discoveryFailure(`Unexpected content hash ${JSON.stringify(hash.slice(0, 80))}.`);
    }
    return { ok: true, value: hash };
  } catch (error) {
    return discoveryFailure(`Cannot hash ${skillDirectory}: ${describe(error)}`);
  }
}

/** Strip terminal escapes and control characters, then cap a display string by UTF-8 bytes. */
function candidateText(value: string, limit: number): string {
  return capBytes(sanitizeMetadata(value).replace(/\s+/g, " "), limit);
}

function capBytes(value: string, limit: number): string {
  if (Buffer.byteLength(value, "utf8") <= limit) return value;
  const budget = limit - Buffer.byteLength("…", "utf8");
  let out = "";
  let used = 0;
  for (const char of value) {
    const size = utf8Size(char.codePointAt(0) ?? 0);
    if (used + size > budget) break;
    out += char;
    used += size;
  }
  return `${out}…`;
}

function utf8Size(code: number): number {
  if (code < 0x80) return 1;
  if (code < 0x800) return 2;
  return code < 0x10000 ? 3 : 4;
}

function discoveryFailure(message: string): Result<never> {
  return { ok: false, error: operationError("discovery-failed", message) };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Resolve user input to a cloneable source. Only repository sources are
 * supported in v1: local paths, well-known URLs, and hosted artifacts are
 * rejected before any process or network work.
 */
export function resolveAddSource(input: string): Result<ParsedSource> {
  const source = input.trim();
  if (source === "" || source.startsWith("-")) {
    return unsupported("Enter a source to add.");
  }
  if (/[\u0000-\u001f]/.test(source)) {
    return unsupported("The source contains control characters.");
  }
  if (source.toLowerCase().includes("ext::")) {
    return unsupported("ext:: git transports are not allowed.");
  }

  let parsed: ParsedSource;
  try {
    parsed = parseSource(source);
  } catch (error) {
    return unsupported(`Cannot parse the source: ${describe(error)}`);
  }

  if (parsed.type === "local") {
    return unsupported("Local directory sources are not supported; use a repository or git URL.");
  }
  if (parsed.type === "well-known") {
    return unsupported("Well-known skill URLs are not supported; use a repository URL.");
  }
  if (parsed.type === "download") {
    return unsupported("Hosted archive and raw-file URLs are not supported; use a repository URL.");
  }
  if (parsed.type === "github" || parsed.type === "gitlab") {
    return { ok: true, value: parsed };
  }

  const withRef = takeGenericRef(parsed);
  if (!isGenericGitUrl(withRef.url)) {
    return unsupported(`"${source}" is not a git repository URL.`);
  }
  return { ok: true, value: withRef };
}

/** The vendored parser only reads `#ref` for hosts it recognises; a generic git URL carries it too. */
function takeGenericRef(parsed: ParsedSource): ParsedSource {
  if (parsed.ref !== undefined) return parsed;
  const hash = parsed.url.indexOf("#");
  if (hash < 0) return parsed;
  const ref = parsed.url.slice(hash + 1);
  const url = parsed.url.slice(0, hash);
  if (ref === "") return { ...parsed, url };
  return { ...parsed, url, ref: decodeURIComponent(ref) };
}

function isGenericGitUrl(url: string): boolean {
  if (/^[\w.-]+@[\w.-]+:.+$/.test(url)) return true;
  if (!/^(?:https?|ssh|git|file):\/\//i.test(url)) return false;
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  // A GitHub or GitLab URL that reached the generic branch was not a repository URL.
  return hostname !== "github.com" && hostname !== "gitlab.com";
}

function unsupported(message: string): Result<never> {
  return { ok: false, error: operationError("unsupported-source", message) };
}
