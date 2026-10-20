import assert from "node:assert/strict";
import test from "node:test";
import type {
  HtmlTemplateTag,
  JsonValue,
  WorkspacePanelContext,
} from "@jmfederico/pi-web/plugin-api";
import { refreshSkillList, renderSkillList } from "../src/browser/list.ts";

type FakeTemplate = {
  readonly strings: readonly string[];
  readonly values: readonly unknown[];
};

const html = ((strings: TemplateStringsArray, ...values: unknown[]): FakeTemplate => ({
  strings: [...strings],
  values,
})) as unknown as HtmlTemplateTag;

function textOf(template: FakeTemplate): string {
  return template.strings.reduce(
    (out, chunk, index) => out + chunk + renderValue(template.values[index]),
    "",
  );
}

function renderValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(renderValue).join("");
  if (isFakeTemplate(value)) return textOf(value);
  return value === null || value === undefined ? "" : String(value);
}

function isFakeTemplate(value: unknown): value is FakeTemplate {
  return typeof value === "object" && value !== null && "strings" in value && "values" in value;
}

function panelContext(
  machineId: string,
  request: (operation: string, input: JsonValue) => Promise<JsonValue>,
  onRender: () => void,
): WorkspacePanelContext {
  return {
    machine: { id: machineId, name: "Local", kind: "local" },
    workspace: { id: "workspace", path: "/workspace", name: "workspace" },
    files: {},
    peer: { request },
    host: { requestRender: onRender },
  } as unknown as WorkspacePanelContext;
}

function render(context: WorkspacePanelContext): FakeTemplate {
  return renderSkillList(html, context) as FakeTemplate;
}

function draw(context: WorkspacePanelContext): string {
  return textOf(render(context));
}

async function settle(): Promise<void> {
  for (let tick = 0; tick < 5; tick += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

const payload = {
  rows: [
    {
      name: "demo",
      folderName: "demo",
      description: "A managed skill",
      state: "managed",
      invalidReason: null,
      source: "owner/repo",
      sourceType: "github",
      ref: "main",
      skillPath: "skills/demo/SKILL.md",
      installedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
      pluginName: "group",
    },
    {
      name: "notes",
      folderName: "notes",
      description: "",
      state: "unmanaged",
      invalidReason: null,
      source: null,
      sourceType: null,
      ref: null,
      skillPath: null,
      installedAt: null,
      updatedAt: null,
      pluginName: null,
    },
    {
      name: "half-written",
      folderName: "half-written",
      description: "",
      state: "unmanaged",
      invalidReason: "description is missing",
      source: null,
      sourceType: null,
      ref: null,
      skillPath: null,
      installedAt: null,
      updatedAt: null,
      pluginName: null,
    },
    {
      name: "gone",
      folderName: null,
      description: "",
      state: "broken",
      invalidReason: null,
      source: "owner/old",
      sourceType: "github",
      ref: "main",
      skillPath: "skills/gone/SKILL.md",
      installedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
      pluginName: null,
    },
  ],
  counts: { managed: 1, unmanaged: 2, broken: 1 },
  lockWarning: null,
};

test("the list panel shows a loading state before the server answers", () => {
  const context = panelContext("loading-machine", () => new Promise(() => undefined), () => undefined);

  assert.match(draw(context), /Loading skills/);
});

test("the list panel renders managed, unmanaged, broken, and invalid rows", async () => {
  let renders = 0;
  const context = panelContext(
    "ready-machine",
    async () => ({ ok: true, value: payload }),
    () => {
      renders += 1;
    },
  );
  draw(context);
  await settle();

  const text = draw(context);

  assert.equal(renders, 1);
  assert.match(text, /1 managed/);
  assert.match(text, /2 unmanaged/);
  assert.match(text, /1 broken/);
  assert.match(text, /demo/);
  assert.match(text, /A managed skill/);
  assert.match(text, /owner\/repo/);
  assert.match(text, /Plugin/);
  assert.match(text, /group/);
  assert.match(text, /notes/);
  assert.match(text, /half-written/);
  assert.match(text, /Invalid frontmatter: description is missing/);
  assert.match(text, /gone/);
  assert.match(text, /Install directory is missing/);
  assert.match(text, /Remove entry/);
  assert.match(text, /Not tracked by the lockfile/);
});

/** Every template in the tree, outermost first. */
function collect(template: FakeTemplate, out: FakeTemplate[] = []): FakeTemplate[] {
  out.push(template);
  for (const value of template.values) {
    if (isFakeTemplate(value)) collect(value, out);
    else if (Array.isArray(value)) {
      for (const item of value) if (isFakeTemplate(item)) collect(item, out);
    }
  }
  return out;
}

/** The handler bound to the attribute whose literal label is `label`, e.g. one button's `@click`. */
function handlerFor(template: FakeTemplate, attribute: string, label: string): () => void {
  for (const node of collect(template)) {
    for (let index = 0; index < node.strings.length; index += 1) {
      if (!node.strings[index]?.trimEnd().endsWith(`${attribute}=`)) continue;
      const handler = node.values[index];
      const following = node.strings[index + 1] ?? "";
      if (typeof handler === "function" && following.includes(label)) {
        return handler as () => void;
      }
    }
  }
  assert.fail(`no ${attribute} handler for ${label}`);
}

function click(template: FakeTemplate, label: string): void {
  handlerFor(template, "@click", label)();
}

type Call = { readonly operation: string; readonly input: JsonValue };

function fakeServer(list: () => JsonValue, remove: (input: JsonValue) => JsonValue): {
  readonly calls: Call[];
  readonly request: (operation: string, input: JsonValue) => Promise<JsonValue>;
} {
  const calls: Call[] = [];
  return {
    calls,
    request: async (operation, input) => {
      calls.push({ operation, input });
      if (operation === "list") return list();
      if (operation === "remove") return remove(input);
      throw new Error(`unexpected operation ${operation}`);
    },
  };
}

const noRows = { rows: [], counts: { managed: 0, unmanaged: 0, broken: 0 }, lockWarning: null };

test("an unmanaged row has no action and explains that the lockfile does not track it", async () => {
  const context = panelContext(
    "unmanaged-action-machine",
    async () => ({
      ok: true,
      value: {
        rows: [payload.rows[1]!],
        counts: { managed: 0, unmanaged: 1, broken: 0 },
        lockWarning: null,
      },
    }),
    () => undefined,
  );
  draw(context);
  await settle();

  const text = draw(context);

  assert.doesNotMatch(text, /<button/);
  assert.match(text, /Not tracked by the lockfile/);
  assert.match(text, /never updates or removes/);
});

test("a managed row offers per-skill Update and expandable details", async () => {
  const context = panelContext(
    "row-details-machine",
    async () => ({ ok: true, value: payload }),
    () => undefined,
  );
  draw(context);
  await settle();

  const updated: string[] = [];
  const template = renderSkillList(html, context, (name) => {
    updated.push(name);
  }) as FakeTemplate;
  const text = textOf(template);

  assert.match(text, /<details/);
  assert.match(text, /Details &amp; actions/);
  assert.match(text, /skills-description/);
  click(template, "Update");
  assert.deepEqual(updated, ["demo"]);
});

test("Remove asks for an inline confirmation before any removal request", async () => {
  const server = fakeServer(
    () => ({ ok: true, value: payload }),
    () => ({ ok: true, value: { results: [] } }),
  );
  const context = panelContext("confirm-machine", server.request, () => undefined);
  draw(context);
  await settle();

  click(render(context), "Remove");

  const confirming = render(context);
  assert.match(textOf(confirming), /Remove demo\?/);
  assert.match(textOf(confirming), /deletes its directory and lock entry/);
  assert.match(textOf(confirming), /Yes, remove/);
  assert.equal(server.calls.filter((call) => call.operation === "remove").length, 0);

  click(confirming, "Cancel");

  assert.doesNotMatch(draw(context), /Yes, remove/);
  assert.equal(server.calls.filter((call) => call.operation === "remove").length, 0);
});

test("confirming a removal sends the row name, refreshes the list, and shows the /reload reminder", async () => {
  let listCalls = 0;
  const server = fakeServer(
    () => {
      listCalls += 1;
      return listCalls === 1
        ? { ok: true, value: payload }
        : {
            ok: true,
            value: {
              rows: payload.rows.filter((row) => row.state !== "managed"),
              counts: { managed: 0, unmanaged: 2, broken: 1 },
              lockWarning: null,
            },
          };
    },
    () => ({
      ok: true,
      value: { results: [{ name: "demo", ok: true, state: "managed", directory: "removed" }] },
    }),
  );
  const context = panelContext("remove-machine", server.request, () => undefined);
  draw(context);
  await settle();

  click(render(context), "Remove");
  click(render(context), "Yes, remove");
  await settle();

  const text = draw(context);

  assert.deepEqual(
    server.calls.filter((call) => call.operation === "remove").map((call) => call.input),
    [{ names: ["demo"] }],
  );
  assert.equal(listCalls, 2);
  assert.match(text, /\/reload/);
  assert.match(text, /0 managed/);
  assert.match(text, /2 unmanaged/);
  assert.match(text, /1 broken/);
  assert.doesNotMatch(text, /<strong>demo<\/strong>/);
});

test("removing a broken entry sends its lock key and deletes only that entry", async () => {
  const brokenOnly = {
    rows: [payload.rows[3]!],
    counts: { managed: 0, unmanaged: 0, broken: 1 },
    lockWarning: null,
  };
  const server = fakeServer(
    () => ({ ok: true, value: brokenOnly }),
    () => ({
      ok: true,
      value: { results: [{ name: "gone", ok: true, state: "broken", directory: "absent" }] },
    }),
  );
  const context = panelContext("broken-action-machine", server.request, () => undefined);
  draw(context);
  await settle();

  click(render(context), "Remove entry");
  const confirming = render(context);
  assert.match(textOf(confirming), /stale lock entry/);
  assert.match(textOf(confirming), /already missing/);
  click(confirming, "Yes, remove entry");
  await settle();

  assert.deepEqual(
    server.calls.filter((call) => call.operation === "remove").map((call) => call.input),
    [{ names: ["gone"] }],
  );
  const text = draw(context);
  assert.match(text, /Removed the stale lock entry for gone/);
  assert.doesNotMatch(text, /\/reload/, "no directory changed, so no reload is needed");
});

test("a refused removal shows the server's reason and does not refresh", async () => {
  let listCalls = 0;
  const server = fakeServer(
    () => {
      listCalls += 1;
      return { ok: true, value: payload };
    },
    () => ({
      ok: true,
      value: {
        results: [
          { name: "demo", ok: false, error: { code: "unsafe-path", message: "demo is a symlink" } },
        ],
      },
    }),
  );
  const context = panelContext("refused-machine", server.request, () => undefined);
  draw(context);
  await settle();

  click(render(context), "Remove");
  click(render(context), "Yes, remove");
  await settle();

  const text = draw(context);

  assert.match(text, /demo is a symlink/);
  assert.match(text, /role="alert"|Note/);
  assert.equal(listCalls, 1);
});

test("a rejected removal request shows the structured error and does not refresh", async () => {
  let listCalls = 0;
  const server = fakeServer(
    () => {
      listCalls += 1;
      return { ok: true, value: payload };
    },
    () => ({
      ok: false,
      error: { code: "lock-unreadable", message: "Cannot read lock: not valid JSON" },
    }),
  );
  const context = panelContext("rejected-machine", server.request, () => undefined);
  draw(context);
  await settle();

  click(render(context), "Remove");
  click(render(context), "Yes, remove");
  await settle();

  assert.match(draw(context), /Cannot read lock: not valid JSON/);
  assert.equal(listCalls, 1);
});


test("the list panel renders a managed row's source, ref, and updated time", async () => {
  const context = panelContext(
    "managed-metadata-machine",
    async () => ({
      ok: true,
      value: {
        rows: [payload.rows[0]!],
        counts: { managed: 1, unmanaged: 0, broken: 0 },
        lockWarning: null,
      },
    }),
    () => undefined,
  );
  draw(context);
  await settle();

  const text = draw(context);

  assert.match(text, /owner\/repo/);
  assert.match(text, /github/);
  assert.match(text, /main/);
  assert.match(text, /2026-01-02 00:00 UTC/);
});

test("the list panel renders an empty state when nothing is present", async () => {
  const context = panelContext(
    "empty-machine",
    async () => ({
      ok: true,
      value: { rows: [], counts: { managed: 0, unmanaged: 0, broken: 0 }, lockWarning: null },
    }),
    () => undefined,
  );
  draw(context);
  await settle();

  assert.match(draw(context), /No skills found/);
});

test("the list panel renders an error state when the peer fails", async () => {
  const context = panelContext(
    "error-machine",
    async () => {
      throw new Error("peer offline");
    },
    () => undefined,
  );
  draw(context);
  await settle();

  assert.match(draw(context), /Skills unavailable: peer offline/);
});

test("the list panel renders a malformed lock as a warning above the rows", async () => {
  const context = panelContext(
    "warning-machine",
    async () => ({
      ok: true,
      value: { ...payload, lockWarning: "Cannot read lock: not valid JSON" },
    }),
    () => undefined,
  );
  draw(context);
  await settle();

  assert.match(draw(context), /Cannot read lock: not valid JSON/);
  assert.match(draw(context), /demo/);
});

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

const emptyPayload = {
  rows: [],
  counts: { managed: 0, unmanaged: 0, broken: 0 },
  lockWarning: null,
};

test("a refresh invalidates an in-flight list and an older response cannot overwrite the newer one", async () => {
  const older = deferred<JsonValue>();
  const newer = deferred<JsonValue>();
  const responses = [older.promise, newer.promise];
  let calls = 0;
  const context = panelContext(
    "refresh-race-machine",
    () => {
      const response = responses[calls];
      calls += 1;
      return response ?? Promise.reject(new Error("unexpected list request"));
    },
    () => undefined,
  );

  draw(context);
  refreshSkillList(context);
  draw(context);

  assert.equal(calls, 2, "a refresh starts a new load even while the old one is in flight");
  newer.resolve({ ok: true, value: emptyPayload });
  await settle();
  older.resolve({ ok: true, value: payload });
  await settle();

  const text = draw(context);
  assert.match(text, /No skills found/);
  assert.doesNotMatch(text, /demo/, "the older response must not replace the newer list");
});

test("a successful refresh clears the previous notice and stale row action", async () => {
  let listCalls = 0;
  const server = fakeServer(
    () => {
      listCalls += 1;
      return listCalls === 1
        ? { ok: true, value: payload }
        : {
            ok: true,
            value: {
              rows: payload.rows.filter((row) => row.state !== "managed"),
              counts: { managed: 0, unmanaged: 2, broken: 1 },
              lockWarning: null,
            },
          };
    },
    () => ({
      ok: true,
      value: { results: [{ name: "demo", ok: true, state: "managed", directory: "removed" }] },
    }),
  );
  const context = panelContext("stale-state-machine", server.request, () => undefined);
  draw(context);
  await settle();

  click(render(context), "Remove");
  click(render(context), "Yes, remove");
  await settle();
  assert.match(draw(context), /Removed demo/);

  refreshSkillList(context);
  draw(context);
  await settle();

  const refreshed = draw(context);
  assert.doesNotMatch(refreshed, /Removed demo/, "the old success notice is stale");
  assert.doesNotMatch(refreshed, /Removing/, "the old row action is stale");
});

test("a second Remove confirmation click while one removal is in flight is ignored", async () => {
  const removal = deferred<JsonValue>();
  let removeCalls = 0;
  const context = panelContext(
    "double-click-machine",
    (operation) => {
      if (operation === "list") return Promise.resolve({ ok: true, value: payload });
      removeCalls += 1;
      return removal.promise;
    },
    () => undefined,
  );
  draw(context);
  await settle();

  click(render(context), "Remove");
  const confirm = handlerFor(render(context), "@click", "Yes, remove");
  confirm();
  confirm();
  removal.resolve({
    ok: true,
    value: {
      results: [
        {
          name: "demo",
          ok: false,
          directory: "removed",
          error: {
            code: "remove-failed",
            message:
              'Removed the directory for "demo" but could not update the lockfile; its entry remains.',
          },
        },
      ],
    },
  });
  await settle();

  assert.equal(removeCalls, 1);
});

test("a lock failure after the directory removal refreshes to the broken row and shows a clear message", async () => {
  let listCalls = 0;
  const brokenDemo = {
    ...payload.rows[0]!,
    folderName: null,
    description: "",
    state: "broken",
  };
  const server = fakeServer(
    () => {
      listCalls += 1;
      return listCalls === 1
        ? { ok: true, value: payload }
        : {
            ok: true,
            value: {
              rows: [brokenDemo, payload.rows[1]!, payload.rows[2]!, payload.rows[3]!],
              counts: { managed: 0, unmanaged: 2, broken: 2 },
              lockWarning: null,
            },
          };
    },
    () => ({
      ok: true,
      value: {
        results: [
          {
            name: "demo",
            ok: false,
            directory: "removed",
            error: {
              code: "remove-failed",
              message:
                'Removed the directory for "demo" but could not update the lockfile; its entry remains.',
            },
          },
        ],
      },
    }),
  );
  const context = panelContext("partial-remove-machine", server.request, () => undefined);
  draw(context);
  await settle();

  click(render(context), "Remove");
  click(render(context), "Yes, remove");
  await settle();

  const text = draw(context);
  assert.equal(listCalls, 2, "the panel refreshes so the now-broken entry is shown");
  assert.match(text, /could not update the lockfile/);
  assert.match(text, /entry remains/);
  assert.match(text, /Install directory is missing/);
  assert.match(text, /\/reload/, "the directory changed, so the reminder still applies");
  assert.doesNotMatch(text, /EACCES/);
});

test("a list error offers Retry and a retry reads the rows again", async () => {
  let calls = 0;
  const context = panelContext(
    "list-retry-machine",
    async () => {
      calls += 1;
      if (calls === 1) throw new Error("peer offline");
      return { ok: true, value: payload };
    },
    () => undefined,
  );
  draw(context);
  await settle();
  assert.match(draw(context), /Skills unavailable: peer offline/);

  click(render(context), "Retry");
  draw(context);
  await settle();

  const text = draw(context);
  assert.equal(calls, 2);
  assert.match(text, /1 managed/);
  assert.match(text, /2 unmanaged/);
  assert.match(text, /1 broken/);
});

test("the removal success notice is dismissible", async () => {
  let listCalls = 0;
  const server = fakeServer(
    () => {
      listCalls += 1;
      return listCalls === 1
        ? { ok: true, value: payload }
        : {
            ok: true,
            value: {
              rows: payload.rows.filter((row) => row.state !== "managed"),
              counts: { managed: 0, unmanaged: 2, broken: 1 },
              lockWarning: null,
            },
          };
    },
    () => ({
      ok: true,
      value: { results: [{ name: "demo", ok: true, state: "managed", directory: "removed" }] },
    }),
  );
  const context = panelContext("dismiss-notice-machine", server.request, () => undefined);
  draw(context);
  await settle();
  click(render(context), "Remove");
  click(render(context), "Yes, remove");
  await settle();
  assert.match(draw(context), /Run \/reload/);

  click(render(context), "Dismiss");

  assert.doesNotMatch(draw(context), /Run \/reload/);
  assert.match(draw(context), /0 managed/);
  assert.match(draw(context), /2 unmanaged/);
  assert.match(draw(context), /1 broken/);
});
