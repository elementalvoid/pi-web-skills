import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import type { AddFrame } from "../src/operations/add.ts";
import { createAddSession } from "../src/operations/add.ts";
import type { SkillPaths } from "../src/operations/paths.ts";
import { resolveSkillPaths } from "../src/operations/paths.ts";
import { removeSkills } from "../src/operations/remove.ts";
import type { UpdateFrame } from "../src/operations/update.ts";
import { createUpdateSession } from "../src/operations/update.ts";
import type { ExecFile, ExecFileRequest, ExecFileResult } from "../src/upstream/git.ts";
import { computeSkillFolderHash } from "../src/vendor/skills/local-lock.ts";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const skillsCli = join(projectRoot, "node_modules", ".bin", "skills");
const cliSkip = (await isFile(skillsCli))
  ? false
  : "the skills CLI is not installed at node_modules/.bin/skills; run npm install to run CLI parity tests";

async function isFile(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

type Harness = { readonly root: string; readonly fixtureRoot: string; readonly tempRoot: string };

async function withHarness(run: (harness: Harness) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "pi-web-skills-parity-"));
  const harness: Harness = {
    root,
    fixtureRoot: join(root, "fixtures"),
    tempRoot: join(root, "tmp"),
  };
  await Promise.all([
    mkdir(harness.fixtureRoot, { recursive: true }),
    mkdir(harness.tempRoot, { recursive: true }),
  ]);
  try {
    await run(harness);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFileCallback("git", ["-C", cwd, ...args], (error, stdout) => {
      if (error) reject(error);
      else resolve(String(stdout));
    });
  });
}

type FixtureSkill = {
  readonly name: string;
  readonly description: string;
  readonly folder: string;
  readonly body: string;
};

type SourceRepo = {
  readonly directory: string;
  readonly url: string;
  readonly branch: string;
  readonly hash: (folder: string) => Promise<string>;
};

/** A local git repository; both the CLI and the plugin reach it through git, never the network. */
async function createSourceRepo(
  harness: Harness,
  skills: readonly FixtureSkill[],
): Promise<SourceRepo> {
  const directory = await mkdtemp(join(harness.fixtureRoot, "repo-"));
  await git(directory, ["init", "-q", "-b", "main"]);
  await git(directory, ["config", "user.email", "fixture@example.com"]);
  await git(directory, ["config", "user.name", "Fixture"]);
  await writeFile(join(directory, "README.md"), "fixture\n");
  for (const skill of skills) await writeFixtureSkill(directory, skill);
  await git(directory, ["add", "."]);
  await git(directory, ["commit", "-qm", "fixture"]);
  return {
    directory,
    url: pathToFileURL(directory).href,
    branch: "main",
    hash: async (folder) => (await git(directory, ["rev-parse", `HEAD:${folder}`])).trim(),
  };
}

async function writeFixtureSkill(root: string, skill: FixtureSkill): Promise<void> {
  const folder = join(root, "skills", skill.folder);
  await mkdir(folder, { recursive: true });
  await writeFile(
    join(folder, "SKILL.md"),
    `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n\n${skill.body}\n`,
  );
}

/** A git config that rewrites the shared source URL to a local path; no network is reachable. */
async function rewriteSource(home: string, url: string, repoUrl: string): Promise<void> {
  await mkdir(home, { recursive: true });
  await writeFile(
    join(home, ".gitconfig"),
    `[url "${repoUrl}/"]\n\tinsteadOf = ${url}\n`,
  );
}

/** CLI environment: a private HOME, a private lock location, and no telemetry or network fetch. */
function cliEnvironment(harness: Harness, home: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env["PATH"] ?? "",
    HOME: home,
    XDG_STATE_HOME: join(home, ".state"),
    XDG_CONFIG_HOME: join(home, ".config"),
    GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    CI: "1",
    DISABLE_TELEMETRY: "1",
    DO_NOT_TRACK: "1",
    TMPDIR: harness.tempRoot,
    LANG: "C.UTF-8",
    NODE_OPTIONS: `--require=${join(harness.root, "no-network.cjs")}`,
  };
}

/** The CLI child gets a fetch that throws, so an accidental network call fails the test loudly. */
async function blockCliNetwork(harness: Harness): Promise<void> {
  await writeFile(
    join(harness.root, "no-network.cjs"),
    'globalThis.fetch = () => { throw new Error("parity test: the CLI attempted a network request"); };\n',
  );
}

function runSkillsCli(
  harness: Harness,
  home: string,
  args: readonly string[],
): Promise<ExecFileResult> {
  return new Promise((resolve) => {
    execFileCallback(
      skillsCli,
      [...args],
      { cwd: harness.root, env: cliEnvironment(harness, home), timeout: 120_000 },
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

/**
 * Real git through the plugin's exec seam, pinned to a private HOME and to the
 * file protocol only. A failed rewrite can therefore never reach the network.
 */
function createGitExec(home: string): ExecFile {
  return (request: ExecFileRequest) => {
    if (request.file === "gh") {
      return Promise.resolve({ exitCode: 1, stdout: "", stderr: "gh is unavailable in parity tests" });
    }
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...request.env,
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_ALLOW_PROTOCOL: "file",
      GIT_TERMINAL_PROMPT: "0",
    };
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
  };
}

type PluginInstall = {
  readonly frames: readonly AddFrame[];
  readonly done: Extract<AddFrame, { type: "done" }>;
};

/** Add with the plugin: resolve candidates, install every one, and wait for the done frame. */
async function installWithPlugin(
  harness: Harness,
  paths: SkillPaths,
  source: string,
  home: string,
): Promise<PluginInstall> {
  const frames: AddFrame[] = [];
  const session = createAddSession(
    {
      paths,
      source,
      exec: createGitExec(home),
      tempRoot: harness.tempRoot,
      signal: new AbortController().signal,
    },
    (frame) => frames.push(frame),
  );
  try {
    session.start();
    await session.settled;
    const page = frames.find((frame) => frame.type === "candidates");
    assert.ok(page?.type === "candidates", `expected candidates, got ${JSON.stringify(frames)}`);
    session.install(page.candidates.map((candidate) => candidate.sourcePath));
    const done = await waitForAddDone(frames);
    return { frames, done };
  } finally {
    await session.dispose();
  }
}

async function waitForAddDone(frames: readonly AddFrame[]): Promise<Extract<AddFrame, { type: "done" }>> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const error = frames.find((frame) => frame.type === "error");
    if (error?.type === "error") throw new Error(JSON.stringify(error));
    const done = frames.find((frame) => frame.type === "done");
    if (done?.type === "done") return done;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`install did not finish: ${JSON.stringify(frames)}`);
}

/** Relative path to bytes for every file under a root; directory-only entries are implied. */
async function snapshotFiles(root: string): Promise<Array<[string, string]>> {
  const files: Array<[string, string]> = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push([relative(root, path), await readFile(path, "utf8")]);
    }
  }
  await visit(root);
  return files.sort(([left], [right]) => left.localeCompare(right));
}

/** Directory entries too, so a deletion can be asserted as a filesystem difference. */
async function snapshotTree(root: string): Promise<string[]> {
  const lines: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const name = relative(root, path).split("\\").join("/");
      if (entry.isDirectory()) {
        lines.push(`dir ${name}`);
        await visit(path);
      } else if (entry.isSymbolicLink()) {
        lines.push(`link ${name}`);
      } else if (entry.isFile()) {
        const digest = createHash("sha256").update(await readFile(path)).digest("hex");
        lines.push(`file ${name} ${digest}`);
      }
    }
  }
  await visit(root);
  return lines.sort();
}

async function readJson(path: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, any>;
}

/** Drop the two fields the two writers are allowed to disagree on. */
function withoutTimestamps(lock: Record<string, any>): Record<string, any> {
  const copy = structuredClone(lock) as Record<string, any>;
  for (const entry of Object.values(copy["skills"] as Record<string, any>)) {
    delete entry["installedAt"];
    delete entry["updatedAt"];
  }
  return copy;
}

test(
  "the CLI and the plugin write the same global lock and files for a generic git source and ref",
  { skip: cliSkip },
  async () => {
    await withHarness(async (harness) => {
      await blockCliNetwork(harness);
      const repo = await createSourceRepo(harness, [
        { name: "alpha", description: "Alpha skill", folder: "alpha", body: "Alpha body" },
        { name: "beta", description: "Beta skill", folder: "beta", body: "Beta body" },
      ]);
      // The shared source is a generic git URL. Both writers record it; git rewrites it to the
      // local fixture, so the source wording and the clone are identical without a network.
      // A file:// URL is the next test's subject: upstream 1.7.4 does not lock that form, so the
      // lock comparison uses the form both writers record.
      const url = "https://upstream.invalid/owner/repo.git";
      const source = `${url}#${repo.branch}`;
      const cliHome = join(harness.root, "cli-home");
      const pluginHome = join(harness.root, "plugin-home");
      await Promise.all([
        rewriteSource(cliHome, url, repo.url),
        rewriteSource(pluginHome, url, repo.url),
      ]);

      const cli = await runSkillsCli(harness, cliHome, ["add", source, "-g", "-a", "pi", "-y"]);
      assert.equal(cli.exitCode, 0, cli.stderr);

      const cliPaths = resolveSkillPaths({ home: cliHome, xdgStateHome: join(cliHome, ".state") });
      const pluginPaths = resolveSkillPaths({
        home: pluginHome,
        xdgStateHome: join(pluginHome, ".state"),
      });
      const plugin = await installWithPlugin(harness, pluginPaths, source, pluginHome);

      assert.deepEqual(plugin.done.failed, []);
      assert.deepEqual([...plugin.done.installed].sort(), ["alpha", "beta"]);

      const cliLock = await readJson(cliPaths.lockfilePath);
      const pluginLock = await readJson(pluginPaths.lockfilePath);
      // Guard: two empty locks would compare equal for the wrong reason.
      assert.deepEqual(Object.keys(cliLock["skills"]).sort(), ["alpha", "beta"]);
      assert.deepEqual(withoutTimestamps(pluginLock), withoutTimestamps(cliLock));

      for (const name of ["alpha", "beta"]) {
        const entry = cliLock["skills"][name];
        assert.equal(entry["source"], url);
        assert.equal(entry["sourceType"], "git");
        assert.equal(entry["sourceUrl"], url);
        assert.equal(entry["ref"], repo.branch);
        assert.equal(entry["skillPath"], `skills/${name}/SKILL.md`);
        assert.match(entry["skillFolderHash"], /^[0-9a-f]{64}$/);
        assert.equal(
          pluginLock["skills"][name]["skillFolderHash"],
          entry["skillFolderHash"],
          "the same clone content produces the same folder hash",
        );
      }

      assert.deepEqual(
        await snapshotFiles(pluginPaths.managedDirectory),
        await snapshotFiles(cliPaths.managedDirectory),
        "both writers install the same bytes",
      );
    });
  },
);

test(
  "a file:// generic source installs the same files in both, but 1.7.4 records a lock entry only in the plugin",
  { skip: cliSkip },
  async () => {
    await withHarness(async (harness) => {
      await blockCliNetwork(harness);
      const repo = await createSourceRepo(harness, [
        { name: "alpha", description: "Alpha skill", folder: "alpha", body: "Alpha body" },
      ]);
      const cliHome = join(harness.root, "cli-home");
      const pluginHome = join(harness.root, "plugin-home");
      await Promise.all([
        mkdir(cliHome, { recursive: true }),
        rewriteSource(pluginHome, repo.url, repo.url),
      ]);

      const cli = await runSkillsCli(harness, cliHome, ["add", repo.url, "-g", "-a", "pi", "-y"]);
      assert.equal(cli.exitCode, 0, cli.stderr);

      const cliPaths = resolveSkillPaths({ home: cliHome, xdgStateHome: join(cliHome, ".state") });
      const pluginPaths = resolveSkillPaths({
        home: pluginHome,
        xdgStateHome: join(pluginHome, ".state"),
      });
      const plugin = await installWithPlugin(harness, pluginPaths, repo.url, pluginHome);
      assert.deepEqual(plugin.done.installed, ["alpha"]);

      assert.deepEqual(
        await snapshotFiles(pluginPaths.managedDirectory),
        await snapshotFiles(cliPaths.managedDirectory),
        "the install itself is identical for a file:// source",
      );

      // Documented upstream 1.7.4 gate: a global lock entry is written only when
      // getOwnerRepo() finds an owner/repo, which a file:// URL cannot provide.
      // The plugin still records a removable entry with the content hash.
      assert.equal(
        await isFile(cliPaths.lockfilePath),
        false,
        "upstream 1.7.4 does not lock a file:// generic source",
      );

      const pluginEntry = (await readJson(pluginPaths.lockfilePath))["skills"]["alpha"];
      assert.equal(pluginEntry["source"], repo.url);
      assert.equal(pluginEntry["sourceType"], "git");
      assert.equal(pluginEntry["sourceUrl"], repo.url);
      assert.equal(pluginEntry["skillPath"], "skills/alpha/SKILL.md");
      assert.match(pluginEntry["skillFolderHash"], /^[0-9a-f]{64}$/);
      assert.equal(
        pluginEntry["skillFolderHash"],
        await computeSkillFolderHash(join(pluginPaths.managedDirectory, "alpha")),
        "a generic git entry records the content hash, not a tree SHA",
      );
      assert.equal(
        pluginEntry["skillFolderHash"],
        await computeSkillFolderHash(join(cliPaths.managedDirectory, "alpha")),
        "the plugin hashes the same installed content the CLI wrote",
      );
    });
  },
);

test("GitHub tree decisions match the lock and the checkout for changed, unchanged, deleted, and relocated paths", async () => {
  await withHarness(async (harness) => {
    const paths: SkillPaths = {
      managedDirectory: join(harness.root, "managed"),
      lockfilePath: join(harness.root, "lock.json"),
    };
    await mkdir(paths.managedDirectory, { recursive: true });
    const now = new Date("2026-03-01T09:00:00.000Z");
    const installedAt = "2026-01-01T00:00:00.000Z";
    const lockedAt = "2026-01-02T00:00:00.000Z";

    const sameRepo = await createSourceRepo(harness, [
      { name: "same", description: "Same skill", folder: "same", body: "same remote" },
    ]);
    const changedRepo = await createSourceRepo(harness, [
      { name: "changed", description: "Changed skill", folder: "changed", body: "changed remote v2" },
    ]);
    const deletedRepo = await createSourceRepo(harness, [
      { name: "other", description: "Other skill", folder: "other", body: "other" },
    ]);
    const movedRepo = await createSourceRepo(harness, [
      { name: "moved", description: "Moved skill", folder: "new-place", body: "moved remote v2" },
    ]);

    const sameHash = await sameRepo.hash("skills/same");
    const changedHash = await changedRepo.hash("skills/changed");
    const movedHash = await movedRepo.hash("skills/new-place");

    type Entry = Record<string, unknown>;
    const entries: Record<string, Entry> = {
      same: {
        source: "org/same",
        sourceType: "github",
        sourceUrl: sameRepo.url,
        ref: "main",
        skillPath: "skills/same/SKILL.md",
        skillFolderHash: sameHash,
        installedAt,
        updatedAt: lockedAt,
      },
      changed: {
        source: "org/changed",
        sourceType: "github",
        sourceUrl: changedRepo.url,
        ref: "main",
        skillPath: "skills/changed/SKILL.md",
        skillFolderHash: "c".repeat(40),
        installedAt,
        updatedAt: lockedAt,
      },
      deleted: {
        source: "org/deleted",
        sourceType: "github",
        sourceUrl: deletedRepo.url,
        ref: "main",
        skillPath: "skills/deleted/SKILL.md",
        skillFolderHash: "d".repeat(40),
        installedAt,
        updatedAt: lockedAt,
      },
      moved: {
        source: "org/moved",
        sourceType: "github",
        sourceUrl: movedRepo.url,
        ref: "main",
        skillPath: "skills/old-place/SKILL.md",
        skillFolderHash: "e".repeat(40),
        installedAt,
        updatedAt: lockedAt,
      },
    };
    await writeFile(
      paths.lockfilePath,
      JSON.stringify(
        {
          version: 3,
          skills: entries,
          dismissed: { keep: true },
          lastSelectedAgents: ["pi"],
        },
        null,
        2,
      ),
    );
    await installLocal(paths.managedDirectory, "same", "same LOCAL EDIT");
    await installLocal(paths.managedDirectory, "changed", "changed LOCAL EDIT v1");
    await installLocal(paths.managedDirectory, "deleted", "deleted install");
    await installLocal(paths.managedDirectory, "moved", "moved LOCAL EDIT v1");

    // The mocked API answers for the two checkable paths and omits the two that need a clone.
    const trees: Record<string, unknown> = {
      [treeUrl("org/same", "main")]: {
        sha: "same-tree",
        tree: [
          { path: "skills/same", type: "tree", sha: sameHash },
          { path: "skills/same/SKILL.md", type: "blob", sha: "same-blob" },
        ],
      },
      [treeUrl("org/changed", "main")]: {
        sha: "changed-tree",
        tree: [
          { path: "skills/changed", type: "tree", sha: changedHash },
          { path: "skills/changed/SKILL.md", type: "blob", sha: "changed-blob" },
        ],
      },
      [treeUrl("org/deleted", "main")]: {
        sha: "deleted-tree",
        tree: [{ path: "README.md", type: "blob", sha: "readme-blob" }],
      },
      [treeUrl("org/moved", "main")]: {
        sha: "moved-tree",
        tree: [{ path: "skills/new-place", type: "tree", sha: movedHash }],
      },
    };
    const requested: string[] = [];
    const fetchTree: typeof fetch = async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      requested.push(url);
      const tree = trees[url];
      return tree === undefined ? new Response("", { status: 503 }) : Response.json(tree);
    };

    const frames: UpdateFrame[] = [];
    const session = createUpdateSession(
      {
        paths,
        signal: new AbortController().signal,
        exec: createGitExec(harness.root),
        tempRoot: harness.tempRoot,
        fetch: fetchTree,
        getToken: () => null,
        now: () => now,
      },
      (frame) => frames.push(frame),
    );
    session.start();
    await session.settled;
    await session.dispose();

    const done = frames.find((frame) => frame.type === "done");
    assert.ok(done?.type === "done", `expected done, got ${JSON.stringify(frames)}`);
    assert.deepEqual([...done.updated].sort(), ["changed", "moved"]);
    assert.deepEqual(done.unchanged, ["same"]);
    assert.deepEqual(done.deleted, ["deleted"]);
    assert.deepEqual(done.skipped, []);
    assert.deepEqual(done.failed, []);
    assert.equal(requested.length, 4, "each source is checked through the mocked tree API");

    const lock = await readJson(paths.lockfilePath);
    assert.deepEqual(lock["skills"]["same"], entries["same"], "an unchanged entry is untouched");
    assert.deepEqual(lock["skills"]["deleted"], entries["deleted"], "a deleted install is not removed");
    assert.equal(lock["skills"]["changed"]["skillFolderHash"], changedHash);
    assert.equal(lock["skills"]["changed"]["skillPath"], "skills/changed/SKILL.md");
    assert.equal(lock["skills"]["changed"]["updatedAt"], now.toISOString());
    assert.equal(lock["skills"]["changed"]["installedAt"], installedAt);
    assert.equal(lock["skills"]["moved"]["skillFolderHash"], movedHash);
    assert.equal(lock["skills"]["moved"]["skillPath"], "skills/new-place/SKILL.md");
    assert.equal(lock["skills"]["moved"]["updatedAt"], now.toISOString());
    assert.equal(lock["skills"]["moved"]["installedAt"], installedAt);
    assert.deepEqual(lock["dismissed"], { keep: true });
    assert.deepEqual(lock["lastSelectedAgents"], ["pi"]);

    assert.match(await readSkill(paths.managedDirectory, "same"), /same LOCAL EDIT/);
    assert.match(await readSkill(paths.managedDirectory, "deleted"), /deleted install/);
    assert.match(await readSkill(paths.managedDirectory, "changed"), /changed remote v2/);
    assert.doesNotMatch(await readSkill(paths.managedDirectory, "changed"), /LOCAL EDIT/);
    assert.match(await readSkill(paths.managedDirectory, "moved"), /moved remote v2/);
    assert.doesNotMatch(await readSkill(paths.managedDirectory, "moved"), /LOCAL EDIT/);
  });
});

function treeUrl(ownerRepo: string, ref: string): string {
  return `https://api.github.com/repos/${ownerRepo}/git/trees/${ref}?recursive=1`;
}

async function installLocal(managedDirectory: string, folder: string, body: string): Promise<void> {
  const directory = join(managedDirectory, folder);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "SKILL.md"),
    `---\nname: ${folder}\ndescription: installed\n---\n\n${body}\n`,
  );
}

async function readSkill(managedDirectory: string, folder: string): Promise<string> {
  return readFile(join(managedDirectory, folder, "SKILL.md"), "utf8");
}

test("remove deletes a managed install, cleans a broken entry, and leaves unmanaged files and lock extras alone", async () => {
  await withHarness(async (harness) => {
    const home = join(harness.root, "home");
    const paths = resolveSkillPaths({ home });
    const installedAt = "2026-01-01T00:00:00.000Z";
    const updatedAt = "2026-01-02T00:00:00.000Z";
    const lockEntry = (name: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
      source: "https://upstream.invalid/owner/repo.git",
      sourceType: "git",
      sourceUrl: "https://upstream.invalid/owner/repo.git",
      ref: "main",
      skillPath: `skills/${name}/SKILL.md`,
      skillFolderHash: "a".repeat(64),
      installedAt,
      updatedAt,
      ...extra,
    });
    const before = {
      version: 3,
      skills: {
        keep: lockEntry("keep", { pluginName: "group", custom: "keep" }),
        drop: lockEntry("drop"),
        gone: lockEntry("gone"),
      },
      dismissed: { keep: true },
      lastSelectedAgents: ["pi"],
      unknownTopLevel: "keep",
    };

    for (const name of ["keep", "drop", "orphan"]) {
      await installLocal(paths.managedDirectory, name, `${name} body`);
    }
    await mkdir(dirname(paths.lockfilePath), { recursive: true });
    await writeFile(paths.lockfilePath, JSON.stringify(before, null, 2));

    const beforeTree = await snapshotTree(paths.managedDirectory);
    assert.ok(beforeTree.includes("dir orphan"));
    assert.ok(beforeTree.includes("dir keep"));

    const result = await removeSkills(
      { paths, signal: new AbortController().signal },
      ["drop", "gone", "orphan"],
    );

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.value.results[0], {
      name: "drop",
      ok: true,
      state: "managed",
      directory: "removed",
    });
    assert.deepEqual(result.value.results[1], {
      name: "gone",
      ok: true,
      state: "broken",
      directory: "absent",
    });
    const orphan = result.value.results[2];
    assert.equal(orphan?.ok, false);
    if (orphan?.ok !== false) return;
    assert.equal(orphan.error.code, "not-managed");

    // Filesystem comparison: only the managed drop install disappears; the
    // unmanaged directory and every other file keep their exact bytes.
    const afterTree = await snapshotTree(paths.managedDirectory);
    const expectedTree = beforeTree.filter(
      (line) => !/^(?:dir|file|link) drop(?:\/|$|\s)/.test(line),
    );
    assert.deepEqual(afterTree, expectedTree);
    assert.match(await readSkill(paths.managedDirectory, "orphan"), /orphan body/);
    assert.match(await readSkill(paths.managedDirectory, "keep"), /keep body/);

    // Lock preservation: only the two named entries go; extras and unknown
    // fields survive byte-for-byte in value.
    const expectedLock = structuredClone(before) as Record<string, any>;
    delete expectedLock["skills"].drop;
    delete expectedLock["skills"].gone;
    assert.deepEqual(await readJson(paths.lockfilePath), expectedLock);
  });
});
