import assert from "node:assert/strict";
import test from "node:test";
import type {
  HtmlTemplateTag,
  JsonValue,
  PluginPeerChannel,
  PluginPeerChannelOptions,
  WorkspacePanelContext,
} from "@jmfederico/pi-web/plugin-api";
import { createAddPanel } from "../src/browser/add-panel.ts";
import { renderSkillList } from "../src/browser/list.ts";

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

type Host = {
  readonly channelOptions: PluginPeerChannelOptions[];
  readonly channelOpen: (options: PluginPeerChannelOptions) => Promise<PluginPeerChannel>;
  readonly requests: string[];
};

const listResponse: JsonValue = {
  ok: true,
  value: {
    rows: [],
    counts: { managed: 0, unmanaged: 0, broken: 0 },
    lockWarning: null,
  },
};

function panelContext(host: Host, machineId = "machine"): WorkspacePanelContext {
  return {
    machine: { id: machineId, name: "Local", kind: "local" },
    workspace: { id: "workspace", path: "/workspace", name: "workspace" },
    files: {},
    peer: {
      openChannel: (_operation: string, _input: JsonValue, options: PluginPeerChannelOptions) => {
        host.channelOptions.push(options);
        return host.channelOpen(options);
      },
      request: async (operation: string) => {
        host.requests.push(operation);
        return listResponse;
      },
    },
    host: { requestRender: () => undefined },
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

function setSource(panel: (context: WorkspacePanelContext) => FakeTemplate, context: WorkspacePanelContext, source: string): FakeTemplate {
  const template = panel(context);
  const input = bindingBefore(template, "@input");
  assert.equal(typeof input, "function");
  (input as (event: unknown) => void)({ target: { value: source } });
  return panel(context);
}

function submit(template: FakeTemplate): void {
  const handler = bindingBefore(template, "@submit");
  assert.equal(typeof handler, "function");
  (handler as (event: unknown) => void)({ preventDefault() {} });
}

function fire(template: FakeTemplate, label: string, attribute: string): void {
  const handler = bindingBefore(template, attribute, label);
  assert.equal(typeof handler, "function", `${attribute} handler for ${label}`);
  (handler as () => void)();
}

function click(template: FakeTemplate, label: string): void {
  fire(template, label, "@click");
}

const candidate = {
  name: "notes",
  description: "Notes skill",
  sourcePath: "skills/notes/SKILL.md",
  folderName: "notes",
  existing: "unmanaged",
};

test("cancel aborts a channel open that has not resolved, then closes the late channel", async () => {
  const sent: JsonValue[] = [];
  const closeReasons: string[] = [];
  const channel = fakeChannel(sent, closeReasons);
  let resolveOpen: (channel: PluginPeerChannel) => void = () => undefined;
  const host: Host = {
    channelOptions: [],
    requests: [],
    channelOpen: () =>
      new Promise<PluginPeerChannel>((resolve) => {
        resolveOpen = resolve;
      }),
  };
  const panel = createAddPanel(html) as unknown as (
    context: WorkspacePanelContext,
  ) => FakeTemplate;
  const context = panelContext(host);

  submit(setSource(panel, context, "owner/repo"));
  await tick();

  assert.equal(host.channelOptions.length, 1, "the open was requested");
  const signal = host.channelOptions[0]?.signal;
  assert.ok(signal !== undefined, "the panel passes a cancellation signal to openChannel");
  assert.equal(signal.aborted, false);

  click(panel(context), "Cancel");
  assert.equal(signal.aborted, true, "cancel aborts the pending open");

  resolveOpen(channel);
  await tick();
  await tick();

  assert.deepEqual(closeReasons, ["cancelled"], "the late channel is closed, not adopted");
  assert.match(textOf(panel(context)), /cancelled/i);
  assert.deepEqual(sent, []);
});

test("an existing target asks for overwrite confirmation before any install frame", async () => {
  const sent: JsonValue[] = [];
  const closeReasons: string[] = [];
  const channel = fakeChannel(sent, closeReasons);
  const host: Host = {
    channelOptions: [],
    requests: [],
    channelOpen: async () => channel,
  };
  const panel = createAddPanel(html) as unknown as (
    context: WorkspacePanelContext,
  ) => FakeTemplate;
  const context = panelContext(host);

  submit(setSource(panel, context, "owner/repo"));
  await tick();

  const onData = host.channelOptions[0]?.onData;
  assert.ok(onData !== undefined);
  onData({
    type: "candidates",
    candidates: [candidate, { ...candidate, name: "alpha", sourcePath: "skills/alpha/SKILL.md", existing: "none" }],
  });
  onData({ type: "candidates-end", total: 2 });

  fire(panel(context), "Select all", "@change");
  click(panel(context), "Install selected");

  assert.deepEqual(sent, [], "no install frame before the confirmation");
  const confirming = panel(context);
  assert.match(textOf(confirming), /overwrite/i, "the panel states that it will overwrite");
  assert.equal(bindingBefore(confirming, "?disabled", "Overwrite and install"), undefined);

  click(confirming, "Overwrite and install");
  assert.deepEqual(sent, [{ type: "install", names: ["notes", "alpha"] }]);
});

test("a new install shows progress, a result, a refreshed list, and a dismissible reload reminder", async () => {
  const sent: JsonValue[] = [];
  const channel = fakeChannel(sent, []);
  const host: Host = {
    channelOptions: [],
    requests: [],
    channelOpen: async () => channel,
  };
  const panel = createAddPanel(html) as unknown as (
    context: WorkspacePanelContext,
  ) => FakeTemplate;
  const context = panelContext(host, "install-machine");

  submit(setSource(panel, context, "owner/repo"));
  await tick();

  const onData = host.channelOptions[0]?.onData;
  assert.ok(onData !== undefined);
  onData({ type: "candidates", candidates: [{ ...candidate, existing: "none" }] });
  onData({ type: "candidates-end", total: 1 });

  fire(panel(context), "Select all", "@change");
  click(panel(context), "Install selected");
  assert.deepEqual(sent, [{ type: "install", names: ["notes"] }], "no confirmation for a new target");

  onData({ type: "progress", phase: "installing", name: "notes", index: 0, total: 1 });
  assert.match(textOf(panel(context)), /Installing 1 of 1: notes/);

  onData({ type: "done", installed: ["notes"], replaced: [], failed: [] });
  const result = textOf(panel(context));
  assert.match(result, /Installed: notes/);
  assert.match(result, /\/reload/);

  assert.deepEqual(host.requests, [], "no list request until the list renders again");
  renderSkillList(html, context);
  await tick();
  assert.deepEqual(host.requests, ["list"], "the cached list was dropped after the install");

  click(panel(context), "Dismiss");
  assert.doesNotMatch(textOf(panel(context)), /\/reload/);
});

test("the done frame reports replaced and failed names and shows no reminder for failures only", async () => {
  const sent: JsonValue[] = [];
  const channel = fakeChannel(sent, []);
  const host: Host = {
    channelOptions: [],
    requests: [],
    channelOpen: async () => channel,
  };
  const panel = createAddPanel(html) as unknown as (
    context: WorkspacePanelContext,
  ) => FakeTemplate;
  const context = panelContext(host, "result-machine");

  submit(setSource(panel, context, "owner/repo"));
  await tick();

  const onData = host.channelOptions[0]?.onData;
  assert.ok(onData !== undefined);
  onData({ type: "candidates", candidates: [candidate] });
  onData({ type: "candidates-end", total: 1 });
  fire(panel(context), "Select all", "@change");
  click(panel(context), "Install selected");
  click(panel(context), "Overwrite and install");

  onData({
    type: "done",
    installed: [],
    replaced: ["notes"],
    failed: [{ name: "alpha", message: "Cannot copy alpha." }],
  });
  const replacedText = textOf(panel(context));
  assert.match(replacedText, /Replaced: notes/);
  assert.match(replacedText, /Failed: alpha \(Cannot copy alpha\.\)/);
  assert.match(replacedText, /\/reload/);

  onData({ type: "done", installed: [], replaced: [], failed: [{ name: "alpha", message: "Cannot copy alpha." }] });
  const failedText = textOf(panel(context));
  assert.doesNotMatch(failedText, /\/reload/);
});
