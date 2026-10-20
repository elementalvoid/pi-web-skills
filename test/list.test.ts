import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { listSkills } from "../src/operations/list.ts";
import type { SkillPaths } from "../src/operations/paths.ts";
import { resolveSkillPaths } from "../src/operations/paths.ts";

const signal = new AbortController().signal;

async function withTemporaryHome(
  run: (environment: { home: string; paths: SkillPaths }) => Promise<void>,
): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "pi-web-skills-list-"));
  try {
    await run({ home, paths: resolveSkillPaths({ home }) });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function writeSkill(
  managedDirectory: string,
  folder: string,
  frontmatter = "---\nname: demo\ndescription: A demo skill\n---\n# demo\n",
): Promise<void> {
  await mkdir(join(managedDirectory, folder), { recursive: true });
  await writeFile(join(managedDirectory, folder, "SKILL.md"), frontmatter);
}

async function writeLock(paths: SkillPaths, skills: Record<string, unknown>): Promise<void> {
  await mkdir(join(paths.lockfilePath, ".."), { recursive: true });
  await writeFile(paths.lockfilePath, JSON.stringify({ version: 3, skills, dismissed: {} }));
}

/** Every path and file body under a root, so a read can prove it wrote nothing. */
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
    for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        lines.push(`dir ${relative(root, path)}`);
        await visit(path);
      } else {
        lines.push(`file ${relative(root, path)} ${await readFile(path, "utf8")}`);
      }
    }
  }
  await visit(root);
  return lines;
}

const demoEntry = {
  source: "owner/repo",
  sourceType: "github",
  sourceUrl: "https://github.com/owner/repo.git",
  ref: "main",
  skillPath: "skills/demo/SKILL.md",
  skillFolderHash: "abc123",
  installedAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
  pluginName: "group",
};

test("listing an empty machine returns no rows and leaves the filesystem untouched", async () => {
  await withTemporaryHome(async ({ home, paths }) => {
    const before = await snapshotTree(home);

    const result = await listSkills({ paths, signal });

    assert.deepEqual(result, {
      rows: [],
      counts: { managed: 0, unmanaged: 0, broken: 0 },
      lockWarning: null,
    });
    assert.deepEqual(await snapshotTree(home), before);
  });
});

test("a present skill with an entry is managed, one without is unmanaged, and a missing install is broken", async () => {
  await withTemporaryHome(async ({ paths }) => {
    await writeSkill(paths.managedDirectory, "demo");
    await writeSkill(
      paths.managedDirectory,
      "notes",
      "---\nname: Notes\ndescription: Hand-written\n---\n",
    );
    await writeLock(paths, { demo: demoEntry, gone: { ...demoEntry, source: "owner/old" } });

    const result = await listSkills({ paths, signal });

    assert.deepEqual(result, {
      rows: [
        {
          name: "demo",
          folderName: "demo",
          description: "A demo skill",
          state: "managed",
          invalidReason: null,
          source: "owner/repo",
          sourceType: "github",
          ref: "main",
          skillPath: "skills/demo/SKILL.md",
          installedAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-02T00:00:00.000Z",
          pluginName: "group",
        },
        {
          name: "Notes",
          folderName: "notes",
          description: "Hand-written",
          state: "unmanaged",
          invalidReason: null,
          source: null,
          sourceType: null,
          ref: null,
          skillPath: null,
          installedAt: null,
          updatedAt: null,
          pluginName: null,
        },
        {
          name: "gone",
          folderName: null,
          description: "",
          state: "broken",
          invalidReason: null,
          source: "owner/old",
          sourceType: "github",
          ref: "main",
          skillPath: "skills/demo/SKILL.md",
          installedAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-02T00:00:00.000Z",
          pluginName: "group",
        },
      ],
      counts: { managed: 1, unmanaged: 1, broken: 1 },
      lockWarning: null,
    });
  });
});

test("invalid frontmatter marks a row without hiding it", async () => {
  await withTemporaryHome(async ({ paths }) => {
    await writeSkill(
      paths.managedDirectory,
      "no-description",
      "---\nname: no-description\n---\n",
    );
    await writeSkill(
      paths.managedDirectory,
      "numeric-name",
      "---\nname: 42\ndescription: Has a number name\n---\n",
    );
    await writeSkill(paths.managedDirectory, "bad-yaml", "---\nname: [unclosed\n---\n");

    const result = await listSkills({ paths, signal });

    assert.deepEqual(
      result.rows.map((row) => ({
        name: row.name,
        folderName: row.folderName,
        description: row.description,
        state: row.state,
        invalidReason: row.invalidReason,
      })),
      [
        {
          name: "bad-yaml",
          folderName: "bad-yaml",
          description: "",
          state: "unmanaged",
          invalidReason: "frontmatter is not valid YAML",
        },
        {
          name: "no-description",
          folderName: "no-description",
          description: "",
          state: "unmanaged",
          invalidReason: "description is missing",
        },
        {
          name: "numeric-name",
          folderName: "numeric-name",
          description: "Has a number name",
          state: "unmanaged",
          invalidReason: "name is not a string",
        },
      ],
    );
    assert.deepEqual(result.counts, { managed: 0, unmanaged: 3, broken: 0 });
  });
});

test("discovery finds nested skills to five levels and skips noise directories", async () => {
  await withTemporaryHome(async ({ paths }) => {
    const skill = (name: string) => `---\nname: ${name}\ndescription: Nested\n---\n`;
    await writeSkill(paths.managedDirectory, join("nested", "deep"), skill("nested-skill"));
    for (const skipped of ["node_modules", ".git", "dist", "build", "__pycache__"]) {
      await writeSkill(paths.managedDirectory, join(skipped, "ignored"), skill("ignored"));
    }
    await writeSkill(
      paths.managedDirectory,
      join("a", "b", "c", "d", "e"),
      skill("depth-five"),
    );
    await writeSkill(
      paths.managedDirectory,
      join("a", "b", "c", "d", "e", "f"),
      skill("too-deep"),
    );

    const result = await listSkills({ paths, signal });

    assert.deepEqual(
      result.rows.map((row) => row.name),
      ["depth-five", "nested-skill"],
    );
  });
});

test("a lock key that sanitises to the folder name matches the present skill", async () => {
  await withTemporaryHome(async ({ paths }) => {
    await writeSkill(
      paths.managedDirectory,
      "ce-review",
      "---\nname: review\ndescription: Code review\n---\n",
    );
    await writeLock(paths, { "ce:review": { ...demoEntry, source: "owner/review" } });

    const result = await listSkills({ paths, signal });

    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0]?.name, "review");
    assert.equal(result.rows[0]?.folderName, "ce-review");
    assert.equal(result.rows[0]?.state, "managed");
    assert.equal(result.rows[0]?.source, "owner/review");
    assert.equal(result.rows[0]?.pluginName, "group");
    assert.deepEqual(result.counts, { managed: 1, unmanaged: 0, broken: 0 });
  });
});

test("an exact lock key matches the displayed name even when the folder differs", async () => {
  await withTemporaryHome(async ({ paths }) => {
    await writeSkill(
      paths.managedDirectory,
      "installed-folder",
      "---\nname: demo\ndescription: A demo skill\n---\n",
    );
    await writeLock(paths, { demo: { ...demoEntry, source: "owner/exact" } });

    const result = await listSkills({ paths, signal });

    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0]?.name, "demo");
    assert.equal(result.rows[0]?.folderName, "installed-folder");
    assert.equal(result.rows[0]?.state, "managed");
    assert.equal(result.rows[0]?.source, "owner/exact");
    assert.deepEqual(result.counts, { managed: 1, unmanaged: 0, broken: 0 });
  });
});

test("a missing lockfile makes present skills unmanaged without creating the lock", async () => {
  await withTemporaryHome(async ({ home, paths }) => {
    await writeSkill(paths.managedDirectory, "demo");
    const before = await snapshotTree(home);

    const result = await listSkills({ paths, signal });

    assert.equal(result.lockWarning, null);
    assert.deepEqual(
      result.rows.map((row) => [row.name, row.state]),
      [["demo", "unmanaged"]],
    );
    assert.deepEqual(await snapshotTree(home), before);
  });
});

test("a malformed lock warns but still renders present skills and writes nothing", async () => {
  await withTemporaryHome(async ({ home, paths }) => {
    await writeSkill(paths.managedDirectory, "demo");
    await mkdir(join(home, ".agents"), { recursive: true });
    await writeFile(paths.lockfilePath, "{ not json");
    const before = await snapshotTree(home);

    const result = await listSkills({ paths, signal });

    assert.match(result.lockWarning ?? "", /not valid JSON/);
    assert.deepEqual(
      result.rows.map((row) => [row.name, row.state]),
      [["demo", "unmanaged"]],
    );
    assert.deepEqual(result.counts, { managed: 0, unmanaged: 1, broken: 0 });
    assert.deepEqual(await snapshotTree(home), before);
  });
});

test("a broken entry appears even when the managed directory does not exist", async () => {
  await withTemporaryHome(async ({ home, paths }) => {
    await writeLock(paths, { gone: demoEntry });
    const before = await snapshotTree(home);

    const result = await listSkills({ paths, signal });

    assert.deepEqual(
      result.rows.map((row) => [row.name, row.state, row.folderName]),
      [["gone", "broken", null]],
    );
    assert.deepEqual(result.counts, { managed: 0, unmanaged: 0, broken: 1 });
    assert.deepEqual(await snapshotTree(home), before);
  });
});
