import assert from "node:assert/strict";
import test from "node:test";
import type {
  HtmlTemplateTag,
  JsonValue,
  PluginPeerChannel,
  PluginPeerChannelOptions,
  WorkspacePanelContext,
} from "@jmfederico/pi-web/plugin-api";
import { createAddHandoff } from "../src/browser/add-handoff.ts";
import { createAddPanel } from "../src/browser/add-panel.ts";
import { createSearchPanel } from "../src/browser/search-panel.ts";

type FakeTemplate = {
  readonly strings: readonly string[];
  readonly values: readonly unknown[];
};

const html = ((strings: TemplateStringsArray, ...values: unknown[]): FakeTemplate => ({
  strings: [...strings],
  values,
})) as unknown as HtmlTemplateTag;

function isTemplate(value: unknown): value is FakeTemplate {
  return typeof value === "object" && value !== null && "strings" in value && "values" in value;
}

function renderValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(renderValue).join("");
  if (isTemplate(value)) return textOf(value);
  return value === null || value === undefined ? "" : String(value);
}

function textOf(template: FakeTemplate): string {
  return template.strings.reduce(
    (out, chunk, index) => out + chunk + renderValue(template.values[index]),
    "",
  );
}

/** Every template in the tree, outermost first. */
function collect(template: FakeTemplate, out: FakeTemplate[] = []): FakeTemplate[] {
  out.push(template);
  for (const value of template.values) {
    if (isTemplate(value)) collect(value, out);
    else if (Array.isArray(value)) for (const item of value) if (isTemplate(item)) collect(item, out);
  }
  return out;
}

/** The binding immediately before the text `text`, e.g. the `?disabled` of one button. */
function bindingBefore(template: FakeTemplate, attribute: string, text?: string): unknown {
  for (const node of collect(template)) {
    if (text !== undefined && !textOf(node).includes(text)) continue;
    const target =
      text === undefined
        ? node.strings.length - 1
        : node.strings.findIndex((chunk) => chunk.includes(text));
    for (let index = target; index >= 0; index -= 1) {
      if (node.strings[index]?.trimEnd().endsWith(`${attribute}=`)) return node.values[index];
    }
  }
  return undefined;
}

function hasAlert(template: FakeTemplate): boolean {
  return collect(template).some((node) => node.strings.some((chunk) => chunk.includes('role="alert"')));
}

type Host = {
  readonly requests: { readonly operation: string; readonly input: JsonValue }[];
  readonly opens: { readonly operation: string; readonly input: JsonValue }[];
  readonly channelOptions: PluginPeerChannelOptions[];
  channelOpen: (options: PluginPeerChannelOptions) => Promise<PluginPeerChannel>;
  readonly host: { requestRender: () => void };
  response: JsonValue;
};

function fakeHost(response: JsonValue): Host {
  return {
    requests: [],
    opens: [],
    channelOptions: [],
    response,
    channelOpen: async () => fakeChannel([], []),
    host: { requestRender: () => undefined },
  };
}

function panelContext(host: Host): WorkspacePanelContext {
  return {
    machine: { id: "machine", name: "Local", kind: "local" },
    workspace: { id: "workspace", path: "/workspace", name: "workspace" },
    files: {},
    peer: {
      openChannel: (operation: string, input: JsonValue, options: PluginPeerChannelOptions) => {
        host.opens.push({ operation, input });
        host.channelOptions.push(options);
        return host.channelOpen(options);
      },
      request: async (operation: string, input: JsonValue) => {
        host.requests.push({ operation, input });
        return host.response;
      },
    },
    host: host.host,
  } as unknown as WorkspacePanelContext;
}

function fakeChannel(sent: JsonValue[], closeReasons: string[]): PluginPeerChannel {
  return {
    closed: new Promise(() => undefined),
    send: (data) => sent.push(data),
    close: (reason) => closeReasons.push(reason ?? ""),
  };
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

type Panel = (context: WorkspacePanelContext) => FakeTemplate;

function setInput(panel: Panel, context: WorkspacePanelContext, value: string): FakeTemplate {
  const template = panel(context);
  const handler = bindingBefore(template, "@input");
  assert.equal(typeof handler, "function");
  (handler as (event: unknown) => void)({ target: { value } });
  return panel(context);
}

function submit(template: FakeTemplate): void {
  const handler = bindingBefore(template, "@submit");
  assert.equal(typeof handler, "function");
  (handler as (event: unknown) => void)({ preventDefault() {} });
}

function click(template: FakeTemplate, label: string): void {
  const handler = bindingBefore(template, "@click", label);
  assert.equal(typeof handler, "function", `@click handler for ${label}`);
  (handler as () => void)();
}

/** The innermost node whose rendered text contains `text`, searched depth-first. */
function nodeWithText(template: FakeTemplate, text: string): FakeTemplate | undefined {
  return [...collect(template)].reverse().find((node) => textOf(node).includes(text));
}

/** The binding of the innermost node whose rendered text contains `text`. */
function bindingIn(template: FakeTemplate, text: string, attribute: string): unknown {
  const node = nodeWithText(template, text);
  if (node === undefined) return undefined;
  const index = node.strings.findIndex((chunk) => chunk.trimEnd().endsWith(`${attribute}=`));
  return index < 0 ? undefined : node.values[index];
}

/** Click the one button inside the node whose rendered text contains `text`. */
function clickIn(template: FakeTemplate, text: string): void {
  for (const node of [...collect(template)].reverse()) {
    if (!textOf(node).includes(text)) continue;
    const index = node.strings.findIndex((chunk) => chunk.trimEnd().endsWith("@click="));
    if (index < 0) continue;
    (node.values[index] as () => void)();
    return;
  }
  assert.fail(`no @click handler in the node containing ${text}`);
}

const searchResults: JsonValue = {
  ok: true,
  value: {
    results: [
      { id: "owner/repo/notes", name: "notes", source: "owner/repo", installs: 1234 },
      { id: "acme/tools/alpha", name: "alpha", source: "acme/tools", installs: 12 },
    ],
  },
};

test("a search prompts for a keyword, shows progress, then rows with source and installs", async () => {
  const host = fakeHost(searchResults);
  const panel = createSearchPanel(html, createAddHandoff()) as unknown as Panel;
  const context = panelContext(host);

  assert.match(textOf(panel(context)), /keyword/i);
  assert.deepEqual(host.requests, [], "no request before a keyword");

  submit(panel(context));
  assert.deepEqual(host.requests, [], "an empty keyword sends no request");

  submit(setInput(panel, context, "react"));
  assert.match(textOf(panel(context)), /Searching skills\.sh/);
  assert.deepEqual(host.requests, [{ operation: "search", input: { query: "react" } }]);

  await tick();
  const ready = panel(context);
  const text = textOf(ready);
  assert.match(text, /notes/);
  assert.match(text, /owner\/repo/);
  assert.match(text, /1234 installs/);
  assert.match(text, /alpha/);
  assert.equal(hasAlert(ready), false);
});

test("a failed search is an error banner but a cancelled one is not", async () => {
  const host = fakeHost({
    ok: false,
    error: { code: "search-unavailable", message: "skills.sh answered 503. Retry in a moment." },
  });
  const panel = createSearchPanel(html, createAddHandoff()) as unknown as Panel;
  const context = panelContext(host);

  submit(setInput(panel, context, "react"));
  await tick();
  const failed = panel(context);
  assert.equal(hasAlert(failed), true);
  assert.match(textOf(failed), /503/);

  host.response = { ok: false, error: { code: "cancelled", message: "The search was cancelled." } };
  submit(panel(context));
  await tick();
  const cancelled = panel(context);
  assert.equal(hasAlert(cancelled), false, "an aborted search is not an error banner");
  assert.match(textOf(cancelled), /cancelled/i);

  host.response = { ok: true, value: { results: [{ name: 1 }] } };
  submit(panel(context));
  await tick();
  assert.equal(hasAlert(panel(context)), true, "a malformed response is reported, not rendered");
});

test("Add from a result prefills the Add source and preselects the matching skill", async () => {
  const sent: JsonValue[] = [];
  const host = fakeHost(searchResults);
  host.channelOpen = async () => fakeChannel(sent, []);
  const handoff = createAddHandoff();
  const addPanel = createAddPanel(html, handoff) as unknown as Panel;
  const searchPanel = createSearchPanel(html, handoff) as unknown as Panel;
  const context = panelContext(host);

  submit(setInput(searchPanel, context, "react"));
  await tick();
  clickIn(searchPanel(context), "Add notes");

  assert.deepEqual(host.opens, [], "the handoff starts nothing until the Add panel renders");
  const prefilled = addPanel(context);
  assert.equal(bindingBefore(prefilled, ".value"), "owner/repo", "the source is prefilled");
  await tick();
  assert.deepEqual(host.opens, [{ operation: "add", input: { source: "owner/repo" } }]);

  const onData = host.channelOptions[0]?.onData;
  assert.ok(onData !== undefined);
  onData({
    type: "candidates",
    candidates: [
      { name: "notes", description: "Notes", sourcePath: "skills/notes/SKILL.md", folderName: "notes", existing: "none" },
      { name: "alpha", description: "Alpha", sourcePath: "skills/alpha/SKILL.md", folderName: "alpha", existing: "none" },
    ],
  });
  onData({ type: "candidates-end", total: 2 });

  const preselected = addPanel(context);
  assert.equal(bindingIn(preselected, "notes", "?checked"), true, "the matching skill is selected");
  assert.equal(bindingIn(preselected, "alpha", "?checked"), false, "other skills are not selected");

  click(preselected, "Install selected");
  assert.deepEqual(sent, [{ type: "install", sourcePaths: ["skills/notes/SKILL.md"] }]);
});

test("Add from a result with no matching skill shows every candidate unselected", async () => {
  const sent: JsonValue[] = [];
  const host = fakeHost(searchResults);
  host.channelOpen = async () => fakeChannel(sent, []);
  const handoff = createAddHandoff();
  const addPanel = createAddPanel(html, handoff) as unknown as Panel;
  const searchPanel = createSearchPanel(html, handoff) as unknown as Panel;
  const context = panelContext(host);

  submit(setInput(searchPanel, context, "react"));
  await tick();
  clickIn(searchPanel(context), "Add alpha");
  addPanel(context);
  await tick();

  const onData = host.channelOptions[0]?.onData;
  assert.ok(onData !== undefined);
  onData({
    type: "candidates",
    candidates: [
      { name: "notes", description: "Notes", sourcePath: "skills/notes/SKILL.md", folderName: "notes", existing: "none" },
      { name: "beta", description: "Beta", sourcePath: "skills/beta/SKILL.md", folderName: "beta", existing: "none" },
    ],
  });
  onData({ type: "candidates-end", total: 2 });

  const candidates = addPanel(context);
  assert.match(textOf(candidates), /notes/);
  assert.match(textOf(candidates), /beta/);
  assert.equal(bindingIn(candidates, "notes", "?checked"), false);
  assert.equal(bindingIn(candidates, "beta", "?checked"), false);
  assert.equal(bindingBefore(candidates, "?disabled", "Install selected"), true);
  assert.deepEqual(sent, [], "search and the handoff never write");
});

test("a handoff waits while the Add panel is resolving and then starts its own resolve", async () => {
  const host = fakeHost(searchResults);
  const handoff = createAddHandoff();
  const addPanel = createAddPanel(html, handoff) as unknown as Panel;
  const context = panelContext(host);

  submit(setInput(addPanel, context, "owner/repo"));
  await tick();
  assert.deepEqual(host.opens, [{ operation: "add", input: { source: "owner/repo" } }]);

  handoff.pending = { source: "acme/tools", skillName: "alpha" };
  const stillResolving = addPanel(context);
  assert.equal(bindingBefore(stillResolving, ".value"), "owner/repo", "the running resolve is kept");
  assert.equal(host.opens.length, 1, "the handoff does not cancel the running resolve");
  assert.equal(bindingIn(stillResolving, "Resolving the source", ".value"), undefined);

  const onData = host.channelOptions[0]?.onData;
  assert.ok(onData !== undefined);
  onData({ type: "candidates", candidates: [] });
  onData({ type: "candidates-end", total: 0 });
  addPanel(context);
  await tick();

  assert.deepEqual(host.opens[1], { operation: "add", input: { source: "acme/tools" } });
  assert.equal(bindingBefore(addPanel(context), ".value"), "acme/tools");
});
