import assert from "node:assert/strict";
import test from "node:test";
import type {
  HtmlTemplateTag,
  JsonValue,
  WorkspacePanelContext,
} from "@jmfederico/pi-web/plugin-api";
import { renderSkillList } from "../src/browser/list.ts";

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
  request: () => Promise<JsonValue>,
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

function draw(context: WorkspacePanelContext): string {
  return textOf(renderSkillList(html, context) as FakeTemplate);
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
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

test("the list panel renders managed, unmanaged, broken, and invalid rows without actions", async () => {
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
  assert.match(text, /1 managed, 2 unmanaged, 1 broken/);
  assert.match(text, /demo/);
  assert.match(text, /A managed skill/);
  assert.match(text, /owner\/repo/);
  assert.match(text, /plugin group/);
  assert.match(text, /notes/);
  assert.match(text, /half-written/);
  assert.match(text, /Invalid frontmatter: description is missing/);
  assert.match(text, /gone/);
  assert.match(text, /Install directory is missing/);
  assert.doesNotMatch(text, /<button/);
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
