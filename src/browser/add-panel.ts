import type {
  HtmlTemplateTag,
  JsonValue,
  PluginPeerChannel,
  WorkspacePanelContext,
} from "@jmfederico/pi-web/plugin-api";
import type { AddHandoffBox } from "./add-handoff.ts";
import { addHandoffKey } from "./add-handoff.ts";
import { sanitizeName } from "./sanitize-name.ts";
import { refreshSkillList } from "./list.ts";

type Template = ReturnType<HtmlTemplateTag>;

type CandidateView = {
  readonly name: string;
  readonly description: string;
  readonly sourcePath: string;
  readonly folderName: string;
  existing: "none" | "managed" | "unmanaged";
};

type AddPhase = "idle" | "resolving" | "candidates" | "confirming" | "installing" | "error";

type AddState = {
  source: string;
  phase: AddPhase;
  message: string;
  candidates: CandidateView[];
  selected: Set<string>;
  channel: PluginPeerChannel | null;
  pending: AbortController | null;
  reloadReminder: boolean;
  /** A terminal result is on screen; a late channel close must not replace it. */
  resultShown: boolean;
  /** Skill a Search handoff asked for; selected once the source resolves. */
  wantedSkill: string | null;
};

const EXISTING = ["none", "managed", "unmanaged"] as const;

/**
 * The Add source and selection panel. State is per hosted panel; the channel is
 * opened on an explicit Resolve or a Search handoff and closed on cancel or a
 * terminal frame.
 */
export function createAddPanel(
  html: HtmlTemplateTag,
  handoff?: AddHandoffBox,
): (context: WorkspacePanelContext) => Template {
  const states = new Map<string, AddState>();

  const stateFor = (context: WorkspacePanelContext): AddState => {
    const key = addHandoffKey(context);
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
        reloadReminder: false,
        resultShown: false,
        wantedSkill: null,
      };
      states.set(key, state);
    }
    return state;
  };

  return (context: WorkspacePanelContext): Template => {
    const state = stateFor(context);
    const render = () => context.host.requestRender();
    const busy =
      state.phase === "resolving" || state.phase === "confirming" || state.phase === "installing";
    // A cancel must reach an open that has not resolved yet, not only a live channel.
    const cancellable = state.pending !== null || (state.channel !== null && state.phase !== "idle");

    const closeChannel = (state: AddState, reason: string) => {
      const channel = state.channel;
      state.channel = null;
      channel?.close(reason);
    };

    // A failed or cancelled resolve drops the handoff's wanted skill: the next
    // manual resolve must not preselect a skill the failed handoff asked for.
    const fail = (message: string) => {
      state.phase = "error";
      state.message = message;
      state.wantedSkill = null;
      render();
    };

    const onFrame = (data: JsonValue) => {
      const frame = readFrame(data);
      if (frame === null) {
        closeChannel(state, "invalid-frame");
        fail("The server sent an invalid frame.");
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
        selectWantedSkill(state);
        state.message =
          state.candidates.length === 0
            ? "The source provides no skills."
            : `${String(state.candidates.length)} skill${state.candidates.length === 1 ? "" : "s"} found. Select what to install.`;
        render();
        return;
      }
      if (frame.type === "progress") {
        state.phase = "installing";
        state.message = `Installing ${String(frame.index + 1)} of ${String(frame.total)}: ${frame.name}…`;
        render();
        return;
      }
      if (frame.type === "done") {
        state.phase = "candidates";
        const parts: string[] = [];
        if (frame.installed.length > 0) parts.push(`Installed: ${frame.installed.join(", ")}`);
        if (frame.replaced.length > 0) parts.push(`Replaced: ${frame.replaced.join(", ")}`);
        if (frame.failed.length > 0) {
          parts.push(
            `Failed: ${frame.failed.map((failure) => `${failure.name} (${failure.message})`).join(", ")}`,
          );
        }
        state.message = `${parts.join(". ") || "No skills were installed"}.`;
        const installed = frame.installed.length + frame.replaced.length > 0;
        const installedNames = new Set([...frame.installed, ...frame.replaced]);
        for (const candidate of state.candidates) {
          if (installedNames.has(candidate.name)) candidate.existing = "managed";
        }
        state.reloadReminder = installed;
        state.resultShown = true;
        if (installed) refreshSkillList(context);
        render();
        return;
      }
      closeChannel(state, "error");
      fail(frame.message);
    };

    const resolve = async () => {
      const source = state.source.trim();
      if (source === "") {
        fail("Enter a source to add.");
        return;
      }
      state.phase = "resolving";
      state.message = "Resolving the source…";
      state.candidates = [];
      state.selected.clear();
      state.reloadReminder = false;
      state.resultShown = false;
      closeChannel(state, "replaced");
      render();

      const peer = context.peer;
      if (peer?.openChannel === undefined) {
        fail("The Skills backend is unavailable on the selected machine.");
        return;
      }
      const pending = new AbortController();
      state.pending = pending;
      // The view now offers Cancel for an open that has not resolved yet.
      render();
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
            fail("The add operation stopped. Resolve again to retry.");
            return;
          }
          if (!state.resultShown && state.phase !== "idle" && state.phase !== "error") {
            state.phase = "error";
            state.message =
              "The add session closed before it finished. Resolve the source again to retry.";
          }
          render();
        });
      } catch (error) {
        if (state.pending === pending) state.pending = null;
        if (pending.signal.aborted) return;
        fail(error instanceof Error ? error.message : String(error));
      }
    };

    const cancel = () => {
      const pending = state.pending;
      state.pending = null;
      pending?.abort();
      const channel = state.channel;
      state.channel = null;
      if (channel === null && pending === null) return;
      if (channel !== null) {
        channel.send({ type: "cancel" });
        channel.close("cancelled");
      }
      // Dismissing the list is the only useful outcome: a closed channel cannot install.
      state.phase = "idle";
      state.candidates = [];
      state.selected.clear();
      state.resultShown = false;
      state.wantedSkill = null;
      state.message = "The add operation was cancelled.";
      render();
    };

    const selectedCandidates = () =>
      state.candidates.filter((candidate) => state.selected.has(candidate.sourcePath));

    const sendInstall = () => {
      const channel = state.channel;
      if (channel === null) return;
      const selected = selectedCandidates();
      if (selected.length === 0) {
        state.message = "Select at least one skill to install.";
        render();
        return;
      }
      state.phase = "installing";
      state.message = `Starting install of ${String(selected.length)} skill${selected.length === 1 ? "" : "s"}…`;
      channel.send({
        type: "install",
        sourcePaths: selected.map((candidate) => candidate.sourcePath),
      });
      render();
    };

    const install = () => {
      const selected = selectedCandidates();
      if (state.channel === null) return;
      if (selected.length === 0) {
        state.message = "Select at least one skill to install.";
        render();
        return;
      }
      if (selected.some((candidate) => candidate.existing !== "none")) {
        state.phase = "confirming";
        state.message = `Installing replaces the existing folders for: ${selected
          .filter((candidate) => candidate.existing !== "none")
          .map((candidate) => candidate.name)
          .join(", ")}. Confirm to overwrite.`;
        render();
        return;
      }
      sendInstall();
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

    // A Search handoff waits while a resolve or install is busy, so it never
    // cancels running work.
    if (handoff !== undefined && !busy) {
      const pendingHandoff = handoff.take(addHandoffKey(context));
      if (pendingHandoff !== null) {
        state.source = pendingHandoff.source;
        state.wantedSkill = pendingHandoff.skillName;
        // Kick off after this render returns, so resolve() cannot re-enter it.
        queueMicrotask(() => {
          void resolve();
        });
      }
    }

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
                if (typeof target?.value !== "string") return;
                state.source = target.value;
                render();
              }}
            />
          </label>
          <button type="submit" class="skills-primary" ?disabled=${busy || state.source.trim() === ""}>Resolve</button>
          ${cancellable ? html`<button type="button" class="skills-ghost" @click=${cancel}>Cancel</button>` : null}
        </form>

        ${state.phase === "error"
          ? html`<p class="skills-alert" role="alert">${state.message}</p>`
          : html`<p class="skills-message" role="status" aria-live="polite">${state.message}</p>`}

        ${state.candidates.length === 0
          ? null
          : html`
              <fieldset ?disabled=${busy}>
                <legend>
                  ${String(state.candidates.length)} discovered
                  skill${state.candidates.length === 1 ? "" : "s"}
                </legend>
                <label class="skills-select-all">
                  <input
                    type="checkbox"
                    ?checked=${allSelected}
                    @change=${toggleAll}
                  />
                  Select all
                </label>
                <ul class="skills-candidates">
                  ${state.candidates.map(
                    (candidate) => html`
                      <li class="skills-candidate">
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
                          : html`<span class="skills-badge">
                              ${candidate.existing === "managed"
                                ? "Already installed — an overwrite confirmation will come before install"
                                : "Unmanaged — an overwrite confirmation will come before install"}
                            </span>`}
                        <p class="skills-description">${candidate.description}</p>
                        <small>${candidate.sourcePath}</small>
                      </li>
                    `,
                  )}
                </ul>
              </fieldset>
              ${state.phase === "confirming"
                ? html`<button type="button" class="skills-primary" @click=${sendInstall}>Overwrite and install</button>`
                : html`<button
                    type="button"
                    class="skills-primary"
                    ?disabled=${busy || state.selected.size === 0 || state.channel === null}
                    @click=${install}
                  >
                    Install selected (${String(state.selected.size)})
                  </button>`}
              ${state.reloadReminder
                ? html`<p class="skills-notice" role="status">
                    <span>Skills were installed. Run <code>/reload</code> so the agent picks them up.</span>
                    <button
                      type="button"
                      class="skills-ghost"
                      @click=${() => {
                        state.reloadReminder = false;
                        render();
                      }}
                    >
                      Dismiss
                    </button>
                  </p>`
                : null}
            `}
      </section>
    `;
  };
}

/** Select the skill a Search handoff asked for; no match leaves every candidate unselected. */
function selectWantedSkill(state: AddState): void {
  const wanted = state.wantedSkill;
  state.wantedSkill = null;
  if (wanted === null) return;
  const sanitized = sanitizeName(wanted);
  const match = state.candidates.find(
    (candidate) =>
      candidate.name === wanted ||
      sanitizeName(candidate.name) === sanitized ||
      sanitizeName(candidate.folderName) === sanitized,
  );
  if (match !== undefined) state.selected.add(match.sourcePath);
}

type ServerFrame =
  | { readonly type: "candidates"; readonly candidates: CandidateView[] }
  | { readonly type: "candidates-end"; readonly total: number }
  | {
      readonly type: "progress";
      readonly phase: string;
      readonly name: string;
      readonly index: number;
      readonly total: number;
    }
  | {
      readonly type: "done";
      readonly installed: string[];
      readonly replaced: string[];
      readonly failed: { readonly name: string; readonly message: string }[];
    }
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
  if (type === "progress") {
    const { phase, name, index, total } = data;
    if (
      typeof phase !== "string" ||
      typeof name !== "string" ||
      typeof index !== "number" ||
      typeof total !== "number"
    ) {
      return null;
    }
    return { type: "progress", phase, name, index, total };
  }
  if (type === "done") {
    const installed = readNames(data["installed"]);
    const replaced = readNames(data["replaced"]);
    const failed = readFailures(data["failed"]);
    if (installed === null || replaced === null || failed === null) return null;
    return { type: "done", installed, replaced, failed };
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

function readFailures(
  value: JsonValue | undefined,
): { readonly name: string; readonly message: string }[] | null {
  if (!Array.isArray(value)) return null;
  const failures: { readonly name: string; readonly message: string }[] = [];
  for (const failure of value) {
    if (!isRecord(failure)) return null;
    const { name, message } = failure;
    if (typeof name !== "string" || typeof message !== "string") return null;
    failures.push({ name, message });
  }
  return failures;
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
