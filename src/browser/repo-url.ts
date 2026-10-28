/** One row's provider location; a list row satisfies this shape. */
export type SkillLocation = {
  readonly sourceType: string | null;
  readonly source: string | null;
  readonly ref: string | null;
  readonly skillPath: string | null;
};

/** File-view roots, including the separators each provider needs before `blob`. */
const PROVIDER_VIEWS = new Map<string, (source: string) => string>([
  ["github", (source) => `https://github.com/${encodePath(source)}`],
  ["gitlab", (source) => `https://gitlab.com/${encodePath(source)}/-`],
]);

/** `owner/repo`, and nested GitLab groups such as `group/sub/repo`. */
const OWNER_REPO = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/;

/**
 * The provider page for a skill's SKILL.md, or null when the source type has no
 * known file view. Both providers resolve `HEAD` to the default branch.
 */
export function skillFileUrl(location: SkillLocation): string | null {
  const { ref, skillPath, source, sourceType } = location;
  const view = sourceType === null ? undefined : PROVIDER_VIEWS.get(sourceType);
  if (view === undefined || source === null || skillPath === null) return null;
  if (!OWNER_REPO.test(source)) return null;
  const revision = ref === null || ref === "" ? "HEAD" : ref;
  return `${view(source)}/blob/${encodePath(revision)}/${encodePath(skillPath)}`;
}

/** Encode every path segment, keeping the separators a provider URL needs. */
function encodePath(value: string): string {
  return value.split("/").map(encodeURIComponent).join("/");
}
