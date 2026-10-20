import { join } from "node:path";

export type Environment = {
  readonly home: string;
  readonly xdgStateHome?: string | undefined;
};

export type SkillPaths = {
  readonly managedDirectory: string;
  readonly lockfilePath: string;
};

/** Resolve the two machine-wide locations from the daemon environment. */
export function resolveSkillPaths(environment: Environment): SkillPaths {
  const { home, xdgStateHome } = environment;
  return {
    managedDirectory: join(home, ".agents", "skills"),
    lockfilePath: xdgStateHome
      ? join(xdgStateHome, "skills", ".skill-lock.json")
      : join(home, ".agents", ".skill-lock.json"),
  };
}
