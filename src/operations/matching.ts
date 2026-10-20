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
