import type { HtmlTemplateTag, JsonValue, WorkspacePanelContext } from "@jmfederico/pi-web/plugin-api";
import type { AddHandoffBox } from "./add-handoff.ts";
import { addHandoffKey } from "./add-handoff.ts";
import type { SearchResult } from "../operations/search.ts";

type Template = ReturnType<HtmlTemplateTag>;

type SearchState = {
  query: string;
  phase: "idle" | "loading" | "ready" | "error" | "cancelled";
  results: readonly SearchResult[];
  message: string;
  sequence: number;
};

/**
 * The Search section. A request only reads skills.sh; Add from a result fills
 * the shared handoff so the Add panel resolves that source and selects the
 * matching skill. Search never writes.
 */
export function createSearchPanel(
  html: HtmlTemplateTag,
  handoff: AddHandoffBox,
): (context: WorkspacePanelContext) => Template {
  const states = new Map<string, SearchState>();

  const stateFor = (context: WorkspacePanelContext): SearchState => {
    const key = addHandoffKey(context);
    let state = states.get(key);
    if (state === undefined) {
      state = { query: "", phase: "idle", results: [], message: "", sequence: 0 };
      states.set(key, state);
    }
    return state;
  };

  return (context: WorkspacePanelContext): Template => {
    const state = stateFor(context);
    const render = () => context.host.requestRender();
    const loading = state.phase === "loading";

    const search = async () => {
      const query = state.query.trim();
      const sequence = (state.sequence += 1);
      state.results = [];
      state.message = "";
      if (query === "") {
        state.phase = "idle";
        render();
        return;
      }
      state.phase = "loading";
      render();
      try {
        if (context.peer?.request === undefined) {
          throw new Error("The Skills backend is unavailable on the selected machine.");
        }
        const outcome = readResponse(await context.peer.request("search", { query }));
        if (sequence !== state.sequence) return;
        if (outcome.kind === "cancelled") state.phase = "cancelled";
        else if (outcome.kind === "error") {
          state.phase = "error";
          state.message = outcome.message;
        } else {
          state.phase = "ready";
          state.results = outcome.results;
        }
      } catch (error) {
        if (sequence !== state.sequence) return;
        if (error instanceof DOMException && error.name === "AbortError") {
          state.phase = "cancelled";
        } else {
          state.phase = "error";
          state.message = error instanceof Error ? error.message : String(error);
        }
      } finally {
        if (sequence === state.sequence) render();
      }
    };

    const add = (result: SearchResult) => {
      handoff.set(addHandoffKey(context), { source: result.source, skillName: result.name });
      render();
    };

    const renderState = (): Template => {
      if (loading) return html`<p aria-live="polite">Searching skills.sh…</p>`;
      if (state.phase === "error") return html`<p role="alert">${state.message}</p>`;
      if (state.phase === "cancelled") {
        return html`<p role="status">The search was cancelled.</p>`;
      }
      if (state.phase === "idle") {
        return html`<p>
          Search skills.sh by keyword to find a source. Searching never changes what is
          installed.
        </p>`;
      }
      if (state.results.length === 0) {
        return html`<p>No skills found for ${state.query.trim()}. Try another keyword.</p>`;
      }
      return html`
        <ul>
          ${state.results.map(
            (result) => html`
              <li>
                <strong>${result.name}</strong>
                <code>${result.source}</code>
                <span>${result.installs} installs</span>
                <button type="button" @click=${() => add(result)}>Add ${result.name}</button>
              </li>
            `,
          )}
        </ul>
      `;
    };

    return html`
      <section aria-labelledby="skills-search-heading">
        <h3 id="skills-search-heading">Search skills.sh</h3>
        <form
          @submit=${(event: Event) => {
            event.preventDefault();
            void search();
          }}
        >
          <label>
            Keyword
            <input
              type="search"
              autocomplete="off"
              spellcheck="false"
              .value=${state.query}
              placeholder="react, testing, docs"
              @input=${(event: Event) => {
                const target = event.target as { value?: unknown } | null;
                if (typeof target?.value !== "string") return;
                state.query = target.value;
                render();
              }}
            />
          </label>
          <button type="submit" ?disabled=${loading || state.query.trim() === ""}>Search</button>
        </form>
        ${renderState()}
      </section>
    `;
  };
}

type Outcome =
  | { readonly kind: "results"; readonly results: readonly SearchResult[] }
  | { readonly kind: "cancelled" }
  | { readonly kind: "error"; readonly message: string };

function readResponse(response: JsonValue): Outcome {
  if (!isRecord(response)) return invalid();
  if (response["ok"] !== true) {
    const error = response["error"];
    if (isRecord(error) && error["code"] === "cancelled") return { kind: "cancelled" };
    return {
      kind: "error",
      message:
        isRecord(error) && typeof error["message"] === "string"
          ? error["message"]
          : "The search failed.",
    };
  }
  const value = response["value"];
  if (!isRecord(value) || !Array.isArray(value["results"])) return invalid();
  const results: SearchResult[] = [];
  for (const row of value["results"]) {
    if (
      !isRecord(row) ||
      typeof row["id"] !== "string" ||
      typeof row["name"] !== "string" ||
      typeof row["source"] !== "string" ||
      typeof row["installs"] !== "number"
    ) {
      return invalid();
    }
    results.push({
      id: row["id"],
      name: row["name"],
      source: row["source"],
      installs: row["installs"],
    });
  }
  return { kind: "results", results };
}

function invalid(): Outcome {
  return { kind: "error", message: "The server returned an invalid search response." };
}

function isRecord(value: JsonValue | undefined): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
