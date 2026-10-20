/**
 * The folder name an install uses. Mirrors upstream `installer.ts:sanitizeName`
 * so a lock key and its install folder agree after sanitising.
 */
export function sanitizeName(name: string): string {
  const sanitized = name
    .toLowerCase()
    .replace(/[^a-z0-9._]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "");
  return sanitized.substring(0, 255) || "unnamed-skill";
}

export type MatchInput = {
  readonly lockKeys: readonly string[];
  readonly folderNames: readonly string[];
};

export type SkillMatch = {
  readonly lockKey: string | null;
  readonly folderName: string | null;
};

/** Where an install of this name would land, and what is already there. */
export type InstallTarget = {
  readonly key: string;
  readonly folderName: string;
  readonly existing: "none" | "managed" | "unmanaged";
};

/**
 * The one destination rule for the existing-target badge and the installer, so
 * the badge never promises a different folder than the install writes.
 */
export function resolveInstallTarget(name: string, input: MatchInput): InstallTarget {
  const match = matchSkillName(name, input);
  const existing =
    match?.lockKey != null && match.folderName != null
      ? "managed"
      : match?.folderName != null
        ? "unmanaged"
        : "none";
  return {
    key: match?.lockKey ?? name,
    folderName: match?.folderName ?? sanitizeName(name),
    existing,
  };
}

/**
 * Resolve a name the way the panel does: exact lock key, sanitised lock key, then
 * sanitised folder name. Lock keys win, so a managed key is never reported as an
 * unmanaged folder.
 */
export function matchSkillName(requested: string, input: MatchInput): SkillMatch | null {
  const wanted = sanitizeName(requested);
  const lockKey = findName(requested, input.lockKeys, wanted);
  const folderName = findName(requested, input.folderNames, wanted);
  if (lockKey === null && folderName === null) return null;
  return { lockKey, folderName };
}

function findName(requested: string, names: readonly string[], sanitized: string): string | null {
  if (names.includes(requested)) return requested;
  return names.find((name) => sanitizeName(name) === sanitized) ?? null;
}
