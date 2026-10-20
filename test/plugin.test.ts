import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { PluginActivationContext } from "@jmfederico/pi-web/plugin-api";
import plugin from "../src/browser/index.ts";

type PluginEntry = {
  readonly id?: unknown;
  readonly browserRoot?: unknown;
  readonly module?: unknown;
  readonly serverModule?: unknown;
  readonly machineSpecific?: unknown;
};

const activation = {
  apiVersion: 4,
  pluginId: "skills",
  runtimePluginId: "skills",
  html: (() => ({})) as unknown as PluginActivationContext["html"],
  svg: (() => ({})) as unknown as PluginActivationContext["svg"],
  signal: new AbortController().signal,
  lifetimeSignal: new AbortController().signal,
} satisfies PluginActivationContext;

test("the browser entry contributes the Skills workspace panel", async () => {
  const result = await plugin.activate(activation);
  const panels = result.contributions.workspacePanels ?? [];

  assert.equal(plugin.apiVersion, 4);
  assert.equal(panels.length, 1);
  assert.equal(panels[0]?.id, "skills");
  assert.equal(panels[0]?.title, "Skills");
});

test("package metadata declares the built dual entry with a narrow browser root", async () => {
  const contents = await readFile(new URL("../package.json", import.meta.url), "utf8");
  const manifest = JSON.parse(contents) as { readonly piWeb?: { readonly plugins?: readonly PluginEntry[] } };
  const entry = manifest.piWeb?.plugins?.find((candidate) => candidate.id === "skills");

  assert.ok(entry);
  assert.equal(entry.browserRoot, "dist/browser");
  assert.equal(entry.module, "dist/browser/index.js");
  assert.equal(entry.serverModule, "dist/server.js");
  assert.equal(entry.machineSpecific, true);
  assert.ok(!String(entry.serverModule).startsWith(`${String(entry.browserRoot)}/`));
});
