import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AddPeerChannel } from "../src/operations/add-channel.ts";
import { openAddChannel } from "../src/operations/add-channel.ts";
import type { JsonValue } from "../src/operations/errors.ts";
import type { ExecFile } from "../src/upstream/git.ts";

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

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for the condition");
}

const empty = async (dir: string) => (await readdir(dir)).length === 0;

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

test("an install frame reports that install is not implemented yet", async () => {
  await withChannel(async (harness) => {
    const channel = harness.open({ source: "file:///tmp/pi-web-skills-repo" });
    channel.receive({ type: "install", names: ["alpha", "beta"] }, new AbortController().signal);

    const frame = harness.frames[0] as { type?: string; error?: { code?: string; message?: string } };
    assert.equal(frame.type, "error");
    assert.equal(frame.error?.code, "not-implemented");
    assert.match(frame.error?.message ?? "", /not implemented/i);

    await channel.close();
  });
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
