import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { operationError } from "../src/operations/errors.ts";
import type { LockDocument, LockEntry } from "../src/operations/lockfile.ts";
import { mutateLockfile, readLockfile } from "../src/operations/lockfile.ts";

type PathRunner = (lockfilePath: string) => Promise<void>;

async function withLockfile(name: string, run: PathRunner): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), `pi-web-skills-lock-${name}-`));
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

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value, null, 2));
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

test("the lock module exposes serialized mutation, not a raw writer", async () => {
  const module = await import("../src/operations/lockfile.ts");

  assert.equal("writeLockfile" in module, false);
});

test("a missing lockfile reads as an empty version 3 lock and is not created", async () => {
  await withLockfile("missing", async (path) => {
    assert.deepEqual(await readLockfile(path), {
      ok: true,
      value: { version: 3, skills: {}, dismissed: {} },
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
    await writeJson(path, contents);

    assert.deepEqual(await readLockfile(path), { ok: true, value: contents });
  });
});

test("a mutation preserves unknown fields, dismissed, and lastSelectedAgents", async () => {
  await withLockfile("write", async (path) => {
    const original = {
      version: 3,
      skills: { demo: { ...entry("demo"), futureEntryField: "keep me" } },
      dismissed: { findSkillsPrompt: true, anotherPrompt: false },
      lastSelectedAgents: ["pi", "claude"],
      futureTopLevel: { nested: [1, 2, 3] },
    };
    await writeJson(path, original);

    const result = await mutateLockfile(path, (lock) => {
      lock.skills["second"] = entry("second");
      return { ok: true, value: null };
    });

    assert.equal(result.ok, true);
    assert.deepEqual(await readJson(path), {
      ...original,
      skills: { demo: original.skills.demo, second: entry("second") },
    });
  });
});

test("a mutation creates the parent directory and leaves no temp file behind", async () => {
  await withLockfile("atomic", async (path) => {
    const nestedDirectory = join(path, "..", "missing");
    const nestedPath = join(nestedDirectory, ".skill-lock.json");

    const result = await mutateLockfile(nestedPath, (lock) => {
      lock.skills["demo"] = entry("demo");
      return { ok: true, value: null };
    });

    assert.equal(result.ok, true);
    assert.deepEqual(await readJson(nestedPath), { ...lockWith("demo"), dismissed: {} });
    assert.deepEqual(await readdir(nestedDirectory), [".skill-lock.json"]);
  });
});

test("a mutation never downgrades a newer schema version", async () => {
  await withLockfile("version", async (path) => {
    await writeJson(path, { version: 9, skills: {} });

    await mutateLockfile(path, (lock) => {
      lock.skills["demo"] = entry("demo");
      return { ok: true, value: null };
    });

    const written = await readJson(path);
    assert.equal(written.version, 9);
    assert.deepEqual(Object.keys(written.skills ?? {}), ["demo"]);
  });
});

test("a mutation re-reads the file so an outside change is preserved", async () => {
  await withLockfile("reread", async (path) => {
    await writeJson(path, lockWith("demo"));
    await writeJson(path, lockWith("demo", "outside"));

    const result = await mutateLockfile(path, (lock) => {
      lock.skills["added"] = entry("added");
      return { ok: true, value: Object.keys(lock.skills) };
    });

    assert.deepEqual(result, { ok: true, value: ["demo", "outside", "added"] });
    assert.deepEqual(Object.keys((await readJson(path)).skills ?? {}), ["demo", "outside", "added"]);
  });
});

test("concurrent mutations are serialized so neither loses the other's entry", async () => {
  await withLockfile("serialized", async (path) => {
    await writeJson(path, lockWith("demo"));

    await Promise.all([
      mutateLockfile(path, async (lock) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        lock.skills["slow"] = entry("slow");
        return { ok: true, value: undefined };
      }),
      mutateLockfile(path, (lock) => {
        lock.skills["fast"] = entry("fast");
        return { ok: true, value: undefined };
      }),
    ]);

    assert.deepEqual(Object.keys((await readJson(path)).skills ?? {}).sort(), [
      "demo",
      "fast",
      "slow",
    ]);
  });
});

test("two spellings of the same lock path share one mutation queue", async () => {
  await withLockfile("spellings", async (path) => {
    await writeJson(path, lockWith("demo"));
    await mkdir(join(path, "..", "nested"), { recursive: true });
    const otherSpelling = `${dirname(path)}/nested/../${basename(path)}`;

    await Promise.all([
      mutateLockfile(path, async (lock) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        lock.skills["first"] = entry("first");
        return { ok: true, value: undefined };
      }),
      mutateLockfile(otherSpelling, (lock) => {
        lock.skills["second"] = entry("second");
        return { ok: true, value: undefined };
      }),
    ]);

    assert.deepEqual(Object.keys((await readJson(path)).skills ?? {}).sort(), [
      "demo",
      "first",
      "second",
    ]);
  });
});

test("a malformed lock blocks mutation and is left untouched", async () => {
  await withLockfile("blocked", async (path) => {
    await writeFile(path, "{ not json");

    const result = await mutateLockfile(path, (lock) => {
      lock.skills["demo"] = entry("demo");
      return { ok: true, value: null };
    });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, "lock-unreadable");
    assert.equal(await readFile(path, "utf8"), "{ not json");
  });
});

test("a mutation that throws writes nothing", async () => {
  await withLockfile("throwing", async (path) => {
    const original = lockWith("demo");
    await writeJson(path, original);

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

test("a vetoed mutation writes nothing, even after changing the draft", async () => {
  await withLockfile("vetoed", async (path) => {
    const original = lockWith("demo");
    await writeJson(path, original);
    const veto = operationError("unsafe-path", "the copy escaped the managed directory");

    const result = await mutateLockfile(path, (lock) => {
      lock.skills["demo"] = entry("changed");
      lock.skills["half-done"] = entry("half-done");
      return { ok: false, error: veto };
    });

    assert.deepEqual(result, { ok: false, error: veto });
    assert.deepEqual(await readJson(path), original);
  });
});
