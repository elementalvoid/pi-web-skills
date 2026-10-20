import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertSafeSkillDirectory,
  removeTempDirectory,
  resolveManagedPath,
} from "../src/operations/containment.ts";

async function withRoots(
  run: (roots: { root: string; managedDirectory: string; tempRoot: string }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "pi-web-skills-containment-"));
  const managedDirectory = join(root, "managed");
  const tempRoot = join(root, "temp");
  try {
    await mkdir(managedDirectory);
    await mkdir(tempRoot);
    await run({ root, managedDirectory, tempRoot });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("a plain folder name resolves inside the managed directory", async () => {
  await withRoots(async ({ managedDirectory }) => {
    assert.deepEqual(resolveManagedPath(managedDirectory, "demo"), {
      ok: true,
      value: join(managedDirectory, "demo"),
    });
  });
});

test("names that escape the managed directory are unsafe-path", async () => {
  await withRoots(async ({ managedDirectory }) => {
    for (const name of ["..", "../elsewhere", "/etc/passwd", "nested/demo", "", ".", "a\\b"]) {
      const result = resolveManagedPath(managedDirectory, name);

      assert.equal(result.ok, false, name);
      assert.equal(result.ok === false && result.error.code, "unsafe-path", name);
    }
  });
});

test("a real skill directory is accepted", async () => {
  await withRoots(async ({ managedDirectory }) => {
    await mkdir(join(managedDirectory, "demo"));
    await writeFile(join(managedDirectory, "demo", "SKILL.md"), "---\nname: demo\n---\n");

    assert.deepEqual(await assertSafeSkillDirectory(managedDirectory, "demo"), {
      ok: true,
      value: join(managedDirectory, "demo"),
    });
  });
});

test("a missing skill directory still resolves, so a broken entry can be cleaned", async () => {
  await withRoots(async ({ managedDirectory }) => {
    assert.deepEqual(await assertSafeSkillDirectory(managedDirectory, "gone"), {
      ok: true,
      value: join(managedDirectory, "gone"),
    });
  });
});

test("a symlinked skill directory is refused instead of followed", async () => {
  await withRoots(async ({ root, managedDirectory }) => {
    const outside = join(root, "outside");
    await mkdir(outside);
    await symlink(outside, join(managedDirectory, "linked"));

    const result = await assertSafeSkillDirectory(managedDirectory, "linked");

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, "unsafe-path");
  });
});

test("a temp directory inside the temp root is removed", async () => {
  await withRoots(async ({ tempRoot }) => {
    const clone = join(tempRoot, "clone-1");
    await mkdir(clone);

    assert.equal(await removeTempDirectory(tempRoot, clone), true);
    await assert.rejects(stat(clone), /ENOENT/);
  });
});

test("a temp path outside the temp root is refused and left alone", async () => {
  await withRoots(async ({ root, tempRoot }) => {
    const outside = join(root, "precious");
    await mkdir(outside);

    assert.equal(await removeTempDirectory(tempRoot, outside), false);
    assert.equal((await stat(outside)).isDirectory(), true);
  });
});

test("the temp root itself is never removed", async () => {
  await withRoots(async ({ tempRoot }) => {
    assert.equal(await removeTempDirectory(tempRoot, tempRoot), false);
    assert.equal((await stat(tempRoot)).isDirectory(), true);
  });
});

test("a managed directory that is a symlink is followed to its real directory", async () => {
  await withRoots(async ({ root, managedDirectory }) => {
    const realManaged = join(root, "real-managed");
    await mkdir(join(realManaged, "demo"), { recursive: true });
    await rm(managedDirectory, { recursive: true, force: true });
    await symlink(realManaged, managedDirectory);

    assert.deepEqual(await assertSafeSkillDirectory(managedDirectory, "demo"), {
      ok: true,
      value: join(realManaged, "demo"),
    });
  });
});

test("a missing skill under a symlinked managed directory resolves inside the real root", async () => {
  await withRoots(async ({ root, managedDirectory }) => {
    const realManaged = join(root, "real-managed");
    await mkdir(realManaged);
    await rm(managedDirectory, { recursive: true, force: true });
    await symlink(realManaged, managedDirectory);

    assert.deepEqual(await assertSafeSkillDirectory(managedDirectory, "gone"), {
      ok: true,
      value: join(realManaged, "gone"),
    });
  });
});

test("a child symlink that escapes a symlinked managed root is refused", async () => {
  await withRoots(async ({ root, managedDirectory }) => {
    const realManaged = join(root, "real-managed");
    const outside = join(root, "outside");
    await mkdir(realManaged);
    await mkdir(outside);
    await rm(managedDirectory, { recursive: true, force: true });
    await symlink(realManaged, managedDirectory);
    await symlink(outside, join(realManaged, "linked"));

    const result = await assertSafeSkillDirectory(managedDirectory, "linked");

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, "unsafe-path");
  });
});

test("temp cleanup refuses a path that escapes through a symlinked component", async () => {
  await withRoots(async ({ root, tempRoot }) => {
    const precious = join(root, "outside", "precious");
    await mkdir(precious, { recursive: true });
    await symlink(join(root, "outside"), join(tempRoot, "link"));

    assert.equal(await removeTempDirectory(tempRoot, join(tempRoot, "link", "precious")), false);
    assert.equal((await stat(precious)).isDirectory(), true);
  });
});

test("temp cleanup refuses a symlink whose target escapes the temp root", async () => {
  await withRoots(async ({ root, tempRoot }) => {
    const outside = join(root, "outside");
    await mkdir(outside);
    await symlink(outside, join(tempRoot, "link"));

    assert.equal(await removeTempDirectory(tempRoot, join(tempRoot, "link")), false);
    assert.equal((await stat(outside)).isDirectory(), true);
  });
});
