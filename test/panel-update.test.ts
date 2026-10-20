import assert from "node:assert/strict";
import test from "node:test";
import type {
  HtmlTemplateTag,
  JsonValue,
  PluginPeerChannel,
  PluginPeerChannelOptions,
  WorkspacePanelContext,
} from "@jmfederico/pi-web/plugin-api";
import { createUpdatePanel } from "../src/browser/update-panel.ts";

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

function collect(template: FakeTemplate, out: FakeTemplate[] = []): FakeTemplate[] {
  out.push(template);
  for (const value of template.values) {
    if (isTemplate(value)) collect(value, out);
    else if (Array.isArray(value)) for (const item of value) if (isTemplate(item)) collect(item, out);
  }
  return out;
}

/** The binding of the element whose label is `text` (the label follows the binding). */
function bindingFor(template: FakeTemplate, attribute: string, text: string): unknown {
  for (const node of collect(template)) {
    for (let index = 0; index < node.strings.length - 1; index += 1) {
      if (!node.strings[index]?.trimEnd().endsWith(`${attribute}=`)) continue;
      const after = node.strings[index + 1] ?? "";
      const open = after.indexOf(">");
      const close = after.indexOf("<", open + 1);
      if (open < 0 || close < 0) continue;
      if (after.slice(open + 1, close).trim() === text) return node.values[index];
    }
  }
  return undefined;
}

function fire(template: FakeTemplate, label: string, attribute: string): void {
  const handler = bindingFor(template, attribute, label);
  assert.equal(typeof handler, "function", `${attribute} handler for ${label}`);
  (handler as () => void)();
}

function click(template: FakeTemplate, label: string): void {
  fire(template, label, "@click");
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

type Host = {
  readonly channelOptions: PluginPeerChannelOptions[];
  readonly operations: string[];
  readonly inputs: JsonValue[];
  readonly channelOpen: (options: PluginPeerChannelOptions) => Promise<PluginPeerChannel>;
};

function panelContext(host: Host): WorkspacePanelContext {
  return {
    machine: { id: "machine", name: "Local", kind: "local" },
    workspace: { id: "workspace", path: "/workspace", name: "workspace" },
    files: {},
    peer: {
      openChannel: (operation: string, input: JsonValue, options: PluginPeerChannelOptions) => {
        host.operations.push(operation);
        host.inputs.push(input);
        host.channelOptions.push(options);
        return host.channelOpen(options);
      },
      request: async () => {
        throw new Error("the update panel makes no direct request");
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

test("Update all confirms the local-edit risk before the channel opens", async () => {
  const sent: JsonValue[] = [];
  const closeReasons: string[] = [];
  const host: Host = {
    channelOptions: [],
    operations: [],
    inputs: [],
    channelOpen: async () => fakeChannel(sent, closeReasons),
  };
  const panel = createUpdatePanel(html) as unknown as (
    context: WorkspacePanelContext,
  ) => FakeTemplate;
  const context = panelContext(host);

  const idle = textOf(panel(context));
  assert.match(idle, /Update all/);
  assert.doesNotMatch(idle, /dry run/i, "there is no Check-only or dry-run action");

  click(panel(context), "Update all");
  const confirming = textOf(panel(context));
  assert.match(confirming, /local edit/i);
  assert.match(confirming, /overwritten/i);
  assert.deepEqual(host.operations, [], "nothing starts before the confirmation");

  click(panel(context), "Confirm update");
  await tick();
  assert.deepEqual(host.operations, ["update"]);
  assert.deepEqual(host.inputs, [{}], "the panel updates every managed entry");
});

test("a per-row Update request confirms and sends only that skill", async () => {
  const sent: JsonValue[] = [];
  const closeReasons: string[] = [];
  const host: Host = {
    channelOptions: [],
    operations: [],
    inputs: [],
    channelOpen: async () => fakeChannel(sent, closeReasons),
  };
  const panel = createUpdatePanel(html);
  const context = panelContext(host);

  panel.requestUpdate(context, ["demo"]);
  const confirming = textOf(panel(context));
  assert.match(confirming, /Update demo\?/);
  assert.match(confirming, /local edit/i);
  assert.deepEqual(host.operations, [], "nothing starts before the confirmation");

  click(panel(context), "Confirm update");
  await tick();
  assert.deepEqual(host.operations, ["update"]);
  assert.deepEqual(host.inputs, [{ names: ["demo"] }]);
});

test("frames show per-skill progress and grouped results with the /reload reminder", async () => {
  const sent: JsonValue[] = [];
  const closeReasons: string[] = [];
  const host: Host = {
    channelOptions: [],
    operations: [],
    inputs: [],
    channelOpen: async () => fakeChannel(sent, closeReasons),
  };
  const panel = createUpdatePanel(html) as unknown as (
    context: WorkspacePanelContext,
  ) => FakeTemplate;
  const context = panelContext(host);

  click(panel(context), "Update all");
  click(panel(context), "Confirm update");
  await tick();

  const onData = host.channelOptions[0]?.onData;
  assert.ok(onData !== undefined);

  onData({ type: "progress", name: "alpha", state: "updating" });
  assert.match(textOf(panel(context)), /Updating alpha/);

  onData({ type: "progress", name: "alpha", state: "unchanged" });
  assert.match(textOf(panel(context)), /alpha is unchanged/);

  onData({ type: "progress", name: "beta", state: "skipped", reason: "Local path" });
  onData({ type: "progress", name: "gamma", state: "deleted" });
  onData({ type: "progress", name: "delta", state: "failed", reason: "Cannot copy delta." });
  onData({
    type: "done",
    updated: ["notes"],
    unchanged: ["alpha"],
    skipped: [{ name: "beta", reason: "Local path" }],
    deleted: ["gamma"],
    failed: [{ name: "delta", message: "Cannot copy delta." }],
  });

  const text = textOf(panel(context));
  assert.match(text, /Updated \(1\)/);
  assert.match(text, /notes/);
  assert.match(text, /Unchanged \(1\)/);
  assert.match(text, /Skipped \(1\)/);
  assert.match(text, /beta<\/strong> — Local path/);
  assert.match(text, /Deleted upstream \(1\)/);
  assert.match(text, /install and its lock entry were kept/);
  assert.match(text, /Failed \(1\)/);
  assert.match(text, /delta<\/strong> — Cannot copy delta\./);
  assert.match(text, /\/reload/);
  assert.deepEqual(closeReasons, ["done"], "a terminal frame closes the channel");

  click(panel(context), "Dismiss");
  assert.doesNotMatch(textOf(panel(context)), /\/reload/);
});

test("Cancel sends a cancel frame and keeps the partial results", async () => {
  const sent: JsonValue[] = [];
  const closeReasons: string[] = [];
  const host: Host = {
    channelOptions: [],
    operations: [],
    inputs: [],
    channelOpen: async () => fakeChannel(sent, closeReasons),
  };
  const panel = createUpdatePanel(html) as unknown as (
    context: WorkspacePanelContext,
  ) => FakeTemplate;
  const context = panelContext(host);

  click(panel(context), "Update all");
  click(panel(context), "Confirm update");
  await tick();

  const onData = host.channelOptions[0]?.onData;
  assert.ok(onData !== undefined);
  onData({ type: "progress", name: "alpha", state: "unchanged" });

  click(panel(context), "Cancel");
  assert.deepEqual(sent, [{ type: "cancel" }]);
  assert.deepEqual(closeReasons, ["cancelled"]);
  const text = textOf(panel(context));
  assert.match(text, /cancelled after the current skill/);
  assert.match(text, /Unchanged \(1\)/, "partial results stay visible");
});

test("Cancel keeps a skill that already updated and still reminds /reload", async () => {
  const sent: JsonValue[] = [];
  const closeReasons: string[] = [];
  const host: Host = {
    channelOptions: [],
    operations: [],
    inputs: [],
    channelOpen: async () => fakeChannel(sent, closeReasons),
  };
  const panel = createUpdatePanel(html) as unknown as (
    context: WorkspacePanelContext,
  ) => FakeTemplate;
  const context = panelContext(host);

  click(panel(context), "Update all");
  click(panel(context), "Confirm update");
  await tick();

  const onData = host.channelOptions[0]?.onData;
  assert.ok(onData !== undefined);
  onData({ type: "progress", name: "alpha", state: "checking" });
  onData({ type: "progress", name: "beta", state: "checking" });
  onData({ type: "progress", name: "alpha", state: "updating" });
  onData({ type: "progress", name: "beta", state: "updating" });

  click(panel(context), "Cancel");
  assert.deepEqual(sent, [{ type: "cancel" }]);

  const render = panel(context);
  const text = textOf(render);
  assert.match(text, /cancelled after the current skill/);
  assert.match(text, /Updated \(1\)/, "the completed skill is kept after cancelling");
  const results = collect(render).find((node) => /Updated \(1\)/.test(textOf(node)));
  assert.ok(results !== undefined);
  assert.match(textOf(results), /alpha/);
  assert.doesNotMatch(textOf(results), /beta/, "the interrupted skill is not reported as updated");
  assert.match(text, /\/reload/, "an updated skill still needs a reload reminder");
});
