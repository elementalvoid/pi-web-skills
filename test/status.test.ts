import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getStatus } from "../src/operations/status.ts";
import { resolveSkillPaths } from "../src/operations/paths.ts";

const signal = new AbortController().signal;

async function withTemporaryHome(
  run: (environment: { home: string; xdgStateHome: string }) => Promise<void>,
): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "pi-web-skills-home-"));
  const xdgStateHome = await mkdtemp(join(tmpdir(), "pi-web-skills-state-"));
  try {
    await run({ home, xdgStateHome });
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(xdgStateHome, { recursive: true, force: true });
  }
}

test("status reports both paths, their existence, and a readable lock", async () => {
  await withTemporaryHome(async (environment) => {
    const paths = resolveSkillPaths(environment);
    await mkdir(paths.managedDirectory, { recursive: true });
    await mkdir(join(environment.xdgStateHome, "skills"), { recursive: true });
    await writeFile(paths.lockfilePath, "{}\n");

    assert.deepEqual(await getStatus({ paths, signal }), {
      managedDirectory: paths.managedDirectory,
      lockfilePath: paths.lockfilePath,
      managedDirectoryExists: true,
      lockfileExists: true,
      lockReadable: true,
    });
  });
});

test("status reports missing locations without failing", async () => {
  await withTemporaryHome(async (environment) => {
    const paths = resolveSkillPaths(environment);

    assert.deepEqual(await getStatus({ paths, signal }), {
      managedDirectory: paths.managedDirectory,
      lockfilePath: paths.lockfilePath,
      managedDirectoryExists: false,
      lockfileExists: false,
      lockReadable: false,
    });
  });
});

test("status reports an unreadable lock without failing", async () => {
  await withTemporaryHome(async (environment) => {
    const paths = resolveSkillPaths(environment);
    await mkdir(paths.lockfilePath, { recursive: true });

    const status = await getStatus({ paths, signal });

    assert.equal(status.lockfileExists, true);
    assert.equal(status.lockReadable, false);
  });
});
