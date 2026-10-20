import type {
  HtmlTemplateTag,
  JsonValue,
  WorkspacePanelContext,
} from "@jmfederico/pi-web/plugin-api";
import type { StatusPayload } from "../operations/status.ts";

type StatusState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly status: StatusPayload }
  | { readonly kind: "error"; readonly message: string };

// Machine-wide state, keyed by machine: every workspace on a machine shares it.
const statuses = new Map<string, StatusState>();
const generations = new Map<string, number>();

function nextGeneration(key: string): number {
  const next = (generations.get(key) ?? 0) + 1;
  generations.set(key, next);
  return next;
}

/** Drop the cached status so the next render re-reads the paths. */
export function refreshMachineStatus(context: WorkspacePanelContext): void {
  const key = context.machine.id;
  // A panel that never showed status has nothing to refresh and must not make
  // an extra request for a section the user is not looking at.
  if (!statuses.has(key)) return;
  statuses.delete(key);
  nextGeneration(key);
  context.host.requestRender();
}

/** The machine-wide notice's paths, with loading, error, and retry states. */
export function renderMachineStatus(
  html: HtmlTemplateTag,
  context: WorkspacePanelContext,
): ReturnType<HtmlTemplateTag> {
  const key = context.machine.id;
  let status = statuses.get(key);
  if (status === undefined) {
    status = { kind: "loading" };
    statuses.set(key, status);
    void loadStatus(context, key);
  }
  if (status.kind === "loading") {
    return html`<p aria-live="polite">Loading machine status…</p>`;
  }
  if (status.kind === "error") {
    return html`
      <p role="alert">Machine status unavailable: ${status.message}</p>
      <button type="button" @click=${() => refreshMachineStatus(context)}>Retry</button>
    `;
  }
  return html`
    <dl>
      <dt>Managed directory</dt>
      <dd>
        <code>${status.status.managedDirectory}</code>
        — ${status.status.managedDirectoryExists ? "exists" : "missing"}
      </dd>
      <dt>Lockfile</dt>
      <dd>
        <code>${status.status.lockfilePath}</code>
        — ${describeLock(status.status)}
      </dd>
    </dl>
  `;
}

async function loadStatus(context: WorkspacePanelContext, key: string): Promise<void> {
  const generation = nextGeneration(key);
  try {
    if (context.peer?.request === undefined) throw new Error("The package peer is unavailable");
    const response = await context.peer.request("status", null);
    if (generations.get(key) !== generation) return;
    statuses.set(key, { kind: "ready", status: readStatus(response) });
  } catch (error) {
    if (generations.get(key) !== generation) return;
    statuses.set(key, {
      kind: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    if (generations.get(key) === generation) context.host.requestRender();
  }
}

function readStatus(response: JsonValue): StatusPayload {
  if (!isRecord(response)) throw new Error("The server returned an invalid status");
  if (response["ok"] !== true) {
    const error = response["error"];
    throw new Error(
      isRecord(error) && typeof error["message"] === "string"
        ? error["message"]
        : "The server rejected the status request",
    );
  }
  const value = response["value"];
  if (!isRecord(value)) throw new Error("The server returned an invalid status");
  return {
    managedDirectory: readString(value, "managedDirectory"),
    lockfilePath: readString(value, "lockfilePath"),
    managedDirectoryExists: readBoolean(value, "managedDirectoryExists"),
    lockfileExists: readBoolean(value, "lockfileExists"),
    lockReadable: readBoolean(value, "lockReadable"),
  };
}

function describeLock(status: StatusPayload): string {
  if (!status.lockfileExists) return "missing";
  return status.lockReadable ? "exists and readable" : "exists but unreadable";
}

function isRecord(value: JsonValue | undefined): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: { readonly [key: string]: JsonValue }, key: string): string {
  const field = value[key];
  if (typeof field !== "string") throw new Error(`The server returned an invalid status: ${key}`);
  return field;
}

function readBoolean(value: { readonly [key: string]: JsonValue }, key: string): boolean {
  const field = value[key];
  if (typeof field !== "boolean") throw new Error(`The server returned an invalid status: ${key}`);
  return field;
}
