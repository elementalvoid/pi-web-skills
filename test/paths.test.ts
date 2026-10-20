import assert from "node:assert/strict";
import test from "node:test";
import { resolveSkillPaths } from "../src/operations/paths.ts";

test("without XDG_STATE_HOME the lock lives under the home .agents directory", () => {
  assert.deepEqual(resolveSkillPaths({ home: "/tmp/pi-web-skills-home" }), {
    managedDirectory: "/tmp/pi-web-skills-home/.agents/skills",
    lockfilePath: "/tmp/pi-web-skills-home/.agents/.skill-lock.json",
  });
});

test("with XDG_STATE_HOME the lock lives under the XDG state skills directory", () => {
  assert.deepEqual(
    resolveSkillPaths({
      home: "/tmp/pi-web-skills-home",
      xdgStateHome: "/tmp/pi-web-skills-state",
    }),
    {
      managedDirectory: "/tmp/pi-web-skills-home/.agents/skills",
      lockfilePath: "/tmp/pi-web-skills-state/skills/.skill-lock.json",
    },
  );
});
