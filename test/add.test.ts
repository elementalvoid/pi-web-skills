import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import type { AddContext, AddFrame, AddSession } from "../src/operations/add.ts";
import { createAddSession } from "../src/operations/add.ts";
import { mutateLockfile } from "../src/operations/lockfile.ts";
import { installSkillDirectory } from "../src/upstream/install.ts";
import type { ExecFile, ExecFileRequest, ExecFileResult } from "../src/upstream/git.ts";

const started = new AbortController();

type Harness = {
  readonly fixtureRoot: string;
  readonly home: string;
  readonly tempRoot: string;
  readonly paths: AddContext["paths"];
};

async function withHarness(run: (harness: Harness) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "pi-web-skills-add-test-"));
  const harness: Harness = {
    fixtureRoot: join(root, "fixtures"),
    home: join(root, "home"),
    tempRoot: join(root, "tmp"),
    paths: {
      managedDirectory: join(root, "home", ".agents", "skills"),
      lockfilePath: join(root, "home", ".agents", ".skill-lock.json"),
    },
  };
  await Promise.all([
    mkdir(harness.fixtureRoot, { recursive: true }),
    mkdir(harness.home, { recursive: true }),
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

type FixtureSkill = { readonly name: string; readonly description: string; readonly folder: string };

async function createSourceRepo(
  harness: Harness,
  skills: readonly FixtureSkill[],
  options: { readonly rootSkill?: boolean; readonly pluginName?: string } = {},
): Promise<string> {
  const root = await mkdtemp(join(harness.fixtureRoot, "repo-"));
  await git(root, ["init", "-q"]);
  await git(root, ["config", "user.email", "fixture@example.com"]);
  await git(root, ["config", "user.name", "Fixture"]);
  await writeFile(join(root, "README.md"), "fixture\n");
  if (options.rootSkill === true) {
    await writeSkill(root, { name: "root-skill", description: "A root skill", folder: "" });
  }
  for (const skill of skills) {
    await writeSkill(root, skill);
  }
  if (options.pluginName !== undefined) {
    await mkdir(join(root, ".claude-plugin"), { recursive: true });
    await writeFile(
      join(root, ".claude-plugin", "plugin.json"),
      JSON.stringify({
        name: options.pluginName,
        skills: skills.map((skill) => (skill.folder === "" ? "." : `./skills/${skill.folder}`)),
      }),
    );
  }
  await git(root, ["add", "."]);
  await git(root, ["commit", "-qm", "fixture"]);
  return pathToFileURL(root).href;
}

async function writeSkill(root: string, skill: FixtureSkill): Promise<void> {
  const folder = skill.folder === "" ? root : join(root, "skills", skill.folder);
  await mkdir(folder, { recursive: true });
  await writeFile(
    join(folder, "SKILL.md"),
    `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n\nBody\n`,
  );
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    try {
      await readdir(path);
      return true;
    } catch {
      return false;
    }
  }
}

/** Run one real process so tests observe the same argv and env the daemon would. */
function runProcess(request: ExecFileRequest): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, ...request.env };
  for (const key of request.unsetEnv ?? []) delete env[key];
  return new Promise((resolve) => {
    execFileCallback(
      request.file,
      [...(request.args ?? [])],
      {
        cwd: request.cwd,
        env,
        timeout: request.timeoutMs,
        signal: request.signal,
      },
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

function createLocalExec(
  intercept?: (request: ExecFileRequest) => ExecFileResult | Promise<ExecFileResult | null> | null,
): { exec: ExecFile; requests: ExecFileRequest[] } {
  const requests: ExecFileRequest[] = [];
  const exec: ExecFile = async (request) => {
    requests.push(request);
    const intercepted = await intercept?.(request);
    return intercepted ?? runProcess(request);
  };
  return { exec, requests };
}

function startAdd(
  harness: Harness,
  source: string,
  exec: ExecFile,
  signal: AbortSignal = started.signal,
  overrides: Partial<AddContext> = {},
): { session: AddSession; frames: AddFrame[] } {
  const frames: AddFrame[] = [];
  const session = createAddSession(
    {
      source,
      paths: harness.paths,
      exec,
      tempRoot: harness.tempRoot,
      signal,
      ...overrides,
    },
    (frame) => frames.push(frame),
  );
  session.start();
  return { session, frames };
}

test("resolving a local git source streams every skill and keeps the clone for install", async () => {
  await withHarness(async (harness) => {
    const source = await createSourceRepo(harness, [
      { name: "alpha", description: "Alpha skill", folder: "alpha" },
      { name: "beta", description: "Beta skill", folder: "beta" },
    ]);
    const { exec } = createLocalExec();
    const { session, frames } = startAdd(harness, source, exec);

    await session.settled;

    const page = frames[0];
    assert.equal(page?.type, "candidates");
    if (page?.type !== "candidates") return;
    assert.equal(page.index, 0);
    assert.equal(page.total, 2);
    assert.deepEqual(
      page.candidates.map((candidate) => ({
        name: candidate.name,
        description: candidate.description,
        sourcePath: candidate.sourcePath,
        folderName: candidate.folderName,
        existing: candidate.existing,
      })),
      [
        {
          name: "alpha",
          description: "Alpha skill",
          sourcePath: "skills/alpha/SKILL.md",
          folderName: "alpha",
          existing: "none",
        },
        {
          name: "beta",
          description: "Beta skill",
          sourcePath: "skills/beta/SKILL.md",
          folderName: "beta",
          existing: "none",
        },
      ],
    );
    for (const candidate of page.candidates) assert.match(candidate.folderHash, /^[0-9a-f]{64}$/);
    assert.deepEqual(frames[1], { type: "candidates-end", total: 2 });

    const clone = session.cloneDirectory();
    assert.ok(clone !== null);
    assert.equal(await exists(clone), true, "the clone stays open for a later install");

    await session.dispose();
    assert.deepEqual(await readdir(harness.tempRoot), []);
  });
});

test("the clone runs through the exec adapter with argv only and bounded git env", async () => {
  await withHarness(async (harness) => {
    const source = await createSourceRepo(harness, [
      { name: "alpha", description: "Alpha skill", folder: "alpha" },
    ]);
    const { exec, requests } = createLocalExec();
    const { session } = startAdd(harness, source, exec);

    await session.settled;

    const clone = requests.find((request) => request.args?.[0] === "clone");
    assert.ok(clone, "a clone request was made");
    assert.equal(clone.file, "git");
    assert.deepEqual(clone.args?.slice(0, 3), ["clone", "--depth", "1"]);
    assert.ok(clone.args?.includes(source));
    assert.equal(clone.env?.["GIT_TERMINAL_PROMPT"], "0");
    assert.equal(clone.env?.["GIT_OPTIONAL_LOCKS"], "0");
    assert.deepEqual(clone.unsetEnv, ["GIT_DIR", "GIT_WORK_TREE"]);
    assert.equal(clone.timeoutMs, 120_000);
    assert.ok(clone.args?.every((argument) => !argument.includes(" ")));
    for (const request of requests) {
      assert.deepEqual(request.unsetEnv, ["GIT_DIR", "GIT_WORK_TREE"], String(request.args?.[0]));
    }

    await session.dispose();
  });
});

test("a lock entry without its install folder is a new target, not an installed one", async () => {
  await withHarness(async (harness) => {
    const source = await createSourceRepo(harness, [
      { name: "alpha", description: "Alpha skill", folder: "alpha" },
    ]);
    await mkdir(dirname(harness.paths.lockfilePath), { recursive: true });
    await writeFile(
      harness.paths.lockfilePath,
      JSON.stringify({ version: 3, skills: { alpha: { source: "owner/repo" } } }),
    );
    const { exec } = createLocalExec();
    const { session, frames } = startAdd(harness, source, exec);

    await session.settled;

    const page = frames[0];
    if (page?.type !== "candidates") throw new Error(JSON.stringify(frames));
    assert.equal(page.candidates[0]?.existing, "none");

    await session.dispose();
  });
});

test("an existing target matches by its sanitised directory name", async () => {
  await withHarness(async (harness) => {
    const source = await createSourceRepo(harness, [
      { name: "ce-review", description: "Review skill", folder: "ce-review" },
      { name: "notes", description: "Notes skill", folder: "notes" },
      { name: "gamma", description: "Gamma skill", folder: "gamma" },
    ]);
    // Written by an older tool: the folder name only matches after sanitising.
    await mkdir(join(harness.paths.managedDirectory, "CE Review"), { recursive: true });
    await writeFile(
      join(harness.paths.managedDirectory, "CE Review", "SKILL.md"),
      "---\nname: ce-review\ndescription: existing\n---\n",
    );
    await mkdir(join(harness.paths.managedDirectory, "notes"), { recursive: true });
    await writeFile(
      join(harness.paths.managedDirectory, "notes", "SKILL.md"),
      "---\nname: notes\ndescription: existing\n---\n",
    );
    await mkdir(dirname(harness.paths.lockfilePath), { recursive: true });
    await writeFile(
      harness.paths.lockfilePath,
      JSON.stringify({ version: 3, skills: { notes: { source: "owner/repo" } } }),
    );
    const { exec } = createLocalExec();
    const { session, frames } = startAdd(harness, source, exec);

    await session.settled;

    const page = frames[0];
    if (page?.type !== "candidates") throw new Error(JSON.stringify(frames));
    assert.deepEqual(
      page.candidates.map((candidate) => [candidate.name, candidate.existing]),
      [
        ["ce-review", "unmanaged"],
        ["gamma", "none"],
        ["notes", "managed"],
      ],
    );

    await session.dispose();
  });
});

test("a nested unmanaged skill matches the target the panel reports", async () => {
  await withHarness(async (harness) => {
    const source = await createSourceRepo(harness, [
      { name: "alpha", description: "Alpha skill", folder: "alpha" },
      { name: "gamma", description: "Gamma skill", folder: "gamma" },
    ]);
    const nested = join(harness.paths.managedDirectory, "nested", "alpha");
    await mkdir(nested, { recursive: true });
    await writeFile(join(nested, "SKILL.md"), "---\nname: alpha\ndescription: nested\n---\n");
    const { exec } = createLocalExec();
    const { session, frames } = startAdd(harness, source, exec);

    await session.settled;

    const page = frames[0];
    if (page?.type !== "candidates") throw new Error(JSON.stringify(frames));
    assert.deepEqual(
      page.candidates.map((candidate) => [candidate.name, candidate.existing]),
      [
        ["alpha", "unmanaged"],
        ["gamma", "none"],
      ],
    );

    await session.dispose();
  });
});

test("two same-named skills install by source path, so the selected one's content wins", async () => {
  await withHarness(async (harness) => {
    const source = await createSourceRepo(harness, [
      { name: "dup", description: "First copy", folder: "first" },
      { name: "dup", description: "Second copy", folder: "second" },
    ]);
    const { exec } = createLocalExec();
    const { session, frames } = startAdd(harness, source, exec);
    await session.settled;

    const page = frames[0];
    if (page?.type !== "candidates") throw new Error(JSON.stringify(frames));
    const second = page.candidates[1];
    assert.deepEqual(
      page.candidates.map((candidate) => [candidate.name, candidate.sourcePath]),
      [
        ["dup", "skills/first/SKILL.md"],
        ["dup", "skills/second/SKILL.md"],
      ],
    );
    assert.ok(second !== undefined);

    session.install([second.sourcePath]);
    const done = await waitForDone(frames);

    assert.deepEqual(done.installed, ["dup"]);
    assert.deepEqual(done.failed, []);
    assert.match(
      await readFile(join(harness.paths.managedDirectory, "dup", "SKILL.md"), "utf8"),
      /Second copy/,
    );
    const lock = await readJson(harness.paths.lockfilePath);
    const entry = (lock["skills"] as Record<string, Record<string, unknown>>)["dup"];
    assert.equal(entry?.["skillPath"], "skills/second/SKILL.md");
    assert.equal(entry?.["skillFolderHash"], second.folderHash);

    await session.dispose();
  });
});

test("an install from a plugin source records the plugin group", async () => {
  await withHarness(async (harness) => {
    const source = await createSourceRepo(
      harness,
      [{ name: "alpha", description: "Alpha skill", folder: "alpha" }],
      { pluginName: "group" },
    );
    const { exec } = createLocalExec();
    const { session, frames } = startAdd(harness, source, exec);
    await session.settled;

    session.install(["skills/alpha/SKILL.md"]);
    const done = await waitForDone(frames);

    assert.deepEqual(done.installed, ["alpha"]);
    const lock = await readJson(harness.paths.lockfilePath);
    const entry = (lock["skills"] as Record<string, Record<string, unknown>>)["alpha"];
    assert.equal(entry?.["pluginName"], "group");

    await session.dispose();
  });
});

test("candidates report the existing target state as none, managed, or unmanaged", async () => {
  await withHarness(async (harness) => {
    const source = await createSourceRepo(harness, [
      { name: "alpha", description: "Alpha skill", folder: "alpha" },
      { name: "beta", description: "Beta skill", folder: "beta" },
      { name: "gamma", description: "Gamma skill", folder: "gamma" },
    ]);
    await mkdir(join(harness.paths.managedDirectory, "alpha"), { recursive: true });
    await writeFile(
      join(harness.paths.managedDirectory, "alpha", "SKILL.md"),
      "---\nname: alpha\ndescription: existing\n---\n",
    );
    await mkdir(join(harness.paths.managedDirectory, "beta"), { recursive: true });
    await writeFile(
      join(harness.paths.managedDirectory, "beta", "SKILL.md"),
      "---\nname: beta\ndescription: existing\n---\n",
    );
    await mkdir(dirname(harness.paths.lockfilePath), { recursive: true });
    await writeFile(
      harness.paths.lockfilePath,
      JSON.stringify({ version: 3, skills: { beta: { source: "owner/repo" } } }),
    );
    const { exec } = createLocalExec();
    const { session, frames } = startAdd(harness, source, exec);

    await session.settled;

    const page = frames[0];
    if (page?.type !== "candidates") throw new Error("expected candidates");
    assert.deepEqual(
      page.candidates.map((candidate) => [candidate.name, candidate.existing]),
      [
        ["alpha", "unmanaged"],
        ["beta", "managed"],
        ["gamma", "none"],
      ],
    );

    await session.dispose();
    assert.deepEqual(await readdir(harness.tempRoot), []);
  });
});

test("a malformed lock reports lock-unreadable instead of pretending it has no entries", async () => {
  await withHarness(async (harness) => {
    const source = await createSourceRepo(harness, [
      { name: "alpha", description: "Alpha skill", folder: "alpha" },
    ]);
    await mkdir(dirname(harness.paths.lockfilePath), { recursive: true });
    await writeFile(harness.paths.lockfilePath, '{ "version": 3, "skills": ');
    const { exec } = createLocalExec();
    const { session, frames } = startAdd(harness, source, exec);

    await session.settled;

    const frame = frames[0];
    assert.equal(frame?.type, "error", JSON.stringify(frames));
    if (frame?.type !== "error") return;
    assert.equal(frame.error.code, "lock-unreadable");
    assert.match(frame.error.message, /lock/i);
    assert.equal(frames.length, 1);
    assert.deepEqual(await readdir(harness.tempRoot), []);
  });
});

test("a full candidate page stays under the host's 64 KiB frame bound for hostile metadata", async () => {
  await withHarness(async (harness) => {
    // Quotes and backslashes double under JSON escaping: a near-worst-case frame.
    const hostileName = `evil-${String.fromCodePoint(27)}[2J\u0007-${'"'.repeat(4000)}`;
    const hostileDescription = `desc ${'"'.repeat(20_000)} ${String.fromCodePoint(27)}[31m\u0000 ${String.fromCodePoint(0x1f600).repeat(1000)}`;
    const skills = Array.from({ length: 25 }, (_, index) => ({
      name: `${hostileName}-${String(index)}`,
      description: `${hostileDescription}-${String(index)}`,
      folder: `hostile-${String(index)}`,
    }));
    const source = await createSourceRepo(harness, skills);
    const { exec } = createLocalExec();
    const { session, frames } = startAdd(harness, source, exec);

    await session.settled;

    const pages = frames.filter((frame) => frame.type === "candidates");
    assert.equal(pages.length, 1);
    const page = pages[0];
    if (page?.type !== "candidates") throw new Error(JSON.stringify(frames));
    assert.equal(page.candidates.length, 25);
    assert.ok(
      Buffer.byteLength(JSON.stringify(page), "utf8") < 64 * 1024,
      `frame is ${String(Buffer.byteLength(JSON.stringify(page), "utf8"))} bytes`,
    );
    for (const candidate of page.candidates) {
      for (const text of [candidate.name, candidate.description, candidate.sourcePath, candidate.folderName]) {
        assert.doesNotMatch(text, /[\u0000-\u001f\u007f-\u009f]/, text.slice(0, 40));
      }
      assert.ok(Buffer.byteLength(candidate.name, "utf8") < 200, "the name is capped");
      assert.ok(Buffer.byteLength(candidate.description, "utf8") < 1000, "the description is capped");
      assert.ok(Buffer.byteLength(candidate.sourcePath, "utf8") < 600, "the source path is capped");
      assert.match(candidate.folderName, /^[a-z0-9._-]+$/);
    }

    await session.dispose();
    assert.deepEqual(await readdir(harness.tempRoot), []);
  });
});

test("candidates stream in bounded pages and end with a total", async () => {
  await withHarness(async (harness) => {
    const skills = Array.from({ length: 27 }, (_, index) => {
      const name = `skill-${String(index + 1).padStart(2, "0")}`;
      return { name, description: `${name} description`, folder: name };
    });
    const source = await createSourceRepo(harness, skills);
    const { exec } = createLocalExec();
    const { session, frames } = startAdd(harness, source, exec);

    await session.settled;

    const pages = frames.filter((frame) => frame.type === "candidates");
    assert.deepEqual(
      pages.map((page) => [page.type === "candidates" ? page.index : -1, page.type === "candidates" ? page.candidates.length : -1]),
      [
        [0, 25],
        [1, 2],
      ],
    );
    assert.deepEqual(frames.at(-1), { type: "candidates-end", total: 27 });

    await session.dispose();
  });
});

test("a clone failure emits a structured error and leaves no temp directory", async () => {
  await withHarness(async (harness) => {
    const { exec } = createLocalExec();
    const { session, frames } = startAdd(harness, "file:///nonexistent/pi-web-skills-repo", exec);

    await session.settled;

    assert.equal(frames.length, 1);
    const frame = frames[0];
    assert.equal(frame?.type, "error");
    if (frame?.type !== "error") return;
    assert.equal(frame.error.code, "clone-failed");
    assert.match(frame.error.message, /retry/i);
    assert.deepEqual(await readdir(harness.tempRoot), []);
  });
});

test("an unsupported source fails before any process runs", async () => {
  await withHarness(async (harness) => {
    const { exec, requests } = createLocalExec();
    const { session, frames } = startAdd(harness, "ext::sh -c whoami", exec);

    await session.settled;

    assert.equal(requests.length, 0);
    const frame = frames[0];
    assert.equal(frame?.type, "error");
    if (frame?.type !== "error") return;
    assert.equal(frame.error.code, "unsupported-source");
    assert.deepEqual(await readdir(harness.tempRoot), []);
  });
});

test("cancel aborts the clone, emits nothing, and leaves no temp directory", async () => {
  await withHarness(async (harness) => {
    let notifyStarted: () => void = () => {};
    const cloneStarted = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const exec: ExecFile = (request) =>
      new Promise((_resolve, reject) => {
        notifyStarted();
        const abort = () => reject(new DOMException("Aborted", "AbortError"));
        if (request.signal.aborted) abort();
        else request.signal.addEventListener("abort", abort, { once: true });
      });
    const { session, frames } = startAdd(harness, "file:///tmp/slow-repo", exec);

    await cloneStarted;
    session.cancel();
    await session.settled;

    assert.deepEqual(frames, []);
    assert.deepEqual(await readdir(harness.tempRoot), []);
  });
});

test("GitHub sources hash a skill folder with the git tree SHA, never a content hash", async () => {
  await withHarness(async (harness) => {
    const fixture = await createSourceRepo(harness, [
      { name: "alpha", description: "Alpha skill", folder: "alpha" },
    ]);
    const treeSha = "a".repeat(40);
    const { exec, requests } = createLocalExec(async (request) => {
      const args = request.args ?? [];
      if (args[0] === "clone") {
        return runProcess({
          ...request,
          args: args.map((argument) =>
            argument === "https://github.com/owner/repo.git" ? fixture : argument,
          ),
        });
      }
      if (args[0] === "rev-parse") {
        return { exitCode: 0, stdout: `${treeSha}\n`, stderr: "" };
      }
      return null;
    });
    const { session, frames } = startAdd(harness, "owner/repo", exec);

    await session.settled;

    const page = frames[0];
    if (page?.type !== "candidates") throw new Error(JSON.stringify(frames));
    assert.equal(page.candidates[0]?.folderHash, treeSha);
    const revParse = requests.find((request) => request.args?.[0] === "rev-parse");
    assert.deepEqual(revParse?.args, [
      "rev-parse",
      "--verify",
      "--end-of-options",
      "HEAD:skills/alpha",
    ]);
    assert.equal(revParse?.cwd, session.cloneDirectory());

    await session.dispose();
  });
});

test("a root-level skill hashes the repository tree", async () => {
  await withHarness(async (harness) => {
    const fixture = await createSourceRepo(harness, [], { rootSkill: true });
    const treeSha = "b".repeat(40);
    const { exec, requests } = createLocalExec(async (request) => {
      const args = request.args ?? [];
      if (args[0] === "clone") {
        return runProcess({
          ...request,
          args: args.map((argument) =>
            argument === "https://gitlab.com/group/repo.git" ? fixture : argument,
          ),
        });
      }
      if (args[0] === "rev-parse") return { exitCode: 0, stdout: `${treeSha}\n`, stderr: "" };
      return null;
    });
    const { session, frames } = startAdd(harness, "https://gitlab.com/group/repo", exec);

    await session.settled;

    const page = frames[0];
    if (page?.type !== "candidates") throw new Error(JSON.stringify(frames));
    assert.deepEqual(
      page.candidates.map((candidate) => [candidate.sourcePath, candidate.folderHash]),
      [["SKILL.md", treeSha]],
    );
    const revParse = requests.find((request) => request.args?.[0] === "rev-parse");
    assert.deepEqual(revParse?.args, ["rev-parse", "--verify", "--end-of-options", "HEAD^{tree}"]);

    await session.dispose();
  });
});

test("a #ref branch is cloned with --branch and the clone stays shallow", async () => {
  await withHarness(async (harness) => {
    const source = await createSourceRepo(harness, [
      { name: "alpha", description: "Alpha at the old ref", folder: "alpha" },
    ]);
    const root = new URL(source);
    const repoPath = decodeURIComponent(root.pathname);
    await git(repoPath, ["branch", "stable"]);
    await writeSkill(repoPath, { name: "beta", description: "Beta on main", folder: "beta" });
    await git(repoPath, ["add", "."]);
    await git(repoPath, ["commit", "-qm", "second"]);
    const { exec, requests } = createLocalExec();
    const { session, frames } = startAdd(harness, `${source}#stable`, exec);

    await session.settled;

    const page = frames[0];
    if (page?.type !== "candidates") throw new Error(JSON.stringify(frames));
    assert.deepEqual(page.candidates.map((candidate) => candidate.name), ["alpha"]);
    const clone = requests.find((request) => request.args?.[0] === "clone");
    assert.ok(clone?.args?.includes("--branch"));
    assert.ok(clone?.args?.includes("stable"));

    await session.dispose();
  });
});

test("a full commit SHA is fetched and checked out after a shallow clone", async () => {
  await withHarness(async (harness) => {
    const source = await createSourceRepo(harness, [
      { name: "alpha", description: "Alpha at the pinned commit", folder: "alpha" },
    ]);
    const repoPath = decodeURIComponent(new URL(source).pathname);
    const sha = (await git(repoPath, ["rev-parse", "HEAD"])).trim();
    await writeSkill(repoPath, { name: "beta", description: "Beta later", folder: "beta" });
    await git(repoPath, ["add", "."]);
    await git(repoPath, ["commit", "-qm", "second"]);
    const { exec, requests } = createLocalExec();
    const { session, frames } = startAdd(harness, `${source}#${sha}`, exec);

    await session.settled;

    const page = frames[0];
    if (page?.type !== "candidates") throw new Error(JSON.stringify(frames));
    assert.deepEqual(page.candidates.map((candidate) => candidate.name), ["alpha"]);
    const clone = requests.find((request) => request.args?.[0] === "clone");
    assert.ok(!clone?.args?.includes("--branch"));
    assert.deepEqual(
      requests.filter((request) => request.cwd !== undefined).map((request) => request.args),
      [
        ["fetch", "--depth", "1", "origin", sha],
        ["checkout", "--quiet", "--detach", "FETCH_HEAD"],
      ],
    );

    await session.dispose();
  });
});

test("a git tree hash that is not 40 hex fails instead of mixing hash shapes", async () => {
  await withHarness(async (harness) => {
    const fixture = await createSourceRepo(harness, [
      { name: "alpha", description: "Alpha skill", folder: "alpha" },
    ]);
    const { exec } = createLocalExec(async (request) => {
      const args = request.args ?? [];
      if (args[0] === "clone") {
        return runProcess({
          ...request,
          args: args.map((argument) =>
            argument === "https://github.com/owner/repo.git" ? fixture : argument,
          ),
        });
      }
      if (args[0] === "rev-parse") {
        return { exitCode: 0, stdout: `${"c".repeat(64)}\n`, stderr: "" };
      }
      return null;
    });
    const { session, frames } = startAdd(harness, "owner/repo", exec);

    await session.settled;

    const frame = frames[0];
    assert.equal(frame?.type, "error");
    if (frame?.type !== "error") return;
    assert.equal(frame.error.code, "folder-hash-failed");
    assert.deepEqual(await readdir(harness.tempRoot), []);
  });
});

test("a source without a valid SKILL.md fails discovery and removes the clone", async () => {
  await withHarness(async (harness) => {
    const source = await createSourceRepo(harness, []);
    const { exec } = createLocalExec();
    const { session, frames } = startAdd(harness, source, exec);

    await session.settled;

    const frame = frames[0];
    assert.equal(frame?.type, "error");
    if (frame?.type !== "error") return;
    assert.equal(frame.error.code, "discovery-failed");
    assert.deepEqual(await readdir(harness.tempRoot), []);
  });
});

test("an @skill fragment narrows the candidates to that skill", async () => {
  await withHarness(async (harness) => {
    const fixture = await createSourceRepo(harness, [
      { name: "alpha", description: "Alpha skill", folder: "alpha" },
      { name: "beta", description: "Beta skill", folder: "beta" },
    ]);
    const { exec } = createLocalExec(async (request) => {
      const args = request.args ?? [];
      if (args[0] !== "clone") return null;
      return runProcess({
        ...request,
        args: args.map((argument) =>
          argument === "https://github.com/owner/repo.git" ? fixture : argument,
        ),
      });
    });
    const { session, frames } = startAdd(harness, "owner/repo@beta", exec);

    await session.settled;

    const page = frames[0];
    if (page?.type !== "candidates") throw new Error(JSON.stringify(frames));
    assert.deepEqual(page.candidates.map((candidate) => candidate.name), ["beta"]);

    await session.dispose();
  });
});

test("a failed tree lookup reports folder-hash-failed and removes the clone", async () => {
  await withHarness(async (harness) => {
    const fixture = await createSourceRepo(harness, [
      { name: "alpha", description: "Alpha skill", folder: "alpha" },
    ]);
    const { exec } = createLocalExec(async (request) => {
      const args = request.args ?? [];
      if (args[0] === "clone") {
        return runProcess({
          ...request,
          args: args.map((argument) =>
            argument === "https://github.com/owner/repo.git" ? fixture : argument,
          ),
        });
      }
      if (args[0] === "rev-parse") {
        return { exitCode: 128, stdout: "", stderr: "fatal: not a tree object" };
      }
      return null;
    });
    const { session, frames } = startAdd(harness, "owner/repo", exec);

    await session.settled;

    const frame = frames[0];
    assert.equal(frame?.type, "error");
    if (frame?.type !== "error") return;
    assert.equal(frame.error.code, "folder-hash-failed");
    assert.deepEqual(await readdir(harness.tempRoot), []);
  });
});

type DoneFrame = Extract<AddFrame, { type: "done" }>;

async function waitForDone(frames: readonly AddFrame[], timeoutMs = 5000): Promise<DoneFrame> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const done = frames.find((frame) => frame.type === "done");
    if (done !== undefined) return done;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for done: ${JSON.stringify(frames)}`);
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

test("the injected clock stamps a new install's times", async () => {
  await withHarness(async (harness) => {
    const source = await createSourceRepo(harness, [
      { name: "alpha", description: "Alpha skill", folder: "alpha" },
    ]);
    const now = new Date("2026-03-04T05:06:07.000Z");
    const { exec } = createLocalExec();
    const { session, frames } = startAdd(harness, source, exec, started.signal, { now: () => now });
    await session.settled;

    session.install(["skills/alpha/SKILL.md"]);
    const done = await waitForDone(frames);

    assert.deepEqual(done.installed, ["alpha"]);
    const lock = await readJson(harness.paths.lockfilePath);
    const lockEntry = (lock["skills"] as Record<string, Record<string, unknown>>)["alpha"];
    assert.equal(lockEntry?.["installedAt"], now.toISOString());
    assert.equal(lockEntry?.["updatedAt"], now.toISOString());

    await session.dispose();
  });
});

test("installing a skill copies its folder and writes one standard lock entry", async () => {
  await withHarness(async (harness) => {
    const source = await createSourceRepo(harness, [
      { name: "alpha", description: "Alpha skill", folder: "alpha" },
    ]);
    const { exec } = createLocalExec();
    const { session, frames } = startAdd(harness, source, exec);
    await session.settled;

    session.install(["skills/alpha/SKILL.md"]);
    const done = await waitForDone(frames);

    assert.deepEqual(done.installed, ["alpha"]);
    assert.deepEqual(done.replaced, []);
    assert.deepEqual(done.failed, []);
    assert.deepEqual(
      frames
        .filter((frame) => frame.type === "progress")
        .map((frame) => [frame.phase, frame.name, frame.index, frame.total]),
      [
        ["installing", "alpha", 0, 1],
        ["installed", "alpha", 0, 1],
      ],
    );

    const target = join(harness.paths.managedDirectory, "alpha");
    assert.match(await readFile(join(target, "SKILL.md"), "utf8"), /name: alpha/);

    const lock = await readJson(harness.paths.lockfilePath);
    const entry = lock["skills"] as Record<string, Record<string, unknown>>;
    assert.equal(lock["version"], 3);
    assert.deepEqual(Object.keys(entry).sort(), ["alpha"]);
    assert.deepEqual(Object.keys(entry["alpha"] ?? {}).sort(), [
      "installedAt",
      "skillFolderHash",
      "skillPath",
      "source",
      "sourceType",
      "sourceUrl",
      "updatedAt",
    ]);
    assert.equal(entry["alpha"]?.["source"], source);
    assert.equal(entry["alpha"]?.["sourceType"], "git");
    assert.equal(entry["alpha"]?.["sourceUrl"], source);
    assert.equal(entry["alpha"]?.["skillPath"], "skills/alpha/SKILL.md");
    assert.match(String(entry["alpha"]?.["skillFolderHash"]), /^[0-9a-f]{64}$/);
    assert.match(String(entry["alpha"]?.["installedAt"]), /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(entry["alpha"]?.["installedAt"], entry["alpha"]?.["updatedAt"]);

    await session.dispose();
    assert.deepEqual(await readdir(harness.tempRoot), []);
  });
});

async function waitForError(
  frames: readonly AddFrame[],
  timeoutMs = 5000,
): Promise<Extract<AddFrame, { type: "error" }>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const error = frames.find((frame) => frame.type === "error");
    if (error !== undefined) return error;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for an error: ${JSON.stringify(frames)}`);
}

test("installing several skills records one lock entry each and keeps the ref", async () => {
  await withHarness(async (harness) => {
    const source = await createSourceRepo(harness, [
      { name: "alpha", description: "Alpha skill", folder: "alpha" },
      { name: "beta", description: "Beta skill", folder: "beta" },
    ]);
    await git(decodeURIComponent(new URL(source).pathname), ["branch", "stable"]);
    const { exec } = createLocalExec();
    const { session, frames } = startAdd(harness, `${source}#stable`, exec);
    await session.settled;

    session.install(["skills/alpha/SKILL.md", "skills/beta/SKILL.md"]);
    const done = await waitForDone(frames);

    assert.deepEqual(done.installed, ["alpha", "beta"]);
    assert.deepEqual(done.replaced, []);
    assert.deepEqual(done.failed, []);
    assert.deepEqual(
      frames
        .filter((frame) => frame.type === "progress")
        .map((frame) => [frame.phase, frame.name, frame.index, frame.total]),
      [
        ["installing", "alpha", 0, 2],
        ["installed", "alpha", 0, 2],
        ["installing", "beta", 1, 2],
        ["installed", "beta", 1, 2],
      ],
    );

    const lock = await readJson(harness.paths.lockfilePath);
    const entry = lock["skills"] as Record<string, Record<string, unknown>>;
    assert.deepEqual(Object.keys(entry).sort(), ["alpha", "beta"]);
    const hashes = new Set<string>();
    for (const name of ["alpha", "beta"]) {
      assert.equal(entry[name]?.["source"], source);
      assert.equal(entry[name]?.["sourceType"], "git");
      assert.equal(entry[name]?.["ref"], "stable");
      assert.equal(entry[name]?.["skillPath"], `skills/${name}/SKILL.md`);
      hashes.add(String(entry[name]?.["skillFolderHash"]));
      assert.match(await readFile(join(harness.paths.managedDirectory, name, "SKILL.md"), "utf8"), new RegExp(`name: ${name}`));
    }
    assert.equal(hashes.size, 2);

    await session.dispose();
  });
});

test("overwriting a managed install replaces the folder and preserves installedAt, unknown fields, and other entries", async () => {
  await withHarness(async (harness) => {
    const source = await createSourceRepo(harness, [
      { name: "alpha", description: "Alpha skill", folder: "alpha" },
    ]);
    const oldEntry = {
      source: "owner/old",
      sourceType: "github",
      sourceUrl: "https://github.com/owner/old.git",
      ref: "main",
      skillPath: "skills/alpha/SKILL.md",
      skillFolderHash: "f".repeat(40),
      installedAt: "2020-01-01T00:00:00.000Z",
      updatedAt: "2020-01-02T00:00:00.000Z",
      futureEntryField: "keep me",
      pluginName: "group",
    };
    const untouched = { ...oldEntry, source: "owner/other", installedAt: "2019-01-01T00:00:00.000Z" };
    await mkdir(join(harness.paths.managedDirectory, "alpha"), { recursive: true });
    await writeFile(join(harness.paths.managedDirectory, "alpha", "SKILL.md"), "old body\n");
    await writeFile(join(harness.paths.managedDirectory, "alpha", "stale.txt"), "must not merge\n");
    await mkdir(dirname(harness.paths.lockfilePath), { recursive: true });
    await writeFile(
      harness.paths.lockfilePath,
      JSON.stringify({
        version: 3,
        skills: { alpha: oldEntry, other: untouched },
        dismissed: { findSkillsPrompt: true },
        lastSelectedAgents: ["pi", "claude"],
        futureTopLevel: { nested: [1, 2, 3] },
      }),
    );
    const { exec } = createLocalExec();
    const { session, frames } = startAdd(harness, source, exec);
    await session.settled;

    session.install(["skills/alpha/SKILL.md"]);
    const done = await waitForDone(frames);

    assert.deepEqual(done.installed, []);
    assert.deepEqual(done.replaced, ["alpha"]);
    const target = join(harness.paths.managedDirectory, "alpha");
    assert.match(await readFile(join(target, "SKILL.md"), "utf8"), /name: alpha/);
    await assert.rejects(readFile(join(target, "stale.txt")), /ENOENT/);

    const lock = await readJson(harness.paths.lockfilePath);
    assert.deepEqual(lock["dismissed"], { findSkillsPrompt: true });
    assert.deepEqual(lock["lastSelectedAgents"], ["pi", "claude"]);
    assert.deepEqual(lock["futureTopLevel"], { nested: [1, 2, 3] });
    const entry = lock["skills"] as Record<string, Record<string, unknown>>;
    assert.deepEqual(entry["other"], untouched);
    assert.equal(entry["alpha"]?.["source"], source);
    assert.equal(entry["alpha"]?.["sourceType"], "git");
    assert.equal(entry["alpha"]?.["installedAt"], "2020-01-01T00:00:00.000Z");
    assert.notEqual(entry["alpha"]?.["updatedAt"], "2020-01-02T00:00:00.000Z");
    assert.equal(entry["alpha"]?.["futureEntryField"], "keep me");
    assert.equal(entry["alpha"]?.["ref"], undefined, "a source without a ref drops the stale ref");
    assert.equal(
      entry["alpha"]?.["pluginName"],
      undefined,
      "a source without a plugin drops the stale plugin name",
    );

    await session.dispose();
  });
});

test("overwriting an unmanaged target replaces it only when the install is requested and reports replaced", async () => {
  await withHarness(async (harness) => {
    const source = await createSourceRepo(harness, [
      { name: "alpha", description: "Alpha skill", folder: "alpha" },
    ]);
    await mkdir(join(harness.paths.managedDirectory, "alpha"), { recursive: true });
    await writeFile(join(harness.paths.managedDirectory, "alpha", "SKILL.md"), "not managed\n");
    await writeFile(join(harness.paths.managedDirectory, "alpha", "stale.txt"), "must not merge\n");
    const { exec } = createLocalExec();
    const { session, frames } = startAdd(harness, source, exec);
    await session.settled;

    session.install(["skills/alpha/SKILL.md"]);
    const done = await waitForDone(frames);

    assert.deepEqual(done.installed, []);
    assert.deepEqual(done.replaced, ["alpha"]);
    const target = join(harness.paths.managedDirectory, "alpha");
    assert.match(await readFile(join(target, "SKILL.md"), "utf8"), /name: alpha/);
    await assert.rejects(readFile(join(target, "stale.txt")), /ENOENT/);
    const lock = await readJson(harness.paths.lockfilePath);
    assert.deepEqual(Object.keys(lock["skills"] as Record<string, unknown>), ["alpha"]);

    await session.dispose();
  });
});

test("the installer writes the folder the badge reported, including a legacy sanitised match", async () => {
  await withHarness(async (harness) => {
    const source = await createSourceRepo(harness, [
      { name: "ce-review", description: "Review skill", folder: "ce-review" },
    ]);
    // An older tool installed under the unsanitised folder name.
    await mkdir(join(harness.paths.managedDirectory, "CE Review"), { recursive: true });
    await writeFile(join(harness.paths.managedDirectory, "CE Review", "SKILL.md"), "old body\n");
    await mkdir(dirname(harness.paths.lockfilePath), { recursive: true });
    await writeFile(
      harness.paths.lockfilePath,
      JSON.stringify({
        version: 3,
        skills: {
          "CE Review": {
            source: "owner/old",
            sourceType: "github",
            sourceUrl: "https://github.com/owner/old.git",
            skillPath: "skills/ce-review/SKILL.md",
            skillFolderHash: "a".repeat(40),
            installedAt: "2020-01-01T00:00:00.000Z",
            updatedAt: "2020-01-02T00:00:00.000Z",
          },
        },
      }),
    );
    const { exec } = createLocalExec();
    const { session, frames } = startAdd(harness, source, exec);
    await session.settled;

    const page = frames[0];
    if (page?.type !== "candidates") throw new Error(JSON.stringify(frames));
    assert.deepEqual(
      page.candidates.map((candidate) => [candidate.name, candidate.folderName, candidate.existing]),
      [["ce-review", "CE Review", "managed"]],
    );

    session.install(["skills/ce-review/SKILL.md"]);
    const done = await waitForDone(frames);

    assert.deepEqual(done.replaced, ["ce-review"]);
    assert.match(
      await readFile(join(harness.paths.managedDirectory, "CE Review", "SKILL.md"), "utf8"),
      /name: ce-review/,
    );
    await assert.rejects(readdir(join(harness.paths.managedDirectory, "ce-review")), /ENOENT/);
    const lock = await readJson(harness.paths.lockfilePath);
    const entry = lock["skills"] as Record<string, Record<string, unknown>>;
    assert.deepEqual(Object.keys(entry), ["CE Review"]);
    assert.equal(entry["CE Review"]?.["installedAt"], "2020-01-01T00:00:00.000Z");

    await session.dispose();
  });
});

test("duplicate sanitised names fail before any copy or lock write", async () => {
  await withHarness(async (harness) => {
    const source = await createSourceRepo(harness, [
      { name: "My Skill", description: "First", folder: "first" },
      { name: "my-skill", description: "Second", folder: "second" },
    ]);
    const { exec } = createLocalExec();
    const { session, frames } = startAdd(harness, source, exec);
    await session.settled;

    session.install(["skills/first/SKILL.md", "skills/second/SKILL.md"]);
    const error = await waitForError(frames);

    assert.equal(error.error.code, "invalid-input");
    assert.match(error.error.message, /install folder/i);
    await assert.rejects(readdir(harness.paths.managedDirectory), /ENOENT/);
    await assert.rejects(readFile(harness.paths.lockfilePath), /ENOENT/);
    assert.equal(frames.some((frame) => frame.type === "done"), false);

    await session.dispose();
  });
});

test("the copy skips symlinks, .git, and node_modules and preserves file modes", async () => {
  await withHarness(async (harness) => {
    const source = await createSourceRepo(harness, [
      { name: "alpha", description: "Alpha skill", folder: "alpha" },
    ]);
    const { exec } = createLocalExec(async (request) => {
      const args = request.args ?? [];
      if (args[0] !== "clone") return null;
      const result = await runProcess(request);
      if (result.exitCode !== 0) return result;
      const skill = join(String(args.at(-1)), "skills", "alpha");
      await mkdir(join(skill, ".git"), { recursive: true });
      await writeFile(join(skill, ".git", "HEAD"), "ref: refs/heads/main\n");
      await mkdir(join(skill, "node_modules", "pkg"), { recursive: true });
      await writeFile(join(skill, "node_modules", "pkg", "index.js"), "x\n");
      await symlink("/etc/hostname", join(skill, "escape"));
      await symlink("SKILL.md", join(skill, "inside-link"));
      await writeFile(join(skill, "run.sh"), "#!/bin/sh\n", { mode: 0o755 });
      await mkdir(join(skill, "docs"), { recursive: true });
      await writeFile(join(skill, "docs", "guide.md"), "guide\n", { mode: 0o640 });
      return result;
    });
    const { session, frames } = startAdd(harness, source, exec);
    await session.settled;

    session.install(["skills/alpha/SKILL.md"]);
    await waitForDone(frames);

    const target = join(harness.paths.managedDirectory, "alpha");
    assert.deepEqual((await readdir(target)).sort(), ["SKILL.md", "docs", "run.sh"]);
    await assert.rejects(readFile(join(target, "escape")), /ENOENT/);
    await assert.rejects(readFile(join(target, "inside-link")), /ENOENT/);
    assert.equal((await stat(join(target, "run.sh"))).mode & 0o111, 0o111);
    assert.equal((await stat(join(target, "docs", "guide.md"))).mode & 0o777, 0o640);
    assert.equal(await readFile(join(target, "docs", "guide.md"), "utf8"), "guide\n");

    await session.dispose();
  });
});

test("a copy failure leaves the previous install and its lock entry intact", async () => {
  await withHarness(async (harness) => {
    const source = await createSourceRepo(harness, [
      { name: "alpha", description: "Alpha skill", folder: "alpha" },
    ]);
    await mkdir(join(harness.paths.managedDirectory, "alpha"), { recursive: true });
    await writeFile(join(harness.paths.managedDirectory, "alpha", "SKILL.md"), "old body\n");
    await writeFile(join(harness.paths.managedDirectory, "alpha", "stale.txt"), "keep me\n");
    const originalLock = {
      version: 3,
      skills: {
        alpha: {
          source: "owner/old",
          sourceType: "github",
          sourceUrl: "https://github.com/owner/old.git",
          skillPath: "skills/alpha/SKILL.md",
          skillFolderHash: "a".repeat(40),
          installedAt: "2020-01-01T00:00:00.000Z",
          updatedAt: "2020-01-02T00:00:00.000Z",
        },
      },
      dismissed: {},
    };
    await mkdir(dirname(harness.paths.lockfilePath), { recursive: true });
    await writeFile(harness.paths.lockfilePath, JSON.stringify(originalLock));
    const { exec } = createLocalExec();
    const { session, frames } = startAdd(harness, source, exec);
    await session.settled;

    const clone = session.cloneDirectory();
    assert.ok(clone !== null);
    await rm(join(clone, "skills", "alpha"), { recursive: true, force: true });

    session.install(["skills/alpha/SKILL.md"]);
    const done = await waitForDone(frames);

    assert.deepEqual(done.installed, []);
    assert.deepEqual(done.replaced, []);
    assert.deepEqual(done.failed.map((failure) => failure.name), ["alpha"]);
    const target = join(harness.paths.managedDirectory, "alpha");
    assert.equal(await readFile(join(target, "SKILL.md"), "utf8"), "old body\n");
    assert.equal(await readFile(join(target, "stale.txt"), "utf8"), "keep me\n");
    assert.deepEqual(await readdir(harness.paths.managedDirectory), ["alpha"]);
    assert.deepEqual(await readJson(harness.paths.lockfilePath), originalLock);

    await session.dispose();
  });
});

test("a throwing lock write fails only that skill and still sends done", async () => {
  await withHarness(async (harness) => {
    const source = await createSourceRepo(harness, [
      { name: "alpha", description: "Alpha skill", folder: "alpha" },
      { name: "beta", description: "Beta skill", folder: "beta" },
    ]);
    const { exec } = createLocalExec();
    let writes = 0;
    const failingMutate: typeof mutateLockfile = async (path, mutate) => {
      writes += 1;
      if (writes === 2) throw new Error("disk full");
      return mutateLockfile(path, mutate);
    };
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    try {
      const { session, frames } = startAdd(harness, source, exec, started.signal, {
        mutateLock: failingMutate,
      });
      await session.settled;

      session.install(["skills/alpha/SKILL.md", "skills/beta/SKILL.md"]);
      const done = await waitForDone(frames);

      assert.deepEqual(done.installed, ["alpha"], "the earlier success stays installed");
      assert.deepEqual(done.replaced, []);
      assert.deepEqual(done.failed.map((failure) => failure.name), ["beta"]);
      assert.match(done.failed[0]?.message ?? "", /disk full/);
      assert.match(
        await readFile(join(harness.paths.managedDirectory, "alpha", "SKILL.md"), "utf8"),
        /name: alpha/,
      );
      const lock = await readJson(harness.paths.lockfilePath);
      assert.deepEqual(Object.keys(lock["skills"] as Record<string, unknown>), ["alpha"]);
      await assert.rejects(readdir(join(harness.paths.managedDirectory, "beta")), /ENOENT/);
      assert.deepEqual(
        (await readdir(harness.paths.managedDirectory)).sort(),
        ["alpha"],
        "no staging or backup directory remains",
      );

      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(rejections, [], "the install promise rejection is handled");

      await session.dispose();
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });
});

test("a failed lock write after a swap restores the previous install and its lock entry", async () => {
  await withHarness(async (harness) => {
    const source = await createSourceRepo(harness, [
      { name: "alpha", description: "Alpha skill", folder: "alpha" },
    ]);
    const target = join(harness.paths.managedDirectory, "alpha");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "SKILL.md"), "old body\n");
    await writeFile(join(target, "stale.txt"), "keep me\n");
    const originalLock = {
      version: 3,
      skills: {
        alpha: {
          source: "owner/old",
          sourceType: "github",
          sourceUrl: "https://github.com/owner/old.git",
          skillPath: "skills/alpha/SKILL.md",
          skillFolderHash: "a".repeat(40),
          installedAt: "2020-01-01T00:00:00.000Z",
          updatedAt: "2020-01-02T00:00:00.000Z",
        },
      },
      dismissed: {},
    };
    await mkdir(dirname(harness.paths.lockfilePath), { recursive: true });
    await writeFile(harness.paths.lockfilePath, JSON.stringify(originalLock));
    const failingMutate: typeof mutateLockfile = async () => {
      throw new Error("the lock is read-only");
    };
    const { exec } = createLocalExec();
    const { session, frames } = startAdd(harness, source, exec, started.signal, {
      mutateLock: failingMutate,
    });
    await session.settled;

    session.install(["skills/alpha/SKILL.md"]);
    const done = await waitForDone(frames);

    assert.deepEqual(done.installed, []);
    assert.deepEqual(done.replaced, []);
    assert.deepEqual(done.failed.map((failure) => failure.name), ["alpha"]);
    assert.match(done.failed[0]?.message ?? "", /read-only/);
    assert.equal(await readFile(join(target, "SKILL.md"), "utf8"), "old body\n");
    assert.equal(await readFile(join(target, "stale.txt"), "utf8"), "keep me\n");
    assert.deepEqual(await readdir(harness.paths.managedDirectory), ["alpha"]);
    assert.deepEqual(await readJson(harness.paths.lockfilePath), originalLock);

    await session.dispose();
  });
});

test("the copier refuses a destination outside the managed directory or through a symlink", async () => {
  await withHarness(async (harness) => {
    const source = join(harness.fixtureRoot, "source-skill");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "SKILL.md"), "---\nname: x\n---\n");
    const signal = new AbortController().signal;

    const escape = await installSkillDirectory(
      harness.paths.managedDirectory,
      "../escape",
      source,
      signal,
    );
    assert.equal(escape.ok, false);
    if (!escape.ok) assert.equal(escape.error.code, "unsafe-path");
    await assert.rejects(readdir(join(harness.home, "escape")), /ENOENT/);

    const outside = join(harness.home, "outside");
    await mkdir(outside, { recursive: true });
    await mkdir(harness.paths.managedDirectory, { recursive: true });
    await symlink(outside, join(harness.paths.managedDirectory, "linked"));
    const linked = await installSkillDirectory(
      harness.paths.managedDirectory,
      "linked",
      source,
      signal,
    );
    assert.equal(linked.ok, false);
    if (!linked.ok) assert.equal(linked.error.code, "unsafe-path");
    assert.deepEqual(await readdir(outside), []);
  });
});

test("a source skill filter that matches nothing reports the shared not-found code", async () => {
  await withHarness(async (harness) => {
    const fixture = await createSourceRepo(harness, [
      { name: "alpha", description: "Alpha skill", folder: "alpha" },
    ]);
    const { exec } = createLocalExec((request) => {
      const args = request.args ?? [];
      if (args[0] !== "clone") return null;
      return runProcess({
        ...request,
        args: args.map((argument) =>
          argument === "https://github.com/owner/repo.git" ? fixture : argument,
        ),
      });
    });
    const { session, frames } = startAdd(harness, "owner/repo@missing", exec);

    await session.settled;

    assert.deepEqual(frames, [
      {
        type: "error",
        error: { code: "not-found", message: 'The source has no skill named "missing".' },
      },
    ]);
    await session.dispose();
  });
});
