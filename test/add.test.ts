import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import type { AddContext, AddFrame, AddSession } from "../src/operations/add.ts";
import { createAddSession } from "../src/operations/add.ts";
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
  options: { readonly rootSkill?: boolean } = {},
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
): { session: AddSession; frames: AddFrame[] } {
  const frames: AddFrame[] = [];
  const session = createAddSession(
    {
      source,
      paths: harness.paths,
      exec,
      tempRoot: harness.tempRoot,
      signal,
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
    await mkdir(join(harness.paths.managedDirectory, "notes"), { recursive: true });
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

test("candidates report the existing target state as none, managed, or unmanaged", async () => {
  await withHarness(async (harness) => {
    const source = await createSourceRepo(harness, [
      { name: "alpha", description: "Alpha skill", folder: "alpha" },
      { name: "beta", description: "Beta skill", folder: "beta" },
      { name: "gamma", description: "Gamma skill", folder: "gamma" },
    ]);
    await mkdir(join(harness.paths.managedDirectory, "alpha"), { recursive: true });
    await mkdir(join(harness.paths.managedDirectory, "beta"), { recursive: true });
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
