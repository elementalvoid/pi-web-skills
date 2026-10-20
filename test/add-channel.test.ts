import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import type { AddPeerChannel } from "../src/operations/add-channel.ts";
import { openAddChannel } from "../src/operations/add-channel.ts";
import type { JsonValue } from "../src/operations/errors.ts";
import type { ExecFile, ExecFileRequest } from "../src/upstream/git.ts";

type ChannelHarness = {
  readonly tempRoot: string;
  readonly paths: { managedDirectory: string; lockfilePath: string };
  readonly frames: JsonValue[];
  readonly requests: number;
  readonly open: (input: JsonValue, operation?: string) => AddPeerChannel;
  readonly blockingExec: ExecFile;
  readonly cloneStarted: Promise<void>;
};

async function withChannel(
  run: (harness: ChannelHarness) => Promise<void>,
  exec?: (started: () => void) => ExecFile,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "pi-web-skills-channel-"));
  const frames: JsonValue[] = [];
  let requests = 0;
  let notifyStarted: () => void = () => {};
  const cloneStarted = new Promise<void>((resolve) => {
    notifyStarted = resolve;
  });
  const controller = new AbortController();
  const blockingExec: ExecFile =
    exec?.(() => notifyStarted()) ??
    ((request) =>
      new Promise((_resolve, reject) => {
        notifyStarted();
        const abort = () => reject(new DOMException("Aborted", "AbortError"));
        if (request.signal.aborted) abort();
        else request.signal.addEventListener("abort", abort, { once: true });
      }));
  const trackedExec: ExecFile = (request) => {
    requests += 1;
    return blockingExec(request);
  };
  const harness: ChannelHarness = {
    tempRoot: root,
    paths: {
      managedDirectory: join(root, "managed"),
      lockfilePath: join(root, "lock.json"),
    },
    frames,
    get requests() {
      return requests;
    },
    cloneStarted,
    blockingExec,
    open(input, operation = "add") {
      return openAddChannel(
        {
          operation,
          input,
          signal: controller.signal,
          send: (frame) => frames.push(frame),
        },
        { paths: harness.paths, exec: trackedExec, tempRoot: root },
      );
    },
  };
  try {
    await run(harness);
  } finally {
    controller.abort();
    await rm(root, { recursive: true, force: true });
  }
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for the condition");
}

const empty = async (dir: string) => (await readdir(dir)).length === 0;

function git(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFileCallback("git", ["-C", cwd, ...args], (error, stdout) => {
      if (error) reject(error);
      else resolve(String(stdout));
    });
  });
}

/** Run one real process so install copies from a real local clone. */
function runProcess(
  request: ExecFileRequest,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
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

const realExec: (started: () => void) => ExecFile = () => (request) => runProcess(request);

async function createSourceRepo(root: string): Promise<string> {
  await mkdir(root, { recursive: true });
  await git(root, ["init", "-q"]);
  await git(root, ["config", "user.email", "fixture@example.com"]);
  await git(root, ["config", "user.name", "Fixture"]);
  await mkdir(join(root, "skills", "alpha"), { recursive: true });
  await writeFile(
    join(root, "skills", "alpha", "SKILL.md"),
    "---\nname: alpha\ndescription: Alpha skill\n---\n\nBody\n",
  );
  await git(root, ["add", "."]);
  await git(root, ["commit", "-qm", "fixture"]);
  return pathToFileURL(root).href;
}

test("openChannel returns before the clone starts and receive returns immediately", async () => {
  await withChannel(async (harness) => {
    const started = Date.now();
    const channel = harness.open({ source: "file:///tmp/pi-web-skills-repo" });
    assert.ok(Date.now() - started < 1000);
    assert.equal(harness.requests, 0, "no synchronous clone inside the open callback");

    await harness.cloneStarted;
    const receiveStarted = Date.now();
    channel.receive({ type: "install", names: ["alpha"] }, new AbortController().signal);
    assert.ok(Date.now() - receiveStarted < 1000);
    assert.equal(harness.frames.length, 1);
    assert.equal(
      (harness.frames[0] as { error?: { code?: string } }).error?.code,
      "invalid-input",
      "an install before resolution is refused, not awaited",
    );

    await channel.close();
    await waitFor(async () => empty(harness.tempRoot));
  });
});

test("a malformed open input returns a structured error without running git", async () => {
  await withChannel(async (harness) => {
    for (const input of [null, {}, { source: 42 }, { source: "owner/repo", extra: true }]) {
      const channel = harness.open(input as JsonValue);
      await channel.close();
    }

    assert.equal(harness.requests, 0);
    assert.deepEqual(
      harness.frames.map((frame) =>
        typeof frame === "object" && frame !== null && !Array.isArray(frame)
          ? (frame as { error?: { code?: string } }).error?.code
          : undefined,
      ),
      ["invalid-input", "invalid-input", "invalid-input", "invalid-input"],
    );
  });
});

test("an unknown channel operation returns a structured error", async () => {
  await withChannel(async (harness) => {
    const channel = harness.open({ source: "owner/repo" }, "update");
    await channel.close();

    const frame = harness.frames[0] as { type?: string; error?: { code?: string } };
    assert.equal(frame.type, "error");
    assert.equal(frame.error?.code, "unknown-operation");
  });
});

test("an install frame streams progress and done frames without blocking the receive callback", async () => {
  const repository = await mkdtemp(join(tmpdir(), "pi-web-skills-channel-repo-"));
  try {
    const source = await createSourceRepo(repository);
    await withChannel(
      async (harness) => {
        const channel = harness.open({ source });
        await waitFor(async () =>
          harness.frames.some(
            (frame) => (frame as { type?: string }).type === "candidates-end",
          ),
        );

        const receiveStarted = Date.now();
        channel.receive({ type: "install", names: ["alpha"] }, new AbortController().signal);
        assert.ok(Date.now() - receiveStarted < 1000);
        assert.equal(
          harness.frames.some((frame) => (frame as { type?: string }).type === "done"),
          false,
          "receive did not wait for the copy",
        );

        await waitFor(async () =>
          harness.frames.some((frame) => (frame as { type?: string }).type === "done"),
        );
        const done = harness.frames.at(-1) as {
          type: string;
          installed: string[];
          replaced: string[];
          failed: unknown[];
        };
        assert.deepEqual(done.installed, ["alpha"]);
        assert.deepEqual(done.replaced, []);
        assert.deepEqual(done.failed, []);
        assert.ok(
          harness.frames.some((frame) => (frame as { type?: string }).type === "progress"),
        );
        assert.match(
          await readFile(join(harness.paths.managedDirectory, "alpha", "SKILL.md"), "utf8"),
          /name: alpha/,
        );
        const lock = JSON.parse(await readFile(harness.paths.lockfilePath, "utf8")) as {
          skills: Record<string, { source: string }>;
        };
        assert.equal(lock.skills["alpha"]?.source, source);

        await channel.close();
      },
      realExec,
    );
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test("an unknown frame type returns invalid-input instead of throwing", async () => {
  await withChannel(async (harness) => {
    const channel = harness.open({ source: "file:///tmp/pi-web-skills-repo" });

    assert.doesNotThrow(() => channel.receive({ type: "install" }, new AbortController().signal));
    assert.doesNotThrow(() => channel.receive({ type: "explode" }, new AbortController().signal));

    const codes = harness.frames.map((frame) =>
      typeof frame === "object" && frame !== null && !Array.isArray(frame)
        ? (frame as { error?: { code?: string } }).error?.code
        : undefined,
    );
    assert.deepEqual(codes, ["invalid-input", "invalid-input"]);

    await channel.close();
  });
});

test("a cancel frame aborts the clone and removes its temporary directory", async () => {
  await withChannel(async (harness) => {
    const channel = harness.open({ source: "file:///tmp/pi-web-skills-repo" });
    await harness.cloneStarted;

    channel.receive({ type: "cancel" }, new AbortController().signal);
    await waitFor(async () => empty(harness.tempRoot));

    await channel.close();
    assert.deepEqual(harness.frames, []);
  });
});
