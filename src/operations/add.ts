import { readdir } from "node:fs/promises";
import { basename, relative, sep } from "node:path";
import { parseSource } from "../vendor/skills/source-parser.ts";
import { computeSkillFolderHash } from "../vendor/skills/local-lock.ts";
import { sanitizeMetadata } from "../vendor/skills/sanitize.ts";
import { discoverSkills } from "../vendor/skills/skills.ts";
import type { ParsedSource } from "../vendor/skills/types.ts";
import { cloneSource, computeGitFolderHash } from "../upstream/git.ts";
import type { ExecFile } from "../upstream/git.ts";
import { removeTempDirectory } from "./containment.ts";
import type { OperationContext } from "./context.ts";
import type { OperationError, Result } from "./errors.ts";
import { operationError } from "./errors.ts";
import { matchSkillName, sanitizeName } from "./matching.ts";
import { readLockfile } from "./lockfile.ts";

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

/** Frames the add session streams to its channel. */
export type AddFrame =
  | {
      readonly type: "candidates";
      readonly candidates: readonly AddCandidate[];
      readonly index: number;
      readonly total: number;
    }
  | { readonly type: "candidates-end"; readonly total: number }
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
      emit({
        type: "error",
        error: operationError("not-implemented", "Installing skills is not implemented yet."),
      });
    },
    cancel() {
      controller.abort();
    },
    async dispose() {
      controller.abort();
      if (runPromise !== null) await runPromise.catch(() => {});
      else settle();
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
): Promise<Result<{ readonly candidates: readonly AddCandidate[] }>> {
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
  for (const skill of selected) {
    if (signal.aborted) return discoveryFailure("The add operation was cancelled.");
    const relativeFolder = relative(cloneDirectory, skill.path).split(sep).join("/");
    const hashed =
      parsed.type === "github" || parsed.type === "gitlab"
        ? await computeGitFolderHash(context.exec, cloneDirectory, relativeFolder, signal)
        : await contentFolderHash(skill.path);
    if (!hashed.ok) return hashed;

    const folderName = sanitizeName(skill.name);
    // The same three rungs List uses: exact lock key, sanitised key, sanitised
    // folder name. A lock key without a present folder is a broken entry, not
    // a target this candidate would replace.
    const match = matchSkillName(skill.name, { lockKeys, folderNames });
    let existing: AddCandidate["existing"] = "none";
    if (match?.lockKey != null && match.folderName != null) existing = "managed";
    else if (match?.folderName != null) existing = "unmanaged";
    const sourcePath = candidateText(
      relativeFolder === "" ? "SKILL.md" : `${relativeFolder}/SKILL.md`,
      SOURCE_PATH_LIMIT,
    );
    candidates.push({
      name: candidateText(skill.name, NAME_LIMIT),
      description: candidateText(skill.description, DESCRIPTION_LIMIT),
      sourcePath,
      folderName,
      folderHash: hashed.value,
      existing,
    });
  }
  return { ok: true, value: { candidates } };
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
