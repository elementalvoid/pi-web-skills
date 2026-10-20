import { dirname, join, relative, sep } from "node:path";
import type { RepoTree } from "../vendor/skills/blob.ts";
import { getSkillFolderHashFromTree } from "../vendor/skills/blob.ts";
import { discoverSkills } from "../vendor/skills/skills.ts";
import type { ParsedSource } from "../vendor/skills/types.ts";
import type { FetchLike } from "../upstream/github-tree.ts";
import { fetchGitHubTree } from "../upstream/github-tree.ts";
import type { ExecFile } from "../upstream/git.ts";
import { cloneSource, computeGitFolderHash } from "../upstream/git.ts";
import { installSkillDirectory } from "../upstream/install.ts";
import { removeTempDirectory } from "./containment.ts";
import type { OperationContext } from "./context.ts";
import type { OperationError, Result } from "./errors.ts";
import { operationError } from "./errors.ts";
import type { LockEntry, LockDocument } from "./lockfile.ts";
import { mutateLockfile, readLockfile } from "./lockfile.ts";
import { discoverSkillDirectories } from "./list.ts";
import { matchSkillName, resolveInstallTarget } from "./matching.ts";

/** The upstream skip reasons, in the order upstream checks them. */
const SKIP_REASONS = {
  local: "Local path",
  git: "Git URL",
  wellKnown: "Well-known skill",
  privateOrDeleted: "Private or deleted repo",
  noPath: "No skill path recorded",
  untracked: "No version tracking",
} as const;

export type UpdateSkip = { readonly name: string; readonly reason: string };
export type UpdateFailure = { readonly name: string; readonly message: string };

/** Frames the update session streams to its channel. */
export type UpdateFrame =
  | {
      readonly type: "progress";
      readonly name: string;
      readonly state: "checking" | "updating" | "unchanged" | "skipped" | "deleted" | "failed";
      readonly reason?: string;
    }
  | {
      readonly type: "done";
      readonly updated: readonly string[];
      readonly unchanged: readonly string[];
      readonly skipped: readonly UpdateSkip[];
      readonly deleted: readonly string[];
      readonly failed: readonly UpdateFailure[];
    }
  | { readonly type: "error"; readonly error: OperationError };

export type UpdateContext = OperationContext & {
  /** Omitted means every entry the lock records. */
  readonly names?: readonly string[] | undefined;
  readonly exec: ExecFile;
  readonly tempRoot: string;
  readonly fetch: FetchLike;
  readonly getToken: () => string | null;
  readonly now?: (() => Date) | undefined;
  /** Replaces the atomic lock mutation; a test uses it to fail the write after the swap. */
  readonly mutateLock?: typeof mutateLockfile | undefined;
};

export type UpdateSession = {
  readonly start: () => void;
  readonly settled: Promise<void>;
  readonly cancel: () => void;
  readonly dispose: () => Promise<void>;
};

type Summary = {
  readonly updated: string[];
  readonly unchanged: string[];
  readonly skipped: UpdateSkip[];
  readonly deleted: string[];
  readonly failed: UpdateFailure[];
};

type Checkable = { readonly name: string; readonly entry: LockEntry };

type Decision =
  | { readonly kind: "unchanged" }
  | { readonly kind: "deleted" }
  | { readonly kind: "changed"; readonly skillPath: string; readonly hash: string };

type CloneSkills = {
  readonly paths: ReadonlySet<string>;
  readonly byName: ReadonlyMap<string, readonly string[]>;
};

type CloneState = {
  directory: string | null;
  error: string | null;
  skills: CloneSkills | null;
};

type Clone = { readonly directory: string; readonly skills: CloneSkills };

/** The upstream checkable-entry rule, expressed as the reason an entry is skipped. */
export function getSkipReason(entry: LockEntry): string | null {
  if (entry.sourceType === "local") return SKIP_REASONS.local;
  if (entry.sourceType === "git") return SKIP_REASONS.git;
  if (entry.sourceType === "well-known") return SKIP_REASONS.wellKnown;
  if (!entry.skillFolderHash) return SKIP_REASONS.privateOrDeleted;
  if (!entry.skillPath) return SKIP_REASONS.noPath;
  if (entry.sourceType !== "github") return SKIP_REASONS.untracked;
  return null;
}

/**
 * Drives one update channel. Checking and replacing run on the session signal;
 * each skill is applied atomically, before the next one is read.
 */
export function createUpdateSession(
  context: UpdateContext,
  onFrame: (frame: UpdateFrame) => void,
): UpdateSession {
  const controller = new AbortController();
  const signal = controller.signal;
  let runPromise: Promise<void> | null = null;
  let settle: () => void = () => {};
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });

  const abort = () => controller.abort();
  context.signal.addEventListener("abort", abort, { once: true });
  if (context.signal.aborted) controller.abort();

  const emit = (frame: UpdateFrame): void => {
    try {
      onFrame(frame);
    } catch {
      controller.abort();
    }
  };

  async function run(): Promise<void> {
    const summary: Summary = { updated: [], unchanged: [], skipped: [], deleted: [], failed: [] };
    let terminal = false;
    try {
      const lock = await readLockfile(context.paths.lockfilePath);
      // Without a readable lock nothing can be classified, and a write would
      // drop unknown entries: refuse before touching any file.
      if (!lock.ok) {
        terminal = true;
        if (!signal.aborted) emit({ type: "error", error: lock.error });
        return;
      }
      await runUpdate(context, lock.value, signal, emit, summary);
    } catch (error) {
      terminal = true;
      if (!signal.aborted) {
        emit({ type: "error", error: operationError("update-failed", `Update failed: ${describe(error)}`) });
      }
    } finally {
      context.signal.removeEventListener("abort", abort);
      if (!terminal) emit({ type: "done", ...summary });
      settle();
    }
  }

  return {
    start() {
      if (runPromise !== null) return;
      runPromise = run();
    },
    settled,
    cancel() {
      controller.abort();
    },
    async dispose() {
      controller.abort();
      if (runPromise !== null) await runPromise.catch(() => {});
      else settle();
    },
  };
}

async function runUpdate(
  context: UpdateContext,
  lock: LockDocument,
  signal: AbortSignal,
  emit: (frame: UpdateFrame) => void,
  summary: Summary,
): Promise<void> {
  const lockKeys = Object.keys(lock.skills);
  const requested =
    context.names === undefined || context.names.length === 0 ? lockKeys : context.names;
  const seen = new Set<string>();
  const checkable: Checkable[] = [];
  for (const requestedName of requested) {
    const key = matchSkillName(requestedName, { lockKeys, folderNames: [] })?.lockKey ?? null;
    if (key === null) {
      fail(requestedName, `No managed skill named ${JSON.stringify(requestedName)} is recorded in the lockfile.`, signal, emit, summary);
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    const entry = lock.skills[key];
    if (entry === undefined) continue;
    const reason = getSkipReason(entry);
    if (reason !== null) {
      summary.skipped.push({ name: key, reason });
      emit({ type: "progress", name: key, state: "skipped", reason });
      continue;
    }
    checkable.push({ name: key, entry });
  }
  if (checkable.length === 0 || signal.aborted) return;

  const folderNames = (await discoverSkillDirectories(context.paths.managedDirectory)).map(
    (directory) => directory.folderName,
  );
  for (const group of groupBySource(checkable)) {
    // Cancel stops after the current skill; no new group starts.
    if (signal.aborted) return;
    await updateGroup(context, group, folderNames, signal, emit, summary);
  }
}

/** Group by source and ref: two skills pinned to different refs need different trees. */
function groupBySource(checkable: readonly Checkable[]): Checkable[][] {
  const groups = new Map<string, Checkable[]>();
  for (const item of checkable) {
    const key = `${item.entry.source}\n${item.entry.ref ?? ""}`;
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  return [...groups.values()];
}

async function updateGroup(
  context: UpdateContext,
  items: readonly Checkable[],
  folderNames: readonly string[],
  signal: AbortSignal,
  emit: (frame: UpdateFrame) => void,
  summary: Summary,
): Promise<void> {
  for (const item of items) emit({ type: "progress", name: item.name, state: "checking" });
  const first = items[0]!.entry;
  const cloneState: CloneState = { directory: null, error: null, skills: null };
  try {
    const tree = await readTree(context, first, signal);
    const treeComplete =
      tree !== null &&
      items.every(({ entry }) => getSkillFolderHashFromTree(tree, entry.skillPath ?? "") !== null);
    let clone: Clone | null = null;
    if (!treeComplete) {
      // The API is unavailable, or a locked path vanished: only the checkout
      // can tell a relocation from a deletion.
      const cloned = await ensureClone(context, first, cloneState, signal);
      if (!cloned.ok) {
        failGroup(items, cloned.error.message, signal, emit, summary);
        return;
      }
      clone = cloned.value;
    }

    for (const item of items) {
      if (signal.aborted) return;
      let decision: Decision;
      if (treeComplete) {
        decision = decideFromTree(tree, item);
      } else {
        const decided = await decideFromClone(context, item, clone!, signal);
        if (!decided.ok) {
          fail(item.name, decided.error.message, signal, emit, summary);
          continue;
        }
        decision = decided.value;
      }
      if (signal.aborted) return;
      if (decision.kind === "unchanged") {
        summary.unchanged.push(item.name);
        emit({ type: "progress", name: item.name, state: "unchanged" });
        continue;
      }
      if (decision.kind === "deleted") {
        // Reported, never removed: the install and its entry stay in place.
        summary.deleted.push(item.name);
        emit({ type: "progress", name: item.name, state: "deleted" });
        continue;
      }
      emit({ type: "progress", name: item.name, state: "updating" });
      if (signal.aborted) return;
      if (clone === null) {
        const cloned = await ensureClone(context, first, cloneState, signal);
        if (!cloned.ok) {
          fail(item.name, cloned.error.message, signal, emit, summary);
          continue;
        }
        clone = cloned.value;
      }
      const applied = await applyChanged(context, item, decision, clone.directory, folderNames, signal);
      if (!applied.ok) {
        fail(item.name, applied.error.message, signal, emit, summary);
        continue;
      }
      summary.updated.push(item.name);
    }
  } catch (error) {
    if (!signal.aborted) failGroup(items, describe(error), signal, emit, summary);
  } finally {
    const directory = cloneState.directory;
    cloneState.directory = null;
    cloneState.skills = null;
    if (directory !== null) await removeTempDirectory(context.tempRoot, directory);
  }
}

async function readTree(
  context: UpdateContext,
  entry: LockEntry,
  signal: AbortSignal,
): Promise<RepoTree | null> {
  const ownerRepo = githubOwnerRepo(entry.source);
  if (ownerRepo === null) return null;
  return fetchGitHubTree({
    ownerRepo,
    ref: entry.ref,
    fetch: context.fetch,
    exec: context.exec,
    getToken: context.getToken,
    signal,
  });
}

function decideFromTree(tree: RepoTree, item: Checkable): Decision {
  const skillPath = item.entry.skillPath!;
  const remoteHash = getSkillFolderHashFromTree(tree, skillPath);
  return remoteHash === item.entry.skillFolderHash
    ? { kind: "unchanged" }
    : { kind: "changed", skillPath, hash: remoteHash! };
}

async function decideFromClone(
  context: UpdateContext,
  item: Checkable,
  clone: Clone,
  signal: AbortSignal,
): Promise<Result<Decision>> {
  const lockedPath = item.entry.skillPath!;
  const candidates = clone.skills.byName.get(normalizeSkillName(item.name)) ?? [];
  const resolved = clone.skills.paths.has(lockedPath)
    ? lockedPath
    : candidates.length === 1
      ? candidates[0]!
      : null;
  if (resolved === null) {
    if (candidates.length > 1) {
      // Ambiguity fails closed: moving the wrong copy would overwrite the skill.
      return {
        ok: false,
        error: operationError(
          "update-failed",
          `The source has several skills named ${JSON.stringify(item.name)}; it is neither relocated nor deleted.`,
        ),
      };
    }
    return { ok: true, value: { kind: "deleted" } };
  }

  const folder = dirname(resolved);
  const hashed = await computeGitFolderHash(
    context.exec,
    clone.directory,
    folder === "." ? "" : folder,
    signal,
  );
  if (!hashed.ok) return hashed;
  const relocated = resolved !== lockedPath;
  if (!relocated && hashed.value === item.entry.skillFolderHash) {
    return { ok: true, value: { kind: "unchanged" } };
  }
  return { ok: true, value: { kind: "changed", skillPath: resolved, hash: hashed.value } };
}

/** Clone the group at its ref once, and discover every skill in the checkout once. */
async function ensureClone(
  context: UpdateContext,
  entry: LockEntry,
  state: CloneState,
  signal: AbortSignal,
): Promise<Result<Clone>> {
  if (state.directory !== null && state.skills !== null) {
    return { ok: true, value: { directory: state.directory, skills: state.skills } };
  }
  if (state.error !== null) {
    return { ok: false, error: operationError("clone-failed", state.error) };
  }
  const parsed: ParsedSource = {
    type: "github",
    url: entry.sourceUrl.trim() === "" ? entry.source : entry.sourceUrl,
    ...(entry.ref === undefined ? {} : { ref: entry.ref }),
  };
  const cloned = await cloneSource(context.exec, parsed, context.tempRoot, signal);
  if (!cloned.ok) {
    state.error = cloned.error.message;
    return cloned;
  }
  state.directory = cloned.value;
  try {
    state.skills = await discoverClone(cloned.value);
  } catch (error) {
    state.error = `Cannot read the clone: ${describe(error)}`;
    return { ok: false, error: operationError("discovery-failed", state.error) };
  }
  return { ok: true, value: { directory: cloned.value, skills: state.skills } };
}

async function discoverClone(directory: string): Promise<CloneSkills> {
  const skills = await discoverSkills(directory, undefined, {
    fullDepth: true,
    includeDuplicateNames: true,
  });
  const paths = new Set<string>();
  const byName = new Map<string, string[]>();
  for (const skill of skills) {
    const folder = relative(directory, skill.path).split(sep).join("/");
    const skillPath = folder === "" ? "SKILL.md" : `${folder}/SKILL.md`;
    paths.add(skillPath);
    const key = normalizeSkillName(skill.name);
    const list = byName.get(key) ?? [];
    if (!list.includes(skillPath)) list.push(skillPath);
    byName.set(key, list);
  }
  for (const list of byName.values()) list.sort();
  return { paths, byName };
}

/** Replace one skill through the safe copier and record it in the same swap. */
async function applyChanged(
  context: UpdateContext,
  item: Checkable,
  decision: { readonly skillPath: string; readonly hash: string },
  cloneDirectory: string,
  folderNames: readonly string[],
  signal: AbortSignal,
): Promise<Result<null>> {
  const target = resolveInstallTarget(item.name, { lockKeys: [], folderNames });
  const copied = await installSkillDirectory(
    context.paths.managedDirectory,
    target.folderName,
    join(cloneDirectory, dirname(decision.skillPath)),
    signal,
    () => writeUpdatedEntry(context, item.name, decision),
  );
  return copied.ok ? { ok: true, value: null } : copied;
}

/** Preserve `installedAt` and every unknown field; move `skillPath`; set `updatedAt` now. */
async function writeUpdatedEntry(
  context: UpdateContext,
  name: string,
  decision: { readonly skillPath: string; readonly hash: string },
): Promise<Result<null>> {
  const mutate = context.mutateLock ?? mutateLockfile;
  try {
    return await mutate(context.paths.lockfilePath, (lock) => {
      const previous = lock.skills[name];
      if (previous === undefined) {
        return {
          ok: false,
          error: operationError(
            "update-failed",
            `The lock entry ${JSON.stringify(name)} disappeared during the update.`,
          ),
        };
      }
      const now = (context.now?.() ?? new Date()).toISOString();
      lock.skills[name] = {
        ...previous,
        skillPath: decision.skillPath,
        skillFolderHash: decision.hash,
        updatedAt: now,
      };
      return { ok: true, value: null };
    });
  } catch (error) {
    return {
      ok: false,
      error: operationError("update-failed", `Cannot write the lock entry: ${describe(error)}`),
    };
  }
}

function fail(
  name: string,
  message: string,
  signal: AbortSignal,
  emit: (frame: UpdateFrame) => void,
  summary: Summary,
): void {
  if (signal.aborted) return;
  summary.failed.push({ name, message });
  emit({ type: "progress", name, state: "failed", reason: message });
}

function failGroup(
  items: readonly Checkable[],
  message: string,
  signal: AbortSignal,
  emit: (frame: UpdateFrame) => void,
  summary: Summary,
): void {
  for (const item of items) fail(item.name, message, signal, emit, summary);
}

/** `owner/repo` for a GitHub lock entry, or null when the source is not that shape. */
function githubOwnerRepo(source: string): string | null {
  const segments = source.split("/");
  if (segments.length !== 2) return null;
  return segments.every((segment) => /^[A-Za-z0-9._-]+$/.test(segment) && segment !== ".")
    ? source
    : null;
}

/** Upstream name normalisation, so a renamed folder still matches its locked skill. */
function normalizeSkillName(name: string): string {
  return name.toLowerCase().replace(/[\s_]+/g, "-");
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
