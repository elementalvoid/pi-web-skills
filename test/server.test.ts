import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  JsonValue,
  ServerPluginActivationContextV5,
  ServerPluginActivationV5,
} from "@jmfederico/pi-web/server-plugin-api";
import { resolveSkillPaths } from "../src/operations/paths.ts";
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

test("an aborted request returns a structured cancelled response instead of rejecting", async () => {
  const controller = new AbortController();
  controller.abort();

  const response = await handlePeerRequest(
    { operation: "list", input: null, signal: controller.signal },
    { home: "/tmp/pi-web-skills-home" },
  );

  assert.deepEqual(response, {
    ok: false,
    error: { code: "cancelled", message: "The request was cancelled." },
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
  const { frames, close } = await openPluginChannel("add", null);
  await close();

  assert.deepEqual(frames, [
    {
      type: "error",
      error: { code: "invalid-input", message: "add takes { source: string }." },
    },
  ]);
});

test("the update channel is routed and rejects malformed input without network work", async () => {
  const { frames, close } = await openPluginChannel("update", { names: "alpha" });
  await close();

  assert.deepEqual(frames, [
    {
      type: "error",
      error: { code: "invalid-input", message: "update takes { names?: string[], checkOnly?: boolean }." },
    },
  ]);
});

/** Activate the real plugin and open one peer channel with the host's context shape. */
async function openPluginChannel(
  operation: string,
  input: JsonValue,
): Promise<{ frames: JsonValue[]; close: () => Promise<void> }> {
  const { default: plugin } = await import("../src/server.ts");
  const frames: JsonValue[] = [];
  const lifetime = new AbortController();
  // The published entry type unions API v3 and v5; this helper exercises the v5 contract.
  const activate = plugin.activate as unknown as (
    context: ServerPluginActivationContextV5,
  ) => Promise<ServerPluginActivationV5>;
  const activation = await activate({
    apiVersion: 5,
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
    // The panel is machine-wide, so it never asks the host for workspace authority.
    scope: { kind: "machine" },
    operation,
    input,
    signal: lifetime.signal,
    send: (frame) => frames.push(frame),
  });
  return {
    frames,
    close: async () => {
      await channel.close?.({ code: 1000, reason: "test", signal: lifetime.signal });
    },
  };
}

test("a remove request removes a managed install and reports the outcome", async () => {
  await withTemporaryHome(async (home) => {
    const paths = resolveSkillPaths({ home });
    await mkdir(join(paths.managedDirectory, "demo"), { recursive: true });
    await writeFile(join(paths.managedDirectory, "demo", "SKILL.md"), "---\nname: demo\n---\n");
    await mkdir(join(home, ".agents"), { recursive: true });
    await writeFile(
      paths.lockfilePath,
      JSON.stringify({
        version: 3,
        skills: {
          demo: {
            source: "owner/repo",
            sourceType: "github",
            sourceUrl: "https://github.com/owner/repo.git",
            skillPath: "skills/demo/SKILL.md",
            skillFolderHash: "0123456789abcdef0123456789abcdef01234567",
            installedAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-02T00:00:00.000Z",
          },
        },
      }),
    );

    const response = await handlePeerRequest(
      { operation: "remove", input: { names: ["demo"] }, signal },
      { home },
    );

    assert.deepEqual(response, {
      ok: true,
      value: {
        results: [{ name: "demo", ok: true, state: "managed", directory: "removed" }],
      },
    });
    await assert.rejects(stat(join(paths.managedDirectory, "demo")), /ENOENT/);
  });
});

test("a malformed remove input returns a structured error instead of throwing", async () => {
  const malformed: JsonValue[] = [null, {}, { names: "demo" }, { names: [] }, { names: [1] }];
  for (const input of malformed) {
    const response = await handlePeerRequest(
      { operation: "remove", input, signal },
      { home: "/tmp/pi-web-skills-home" },
    );

    assert.deepEqual(response, {
      ok: false,
      error: { code: "invalid-input", message: "remove takes { names: string[] }" },
    });
  }
});
