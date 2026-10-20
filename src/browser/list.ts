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

/** List section: managed, unmanaged, broken, and invalid rows, with details and actions. */
export function renderSkillList(
  html: HtmlTemplateTag,
  context: WorkspacePanelContext,
  onUpdateSkill?: (name: string) => void,
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
      : html`<p class="skills-notice" role="status">
          <span>${notice}</span>
          <button
            type="button"
            class="skills-ghost"
            @click=${() => {
              notices.delete(key);
              context.host.requestRender();
            }}
          >
            Dismiss
          </button>
        </p>`}
    ${renderList(html, state, context, onUpdateSkill)}
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
  onUpdateSkill?: (name: string) => void,
): ReturnType<HtmlTemplateTag> {
  if (state.kind === "loading") {
    return html`<p class="skills-loading" aria-live="polite">Loading skills…</p>`;
  }
  if (state.kind === "error") {
    return html`
      <div class="skills-alert">
        <p role="alert">Skills unavailable: ${state.message}</p>
        <button type="button" class="skills-ghost" @click=${() => refreshSkillList(context)}>
          Retry
        </button>
      </div>
    `;
  }

  const { list } = state;
  const warning =
    list.lockWarning === null
      ? html``
      : html`<p class="skills-warning" role="status">Lockfile warning: ${list.lockWarning}</p>`;
  if (list.rows.length === 0) {
    return html`${warning}<div class="skills-empty">No skills found in the managed directory.</div>`;
  }

  return html`
    <section aria-labelledby="skills-list-heading">
      <h3 id="skills-list-heading">Installed skills</h3>
      ${warning}
      <div class="skills-stats" aria-label="Skill counts">
        <span class="skills-chip skills-chip-managed">${list.counts.managed} managed</span>
        <span class="skills-chip skills-chip-unmanaged">${list.counts.unmanaged} unmanaged</span>
        <span class="skills-chip skills-chip-broken">${list.counts.broken} broken</span>
      </div>
      ${GROUPS.map((group) =>
        renderGroup(html, list.rows, group.state, group.title, context, onUpdateSkill),
      )}
    </section>
  `;
}

function renderGroup(
  html: HtmlTemplateTag,
  rows: readonly ListRow[],
  state: SkillState,
  title: string,
  context: WorkspacePanelContext,
  onUpdateSkill?: (name: string) => void,
): ReturnType<HtmlTemplateTag> {
  const group = rows.filter((row) => row.state === state);
  if (group.length === 0) return html``;
  return html`
    <section class="skills-group skills-group-${state}">
      <h4>${title} (${group.length})</h4>
      <ul class="skills-list">
        ${group.map((row) => renderRow(html, row, context, onUpdateSkill))}
      </ul>
    </section>
  `;
}

function renderRow(
  html: HtmlTemplateTag,
  row: ListRow,
  context: WorkspacePanelContext,
  onUpdateSkill?: (name: string) => void,
): ReturnType<HtmlTemplateTag> {
  const key = rowKey(context.machine.id, row);
  const action = rowActions.get(key);
  const confirming = action?.kind === "confirming";
  const stateLabel =
    row.state === "managed" ? "Managed" : row.state === "unmanaged" ? "Unmanaged" : "Broken";
  const invalid =
    row.invalidReason === null
      ? html``
      : html`<span class="skills-chip skills-chip-invalid">Invalid frontmatter</span>`;
  const updateAction =
    row.state === "managed" && onUpdateSkill !== undefined && !confirming
      ? html`<button
          type="button"
          class="skills-primary"
          @click=${() => onUpdateSkill(row.name)}
        >
          Update
        </button>`
      : html``;
  const unmanagedNote =
    row.state === "unmanaged"
      ? html`<p>
          Not tracked by the lockfile. This panel never updates or removes unmanaged skills;
          Add can replace the folder only after an explicit overwrite confirmation.
        </p>`
      : html``;
  return html`
    <li class="skills-row skills-row-${row.state}">
      <details class="skills-details">
        <summary>
          <span class="skills-row-header">
            <span class="skills-row-title">${row.name}</span>
            <span class="skills-chip skills-chip-${row.state}">${stateLabel}</span>
            ${invalid}
          </span>
          ${row.description === ""
            ? html``
            : html`<span class="skills-description">${row.description}</span>`}
          ${row.invalidReason === null
            ? html``
            : html`<span class="skills-warning" role="note">
                Invalid frontmatter: ${row.invalidReason}
              </span>`}
          <span class="skills-details-cta">Details &amp; actions</span>
        </summary>
        <div class="skills-details-body">
          ${row.description === "" ? html`` : html`<p>${row.description}</p>`}
          ${row.folderName === null
            ? html`<p>Install directory is missing.</p>`
            : html``}
          ${renderMeta(html, row)}
          ${unmanagedNote}
          ${row.state === "unmanaged"
            ? html``
            : html`<div class="skills-actions">
                ${updateAction}
                ${renderRemoveAction(html, row, context)}
              </div>`}
        </div>
      </details>
    </li>
  `;
}

function renderMeta(
  html: HtmlTemplateTag,
  row: ListRow,
): ReturnType<HtmlTemplateTag> {
  const items: { label: string; value: unknown }[] = [];
  if (row.source !== null) items.push({ label: "Source", value: html`<code>${row.source}</code>` });
  if (row.sourceType !== null) items.push({ label: "Type", value: row.sourceType });
  if (row.ref !== null) items.push({ label: "Ref", value: html`<code>${row.ref}</code>` });
  if (row.folderName !== null) {
    items.push({ label: "Folder", value: html`<code>${row.folderName}</code>` });
  }
  if (row.skillPath !== null) {
    items.push({ label: "Skill path", value: html`<code>${row.skillPath}</code>` });
  }
  if (row.pluginName !== null) items.push({ label: "Plugin", value: row.pluginName });
  if (row.installedAt !== null) {
    items.push({ label: "Installed", value: formatTimestamp(row.installedAt) });
  }
  if (row.updatedAt !== null) {
    items.push({ label: "Updated", value: formatTimestamp(row.updatedAt) });
  }
  if (items.length === 0) return html``;
  return html`<dl class="skills-meta">
    ${items.map((item) => html`<dt>${item.label}</dt><dd>${item.value}</dd>`)}
  </dl>`;
}

/** Compact, deterministic display for a lock timestamp. */
function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${date.toISOString().replace("T", " ").slice(0, 16)} UTC`;
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
    return html`<p class="skills-message" aria-live="polite">Removing…</p>`;
  }
  const failure =
    action?.kind === "error" ? html`<p class="skills-alert" role="alert">${action.message}</p>` : html``;

  if (action?.kind !== "confirming") {
    if (row.state === "broken") {
      return html`<button type="button" class="skills-danger" @click=${() => startRemove(context, key)}>
        Remove entry
      </button>
      ${failure}`;
    }
    return html`<button type="button" class="skills-danger" @click=${() => startRemove(context, key)}>
      Remove
    </button>
    ${failure}`;
  }

  if (row.state === "broken") {
    return html`
      <div class="skills-confirm">
        <p role="alert">
          Remove the stale lock entry for ${row.name}? Its install directory is already missing.
        </p>
        <div class="skills-actions">
          <button
            type="button"
            class="skills-danger"
            @click=${() => void confirmRemove(context, row, key)}
          >
            Yes, remove entry
          </button>
          <button type="button" class="skills-ghost" @click=${() => cancelRemove(context, key)}>
            Cancel
          </button>
        </div>
        ${failure}
      </div>
    `;
  }
  return html`
    <div class="skills-confirm">
      <p role="alert">Remove ${row.name}? This deletes its directory and lock entry.</p>
      <div class="skills-actions">
        <button
          type="button"
          class="skills-danger"
          @click=${() => void confirmRemove(context, row, key)}
        >
          Yes, remove
        </button>
        <button type="button" class="skills-ghost" @click=${() => cancelRemove(context, key)}>
          Cancel
        </button>
      </div>
      ${failure}
    </div>
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
