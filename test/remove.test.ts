import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { removeSkills } from "../src/operations/remove.ts";
import type { SkillPaths } from "../src/operations/paths.ts";
import { resolveSkillPaths } from "../src/operations/paths.ts";

const signal = new AbortController().signal;

async function withTemporaryHome(
  run: (environment: { home: string; paths: SkillPaths }) => Promise<void>,
): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "pi-web-skills-remove-"));
  try {
    await run({ home, paths: resolveSkillPaths({ home }) });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

/** One lock entry in the standard upstream shape. */
function entry(name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: "owner/repo",
    sourceType: "github",
    sourceUrl: "https://github.com/owner/repo.git",
    ref: "main",
    skillPath: `skills/${name}/SKILL.md`,
    skillFolderHash: "0123456789abcdef0123456789abcdef01234567",
    installedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    ...extra,
  };
}

async function writeSkill(managedDirectory: string, folder: string): Promise<void> {
  await mkdir(join(managedDirectory, folder), { recursive: true });
  await writeFile(join(managedDirectory, folder, "SKILL.md"), `---\nname: ${folder}\n---\n`);
}

async function writeLockFile(paths: SkillPaths, lock: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(paths.lockfilePath), { recursive: true });
  await writeFile(paths.lockfilePath, JSON.stringify(lock, null, 2));
}

async function readLockFile(paths: SkillPaths): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(paths.lockfilePath, "utf8")) as Record<string, unknown>;
}

function lockKeys(lock: Record<string, unknown>): string[] {
  return Object.keys(lock["skills"] as Record<string, unknown>);
}

/** Every path and file body under a root, so a refusal can prove it wrote nothing. */
async function snapshotTree(root: string): Promise<string[]> {
  const lines: string[] = [];
  async function visit(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      lines.push(`missing ${relative(root, directory) || "."}`);
      return;
    }
    for (const item of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, item.name);
      if (item.isDirectory()) {
        lines.push(`dir ${relative(root, path)}`);
        await visit(path);
      } else if (item.isSymbolicLink()) {
        lines.push(`link ${relative(root, path)}`);
      } else {
        lines.push(`file ${relative(root, path)} ${await readFile(path, "utf8")}`);
      }
    }
  }
  await visit(root);
  return lines;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

test("removing a managed skill deletes its directory and only its lock entry", async () => {
  await withTemporaryHome(async ({ paths }) => {
    await writeSkill(paths.managedDirectory, "demo");
    await writeSkill(paths.managedDirectory, "notes");
    await writeLockFile(paths, {
      version: 3,
      skills: { demo: entry("demo"), notes: entry("notes") },
    });

    const result = await removeSkills({ paths, signal }, ["demo"]);

    assert.deepEqual(result, {
      ok: true,
      value: {
        results: [{ name: "demo", ok: true, state: "managed", directory: "removed" }],
      },
    });
    assert.equal(await exists(join(paths.managedDirectory, "demo")), false);
    assert.equal(await exists(join(paths.managedDirectory, "notes")), true);
    const lock = await readLockFile(paths);
    assert.deepEqual(lockKeys(lock), ["notes"]);
    assert.equal(lock["version"], 3);
  });
});

test("removing a broken entry deletes only the entry and reports the missing directory", async () => {
  await withTemporaryHome(async ({ paths }) => {
    await writeSkill(paths.managedDirectory, "notes");
    await writeLockFile(paths, {
      version: 3,
      skills: { gone: entry("gone"), notes: entry("notes") },
    });

    const result = await removeSkills({ paths, signal }, ["gone"]);

    assert.deepEqual(result, {
      ok: true,
      value: {
        results: [{ name: "gone", ok: true, state: "broken", directory: "absent" }],
      },
    });
    assert.equal(await exists(join(paths.managedDirectory, "notes")), true);
    assert.deepEqual(lockKeys(await readLockFile(paths)), ["notes"]);
  });
});

test("an unmanaged directory is refused as not-managed and left untouched", async () => {
  await withTemporaryHome(async ({ home, paths }) => {
    await writeSkill(paths.managedDirectory, "notes");
    await writeLockFile(paths, { version: 3, skills: {} });
    const before = await snapshotTree(home);

    const result = await removeSkills({ paths, signal }, ["notes"]);

    assert.equal(result.ok, true);
    assert.deepEqual(result.ok && result.value.results, [
      {
        name: "notes",
        ok: false,
        error: {
          code: "not-managed",
          message: '"notes" is not tracked by the lockfile; unmanaged skills are never removed.',
        },
      },
    ]);
    assert.deepEqual(await snapshotTree(home), before);
  });
});

test("an unknown name is not-found and changes nothing", async () => {
  await withTemporaryHome(async ({ home, paths }) => {
    await writeSkill(paths.managedDirectory, "demo");
    await writeLockFile(paths, { version: 3, skills: { demo: entry("demo") } });
    const before = await snapshotTree(home);

    const result = await removeSkills({ paths, signal }, ["hidden"]);

    assert.equal(result.ok, true);
    assert.deepEqual(result.ok && result.value.results, [
      {
        name: "hidden",
        ok: false,
        error: {
          code: "not-found",
          message: 'No skill named "hidden" is present or recorded in the lockfile.',
        },
      },
    ]);
    assert.deepEqual(await snapshotTree(home), before);
  });
});

test("a missing managed directory still removes the entry and reports it was absent", async () => {
  await withTemporaryHome(async ({ paths }) => {
    await writeLockFile(paths, { version: 3, skills: { gone: entry("gone") } });

    const result = await removeSkills({ paths, signal }, ["gone"]);

    assert.deepEqual(result, {
      ok: true,
      value: {
        results: [{ name: "gone", ok: true, state: "broken", directory: "absent" }],
      },
    });
    assert.deepEqual(lockKeys(await readLockFile(paths)), []);
  });
});

test("a symlinked skill directory is refused as unsafe-path and its target survives", async () => {
  await withTemporaryHome(async ({ home, paths }) => {
    const outside = join(home, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "precious.txt"), "keep me");
    await mkdir(paths.managedDirectory, { recursive: true });
    await symlink(outside, join(paths.managedDirectory, "linked"));
    await writeLockFile(paths, { version: 3, skills: { linked: entry("linked") } });

    const result = await removeSkills({ paths, signal }, ["linked"]);

    assert.equal(result.ok, true);
    const outcome = result.ok ? result.value.results[0] : null;
    assert.equal(outcome?.ok, false);
    assert.equal(outcome?.ok === false && outcome.error.code, "unsafe-path");
    assert.equal(await readFile(join(outside, "precious.txt"), "utf8"), "keep me");
    assert.deepEqual(lockKeys(await readLockFile(paths)), ["linked"]);
  });
});

test("a lock key shaped like traversal never touches a directory outside the managed root", async () => {
  await withTemporaryHome(async ({ home, paths }) => {
    const outside = join(home, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "precious.txt"), "keep me");
    await writeLockFile(paths, { version: 3, skills: { "../../outside": entry("outside") } });

    const result = await removeSkills({ paths, signal }, ["../../outside"]);

    assert.equal(result.ok, true);
    assert.equal(await readFile(join(outside, "precious.txt"), "utf8"), "keep me");
    assert.deepEqual(lockKeys(await readLockFile(paths)), []);
  });
});

test("an unreadable lockfile blocks every removal before any file is deleted", async () => {
  await withTemporaryHome(async ({ home, paths }) => {
    await writeSkill(paths.managedDirectory, "demo");
    await mkdir(dirname(paths.lockfilePath), { recursive: true });
    await writeFile(paths.lockfilePath, "{ not json");
    const before = await snapshotTree(home);

    const result = await removeSkills({ paths, signal }, ["demo"]);

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, "lock-unreadable");
    assert.deepEqual(await snapshotTree(home), before);
  });
});

test("several names report one outcome each in request order", async () => {
  await withTemporaryHome(async ({ paths }) => {
    await writeSkill(paths.managedDirectory, "demo");
    await writeLockFile(paths, { version: 3, skills: { demo: entry("demo") } });

    const result = await removeSkills({ paths, signal }, ["hidden", "demo"]);

    assert.equal(result.ok, true);
    assert.deepEqual(
      result.ok && result.value.results.map((outcome) => [outcome.name, outcome.ok]),
      [
        ["hidden", false],
        ["demo", true],
      ],
    );
  });
});

test("the lock write preserves unknown fields, other entries, and the schema version", async () => {
  await withTemporaryHome(async ({ paths }) => {
    await writeSkill(paths.managedDirectory, "demo");
    await writeSkill(paths.managedDirectory, "notes");
    await writeLockFile(paths, {
      version: 3,
      skills: {
        demo: entry("demo", { pluginName: "group", futureField: { keep: true } }),
        notes: entry("notes", { extraPerEntry: "kept" }),
      },
      dismissed: { "owner/repo": ["demo"] },
      lastSelectedAgents: ["claude", "codex"],
      futureTopLevel: { nested: 1 },
    });

    await removeSkills({ paths, signal }, ["demo"]);

    const lock = await readLockFile(paths);
    assert.deepEqual(lock, {
      version: 3,
      skills: { notes: entry("notes", { extraPerEntry: "kept" }) },
      dismissed: { "owner/repo": ["demo"] },
      lastSelectedAgents: ["claude", "codex"],
      futureTopLevel: { nested: 1 },
    });
  });
});

test("a symlinked managed directory removes the real install and keeps the link", async () => {
  await withTemporaryHome(async ({ home, paths }) => {
    const realManaged = join(home, "real-managed");
    await writeSkill(realManaged, "demo");
    await mkdir(join(home, ".agents"), { recursive: true });
    await symlink(realManaged, paths.managedDirectory);
    await writeLockFile(paths, { version: 3, skills: { demo: entry("demo") } });

    const result = await removeSkills({ paths, signal }, ["demo"]);

    assert.deepEqual(result, {
      ok: true,
      value: {
        results: [{ name: "demo", ok: true, state: "managed", directory: "removed" }],
      },
    });
    assert.equal(await exists(join(realManaged, "demo")), false);
    assert.equal((await lstat(paths.managedDirectory)).isSymbolicLink(), true);
    assert.deepEqual(lockKeys(await readLockFile(paths)), []);
  });
});
