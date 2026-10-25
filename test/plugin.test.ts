import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import type { PluginActivationContextV5 } from "@jmfederico/pi-web/plugin-api";
import plugin from "../src/browser/index.ts";

type PluginEntry = {
  readonly id?: unknown;
  readonly browserRoot?: unknown;
  readonly module?: unknown;
  readonly serverModule?: unknown;
  readonly machineSpecific?: unknown;
};

const activation = {
  apiVersion: 5,
  pluginId: "skills",
  runtimePluginId: "skills",
  html: (() => ({})) as unknown as PluginActivationContextV5["html"],
  svg: (() => ({})) as unknown as PluginActivationContextV5["svg"],
  signal: new AbortController().signal,
  lifetimeSignal: new AbortController().signal,
} satisfies PluginActivationContextV5;

test("the browser entry contributes the Skills workspace panel", async () => {
  const result = await plugin.activate(activation);
  const panels = result.contributions.workspacePanels ?? [];

  assert.equal(plugin.apiVersion, 5);
  assert.equal(panels.length, 1);
  assert.equal(panels[0]?.id, "skills");
  assert.equal(panels[0]?.title, "Skills");
});

test("the browser entry contributes a stylesheet that ships next to the module", async () => {
  const result = await plugin.activate(activation);
  const stylesheets = result.contributions.stylesheets ?? [];
  const stylesheet = stylesheets[0];

  assert.equal(stylesheets.length, 1);
  assert.equal(stylesheet?.id, "panel");
  // The host serves only browserRoot, so the URL must resolve beside the module.
  const css = await readFile(new URL(String(stylesheet?.url)), "utf8");
  assert.match(css, /^\.skills-panel,/mu);
});

test("the browser entry contributes an Open Skills action", async () => {
  const result = await plugin.activate(activation);
  const actions = result.contributions.actions ?? [];

  assert.equal(actions.length, 1);
  assert.equal(actions[0]?.id, "skills.open");
  assert.equal(actions[0]?.title, "Open Skills");
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

test("browser modules only import other modules inside the browser root", async () => {
  const directory = new URL("../src/browser/", import.meta.url);
  const names = (await readdir(directory)).filter((name) => name.endsWith(".ts"));
  const offenders: string[] = [];
  for (const name of names) {
    const contents = await readFile(new URL(name, directory), "utf8");
    for (const match of contents.matchAll(/^import\s+(?!type\s)[^;]*?from\s+"([^"]+)";/gmu)) {
      const specifier = match[1] ?? "";
      if (specifier.startsWith("./") || specifier.startsWith("../browser/")) continue;
      offenders.push(`${name}: ${specifier}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "the host serves only browserRoot, so a runtime import outside it 404s in the browser",
  );
});
