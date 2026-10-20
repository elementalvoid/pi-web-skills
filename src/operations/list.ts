import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseFrontmatter } from "../vendor/skills/frontmatter.ts";
import { sanitizeMetadata } from "../vendor/skills/sanitize.ts";
import type { OperationContext } from "./context.ts";
import type { LockEntry } from "./lockfile.ts";
import { readLockfile } from "./lockfile.ts";
import { sanitizeName } from "./matching.ts";

/** How a row relates to the lockfile: present with an entry, present without one, or an entry alone. */
export type SkillState = "managed" | "unmanaged" | "broken";

/** One displayed skill; broken rows have no folder and no frontmatter. */
export type ListRow = {
  readonly name: string;
  readonly folderName: string | null;
  readonly description: string;
  readonly state: SkillState;
  readonly invalidReason: string | null;
  readonly source: string | null;
  readonly sourceType: string | null;
  readonly ref: string | null;
  readonly skillPath: string | null;
  readonly installedAt: string | null;
  readonly updatedAt: string | null;
  readonly pluginName: string | null;
};

export type ListPayload = {
  readonly rows: readonly ListRow[];
  readonly counts: {
    readonly managed: number;
    readonly unmanaged: number;
    readonly broken: number;
  };
  readonly lockWarning: string | null;
};

// Kept local instead of reusing the vendored SKIP_DIRS/findSkillDirs because the
// vendored parser drops skills with invalid frontmatter, and list must show them.
const MAX_DEPTH = 5;
const SKIPPED_DIRECTORIES = new Set(["node_modules", ".git", "dist", "build", "__pycache__"]);
/** Longest description a row carries; matches the add candidate cap. */
const DESCRIPTION_LIMIT = 500;
const STATE_ORDER: Readonly<Record<SkillState, number>> = {
  managed: 0,
  unmanaged: 1,
  broken: 2,
};

type PresentSkill = {
  readonly folderName: string;
  readonly name: string | null;
  readonly description: string | null;
  readonly invalidReason: string | null;
};

type Frontmatter = {
  readonly name: string | null;
  readonly description: string | null;
  readonly invalidReason: string | null;
};

/**
 * Read present skills and lock entries into rows. Strictly read-only: it never
 * creates the managed directory or the lockfile, and a malformed lock degrades
 * to a warning so present skills still render.
 */
export async function listSkills(context: OperationContext): Promise<ListPayload> {
  const { managedDirectory, lockfilePath } = context.paths;
  const lock = await readLockfile(lockfilePath);
  context.signal.throwIfAborted();
  const present = await discoverPresentSkills(managedDirectory);
  context.signal.throwIfAborted();

  const lockKeys = lock.ok ? Object.keys(lock.value.skills) : [];
  const availableKeys = [...lockKeys];
  const presentRows = present.map((skill): ListRow => {
    if (!lock.ok) return presentRow(skill, "unmanaged", null);
    const lockKey = findLockKey(skill, availableKeys);
    if (lockKey === null) return presentRow(skill, "unmanaged", null);
    availableKeys.splice(availableKeys.indexOf(lockKey), 1);
    return presentRow(skill, "managed", lock.value.skills[lockKey] ?? null);
  });
  const brokenRows: ListRow[] = [];
  if (lock.ok) {
    for (const key of availableKeys) {
      brokenRows.push(brokenRow(key, lock.value.skills[key]));
    }
  }

  const rows = [...presentRows, ...brokenRows].sort(compareRows);
  return {
    rows,
    counts: {
      managed: rows.filter((row) => row.state === "managed").length,
      unmanaged: rows.filter((row) => row.state === "unmanaged").length,
      broken: rows.filter((row) => row.state === "broken").length,
    },
    lockWarning: lock.ok ? null : lock.error.message,
  };
}

/**
 * Resolve which available lock key owns a present skill: the exact displayed
 * name, then a key that sanitises to that name, then one that sanitises to the
 * folder name. The caller removes the result so an entry marks only one row.
 */
function findLockKey(skill: PresentSkill, lockKeys: readonly string[]): string | null {
  const name = skill.name ?? skill.folderName;
  const exact = lockKeys.find((key) => key === name);
  if (exact !== undefined) return exact;
  const sanitisedName = sanitizeName(name);
  const sanitisedKey = lockKeys.find((key) => sanitizeName(key) === sanitisedName);
  if (sanitisedKey !== undefined) return sanitisedKey;
  const sanitisedFolder = sanitizeName(skill.folderName);
  return lockKeys.find((key) => sanitizeName(key) === sanitisedFolder) ?? null;
}

function presentRow(skill: PresentSkill, state: SkillState, entry: LockEntry | null): ListRow {
  return {
    name: skill.name ?? skill.folderName,
    folderName: skill.folderName,
    description: rowDescription(skill.description),
    state,
    invalidReason: skill.invalidReason,
    source: text(entry?.["source"]),
    sourceType: text(entry?.["sourceType"]),
    ref: text(entry?.["ref"]),
    skillPath: text(entry?.["skillPath"]),
    installedAt: text(entry?.["installedAt"]),
    updatedAt: text(entry?.["updatedAt"]),
    pluginName: text(entry?.["pluginName"]),
  };
}

function brokenRow(lockKey: string, entry: LockEntry | undefined): ListRow {
  return {
    name: lockKey,
    folderName: null,
    description: "",
    state: "broken",
    invalidReason: null,
    source: text(entry?.["source"]),
    sourceType: text(entry?.["sourceType"]),
    ref: text(entry?.["ref"]),
    skillPath: text(entry?.["skillPath"]),
    installedAt: text(entry?.["installedAt"]),
    updatedAt: text(entry?.["updatedAt"]),
    pluginName: text(entry?.["pluginName"]),
  };
}

function compareRows(left: ListRow, right: ListRow): number {
  const byState = STATE_ORDER[left.state] - STATE_ORDER[right.state];
  return byState !== 0 ? byState : left.name.localeCompare(right.name);
}

async function discoverPresentSkills(managedDirectory: string): Promise<PresentSkill[]> {
  const found: PresentSkill[] = [];
  await walk(managedDirectory, 0);
  return found;

  async function walk(directory: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH) return;
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    if (depth > 0 && entries.some((entry) => entry.name === "SKILL.md" && entry.isFile())) {
      const frontmatter = await readFrontmatter(join(directory, "SKILL.md"));
      found.push({ folderName: basename(directory), ...frontmatter });
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIPPED_DIRECTORIES.has(entry.name)) continue;
      await walk(join(directory, entry.name), depth + 1);
    }
  }
}

/** Parse frontmatter; a YAML failure or a bad field is a reason on the row, never a failure. */
async function readFrontmatter(skillMdPath: string): Promise<Frontmatter> {
  let raw: string;
  try {
    raw = await readFile(skillMdPath, "utf8");
  } catch {
    return { name: null, description: null, invalidReason: "SKILL.md is unreadable" };
  }

  let data: unknown;
  try {
    data = parseFrontmatter(raw).data;
  } catch {
    return { name: null, description: null, invalidReason: "frontmatter is not valid YAML" };
  }
  if (!isPlainObject(data)) {
    return { name: null, description: null, invalidReason: "frontmatter is not an object" };
  }

  const name = typeof data["name"] === "string" ? data["name"] : null;
  const description = typeof data["description"] === "string" ? data["description"] : null;
  const reasons: string[] = [];
  if (!("name" in data)) reasons.push("name is missing");
  else if (name === null) reasons.push("name is not a string");
  if (!("description" in data)) reasons.push("description is missing");
  else if (description === null) reasons.push("description is not a string");
  return {
    name,
    description,
    invalidReason: reasons.length === 0 ? null : reasons.join("; "),
  };
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function rowDescription(value: string | null): string {
  return value === null ? "" : sanitizeMetadata(value).slice(0, DESCRIPTION_LIMIT);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
