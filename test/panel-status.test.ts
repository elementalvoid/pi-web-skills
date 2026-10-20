import assert from "node:assert/strict";
import test from "node:test";
import type {
  HtmlTemplateTag,
  JsonValue,
  WorkspacePanelContext,
} from "@jmfederico/pi-web/plugin-api";
import plugin from "../src/browser/index.ts";
import { refreshSkillList } from "../src/browser/list.ts";
import { refreshMachineStatus, renderMachineStatus } from "../src/browser/status.ts";

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

function click(template: FakeTemplate, label: string): void {
  for (const node of collect(template)) {
    for (let index = 0; index < node.strings.length - 1; index += 1) {
      if (!node.strings[index]?.trimEnd().endsWith("@click=")) continue;
      const handler = node.values[index];
      const following = node.strings[index + 1] ?? "";
      if (typeof handler === "function" && following.includes(label)) {
        (handler as () => void)();
        return;
      }
    }
  }
  assert.fail(`no click handler for ${label}`);
}

async function settle(): Promise<void> {
  for (let tick = 0; tick < 5; tick += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

const status = {
  ok: true,
  value: {
    managedDirectory: "/tmp/home/.agents/skills",
    lockfilePath: "/tmp/home/.agents/.skill-lock.json",
    managedDirectoryExists: true,
    lockfileExists: false,
    lockReadable: true,
  },
};

const emptyList = {
  ok: true,
  value: { rows: [], counts: { managed: 0, unmanaged: 0, broken: 0 }, lockWarning: null },
};

function panelContext(
  machineId: string,
  request: (operation: string) => Promise<JsonValue>,
  renders: () => void = () => undefined,
): WorkspacePanelContext {
  return {
    machine: { id: machineId, name: "Local", kind: "local" },
    workspace: { id: "workspace", path: "/workspace", name: "workspace" },
    files: {},
    peer: { request: (operation: string) => request(operation) },
    host: { requestRender: renders },
  } as unknown as WorkspacePanelContext;
}

function drawStatus(context: WorkspacePanelContext): string {
  return textOf(renderMachineStatus(html, context) as FakeTemplate);
}

function drawPanel(context: WorkspacePanelContext): string {
  const activation = plugin.activate({
    apiVersion: 4,
    pluginId: "skills",
    runtimePluginId: "skills",
    html,
    svg: (() => undefined) as unknown as HtmlTemplateTag,
    signal: new AbortController().signal,
    lifetimeSignal: new AbortController().signal,
  }) as { contributions: { workspacePanels: { render: (context: WorkspacePanelContext) => FakeTemplate }[] } };
  return textOf(activation.contributions.workspacePanels[0]!.render(context));
}

test("machine status shows loading, then the resolved managed directory and lockfile", async () => {
  const context = panelContext("status-ready-machine", async () => status);
  drawStatus(context);
  assert.match(drawStatus(context), /Loading machine status/);
  await settle();

  const text = drawStatus(context);

  assert.match(text, /\/tmp\/home\/\.agents\/skills/);
  assert.match(text, /\/tmp\/home\/\.agents\/\.skill-lock\.json/);
  assert.match(text, /missing/);
});

test("a status error offers Retry and a retry reads the machine again", async () => {
  let calls = 0;
  const context = panelContext("status-retry-machine", async () => {
    calls += 1;
    if (calls === 1) throw new Error("peer offline");
    return status;
  });
  drawStatus(context);
  await settle();
  assert.match(drawStatus(context), /Machine status unavailable: peer offline/);

  click(renderMachineStatus(html, context) as FakeTemplate, "Retry");
  drawStatus(context);
  await settle();

  const text = drawStatus(context);
  assert.equal(calls, 2);
  assert.match(text, /\/tmp\/home\/\.agents\/skills/);
});

test("a list refresh also re-reads the machine status, so paths never stay stale", async () => {
  const requests: string[] = [];
  const context = panelContext("status-refresh-machine", async (operation) => {
    requests.push(operation);
    return operation === "status" ? status : emptyList;
  });
  drawPanel(context);
  await settle();
  assert.match(drawPanel(context), /\/tmp\/home\/\.agents\/skills/);

  refreshSkillList(context);
  drawPanel(context);
  await settle();

  assert.deepEqual(requests, ["status", "list", "status", "list"]);
});

test("the panel states its machine-wide scope before any status or list row", async () => {
  const context = panelContext("scope-machine", async (operation) =>
    operation === "status" ? status : emptyList,
  );
  drawPanel(context);
  await settle();
  const text = drawPanel(context);

  assert.match(text, /Machine-wide/);
  assert.match(text, /every workspace on this machine/);
  assert.ok(
    text.indexOf("Machine-wide") < text.indexOf("Managed directory"),
    "the scope notice comes before the resolved paths",
  );
});

test("a refresh during the first status load starts a new request instead of stranding loading", async () => {
  let calls = 0;
  let finishFirst: (value: JsonValue) => void = () => undefined;
  const context = panelContext("status-race-machine", () => {
    calls += 1;
    if (calls === 1) {
      return new Promise<JsonValue>((resolve) => {
        finishFirst = resolve;
      });
    }
    return Promise.resolve(status);
  });
  drawStatus(context);
  assert.equal(calls, 1);

  refreshMachineStatus(context);
  drawStatus(context);
  assert.equal(calls, 2, "the refresh starts a new status request");

  finishFirst({ ok: false, error: { message: "stale" } });
  await settle();

  assert.match(drawStatus(context), /\/tmp\/home\/\.agents\/skills/);
});
