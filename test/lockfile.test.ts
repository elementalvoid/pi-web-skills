import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { LockDocument, LockEntry } from "../src/operations/lockfile.ts";
import { mutateLockfile, readLockfile, writeLockfile } from "../src/operations/lockfile.ts";

type PathRunner = (lockfilePath: string) => Promise<void>;

async function withLockfile(name: string, run: PathRunner): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-skills-lock-"));
  try {
    await run(join(directory, ".skill-lock.json"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function entry(name: string): LockEntry {
  return {
    source: "owner/repo",
    sourceType: "github",
    sourceUrl: "https://github.com/owner/repo.git",
    skillPath: `skills/${name}/SKILL.md`,
    skillFolderHash: "0123456789abcdef0123456789abcdef01234567",
    installedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
  };
}

function lockWith(...names: string[]): LockDocument {
  return {
    version: 3,
    skills: Object.fromEntries(names.map((name) => [name, entry(name)])),
  };
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

test("a missing lockfile reads as an empty version 3 lock and is not created", async () => {
  await withLockfile("missing", async (path) => {
    assert.deepEqual(await readLockfile(path), {
      ok: true,
      lock: { version: 3, skills: {}, dismissed: {} },
    });
    await assert.rejects(readFile(path), /ENOENT/);
  });
});

test("malformed JSON is reported as lock-unreadable instead of throwing", async () => {
  await withLockfile("malformed", async (path) => {
    await writeFile(path, "{ not json");

    const result = await readLockfile(path);

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, "lock-unreadable");
  });
});

test("a lock whose shape is not version 3 is lock-unreadable", async () => {
  const shapes = [
    '{"version":"3","skills":{}}',
    '{"version":3,"skills":[]}',
    '{"skills":{}}',
    '{"version":2,"skills":{}}',
  ];
  for (const shape of shapes) {
    await withLockfile("shape", async (path) => {
      await writeFile(path, shape);

      const result = await readLockfile(path);

      assert.equal(result.ok, false, shape);
      assert.equal(result.ok === false && result.error.code, "lock-unreadable", shape);
    });
  }
});

test("a version 3 lock reads entries and unknown fields verbatim", async () => {
  await withLockfile("read", async (path) => {
    const contents = {
      version: 3,
      skills: { demo: { ...entry("demo"), futureEntryField: { nested: true } } },
      dismissed: { findSkillsPrompt: true },
      lastSelectedAgents: ["pi"],
      futureTopLevel: 7,
    };
    await writeFile(path, JSON.stringify(contents, null, 2));

    const result = await readLockfile(path);

    assert.deepEqual(result, { ok: true, lock: contents });
  });
});

test("writing preserves unknown fields, dismissed, and lastSelectedAgents", async () => {
  await withLockfile("write", async (path) => {
    const original = {
      version: 3,
      skills: { demo: { ...entry("demo"), futureEntryField: "keep me" } },
      dismissed: { findSkillsPrompt: true, anotherPrompt: false },
      lastSelectedAgents: ["pi", "claude"],
      futureTopLevel: { nested: [1, 2, 3] },
    };
    await writeFile(path, JSON.stringify(original, null, 2));
    // A field the module has never heard of must survive an unrelated change.
    const read = await readLockfile(path);
    assert.equal(read.ok, true);
    if (!read.ok) return;
    read.lock.skills["second"] = entry("second");

    await writeLockfile(path, read.lock);

    assert.deepEqual(await readJson(path), {
      ...original,
      skills: { demo: original.skills.demo, second: entry("second") },
    });
  });
});

test("writing creates the parent directory and leaves no temp file behind", async () => {
  await withLockfile("atomic", async (path) => {
    await mkdir(join(path, "..", "missing"), { recursive: true });
    const nestedPath = join(path, "..", "missing", ".skill-lock.json");

    await writeLockfile(nestedPath, lockWith("demo"));

    assert.deepEqual(await readJson(nestedPath), lockWith("demo"));
    assert.deepEqual(await readdir(join(path, "..", "missing")), [".skill-lock.json"]);
  });
});

test("the writer never downgrades a newer schema version", async () => {
  await withLockfile("version", async (path) => {
    await writeFile(path, JSON.stringify({ version: 9, skills: {} }));

    await writeLockfile(path, { version: 9, skills: { demo: entry("demo") } });

    assert.equal((await readJson(path)).version, 9);
  });
});

test("a mutation re-reads the file so an outside change is preserved", async () => {
  await withLockfile("reread", async (path) => {
    await writeLockfile(path, lockWith("demo"));
    await writeFile(path, JSON.stringify(lockWith("demo", "outside")));

    const result = await mutateLockfile(path, (lock) => {
      lock.skills["added"] = entry("added");
      return Object.keys(lock.skills);
    });

    assert.deepEqual(result, { ok: true, value: ["demo", "outside", "added"] });
    assert.deepEqual(Object.keys((await readJson(path)).skills ?? {}), ["demo", "outside", "added"]);
  });
});

test("concurrent mutations are serialized so neither loses the other's entry", async () => {
  await withLockfile("serialized", async (path) => {
    await writeLockfile(path, lockWith("demo"));

    await Promise.all([
      mutateLockfile(path, async (lock) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        lock.skills["slow"] = entry("slow");
      }),
      mutateLockfile(path, async (lock) => {
        lock.skills["fast"] = entry("fast");
      }),
    ]);

    assert.deepEqual(Object.keys((await readJson(path)).skills ?? {}).sort(), [
      "demo",
      "fast",
      "slow",
    ]);
  });
});

test("a malformed lock blocks mutation and is left untouched", async () => {
  await withLockfile("blocked", async (path) => {
    await writeFile(path, "{ not json");

    const result = await mutateLockfile(path, (lock) => {
      lock.skills["demo"] = entry("demo");
    });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, "lock-unreadable");
    assert.equal(await readFile(path, "utf8"), "{ not json");
  });
});

test("a mutation that throws writes nothing", async () => {
  await withLockfile("throwing", async (path) => {
    const original = lockWith("demo");
    await writeLockfile(path, original);

    await assert.rejects(
      mutateLockfile(path, (lock) => {
        lock.skills["demo"] = entry("changed");
        throw new Error("copy failed");
      }),
      /copy failed/,
    );
    assert.deepEqual(await readJson(path), original);
  });
});
