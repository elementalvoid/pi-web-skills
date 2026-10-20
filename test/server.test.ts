import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
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
    { operation: "list", input: null, signal },
    { home: "/tmp/pi-web-skills-home" },
  );

  assert.deepEqual(response, {
    ok: false,
    error: { code: "unknown-operation", message: 'Unsupported operation "list"' },
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
