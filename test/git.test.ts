import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ParsedSource } from "../src/vendor/skills/types.ts";
import type { ExecFile, ExecFileRequest } from "../src/upstream/git.ts";
import { cloneSource, computeGitFolderHash } from "../src/upstream/git.ts";

function runProcess(request: ExecFileRequest): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, ...request.env };
  for (const key of request.unsetEnv ?? []) delete env[key];
  return new Promise((resolve) => {
    execFileCallback(
      request.file,
      [...(request.args ?? [])],
      { cwd: request.cwd, env, signal: request.signal },
      (error, stdout, stderr) => {
        const code = (error as NodeJS.ErrnoException | null)?.code;
        resolve({
          exitCode: error === null ? 0 : typeof code === "number" ? code : 1,
          stdout: String(stdout),
          stderr: String(stderr) || (error?.message ?? ""),
        });
      },
    );
  });
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFileCallback("git", ["-C", cwd, ...args], (error) =>
      error === null ? resolve() : reject(error),
    );
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function withRepo(run: (root: string, tempRoot: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "pi-web-skills-git-test-"));
  const repo = join(root, "repo");
  const tempRoot = join(root, "tmp");
  await mkdir(repo);
  await mkdir(tempRoot);
  await git(repo, ["init", "-q"]);
  await git(repo, ["config", "user.email", "fixture@example.com"]);
  await git(repo, ["config", "user.name", "Fixture"]);
  try {
    await run(repo, tempRoot);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function commitSkill(repo: string, options: { readonly rootSkill?: boolean } = {}): Promise<void> {
  await writeFile(join(repo, "README.md"), "fixture\n");
  const folder = options.rootSkill === true ? repo : join(repo, "skills", "demo");
  await mkdir(join(folder, "references"), { recursive: true });
  await writeFile(
    join(folder, "SKILL.md"),
    "---\nname: demo\ndescription: Demo skill\n---\nbody\n",
  );
  await writeFile(join(folder, "references", "notes.md"), "notes\n");
  if (options.rootSkill !== true) {
    await mkdir(join(repo, ".claude-plugin"), { recursive: true });
    await writeFile(join(repo, ".claude-plugin", "plugin.json"), "{}\n");
    await mkdir(join(repo, "packages", "tool", ".claude-plugin"), { recursive: true });
    await writeFile(join(repo, "packages", "tool", ".claude-plugin", "plugin.json"), "{}\n");
    await mkdir(join(repo, "docs"), { recursive: true });
    await writeFile(join(repo, "docs", "manual.md"), "manual\n");
  }
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-qm", "one"]);
}

function source(url: string): ParsedSource {
  return { type: "git", url };
}

test("a clone materializes the skill folders and leaves the rest of the tree out", async () => {
  await withRepo(async (repo, tempRoot) => {
    await commitSkill(repo);
    const cloned = await cloneSource(runProcess, source(repo), tempRoot, new AbortController().signal);

    assert.equal(cloned.ok, true);
    if (!cloned.ok) return;
    assert.equal(await exists(join(cloned.value, "skills", "demo", "SKILL.md")), true);
    assert.equal(await exists(join(cloned.value, "skills", "demo", "references", "notes.md")), true);
    assert.equal(await exists(join(cloned.value, "docs")), false, "no unrelated folder is checked out");
    assert.equal(await exists(join(cloned.value, "README.md")), true, "root files stay available");
    assert.equal(
      await exists(join(cloned.value, ".claude-plugin", "plugin.json")),
      true,
      "the root manifest is readable",
    );
    assert.equal(
      await exists(join(cloned.value, "packages", "tool", ".claude-plugin", "plugin.json")),
      true,
      "a nested manifest is readable",
    );

    const hashed = await computeGitFolderHash(
      runProcess,
      cloned.value,
      "skills/demo",
      new AbortController().signal,
    );
    assert.equal(hashed.ok, true);
    if (hashed.ok) assert.match(hashed.value, /^[0-9a-f]{40}$/);
  });
});

test("a SKILL.md at the repository root keeps the whole working tree", async () => {
  await withRepo(async (repo, tempRoot) => {
    await commitSkill(repo, { rootSkill: true });
    const cloned = await cloneSource(runProcess, source(repo), tempRoot, new AbortController().signal);

    assert.equal(cloned.ok, true);
    if (!cloned.ok) return;
    assert.equal(await exists(join(cloned.value, "SKILL.md")), true);
    assert.equal(await exists(join(cloned.value, "references", "notes.md")), true);
  });
});

test("a host command timeout names the command bound instead of blaming the source", async () => {
  await withRepo(async (repo, tempRoot) => {
    await commitSkill(repo);
    const timedOut: ExecFile = async () => {
      throw new Error("Server plugin command timed out after 30000ms");
    };
    const cloned = await cloneSource(timedOut, source(repo), tempRoot, new AbortController().signal);

    assert.equal(cloned.ok, false);
    if (cloned.ok) return;
    assert.equal(cloned.error.code, "clone-failed");
    assert.match(cloned.error.message, /too slow to read/);
    assert.doesNotMatch(cloned.error.message, /Check the source/);
  });
});
