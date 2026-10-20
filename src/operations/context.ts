import type { SkillPaths } from "./paths.ts";

/** Everything one operation may touch; the seam tests drive directly. */
export type OperationContext = {
  readonly paths: SkillPaths;
  readonly signal: AbortSignal;
};
