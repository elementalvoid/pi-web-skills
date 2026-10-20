import type {
  HtmlTemplateTag,
  JsonValue,
  PluginPeerChannel,
  WorkspacePanelContext,
} from "@jmfederico/pi-web/plugin-api";
import { refreshSkillList } from "./list.ts";

type Template = ReturnType<HtmlTemplateTag>;

type UpdatePhase = "idle" | "confirming" | "running" | "done" | "error";

type SkipNote = { readonly name: string; readonly reason: string };
type FailureNote = { readonly name: string; readonly message: string };

type UpdateState = {
  phase: UpdatePhase;
  message: string;
  current: string | null;
  updated: string[];
  unchanged: string[];
  skipped: SkipNote[];
  deleted: string[];
  failed: FailureNote[];
  channel: PluginPeerChannel | null;
  pending: AbortController | null;
  /** The skill whose `updating` frame arrived; the next frame proves its swap finished. */
  pendingUpdate: string | null;
  /** null means every managed skill; a list means a per-row Update. */
  pendingNames: string[] | null;
  reloadReminder: boolean;
};

export type UpdatePanel = ((context: WorkspacePanelContext) => Template) & {
  /** Ask the panel to confirm an update for these names, or every managed skill. */
  requestUpdate: (context: WorkspacePanelContext, names: readonly string[] | null) => void;
};

const CONFIRMATION =
  "Update checks every managed skill at its locked ref and replaces a skill only when its remote folder changed. A remote change replaces the installed folder, so any local edit to a changed skill is overwritten.";

/**
 * The Update all panel. Update is not a dry run: the confirmation names the
 * local-edit risk before any channel opens, and there is no Check action.
 */
export function createUpdatePanel(
  html: HtmlTemplateTag,
): UpdatePanel {
  const states = new Map<string, UpdateState>();

  const stateFor = (context: WorkspacePanelContext): UpdateState => {
    const key = `${context.machine.id}\u0000${context.workspace.id}`;
    let state = states.get(key);
    if (state === undefined) {
      state = {
        phase: "idle",
        message: "Update checks every managed skill and replaces only the ones that changed.",
        current: null,
        updated: [],
        unchanged: [],
        skipped: [],
        deleted: [],
        failed: [],
        channel: null,
        pending: null,
        pendingUpdate: null,
        pendingNames: null,
        reloadReminder: false,
      };
      states.set(key, state);
    }
    return state;
  };

  const requestUpdate = (
    context: WorkspacePanelContext,
    names: readonly string[] | null,
  ): void => {
    const state = stateFor(context);
    if (state.phase === "running") return;
    state.phase = "confirming";
    state.pendingNames = names === null || names.length === 0 ? null : [...names];
    state.message =
      state.pendingNames === null
        ? "Update all managed skills?"
        : `Update ${state.pendingNames.join(", ")}?`;
    context.host.requestRender();
  };

  const panel = ((context: WorkspacePanelContext): Template => {
    const state = stateFor(context);
    const render = () => context.host.requestRender();

    const closeChannel = (target: UpdateState, reason: string) => {
      const channel = target.channel;
      target.channel = null;
      channel?.close(reason);
    };

    // `updating` is the only frame a replaced skill gets before the next skill starts.
    const settlePendingUpdate = () => {
      const name = state.pendingUpdate;
      if (name === null) return;
      state.pendingUpdate = null;
      if (!state.updated.includes(name)) state.updated.push(name);
    };

    const resultsMessage = (): string => {
      const parts: string[] = [];
      if (state.updated.length > 0) parts.push(`Updated ${state.updated.join(", ")}`);
      if (state.unchanged.length > 0) parts.push(`${String(state.unchanged.length)} unchanged`);
      if (state.skipped.length > 0) parts.push(`${String(state.skipped.length)} skipped`);
      if (state.deleted.length > 0) parts.push(`${String(state.deleted.length)} deleted upstream (kept)`);
      if (state.failed.length > 0) parts.push(`${String(state.failed.length)} failed`);
      return parts.join(". ") || "No managed skills to update";
    };

    const finish = (prefix: string | null) => {
      const summary = resultsMessage();
      state.message = prefix === null ? `${summary}.` : `${prefix} ${summary}.`;
      state.reloadReminder = state.updated.length > 0;
      if (state.updated.length > 0) refreshSkillList(context);
    };

    const onFrame = (data: JsonValue) => {
      const frame = readFrame(data);
      if (frame === null) {
        state.phase = "error";
        state.message = "The server sent an invalid update frame.";
        closeChannel(state, "invalid-frame");
        render();
        return;
      }
      if (frame.type === "progress") {
        state.current = frame.name;
        if (frame.state === "updating") {
          settlePendingUpdate();
          state.pendingUpdate = frame.name;
        } else if (state.pendingUpdate === frame.name) {
          // A `failed` frame belongs to the copy in flight, so it is not updated.
          state.pendingUpdate = null;
        } else {
          settlePendingUpdate();
        }
        if (frame.state === "checking") state.message = `Checking ${frame.name}…`;
        else if (frame.state === "updating") state.message = `Updating ${frame.name}…`;
        else if (frame.state === "unchanged") {
          if (!state.unchanged.includes(frame.name)) state.unchanged.push(frame.name);
          state.message = `${frame.name} is unchanged.`;
        } else if (frame.state === "skipped") {
          const reason = frame.reason ?? "No version tracking";
          if (!state.skipped.some((note) => note.name === frame.name)) {
            state.skipped.push({ name: frame.name, reason });
          }
          state.message = `Skipped ${frame.name}: ${reason}.`;
        } else if (frame.state === "deleted") {
          if (!state.deleted.includes(frame.name)) state.deleted.push(frame.name);
          state.message = `${frame.name} was deleted upstream; its install was kept.`;
        } else {
          const message = frame.reason ?? "The update failed.";
          if (!state.failed.some((note) => note.name === frame.name)) {
            state.failed.push({ name: frame.name, message });
          }
          state.message = `Failed ${frame.name}: ${message}`;
        }
        render();
        return;
      }
      if (frame.type === "done") {
        state.phase = "done";
        state.current = null;
        state.pendingUpdate = null;
        state.pendingNames = null;
        state.updated = [...new Set([...state.updated, ...frame.updated])];
        state.unchanged = [...new Set([...state.unchanged, ...frame.unchanged])];
        state.skipped = frame.skipped.length > 0 ? [...frame.skipped] : state.skipped;
        state.deleted = [...new Set([...state.deleted, ...frame.deleted])];
        state.failed = frame.failed.length > 0 ? [...frame.failed] : state.failed;
        finish(null);
        closeChannel(state, "done");
        render();
        return;
      }
      state.phase = "error";
      state.message = frame.message;
      state.pendingNames = null;
      closeChannel(state, "error");
      render();
    };

    const start = async () => {
      const peer = context.peer;
      if (peer?.openChannel === undefined) {
        state.phase = "error";
        state.message = "The Skills backend is unavailable on the selected machine.";
        render();
        return;
      }
      state.phase = "running";
      state.message = "Checking managed skills…";
      state.current = null;
      state.updated = [];
      state.unchanged = [];
      state.skipped = [];
      state.deleted = [];
      state.failed = [];
      state.pendingUpdate = null;
      state.reloadReminder = false;
      closeChannel(state, "replaced");
      render();

      const names = state.pendingNames;
      state.pendingNames = null;
      const pending = new AbortController();
      state.pending = pending;
      try {
        const channel = await peer.openChannel(
          "update",
          names === null ? {} : { names },
          { onData: (data) => onFrame(data), signal: pending.signal },
        );
        if (state.pending === pending) state.pending = null;
        if (pending.signal.aborted) {
          channel.close("cancelled");
          return;
        }
        state.channel = channel;
        void channel.closed.then(() => {
          if (state.channel !== channel) return;
          state.channel = null;
          if (state.phase === "running") {
            state.phase = "error";
            state.message = "The update stopped. Run Update all again to retry.";
          }
          render();
        });
      } catch (error) {
        if (state.pending === pending) state.pending = null;
        if (pending.signal.aborted) return;
        state.phase = "error";
        state.message = error instanceof Error ? error.message : String(error);
        render();
      }
    };

    const cancel = () => {
      const pending = state.pending;
      state.pending = null;
      state.pendingNames = null;
      pending?.abort();
      if (state.phase === "running") {
        state.channel?.send({ type: "cancel" });
        // The interrupted skill's swap may or may not have happened: never count it.
        state.pendingUpdate = null;
        state.current = null;
        state.phase = "done";
        finish("The update was cancelled after the current skill.");
      }
      closeChannel(state, "cancelled");
      render();
    };

    const hasResults =
      state.updated.length > 0 ||
      state.unchanged.length > 0 ||
      state.skipped.length > 0 ||
      state.deleted.length > 0 ||
      state.failed.length > 0;

    return html`
      <section aria-labelledby="skills-update-heading">
        <h3 id="skills-update-heading">Update skills</h3>
        ${state.phase === "error"
          ? html`<p role="alert">${state.message}</p>`
          : html`<p role="status" aria-live="polite">${state.message}</p>`}

        ${state.phase === "confirming"
          ? html`
              <p>
                ${state.pendingNames === null
                  ? "Update all managed skills?"
                  : `Update ${state.pendingNames.join(", ")}?`}
              </p>
              <p>${CONFIRMATION}</p>
              <div class="skills-actions">
                <button type="button" class="skills-primary" @click=${() => void start()}>
                  Confirm update
                </button>
                <button
                  type="button"
                  class="skills-ghost"
                  @click=${() => {
                    state.phase = "idle";
                    state.pendingNames = null;
                    state.message = "Update was not started.";
                    render();
                  }}
                >
                  Cancel
                </button>
              </div>
            `
          : state.phase === "running"
            ? html`<button type="button" class="skills-danger" @click=${cancel}>Cancel</button>`
            : html`<button type="button" class="skills-primary" @click=${() =>
                requestUpdate(context, null)}>Update all</button>`}

        ${hasResults
          ? html`
              ${state.updated.length === 0
                ? null
                : html`
                    <h4>Updated (${String(state.updated.length)})</h4>
                    <ul>
                      ${state.updated.map((name) => html`<li><strong>${name}</strong></li>`)}
                    </ul>
                  `}
              ${state.unchanged.length === 0
                ? null
                : html`
                    <h4>Unchanged (${String(state.unchanged.length)})</h4>
                    <ul>
                      ${state.unchanged.map((name) => html`<li>${name}</li>`)}
                    </ul>
                  `}
              ${state.skipped.length === 0
                ? null
                : html`
                    <h4>Skipped (${String(state.skipped.length)})</h4>
                    <ul>
                      ${state.skipped.map(
                        (note) => html`<li><strong>${note.name}</strong> — ${note.reason}</li>`,
                      )}
                    </ul>
                  `}
              ${state.deleted.length === 0
                ? null
                : html`
                    <h4>Deleted upstream (${String(state.deleted.length)})</h4>
                    <p>Reported only: the install and its lock entry were kept.</p>
                    <ul>
                      ${state.deleted.map((name) => html`<li>${name}</li>`)}
                    </ul>
                  `}
              ${state.failed.length === 0
                ? null
                : html`
                    <h4>Failed (${String(state.failed.length)})</h4>
                    <ul>
                      ${state.failed.map(
                        (note) => html`<li><strong>${note.name}</strong> — ${note.message}</li>`,
                      )}
                    </ul>
                  `}
              <button type="button" @click=${() => refreshSkillList(context)}>Refresh list</button>
            `
          : null}

        ${state.reloadReminder
          ? html`<p role="status">
              Skills were updated. Run <code>/reload</code> so the agent picks them up.
              <button
                type="button"
                @click=${() => {
                  state.reloadReminder = false;
                  render();
                }}
              >
                Dismiss
              </button>
            </p>`
          : null}
      </section>
    `;
  }) as UpdatePanel;

  panel.requestUpdate = requestUpdate;
  return panel;
}

type ServerFrame =
  | {
      readonly type: "progress";
      readonly name: string;
      readonly state: string;
      readonly reason?: string;
    }
  | {
      readonly type: "done";
      readonly updated: string[];
      readonly unchanged: string[];
      readonly skipped: SkipNote[];
      readonly deleted: string[];
      readonly failed: FailureNote[];
    }
  | { readonly type: "error"; readonly message: string };

function readFrame(data: JsonValue): ServerFrame | null {
  if (!isRecord(data)) return null;
  const type = data["type"];
  if (type === "progress") {
    const { name, state, reason } = data;
    if (typeof name !== "string" || typeof state !== "string") return null;
    const frame: ServerFrame = {
      type: "progress",
      name,
      state,
      ...(typeof reason === "string" ? { reason } : {}),
    };
    return frame;
  }
  if (type === "done") {
    const updated = readNames(data["updated"]);
    const unchanged = readNames(data["unchanged"]);
    const skipped = readSkips(data["skipped"]);
    const deleted = readNames(data["deleted"]);
    const failed = readFailures(data["failed"]);
    if (
      updated === null ||
      unchanged === null ||
      skipped === null ||
      deleted === null ||
      failed === null
    ) {
      return null;
    }
    return { type: "done", updated, unchanged, skipped, deleted, failed };
  }
  if (type === "error") {
    const error = data["error"];
    if (error === undefined || !isRecord(error) || typeof error["message"] !== "string") return null;
    return { type: "error", message: error["message"] };
  }
  return null;
}

function readNames(value: JsonValue | undefined): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.every((name) => typeof name === "string") ? [...value] : null;
}

function readSkips(value: JsonValue | undefined): SkipNote[] | null {
  if (!Array.isArray(value)) return null;
  const notes: SkipNote[] = [];
  for (const note of value) {
    if (!isRecord(note) || typeof note["name"] !== "string" || typeof note["reason"] !== "string") {
      return null;
    }
    notes.push({ name: note["name"], reason: note["reason"] });
  }
  return notes;
}

function readFailures(value: JsonValue | undefined): FailureNote[] | null {
  if (!Array.isArray(value)) return null;
  const notes: FailureNote[] = [];
  for (const note of value) {
    if (!isRecord(note) || typeof note["name"] !== "string" || typeof note["message"] !== "string") {
      return null;
    }
    notes.push({ name: note["name"], message: note["message"] });
  }
  return notes;
}

function isRecord(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
