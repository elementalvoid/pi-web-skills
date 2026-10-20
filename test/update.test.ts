import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import type { SkillPaths } from "../src/operations/paths.ts";
import { createUpdateSession } from "../src/operations/update.ts";
import type { UpdateContext, UpdateFrame } from "../src/operations/update.ts";
import { openUpdateChannel } from "../src/operations/update-channel.ts";
import type { JsonValue } from "../src/operations/errors.ts";
import type { ExecFile, ExecFileRequest, ExecFileResult } from "../src/upstream/git.ts";

const NOW = new Date("2026-02-01T12:00:00.000Z");
const OFFLINE = "https://api.github.com/repos/offline/offline/git/trees/main?recursive=1";

type Harness = { readonly root: string; readonly paths: SkillPaths; readonly tempRoot: string };

async function withHarness(run: (harness: Harness) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "pi-web-skills-update-test-"));
  const harness: Harness = {
    root,
    paths: {
      managedDirectory: join(root, "managed"),
      lockfilePath: join(root, "lock.json"),
    },
    tempRoot: join(root, "tmp"),
  };
  await Promise.all([
    mkdir(harness.paths.managedDirectory, { recursive: true }),
    mkdir(harness.tempRoot, { recursive: true }),
  ]);
  try {
    await run(harness);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

type Repo = {
  readonly directory: string;
  readonly url: string;
  readonly branch: string;
  readonly hash: (folder: string) => Promise<string>;
};

type FixtureSkill = { readonly name: string; readonly folder: string; readonly body: string };

async function git(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFileCallback("git", ["-C", cwd, ...args], (error, stdout) => {
      if (error) reject(error);
      else resolve(String(stdout));
    });
  });
}

/** One local git repository, so clones and tree hashes are real but never online. */
async function createRepo(root: string, skills: readonly FixtureSkill[]): Promise<Repo> {
  const directory = await mkdtemp(join(root, "repo-"));
  await git(directory, ["init", "-q"]);
  await git(directory, ["config", "user.email", "fixture@example.com"]);
  await git(directory, ["config", "user.name", "Fixture"]);
  for (const skill of skills) {
    const folder = join(directory, "skills", skill.folder);
    await mkdir(folder, { recursive: true });
    await writeFile(
      join(folder, "SKILL.md"),
      `---\nname: ${skill.name}\ndescription: ${skill.name} description\n---\n\n${skill.body}\n`,
    );
  }
  await git(directory, ["add", "."]);
  await git(directory, ["commit", "-qm", "fixture"]);
  const branch = (await git(directory, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  return {
    directory,
    url: pathToFileURL(directory).href,
    branch,
    hash: async (folder) =>
      (await git(directory, ["rev-parse", folder === "" ? "HEAD^{tree}" : `HEAD:${folder}`])).trim(),
  };
}

async function installFixture(paths: SkillPaths, folder: string, body: string): Promise<void> {
  await mkdir(join(paths.managedDirectory, folder), { recursive: true });
  await writeFile(
    join(paths.managedDirectory, folder, "SKILL.md"),
    `---\nname: ${folder}\ndescription: installed\n---\n\n${body}\n`,
  );
}

/** One lock entry in the standard upstream shape. */
function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: "owner/repo",
    sourceType: "github",
    sourceUrl: "https://github.com/owner/repo.git",
    ref: "main",
    skillPath: "skills/example/SKILL.md",
    skillFolderHash: "0000000000000000000000000000000000000000",
    installedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    ...overrides,
  };
}

async function writeLock(paths: SkillPaths, skills: Record<string, unknown>): Promise<void> {
  await writeFile(
    paths.lockfilePath,
    JSON.stringify({ version: 3, skills, dismissed: { keep: true }, lastSelectedAgents: [] }, null, 2),
  );
}

async function readLock(paths: SkillPaths): Promise<Record<string, any>> {
  return JSON.parse(await readFile(paths.lockfilePath, "utf8")) as Record<string, any>;
}

async function readSkill(paths: SkillPaths, folder: string): Promise<string> {
  return readFile(join(paths.managedDirectory, folder, "SKILL.md"), "utf8");
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

/** The no-network default: the API is unavailable, so every group falls back to a clone. */
const offlineFetch: typeof fetch = async () => new Response("", { status: 503 });

type TreeResponse = {
  readonly sha: string;
  readonly tree: readonly { readonly path: string; readonly type: "blob" | "tree"; readonly sha: string }[];
};

/** A fake GitHub Trees API answer for one `owner/repo`. */
function treeFetch(ownerRepo: string, tree: TreeResponse): typeof fetch {
  return async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.includes(`/repos/${ownerRepo}/git/trees/`)) return new Response("", { status: 503 });
    return Response.json(tree);
  };
}

/** Run one real process so the tests observe the same argv and env the daemon would. */
function runProcess(request: ExecFileRequest): Promise<ExecFileResult> {
  const env: NodeJS.ProcessEnv = { ...process.env, ...request.env };
  for (const key of request.unsetEnv ?? []) delete env[key];
  return new Promise((resolve) => {
    execFileCallback(
      request.file,
      [...(request.args ?? [])],
      { cwd: request.cwd, env, timeout: request.timeoutMs, signal: request.signal },
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

type ExecOptions = {
  readonly calls?: ExecFileRequest[];
  /** Any clone whose argv contains this text fails, as a missing repository would. */
  readonly failCloneContains?: string;
  /** Answer `gh api` with this JSON instead of failing, as an authenticated CLI would. */
  readonly ghTree?: TreeResponse;
};

function makeExec(options: ExecOptions = {}): ExecFile {
  return (request) => {
    options.calls?.push(request);
    if (request.file === "gh") {
      if (options.ghTree === undefined) {
        return Promise.resolve({ exitCode: 1, stdout: "", stderr: "gh unavailable in tests" });
      }
      return Promise.resolve({ exitCode: 0, stdout: JSON.stringify(options.ghTree), stderr: "" });
    }
    const args = request.args ?? [];
    if (
      options.failCloneContains !== undefined &&
      args.includes("clone") &&
      args.some((arg) => arg.includes(options.failCloneContains!))
    ) {
      return Promise.resolve({ exitCode: 128, stdout: "", stderr: "fatal: repository not found" });
    }
    return runProcess(request);
  };
}

type RunOptions = {
  readonly paths: SkillPaths;
  readonly tempRoot: string;
  readonly names?: readonly string[];
  readonly fetch?: typeof fetch;
  readonly exec?: ExecFile;
  readonly onFrame?: (frame: UpdateFrame, control: { cancel: () => void }) => void;
};

async function runUpdate(options: RunOptions): Promise<UpdateFrame[]> {
  const frames: UpdateFrame[] = [];
  const control = { cancel: () => {} };
  const context: UpdateContext = {
    paths: options.paths,
    signal: new AbortController().signal,
    exec: options.exec ?? makeExec(),
    tempRoot: options.tempRoot,
    fetch: options.fetch ?? offlineFetch,
    getToken: () => null,
    now: () => NOW,
    ...(options.names === undefined ? {} : { names: options.names }),
  };
  const session = createUpdateSession(context, (frame) => {
    frames.push(frame);
    options.onFrame?.(frame, control);
  });
  control.cancel = () => session.cancel();
  session.start();
  await session.settled;
  await session.dispose();
  return frames;
}

function progress(frames: readonly UpdateFrame[]): { name: string; state: string; reason?: string }[] {
  return frames.flatMap((frame) =>
    frame.type === "progress"
      ? [{ name: frame.name, state: frame.state, ...(frame.reason === undefined ? {} : { reason: frame.reason }) }]
      : [],
  );
}

function doneFrame(frames: readonly UpdateFrame[]): Extract<UpdateFrame, { type: "done" }> {
  const done = [...frames].reverse().find((frame) => frame.type === "done");
  assert.ok(done !== undefined && done.type === "done", "the session emits a done frame");
  return done;
}

test("an unchanged skill is reported without cloning or rewriting anything", async () => {
  await withHarness(async (harness) => {
    const repo = await createRepo(harness.root, [{ name: "alpha", folder: "alpha", body: "remote body" }]);
    const hash = await repo.hash("skills/alpha");
    await writeLock(harness.paths, {
      alpha: entry({ sourceUrl: repo.url, ref: repo.branch, skillPath: "skills/alpha/SKILL.md", skillFolderHash: hash }),
    });
    await installFixture(harness.paths, "alpha", "LOCAL EDIT");
    const calls: ExecFileRequest[] = [];

    const frames = await runUpdate({
      paths: harness.paths,
      tempRoot: harness.tempRoot,
      exec: makeExec({ calls }),
      fetch: treeFetch("owner/repo", {
        sha: "tree-sha",
        tree: [
          { path: "skills/alpha/SKILL.md", type: "blob", sha: "blob-sha" },
          { path: "skills/alpha", type: "tree", sha: hash },
        ],
      }),
    });

    assert.deepEqual(progress(frames), [
      { name: "alpha", state: "checking" },
      { name: "alpha", state: "unchanged" },
    ]);
    assert.deepEqual(doneFrame(frames).updated, []);
    assert.deepEqual(doneFrame(frames).unchanged, ["alpha"]);
    assert.equal(calls.length, 0, "an unchanged skill needs neither gh nor a clone");
    assert.match(await readSkill(harness.paths, "alpha"), /LOCAL EDIT/);
    const entryAfter = (await readLock(harness.paths)).skills.alpha;
    assert.equal(entryAfter.updatedAt, "2026-01-02T00:00:00.000Z", "updatedAt only changes on a replace");
    assert.equal(entryAfter.installedAt, "2026-01-01T00:00:00.000Z");
  });
});

test("a changed skill is replaced through the clone and keeps installedAt", async () => {
  await withHarness(async (harness) => {
    const repo = await createRepo(harness.root, [{ name: "beta", folder: "beta", body: "remote v2" }]);
    const remoteHash = await repo.hash("skills/beta");
    await writeLock(harness.paths, {
      beta: entry({ sourceUrl: repo.url, ref: repo.branch, skillPath: "skills/beta/SKILL.md", skillFolderHash: "a".repeat(40) }),
    });
    await installFixture(harness.paths, "beta", "old install");

    const frames = await runUpdate({
      paths: harness.paths,
      tempRoot: harness.tempRoot,
      fetch: treeFetch("owner/repo", {
        sha: "tree-sha",
        tree: [
          { path: "skills/beta/SKILL.md", type: "blob", sha: "blob-sha" },
          { path: "skills/beta", type: "tree", sha: remoteHash },
        ],
      }),
    });

    assert.deepEqual(doneFrame(frames).updated, ["beta"]);
    assert.deepEqual(doneFrame(frames).unchanged, []);
    const installed = await readSkill(harness.paths, "beta");
    assert.match(installed, /remote v2/);
    assert.doesNotMatch(installed, /old install/);
    const entryAfter = (await readLock(harness.paths)).skills.beta;
    assert.equal(entryAfter.skillFolderHash, remoteHash);
    assert.equal(entryAfter.skillPath, "skills/beta/SKILL.md");
    assert.equal(entryAfter.updatedAt, NOW.toISOString());
    assert.equal(entryAfter.installedAt, "2026-01-01T00:00:00.000Z");
  });
});

test("a local edit survives when the remote folder is unchanged and is overwritten when it changed", async () => {
  await withHarness(async (harness) => {
    const repo = await createRepo(harness.root, [
      { name: "alpha", folder: "alpha", body: "remote alpha" },
      { name: "beta", folder: "beta", body: "remote beta v2" },
    ]);
    const alphaHash = await repo.hash("skills/alpha");
    const betaHash = await repo.hash("skills/beta");
    await writeLock(harness.paths, {
      alpha: entry({ sourceUrl: repo.url, ref: repo.branch, skillPath: "skills/alpha/SKILL.md", skillFolderHash: alphaHash }),
      beta: entry({ sourceUrl: repo.url, ref: repo.branch, skillPath: "skills/beta/SKILL.md", skillFolderHash: betaHash }),
    });
    await installFixture(harness.paths, "alpha", "alpha LOCAL EDIT");
    await installFixture(harness.paths, "beta", "beta LOCAL EDIT");

    // The tree claims alpha is unchanged and beta is still at the stale hash.
    const frames = await runUpdate({
      paths: harness.paths,
      tempRoot: harness.tempRoot,
      fetch: async (input) => {
        const url = input instanceof Request ? input.url : String(input);
        if (!url.includes("/repos/owner/repo/git/trees/")) return new Response("", { status: 503 });
        return Response.json({
          sha: "tree-sha",
          tree: [
            { path: "skills/alpha", type: "tree", sha: alphaHash },
            { path: "skills/beta", type: "tree", sha: "b".repeat(40) },
            { path: "skills/alpha/SKILL.md", type: "blob", sha: "alpha-blob" },
            { path: "skills/beta/SKILL.md", type: "blob", sha: "beta-blob" },
          ],
        });
      },
    });

    assert.deepEqual(doneFrame(frames).unchanged, ["alpha"]);
    assert.deepEqual(doneFrame(frames).updated, ["beta"]);
    assert.match(await readSkill(harness.paths, "alpha"), /alpha LOCAL EDIT/);
    assert.match(await readSkill(harness.paths, "beta"), /remote beta v2/);
    assert.doesNotMatch(await readSkill(harness.paths, "beta"), /LOCAL EDIT/);
  });
});

test("a lock entry without its install directory is skipped and never reinstalled", async () => {
  await withHarness(async (harness) => {
    const repo = await createRepo(harness.root, [{ name: "alpha", folder: "alpha", body: "remote body" }]);
    const locked = entry({
      sourceUrl: repo.url,
      ref: repo.branch,
      skillPath: "skills/alpha/SKILL.md",
      skillFolderHash: "0".repeat(40),
    });
    await writeLock(harness.paths, { alpha: locked });
    const calls: ExecFileRequest[] = [];

    const frames = await runUpdate({
      paths: harness.paths,
      tempRoot: harness.tempRoot,
      exec: makeExec({ calls }),
    });

    const done = doneFrame(frames);
    assert.deepEqual(done.skipped, [{ name: "alpha", reason: "Install directory is missing" }]);
    assert.deepEqual(done.updated, []);
    assert.deepEqual(done.unchanged, []);
    assert.deepEqual(done.failed, []);
    assert.equal(await exists(join(harness.paths.managedDirectory, "alpha", "SKILL.md")), false);
    assert.deepEqual((await readLock(harness.paths)).skills.alpha, locked, "the entry is untouched");
    assert.equal(calls.length, 0, "a broken entry is never fetched or cloned");
  });
});

test("a lock entry with an ext:: transport is rejected before any clone", async () => {
  await withHarness(async (harness) => {
    const locked = entry({
      source: "ext::sh",
      sourceUrl: "ext::sh -c 'touch /tmp/pi-web-skills-pwned'",
      ref: "main",
      skillPath: "SKILL.md",
      skillFolderHash: "a".repeat(40),
    });
    await writeLock(harness.paths, { evil: locked });
    await installFixture(harness.paths, "evil", "evil install");
    const calls: ExecFileRequest[] = [];

    const frames = await runUpdate({
      paths: harness.paths,
      tempRoot: harness.tempRoot,
      exec: makeExec({ calls }),
    });

    const done = doneFrame(frames);
    assert.deepEqual(done.failed.map((failure) => failure.name), ["evil"]);
    assert.match(done.failed[0]?.message ?? "", /ext::/);
    assert.deepEqual(done.updated, []);
    assert.deepEqual(done.unchanged, []);
    assert.ok(
      !calls.some((call) => call.file === "git"),
      "an ext:: transport never reaches a git process",
    );
    assert.match(await readSkill(harness.paths, "evil"), /evil install/);
    assert.deepEqual((await readLock(harness.paths)).skills.evil, locked);
  });
});

test("every uncheckable entry is skipped with the exact upstream reason", async () => {
  await withHarness(async (harness) => {
    await writeLock(harness.paths, {
      local: entry({ sourceType: "local", skillPath: undefined, skillFolderHash: "" }),
      git: entry({ sourceType: "git" }),
      wellknown: entry({ sourceType: "well-known", skillPath: "SKILL.md", skillFolderHash: "abc" }),
      nohash: entry({ skillFolderHash: "" }),
      nopath: entry({ skillPath: "" }),
      gitlab: entry({ sourceType: "gitlab", skillFolderHash: "c".repeat(40) }),
    });

    const frames = await runUpdate({
      paths: harness.paths,
      tempRoot: harness.tempRoot,
      fetch: async () => {
        throw new Error("no request may be made for a skipped entry");
      },
    });

    const done = doneFrame(frames);
    assert.deepEqual(done.skipped, [
      { name: "local", reason: "Local path" },
      { name: "git", reason: "Git URL" },
      { name: "wellknown", reason: "Well-known skill" },
      { name: "nohash", reason: "Private or deleted repo" },
      { name: "nopath", reason: "No skill path recorded" },
      { name: "gitlab", reason: "No version tracking" },
    ]);
    assert.deepEqual(done.updated, []);
    assert.deepEqual(done.unchanged, []);
    assert.deepEqual(done.deleted, []);
    assert.deepEqual(done.failed, []);
    assert.deepEqual(
      progress(frames)
        .filter((frame) => frame.state === "skipped")
        .map((frame) => ({ name: frame.name, reason: frame.reason })),
      done.skipped,
    );
  });
});

test("a skill deleted upstream is reported and its install and entry are kept", async () => {
  await withHarness(async (harness) => {
    const repo = await createRepo(harness.root, [{ name: "alpha", folder: "alpha", body: "alpha body" }]);
    const alphaHash = await repo.hash("skills/alpha");
    await writeLock(harness.paths, {
      alpha: entry({ sourceUrl: repo.url, ref: repo.branch, skillPath: "skills/alpha/SKILL.md", skillFolderHash: alphaHash }),
      gone: entry({ sourceUrl: repo.url, ref: repo.branch, skillPath: "skills/gone/SKILL.md", skillFolderHash: "d".repeat(40) }),
    });
    await installFixture(harness.paths, "alpha", "alpha install");
    await installFixture(harness.paths, "gone", "gone install");

    const frames = await runUpdate({ paths: harness.paths, tempRoot: harness.tempRoot });

    const done = doneFrame(frames);
    assert.deepEqual(done.deleted, ["gone"]);
    assert.deepEqual(done.updated, []);
    assert.deepEqual(done.unchanged, ["alpha"]);
    assert.ok(await exists(join(harness.paths.managedDirectory, "gone", "SKILL.md")), "the install stays");
    const gone = (await readLock(harness.paths)).skills.gone;
    assert.equal(gone.updatedAt, "2026-01-02T00:00:00.000Z", "the entry is untouched");
    assert.match(await readSkill(harness.paths, "gone"), /gone install/);
  });
});

test("a skill that moved within its source is relocated, not deleted", async () => {
  await withHarness(async (harness) => {
    const repo = await createRepo(harness.root, [{ name: "notes", folder: "new", body: "notes v2" }]);
    await writeLock(harness.paths, {
      notes: entry({ sourceUrl: repo.url, ref: repo.branch, skillPath: "skills/old/SKILL.md", skillFolderHash: "e".repeat(40) }),
    });
    await installFixture(harness.paths, "notes", "notes v1");

    // The tree no longer carries the locked path, so only the checkout can
    // tell a relocation from a deletion.
    const frames = await runUpdate({
      paths: harness.paths,
      tempRoot: harness.tempRoot,
      fetch: treeFetch("owner/repo", {
        sha: "tree-sha",
        tree: [
          { path: "skills/new/SKILL.md", type: "blob", sha: "blob-sha" },
          { path: "skills/new", type: "tree", sha: await repo.hash("skills/new") },
        ],
      }),
    });

    const done = doneFrame(frames);
    assert.deepEqual(done.updated, ["notes"]);
    assert.deepEqual(done.deleted, []);
    assert.match(await readSkill(harness.paths, "notes"), /notes v2/);
    const entryAfter = (await readLock(harness.paths)).skills.notes;
    assert.equal(entryAfter.skillPath, "skills/new/SKILL.md", "the moved path is recorded");
    assert.equal(entryAfter.skillFolderHash, await repo.hash("skills/new"));
    assert.equal(entryAfter.installedAt, "2026-01-01T00:00:00.000Z");
    assert.equal(entryAfter.updatedAt, NOW.toISOString());
  });
});

test("two current paths with the locked name fail closed instead of relocating", async () => {
  await withHarness(async (harness) => {
    const repo = await createRepo(harness.root, [
      { name: "dup", folder: "a", body: "a" },
      { name: "dup", folder: "b", body: "b" },
    ]);
    await writeLock(harness.paths, {
      dup: entry({ sourceUrl: repo.url, ref: repo.branch, skillPath: "skills/old/SKILL.md", skillFolderHash: "e".repeat(40) }),
    });
    await installFixture(harness.paths, "dup", "dup v1");

    const frames = await runUpdate({ paths: harness.paths, tempRoot: harness.tempRoot });

    const done = doneFrame(frames);
    assert.deepEqual(done.failed.map((failure) => failure.name), ["dup"]);
    assert.match(done.failed[0]!.message, /several skills named "dup"/);
    assert.deepEqual(done.deleted, []);
    assert.deepEqual(done.updated, []);
    assert.match(await readSkill(harness.paths, "dup"), /dup v1/);
  });
});

test("an unavailable API is replaced first by gh api and then by a clone", async () => {
  await withHarness(async (harness) => {
    const repo = await createRepo(harness.root, [{ name: "gamma", folder: "gamma", body: "gamma v2" }]);
    await writeLock(harness.paths, {
      gamma: entry({ sourceUrl: repo.url, ref: repo.branch, skillPath: "skills/gamma/SKILL.md", skillFolderHash: "f".repeat(40) }),
    });
    await installFixture(harness.paths, "gamma", "gamma v1");
    const calls: ExecFileRequest[] = [];

    const frames = await runUpdate({
      paths: harness.paths,
      tempRoot: harness.tempRoot,
      exec: makeExec({ calls }),
      fetch: async () => {
        throw new Error("network disabled");
      },
    });

    assert.deepEqual(doneFrame(frames).updated, ["gamma"]);
    assert.ok(
      calls.some((call) => call.file === "gh" && (call.args ?? []).includes("api")),
      "the CLI fallback is attempted through the bounded exec adapter",
    );
    assert.ok(
      calls.some((call) => call.file === "git" && (call.args ?? []).includes("clone")),
      "the checkout provides the hashes when the API is unavailable",
    );
    assert.match(await readSkill(harness.paths, "gamma"), /gamma v2/);
  });
});

test("the gh api tree is used when the fetch API is unavailable", async () => {
  await withHarness(async (harness) => {
    const repo = await createRepo(harness.root, [{ name: "alpha", folder: "alpha", body: "alpha body" }]);
    const hash = await repo.hash("skills/alpha");
    await writeLock(harness.paths, {
      alpha: entry({ sourceUrl: repo.url, ref: repo.branch, skillPath: "skills/alpha/SKILL.md", skillFolderHash: hash }),
    });
    await installFixture(harness.paths, "alpha", "alpha install");
    const calls: ExecFileRequest[] = [];

    const frames = await runUpdate({
      paths: harness.paths,
      tempRoot: harness.tempRoot,
      exec: makeExec({
        calls,
        ghTree: {
          sha: "tree-sha",
          tree: [
            { path: "skills/alpha/SKILL.md", type: "blob", sha: "blob-sha" },
            { path: "skills/alpha", type: "tree", sha: hash },
          ],
        },
      }),
      fetch: async () => new Response("", { status: 503 }),
    });

    assert.deepEqual(doneFrame(frames).unchanged, ["alpha"]);
    assert.ok(calls.some((call) => call.file === "gh"), "the CLI answered the tree read");
    assert.ok(
      !calls.some((call) => call.file === "git"),
      "a complete tree answer needs no clone",
    );
  });
});

test("a group that cannot be fetched fails without stopping another group", async () => {
  await withHarness(async (harness) => {
    const broken = await createRepo(harness.root, [{ name: "alpha", folder: "alpha", body: "alpha v2" }]);
    const healthy = await createRepo(harness.root, [{ name: "beta", folder: "beta", body: "beta body" }]);
    const betaHash = await healthy.hash("skills/beta");
    await writeLock(harness.paths, {
      alpha: entry({
        source: "owner/broken",
        sourceUrl: broken.url,
        ref: broken.branch,
        skillPath: "skills/alpha/SKILL.md",
        skillFolderHash: "1".repeat(40),
      }),
      beta: entry({
        source: "owner/healthy",
        sourceUrl: healthy.url,
        ref: healthy.branch,
        skillPath: "skills/beta/SKILL.md",
        skillFolderHash: betaHash,
      }),
    });
    await installFixture(harness.paths, "alpha", "alpha install");
    await installFixture(harness.paths, "beta", "beta install");

    const frames = await runUpdate({
      paths: harness.paths,
      tempRoot: harness.tempRoot,
      exec: makeExec({ failCloneContains: broken.url }),
    });

    const done = doneFrame(frames);
    assert.deepEqual(done.failed.map((failure) => failure.name), ["alpha"]);
    assert.match(done.failed[0]!.message, /repository not found|clone failed/i);
    assert.deepEqual(done.unchanged, ["beta"], "the healthy group still reports");
    assert.deepEqual(done.updated, []);
    assert.match(await readSkill(harness.paths, "alpha"), /alpha install/);
    assert.equal((await readLock(harness.paths)).skills.alpha.updatedAt, "2026-01-02T00:00:00.000Z");
  });
});

test("a cancel after one completed skill reports partial results and stops", async () => {
  await withHarness(async (harness) => {
    const repo = await createRepo(harness.root, [
      { name: "alpha", folder: "alpha", body: "alpha v2" },
      { name: "beta", folder: "beta", body: "beta v2" },
    ]);
    await writeLock(harness.paths, {
      alpha: entry({ sourceUrl: repo.url, ref: repo.branch, skillPath: "skills/alpha/SKILL.md", skillFolderHash: "2".repeat(40) }),
      beta: entry({ sourceUrl: repo.url, ref: repo.branch, skillPath: "skills/beta/SKILL.md", skillFolderHash: "3".repeat(40) }),
    });
    await installFixture(harness.paths, "alpha", "alpha v1");
    await installFixture(harness.paths, "beta", "beta v1");

    const frames = await runUpdate({
      paths: harness.paths,
      tempRoot: harness.tempRoot,
      onFrame: (frame, control) => {
        if (frame.type === "progress" && frame.state === "updating" && frame.name === "beta") {
          control.cancel();
        }
      },
    });

    const done = doneFrame(frames);
    assert.deepEqual(done.updated, ["alpha"], "the completed skill is reported");
    assert.ok(!done.unchanged.includes("beta"));
    assert.ok(!done.failed.some((failure) => failure.name === "beta"), "the stopped skill is not a failure");
    assert.match(await readSkill(harness.paths, "alpha"), /alpha v2/);
    assert.match(await readSkill(harness.paths, "beta"), /beta v1/);
    const beta = (await readLock(harness.paths)).skills.beta;
    assert.equal(beta.updatedAt, "2026-01-02T00:00:00.000Z");
    assert.equal(beta.skillFolderHash, "3".repeat(40));
  });
});

test("an explicit empty names list means every managed entry", async () => {
  await withHarness(async (harness) => {
    await writeLock(harness.paths, {
      alpha: entry({ sourceType: "local" }),
      beta: entry({ sourceType: "git" }),
    });

    const frames = await runUpdate({ paths: harness.paths, tempRoot: harness.tempRoot, names: [] });

    assert.deepEqual(doneFrame(frames).skipped, [
      { name: "alpha", reason: "Local path" },
      { name: "beta", reason: "Git URL" },
    ]);
  });
});

test("a names filter checks only the requested entries", async () => {
  await withHarness(async (harness) => {
    await writeLock(harness.paths, {
      alpha: entry({ sourceType: "local" }),
      beta: entry({ sourceType: "git" }),
    });

    const frames = await runUpdate({ paths: harness.paths, tempRoot: harness.tempRoot, names: ["beta"] });

    assert.deepEqual(doneFrame(frames).skipped, [{ name: "beta", reason: "Git URL" }]);
  });
});

async function withChannelPaths(
  run: (paths: SkillPaths, tempRoot: string, frames: JsonValue[]) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "pi-web-skills-update-channel-"));
  const paths: SkillPaths = { managedDirectory: join(root, "managed"), lockfilePath: join(root, "lock.json") };
  const frames: JsonValue[] = [];
  try {
    await run(paths, root, frames);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function openChannel(
  input: JsonValue,
  paths: SkillPaths,
  tempRoot: string,
  frames: JsonValue[],
  operation = "update",
) {
  return openUpdateChannel(
    {
      operation,
      input,
      signal: new AbortController().signal,
      send: (frame) => frames.push(frame),
    },
    {
      paths,
      exec: makeExec(),
      tempRoot,
      fetch: offlineFetch,
      getToken: () => null,
      now: () => NOW,
    },
  );
}

test("the channel rejects a malformed input or frame with a structured error", async () => {
  await withChannelPaths(async (paths, tempRoot, frames) => {
    const malformed = openChannel({ names: 42 }, paths, tempRoot, frames);
    await malformed.close();
    assert.deepEqual(frames, [
      { type: "error", error: { code: "invalid-input", message: "update takes { names?: string[] }." } },
    ]);

    frames.length = 0;
    const wrongOperation = openChannel({}, paths, tempRoot, frames, "add");
    await wrongOperation.close();
    assert.deepEqual(frames, [
      { type: "error", error: { code: "unknown-operation", message: 'Unsupported channel "add"' } },
    ]);

    frames.length = 0;
    const channel = openChannel({}, paths, tempRoot, frames);
    await new Promise((resolve) => setImmediate(resolve));
    channel.receive({ type: "frobnicate" }, new AbortController().signal);
    await channel.close();
    assert.ok(
      frames.some((frame) => isRecord(frame) && frame["type"] === "error"),
      "a malformed frame produces an error frame",
    );
  });
});

test("the channel treats an empty input as every managed entry", async () => {
  await withChannelPaths(async (paths, tempRoot, frames) => {
    await mkdir(join(paths.managedDirectory), { recursive: true });
    await writeLock(paths, { alpha: entry({ sourceType: "local" }) });
    const channel = openChannel({}, paths, tempRoot, frames);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await channel.close();
    const done = frames.find((frame) => isRecord(frame) && frame["type"] === "done") as
      | { skipped?: { name: string; reason: string }[] }
      | undefined;
    assert.deepEqual(done?.skipped, [{ name: "alpha", reason: "Local path" }]);
  });
});

function isRecord(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
