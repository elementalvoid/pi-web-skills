import type {
  HtmlTemplateTag,
  JsonValue,
  WorkspacePanelContext,
} from "@jmfederico/pi-web/plugin-api";
import type { ListPayload, ListRow, SkillState } from "../operations/list.ts";

type ListState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly list: ListPayload }
  | { readonly kind: "error"; readonly message: string };

const GROUPS: readonly { readonly state: SkillState; readonly title: string }[] = [
  { state: "managed", title: "Managed skills" },
  { state: "unmanaged", title: "Unmanaged skills" },
  { state: "broken", title: "Broken entries" },
];

// Machine-wide state, keyed by machine: every workspace on a machine shares it.
const lists = new Map<string, ListState>();
const inFlight = new Set<string>();

/** Read-only list section: managed, unmanaged, broken, and invalid rows. */
export function renderSkillList(
  html: HtmlTemplateTag,
  context: WorkspacePanelContext,
): ReturnType<HtmlTemplateTag> {
  const key = context.machine.id;
  let state = lists.get(key);
  if (state === undefined) {
    state = { kind: "loading" };
    lists.set(key, state);
    void loadList(context, key);
  }
  return renderList(html, state);
}

function renderList(html: HtmlTemplateTag, state: ListState): ReturnType<HtmlTemplateTag> {
  if (state.kind === "loading") {
    return html`<p aria-live="polite">Loading skills…</p>`;
  }
  if (state.kind === "error") {
    return html`<p role="alert">Skills unavailable: ${state.message}</p>`;
  }

  const { list } = state;
  const warning =
    list.lockWarning === null
      ? html``
      : html`<p role="status">Lockfile warning: ${list.lockWarning}</p>`;
  if (list.rows.length === 0) {
    return html`${warning}<p>No skills found in the managed directory.</p>`;
  }

  const summary = `${list.counts.managed} managed, ${list.counts.unmanaged} unmanaged, ${list.counts.broken} broken`;
  return html`
    ${warning}
    <p>${summary}</p>
    ${GROUPS.map((group) => renderGroup(html, list.rows, group.state, group.title))}
  `;
}

function renderGroup(
  html: HtmlTemplateTag,
  rows: readonly ListRow[],
  state: SkillState,
  title: string,
): ReturnType<HtmlTemplateTag> {
  const group = rows.filter((row) => row.state === state);
  if (group.length === 0) return html``;
  return html`
    <section>
      <h3>${title} (${group.length})</h3>
      <ul>
        ${group.map((row) => renderRow(html, row))}
      </ul>
    </section>
  `;
}

function renderRow(html: HtmlTemplateTag, row: ListRow): ReturnType<HtmlTemplateTag> {
  const details: string[] = [];
  if (row.source !== null) details.push(`${row.sourceType ?? "source"} ${row.source}`);
  if (row.ref !== null) details.push(`ref ${row.ref}`);
  if (row.pluginName !== null) details.push(`plugin ${row.pluginName}`);
  if (row.updatedAt !== null) details.push(`updated ${row.updatedAt}`);
  return html`
    <li>
      <strong>${row.name}</strong>
      ${row.invalidReason === null
        ? html``
        : html`<span role="note">Invalid frontmatter: ${row.invalidReason}</span>`}
      ${row.description === "" ? html`` : html`<p>${row.description}</p>`}
      ${row.folderName === null
        ? html`<p>Install directory is missing.</p>`
        : html`<p><code>${row.folderName}</code></p>`}
      ${details.length === 0 ? html`` : html`<p>${details.join(" · ")}</p>`}
    </li>
  `;
}

async function loadList(context: WorkspacePanelContext, key: string): Promise<void> {
  if (inFlight.has(key)) return;
  inFlight.add(key);
  try {
    if (context.peer?.request === undefined) throw new Error("The package peer is unavailable");
    const response = await context.peer.request("list", null);
    lists.set(key, { kind: "ready", list: readListPayload(response) });
  } catch (error) {
    lists.set(key, {
      kind: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    inFlight.delete(key);
    context.host.requestRender();
  }
}

function readListPayload(response: JsonValue): ListPayload {
  if (!isRecord(response)) throw new Error("The server returned an invalid list");
  if (response["ok"] !== true) {
    const error = response["error"];
    throw new Error(
      isRecord(error) && typeof error["message"] === "string"
        ? error["message"]
        : "The server rejected the list request",
    );
  }
  const value = response["value"];
  if (!isRecord(value) || !Array.isArray(value["rows"]) || !isRecord(value["counts"])) {
    throw new Error("The server returned an invalid list");
  }
  const counts = value["counts"];
  return {
    rows: value["rows"].map(readRow),
    counts: {
      managed: readCount(counts, "managed"),
      unmanaged: readCount(counts, "unmanaged"),
      broken: readCount(counts, "broken"),
    },
    lockWarning: readNullableString(value, "lockWarning"),
  };
}

function readRow(row: JsonValue): ListRow {
  if (!isRecord(row)) throw new Error("The server returned an invalid list row");
  return {
    name: readString(row, "name"),
    folderName: readNullableString(row, "folderName"),
    description: readString(row, "description"),
    state: readState(row["state"]),
    invalidReason: readNullableString(row, "invalidReason"),
    source: readNullableString(row, "source"),
    sourceType: readNullableString(row, "sourceType"),
    ref: readNullableString(row, "ref"),
    skillPath: readNullableString(row, "skillPath"),
    installedAt: readNullableString(row, "installedAt"),
    updatedAt: readNullableString(row, "updatedAt"),
    pluginName: readNullableString(row, "pluginName"),
  };
}

function readState(value: JsonValue | undefined): SkillState {
  if (value === "managed" || value === "unmanaged" || value === "broken") return value;
  throw new Error("The server returned an invalid list row: state");
}

function readCount(counts: { readonly [key: string]: JsonValue }, key: string): number {
  const field = counts[key];
  if (typeof field !== "number") throw new Error(`The server returned an invalid list count: ${key}`);
  return field;
}

function isRecord(value: JsonValue | undefined): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: { readonly [key: string]: JsonValue }, key: string): string {
  const field = value[key];
  if (typeof field !== "string") throw new Error(`The server returned an invalid list row: ${key}`);
  return field;
}

function readNullableString(
  value: { readonly [key: string]: JsonValue },
  key: string,
): string | null {
  const field = value[key];
  if (field === null || field === undefined) return null;
  if (typeof field !== "string") throw new Error(`The server returned an invalid list row: ${key}`);
  return field;
}
