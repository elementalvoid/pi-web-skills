import type {
  HtmlTemplateTag,
  JsonValue,
  PluginPeerChannel,
  WorkspacePanelContext,
} from "@jmfederico/pi-web/plugin-api";

type Template = ReturnType<HtmlTemplateTag>;

type CandidateView = {
  readonly name: string;
  readonly description: string;
  readonly sourcePath: string;
  readonly folderName: string;
  readonly existing: "none" | "managed" | "unmanaged";
};

type AddPhase = "idle" | "resolving" | "candidates" | "installing" | "error";

type AddState = {
  source: string;
  phase: AddPhase;
  message: string;
  candidates: CandidateView[];
  selected: Set<string>;
  channel: PluginPeerChannel | null;
  pending: AbortController | null;
};

const EXISTING = ["none", "managed", "unmanaged"] as const;

/** Ticket 05 owns install; until then the action is visible but not actionable. */
const INSTALL_AVAILABLE = false;

/**
 * The Add source and selection panel. State is per hosted panel; the channel is
 * opened only on an explicit Resolve and closed on cancel or a terminal frame.
 */
export function createAddPanel(html: HtmlTemplateTag): (context: WorkspacePanelContext) => Template {
  const states = new Map<string, AddState>();

  const stateFor = (context: WorkspacePanelContext): AddState => {
    const key = `${context.machine.id}\u0000${context.workspace.id}`;
    let state = states.get(key);
    if (state === undefined) {
      state = {
        source: "",
        phase: "idle",
        message: "Enter a source and resolve it to see the skills it provides.",
        candidates: [],
        selected: new Set(),
        channel: null,
        pending: null,
      };
      states.set(key, state);
    }
    return state;
  };

  return (context: WorkspacePanelContext): Template => {
    const state = stateFor(context);
    const render = () => context.host.requestRender();
    const busy = state.phase === "resolving" || state.phase === "installing";
    // A cancel must reach an open that has not resolved yet, not only a live channel.
    const cancellable = state.pending !== null || (state.channel !== null && state.phase !== "idle");

    const closeChannel = (state: AddState, reason: string) => {
      const channel = state.channel;
      state.channel = null;
      channel?.close(reason);
    };

    const onFrame = (data: JsonValue) => {
      const frame = readFrame(data);
      if (frame === null) {
        state.phase = "error";
        state.message = "The server sent an invalid frame.";
        closeChannel(state, "invalid-frame");
        render();
        return;
      }
      if (frame.type === "candidates") {
        const known = new Set(state.candidates.map((candidate) => candidate.sourcePath));
        state.candidates.push(...frame.candidates.filter((candidate) => !known.has(candidate.sourcePath)));
        state.phase = "candidates";
        render();
        return;
      }
      if (frame.type === "candidates-end") {
        state.phase = "candidates";
        state.message =
          state.candidates.length === 0
            ? "The source provides no skills."
            : `${String(state.candidates.length)} skill${state.candidates.length === 1 ? "" : "s"} found. Select what to install.`;
        render();
        return;
      }
      state.phase = "error";
      state.message = frame.message;
      closeChannel(state, "error");
      render();
    };

    const resolve = async () => {
      const source = state.source.trim();
      if (source === "") {
        state.phase = "error";
        state.message = "Enter a source to add.";
        render();
        return;
      }
      state.phase = "resolving";
      state.message = "Resolving the source…";
      state.candidates = [];
      state.selected.clear();
      closeChannel(state, "replaced");
      render();

      const peer = context.peer;
      if (peer?.openChannel === undefined) {
        state.phase = "error";
        state.message = "The Skills backend is unavailable on the selected machine.";
        render();
        return;
      }
      const pending = new AbortController();
      state.pending = pending;
      try {
        const channel = await peer.openChannel(
          "add",
          { source },
          { onData: (data) => onFrame(data), signal: pending.signal },
        );
        if (state.pending === pending) state.pending = null;
        if (pending.signal.aborted) {
          // Cancel arrived while the open was in flight: close the late channel.
          channel.close("cancelled");
          return;
        }
        state.channel = channel;
        void channel.closed.then(() => {
          if (state.channel !== channel) return;
          state.channel = null;
          if (state.phase === "resolving") {
            state.phase = "error";
            state.message = "The add operation stopped. Resolve again to retry.";
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
      pending?.abort();
      if (state.channel === null) {
        if (pending === null) return;
        state.phase = state.candidates.length === 0 ? "idle" : "candidates";
        state.message = "The add operation was cancelled.";
        render();
        return;
      }
      state.channel.send({ type: "cancel" });
      closeChannel(state, "cancelled");
      state.phase = state.candidates.length === 0 ? "idle" : "candidates";
      state.message = "The add operation was cancelled.";
      render();
    };

    const install = () => {
      const channel = state.channel;
      if (channel === null) return;
      const names = state.candidates
        .filter((candidate) => state.selected.has(candidate.sourcePath))
        .map((candidate) => candidate.name);
      if (names.length === 0) {
        state.message = "Select at least one skill to install.";
        render();
        return;
      }
      state.phase = "installing";
      state.message = `Starting install of ${String(names.length)} skill${names.length === 1 ? "" : "s"}…`;
      channel.send({ type: "install", names });
      render();
    };

    const toggle = (sourcePath: string) => {
      if (state.selected.has(sourcePath)) state.selected.delete(sourcePath);
      else state.selected.add(sourcePath);
      render();
    };

    const allSelected =
      state.candidates.length > 0 && state.selected.size === state.candidates.length;
    const toggleAll = () => {
      if (allSelected) state.selected.clear();
      else for (const candidate of state.candidates) state.selected.add(candidate.sourcePath);
      render();
    };

    return html`
      <section aria-labelledby="skills-add-heading">
        <h3 id="skills-add-heading">Add skills</h3>
        <form
          @submit=${(event: Event) => {
            event.preventDefault();
            void resolve();
          }}
        >
          <label>
            Source
            <input
              type="text"
              autocomplete="off"
              spellcheck="false"
              .value=${state.source}
              placeholder="owner/repo, https://github.com/owner/repo, or a git URL"
              ?disabled=${busy}
              @input=${(event: Event) => {
                const target = event.target as { value?: unknown } | null;
                if (typeof target?.value === "string") state.source = target.value;
              }}
            />
          </label>
          <button type="submit" ?disabled=${busy || state.source.trim() === ""}>Resolve</button>
          ${cancellable ? html`<button type="button" @click=${cancel}>Cancel</button>` : null}
        </form>

        ${state.phase === "error"
          ? html`<p role="alert">${state.message}</p>`
          : html`<p role="status" aria-live="polite">${state.message}</p>`}

        ${state.candidates.length === 0
          ? null
          : html`
              <fieldset ?disabled=${busy}>
                <legend>
                  ${String(state.candidates.length)} discovered
                  skill${state.candidates.length === 1 ? "" : "s"}
                </legend>
                <label>
                  <input
                    type="checkbox"
                    ?checked=${allSelected}
                    @change=${toggleAll}
                  />
                  Select all
                </label>
                <ul>
                  ${state.candidates.map(
                    (candidate) => html`
                      <li>
                        <label>
                          <input
                            type="checkbox"
                            ?checked=${state.selected.has(candidate.sourcePath)}
                            @change=${() => toggle(candidate.sourcePath)}
                          />
                          <strong>${candidate.name}</strong>
                        </label>
                        <code>${candidate.folderName}</code>
                        ${candidate.existing === "none"
                          ? null
                          : html`<span class="badge">
                              ${candidate.existing === "managed"
                                ? "Already installed — an overwrite confirmation will come before install"
                                : "Unmanaged — an overwrite confirmation will come before install"}
                            </span>`}
                        <p>${candidate.description}</p>
                        <small>${candidate.sourcePath}</small>
                      </li>
                    `,
                  )}
                </ul>
              </fieldset>
              <button
                type="button"
                ?disabled=${!INSTALL_AVAILABLE ||
                busy ||
                state.selected.size === 0 ||
                state.channel === null}
                @click=${install}
              >
                Install selected (${String(state.selected.size)})
              </button>
              <p>Install is not available yet. Selecting skills writes nothing.</p>
            `}
      </section>
    `;
  };
}

type ServerFrame =
  | { readonly type: "candidates"; readonly candidates: CandidateView[] }
  | { readonly type: "candidates-end"; readonly total: number }
  | { readonly type: "error"; readonly message: string };

function readFrame(data: JsonValue): ServerFrame | null {
  if (!isRecord(data)) return null;
  const type = data["type"];
  if (type === "candidates") {
    const candidates = data["candidates"];
    if (!Array.isArray(candidates)) return null;
    const rows: CandidateView[] = [];
    for (const candidate of candidates) {
      const row = readCandidate(candidate);
      if (row === null) return null;
      rows.push(row);
    }
    return { type: "candidates", candidates: rows };
  }
  if (type === "candidates-end") {
    return typeof data["total"] === "number"
      ? { type: "candidates-end", total: data["total"] }
      : null;
  }
  if (type === "error") {
    const error = data["error"];
    if (error === undefined || !isRecord(error) || typeof error["message"] !== "string") return null;
    return { type: "error", message: error["message"] };
  }
  return null;
}

function readCandidate(value: JsonValue): CandidateView | null {
  if (!isRecord(value)) return null;
  const { name, description, sourcePath, folderName, existing } = value;
  if (
    typeof name !== "string" ||
    typeof description !== "string" ||
    typeof sourcePath !== "string" ||
    typeof folderName !== "string" ||
    typeof existing !== "string" ||
    !EXISTING.includes(existing as (typeof EXISTING)[number])
  ) {
    return null;
  }
  return {
    name,
    description,
    sourcePath,
    folderName,
    existing: existing as (typeof EXISTING)[number],
  };
}

function isRecord(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
