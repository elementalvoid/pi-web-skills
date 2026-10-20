import type {
  HtmlTemplateTag,
  JsonValue,
  WorkspacePanelContext,
} from "@jmfederico/pi-web/plugin-api";
import type { ListPayload, ListRow, SkillState } from "../operations/list.ts";
import { refreshMachineStatus } from "./status.ts";

type ListState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly list: ListPayload }
  | { readonly kind: "error"; readonly message: string };

const GROUPS: readonly { readonly state: SkillState; readonly title: string }[] = [
  { state: "managed", title: "Managed skills" },
  { state: "unmanaged", title: "Unmanaged skills" },
  { state: "broken", title: "Broken entries" },
];

type RowAction =
  | { readonly kind: "confirming" }
  | { readonly kind: "removing" }
  | { readonly kind: "error"; readonly message: string };

// Machine-wide state, keyed by machine: every workspace on a machine shares it.
const lists = new Map<string, ListState>();
const generations = new Map<string, number>();
const rowActions = new Map<string, RowAction>();
const notices = new Map<string, string>();

/** Every load takes a new generation so only the newest response may write state. */
function nextGeneration(key: string): number {
  const next = (generations.get(key) ?? 0) + 1;
  generations.set(key, next);
  return next;
}

function clearRowActions(key: string): void {
  const prefix = `${key}\u0000`;
  for (const actionKey of rowActions.keys()) {
    if (actionKey.startsWith(prefix)) rowActions.delete(actionKey);
  }
}

/** List section: managed, unmanaged, broken, and invalid rows, with Remove actions. */
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
  const notice = notices.get(key);
  return html`
    ${notice === undefined
      ? html``
      : html`<p role="status">
          ${notice}
          <button
            type="button"
            @click=${() => {
              notices.delete(key);
              context.host.requestRender();
            }}
          >
            Dismiss
          </button>
        </p>`}
    ${renderList(html, state, context)}
  `;
}

/** Forget the cached list so the next render re-reads the machine after a mutation. */
export function refreshSkillList(context: WorkspacePanelContext): void {
  const key = context.machine.id;
  lists.delete(key);
  notices.delete(key);
  clearRowActions(key);
  // Invalidate any response already in flight; the next render loads a new one.
  nextGeneration(key);
  // A mutation can create or empty the managed directory and the lockfile.
  refreshMachineStatus(context);
  context.host.requestRender();
}

function renderList(
  html: HtmlTemplateTag,
  state: ListState,
  context: WorkspacePanelContext,
): ReturnType<HtmlTemplateTag> {
  if (state.kind === "loading") {
    return html`<p aria-live="polite">Loading skills…</p>`;
  }
  if (state.kind === "error") {
    return html`
      <p role="alert">Skills unavailable: ${state.message}</p>
      <button type="button" @click=${() => refreshSkillList(context)}>Retry</button>
    `;
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
    ${GROUPS.map((group) => renderGroup(html, list.rows, group.state, group.title, context))}
  `;
}

function renderGroup(
  html: HtmlTemplateTag,
  rows: readonly ListRow[],
  state: SkillState,
  title: string,
  context: WorkspacePanelContext,
): ReturnType<HtmlTemplateTag> {
  const group = rows.filter((row) => row.state === state);
  if (group.length === 0) return html``;
  return html`
    <section>
      <h3>${title} (${group.length})</h3>
      <ul>
        ${group.map((row) => renderRow(html, row, context))}
      </ul>
    </section>
  `;
}

function renderRow(
  html: HtmlTemplateTag,
  row: ListRow,
  context: WorkspacePanelContext,
): ReturnType<HtmlTemplateTag> {
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
      ${row.state === "unmanaged"
        ? html`<p>Not tracked by the lockfile; the panel cannot remove this skill.</p>`
        : renderRemoveAction(html, row, context)}
    </li>
  `;
}

/**
 * Remove or Remove entry, gated by an inline confirmation. Broken rows only
 * delete the stale lock entry; managed rows delete the directory as well.
 */
function renderRemoveAction(
  html: HtmlTemplateTag,
  row: ListRow,
  context: WorkspacePanelContext,
): ReturnType<HtmlTemplateTag> {
  const key = rowKey(context.machine.id, row);
  const action = rowActions.get(key);
  if (action?.kind === "removing") {
    return html`<p aria-live="polite">Removing…</p>`;
  }
  const failure =
    action?.kind === "error" ? html`<p role="alert">${action.message}</p>` : html``;

  if (action?.kind !== "confirming") {
    if (row.state === "broken") {
      return html`<button type="button" @click=${() => startRemove(context, key)}>
        Remove entry
      </button>
      ${failure}`;
    }
    return html`<button type="button" @click=${() => startRemove(context, key)}>
      Remove
    </button>
    ${failure}`;
  }

  if (row.state === "broken") {
    return html`
      <p role="alert">
        Remove the stale lock entry for ${row.name}? Its install directory is already missing.
      </p>
      <button type="button" @click=${() => void confirmRemove(context, row, key)}>
        Yes, remove entry
      </button>
      <button type="button" @click=${() => cancelRemove(context, key)}>Cancel</button>
      ${failure}
    `;
  }
  return html`
    <p role="alert">Remove ${row.name}? This deletes its directory and lock entry.</p>
    <button type="button" @click=${() => void confirmRemove(context, row, key)}>Yes, remove</button>
    <button type="button" @click=${() => cancelRemove(context, key)}>Cancel</button>
    ${failure}
  `;
}

function rowKey(machineId: string, row: ListRow): string {
  return `${machineId}\u0000${row.state}\u0000${row.name}`;
}

function startRemove(context: WorkspacePanelContext, key: string): void {
  rowActions.set(key, { kind: "confirming" });
  context.host.requestRender();
}

function cancelRemove(context: WorkspacePanelContext, key: string): void {
  rowActions.delete(key);
  context.host.requestRender();
}

/** Remove the row's identity, then re-read the list and remind the user to /reload. */
async function confirmRemove(
  context: WorkspacePanelContext,
  row: ListRow,
  key: string,
): Promise<void> {
  // A second click on the old template while the first request runs is ignored.
  if (rowActions.get(key)?.kind === "removing") return;
  rowActions.set(key, { kind: "removing" });
  context.host.requestRender();
  try {
    if (context.peer?.request === undefined) {
      throw new Error("The Skills backend is unavailable on the selected machine.");
    }
    // The install folder is the identity matching is sure to resolve back to the
    // entry, and a broken row has no folder, so its lock key is the identity.
    const identity = row.folderName ?? row.name;
    const response = await context.peer.request("remove", { names: [identity] });
    const results = readRemovalResults(response);
    const removedDirectory = results.some((result) => result.directory === "removed");
    const failed = results.filter((result) => !result.ok);
    if (failed.length > 0 && !removedDirectory) {
      rowActions.set(key, { kind: "error", message: removalFailure(failed) });
      context.host.requestRender();
      return;
    }

    const notice = removalNotice(row, results);
    // A successful read clears the old notice and row action; set the new one after.
    await loadList(context, context.machine.id);
    rowActions.delete(key);
    notices.set(context.machine.id, notice);
    context.host.requestRender();
  } catch (error) {
    rowActions.set(key, { kind: "error", message: describe(error) });
    context.host.requestRender();
  }
}

/** One per-name outcome the panel can render; a rejected request instead throws. */
type RemovalResultView = {
  readonly name: string;
  readonly ok: boolean;
  readonly directory: "removed" | "absent" | null;
  readonly message: string | null;
};

function readRemovalResults(response: JsonValue): readonly RemovalResultView[] {
  if (!isRecord(response)) throw new Error("The server returned an invalid removal.");
  if (response["ok"] !== true) {
    const error = response["error"];
    throw new Error(
      isRecord(error) && typeof error["message"] === "string"
        ? error["message"]
        : "The server rejected the removal.",
    );
  }
  const value = response["value"];
  if (!isRecord(value) || !Array.isArray(value["results"])) {
    throw new Error("The server returned an invalid removal.");
  }
  return value["results"].map((result): RemovalResultView => {
    if (!isRecord(result)) throw new Error("The server returned an invalid removal.");
    const name = result["name"];
    const ok = result["ok"];
    if (typeof name !== "string" || typeof ok !== "boolean") {
      throw new Error("The server returned an invalid removal.");
    }
    const directory = result["directory"];
    const error = result["error"];
    return {
      name,
      ok,
      directory: directory === "removed" || directory === "absent" ? directory : null,
      message:
        ok || !isRecord(error) || typeof error["message"] !== "string"
          ? null
          : error["message"],
    };
  });
}

function removalFailure(failed: readonly RemovalResultView[]): string {
  return failed.map((result) => result.message ?? `Removal of ${result.name} failed.`).join(" ");
}

/** The success or partial-failure notice; /reload only matters when a directory changed. */
function removalNotice(row: ListRow, results: readonly RemovalResultView[]): string {
  const parts: string[] = [];
  const succeeded = results.filter((result) => result.ok);
  const failed = results.filter((result) => !result.ok);
  if (succeeded.length > 0) {
    parts.push(
      row.state === "broken"
        ? `Removed the stale lock entry for ${row.name}.`
        : `Removed ${succeeded.map((result) => result.name).join(", ")}.`,
    );
  }
  if (failed.length > 0) parts.push(removalFailure(failed));
  if (results.some((result) => result.directory === "removed")) {
    parts.push("Run /reload in each session to apply the change.");
  }
  return parts.join(" ");
}

/** Load the list for `key`; only the newest load may write state, notices, or actions. */
async function loadList(context: WorkspacePanelContext, key: string): Promise<void> {
  const generation = nextGeneration(key);
  try {
    if (context.peer?.request === undefined) throw new Error("The package peer is unavailable");
    const response = await context.peer.request("list", null);
    const list = readListPayload(response);
    if (generations.get(key) !== generation) return;
    lists.set(key, { kind: "ready", list });
    notices.delete(key);
    clearRowActions(key);
  } catch (error) {
    if (generations.get(key) !== generation) return;
    lists.set(key, {
      kind: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    if (generations.get(key) === generation) context.host.requestRender();
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

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
