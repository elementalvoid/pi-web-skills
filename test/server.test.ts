import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { JsonValue } from "@jmfederico/pi-web/server-plugin-api";
import { handlePeerRequest } from "../src/server.ts";

const signal = new AbortController().signal;

async function withTemporaryHome(
  run: (home: string) => Promise<void>,
): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "pi-web-skills-home-"));
  try {
    await run(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test("an unknown operation returns a structured error instead of throwing", async () => {
  const response = await handlePeerRequest(
    { operation: "frobnicate", input: null, signal },
    { home: "/tmp/pi-web-skills-home" },
  );

  assert.deepEqual(response, {
    ok: false,
    error: { code: "unknown-operation", message: 'Unsupported operation "frobnicate"' },
  });
});

test("a malformed status input returns a structured error instead of throwing", async () => {
  const response = await handlePeerRequest(
    { operation: "status", input: { unexpected: true }, signal },
    { home: "/tmp/pi-web-skills-home" },
  );

  assert.deepEqual(response, {
    ok: false,
    error: { code: "invalid-input", message: "status takes no input" },
  });
});

test("a list request returns rows, counts, and no lock warning", async () => {
  await withTemporaryHome(async (home) => {
    const response = await handlePeerRequest(
      { operation: "list", input: null, signal },
      { home },
    );

    assert.deepEqual(response, {
      ok: true,
      value: {
        rows: [],
        counts: { managed: 0, unmanaged: 0, broken: 0 },
        lockWarning: null,
      },
    });
  });
});

test("a malformed list input returns a structured error instead of throwing", async () => {
  const response = await handlePeerRequest(
    { operation: "list", input: {}, signal },
    { home: "/tmp/pi-web-skills-home" },
  );

  assert.deepEqual(response, {
    ok: false,
    error: { code: "invalid-input", message: "list takes no input" },
  });
});

test("a status request returns the resolved paths and existence flags", async () => {
  await withTemporaryHome(async (home) => {
    const response = await handlePeerRequest(
      { operation: "status", input: null, signal },
      { home },
    );

    assert.deepEqual(response, {
      ok: true,
      value: {
        managedDirectory: join(home, ".agents", "skills"),
        lockfilePath: join(home, ".agents", ".skill-lock.json"),
        managedDirectoryExists: false,
        lockfileExists: false,
        lockReadable: false,
      },
    });
  });
});

test("the activated plugin opens an add channel that rejects malformed input", async () => {
  const { default: plugin } = await import("../src/server.ts");
  const frames: JsonValue[] = [];
  const lifetime = new AbortController();
  const activation = await plugin.activate({
    apiVersion: 3,
    pluginId: "skills",
    packageRoot: "/tmp",
    dataDirectory: "/tmp",
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    settings: {},
    execFile: async () => ({
      exitCode: 0,
      stdout: "",
      stderr: "",
      signal: null,
      stdoutTruncated: false,
      stderrTruncated: false,
    }),
    signal: lifetime.signal,
    lifetimeSignal: lifetime.signal,
  });
  const peer = activation.peer;
  const openChannel = peer?.openChannel;
  if (openChannel === undefined) throw new Error("the plugin exposes no channel");

  const channel = await openChannel.call(peer, {
    project: { id: "project", name: "Project", path: "/project" },
    workspace: {
      id: "workspace",
      projectId: "project",
      path: "/project",
      label: "Project",
      isMain: true,
    },
    operation: "add",
    input: null,
    signal: lifetime.signal,
    send: (frame) => frames.push(frame),
  });
  await channel.close?.({ code: 1000, reason: "test", signal: lifetime.signal });

  assert.deepEqual(frames, [
    {
      type: "error",
      error: { code: "invalid-input", message: "add takes { source: string }." },
    },
  ]);
});
