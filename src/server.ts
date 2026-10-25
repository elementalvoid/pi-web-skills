import { homedir, tmpdir } from "node:os";
import type {
  JsonValue,
  PiWebServerPlugin,
  ServerPluginPeerRequestContextV5,
} from "@jmfederico/pi-web/server-plugin-api";
import { openAddChannel } from "./operations/add-channel.ts";
import { openUpdateChannel } from "./operations/update-channel.ts";
import type { Environment } from "./operations/paths.ts";
import { resolveSkillPaths } from "./operations/paths.ts";
import type { ListPayload } from "./operations/list.ts";
import { listSkills } from "./operations/list.ts";
import type { RemovePayload } from "./operations/remove.ts";
import { readRemoveNames, removeSkills } from "./operations/remove.ts";
import type { FetchLike, SearchPayload } from "./operations/search.ts";
import { readSearchQuery, searchSkills } from "./operations/search.ts";
import type { StatusPayload } from "./operations/status.ts";
import { getStatus } from "./operations/status.ts";

export type PeerRequest = {
  readonly operation: string;
  readonly input: JsonValue;
  readonly signal: AbortSignal;
};

export type PeerResponse =
  | {
      readonly ok: true;
      readonly value: StatusPayload | ListPayload | RemovePayload | SearchPayload;
    }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };

/** Injectable network seam; production uses the global fetch against skills.sh. */
export type PeerDependencies = {
  readonly fetch?: FetchLike;
  readonly searchBaseUrl?: string;
};

/** Peer router: validate the request, then run the matching operation. */
export async function handlePeerRequest(
  request: PeerRequest,
  environment: Environment,
  dependencies: PeerDependencies = {},
): Promise<PeerResponse> {
  try {
    return await routePeerRequest(request, environment, dependencies);
  } catch (error) {
    // A disconnecting client or a surprising failure still gets one JSON answer,
    // so the host never sees an unhandled rejection.
    if (request.signal.aborted || isAbortError(error)) {
      return failure("cancelled", "The request was cancelled.");
    }
    return failure(
      "internal-error",
      `The ${request.operation} request failed: ${describe(error)}`,
    );
  }
}

async function routePeerRequest(
  request: PeerRequest,
  environment: Environment,
  dependencies: PeerDependencies,
): Promise<PeerResponse> {
  if (request.operation === "list") {
    if (request.input !== null) {
      return failure("invalid-input", "list takes no input");
    }
    const value = await listSkills({
      paths: resolveSkillPaths(environment),
      signal: request.signal,
    });
    return { ok: true, value };
  }
  if (request.operation === "remove") {
    const names = readRemoveNames(request.input);
    if (names === null) return failure("invalid-input", "remove takes { names: string[] }");
    const removed = await removeSkills(
      { paths: resolveSkillPaths(environment), signal: request.signal },
      names,
    );
    return removed.ok
      ? { ok: true, value: removed.value }
      : failure(removed.error.code, removed.error.message);
  }
  if (request.operation === "search") {
    const query = readSearchQuery(request.input);
    if (query === null) return failure("invalid-input", "search takes { query: string }");
    const found = await searchSkills(
      {
        signal: request.signal,
        fetch: dependencies.fetch ?? hostFetch,
        baseUrl: dependencies.searchBaseUrl,
      },
      query,
    );
    return found.ok
      ? { ok: true, value: found.value }
      : failure(found.error.code, found.error.message);
  }
  if (request.operation !== "status") {
    return failure("unknown-operation", `Unsupported operation "${request.operation}"`);
  }
  if (request.input !== null) {
    return failure("invalid-input", "status takes no input");
  }
  const value = await getStatus({ paths: resolveSkillPaths(environment), signal: request.signal });
  return { ok: true, value };
}

const plugin: PiWebServerPlugin = {
  apiVersion: 5,
  name: "Skills",
  activate({ pluginId, logger, execFile }) {
    logger.info("Activating Skills plugin", { pluginId });
    return {
      peer: {
        request: (context: ServerPluginPeerRequestContextV5) =>
          handlePeerRequest(
            { operation: context.operation, input: context.input, signal: context.signal },
            daemonEnvironment(),
          ),
        openChannel: (context) => {
          const channel = {
            operation: context.operation,
            input: context.input,
            signal: context.signal,
            send: context.send,
          };
          const dependencies = {
            paths: resolveSkillPaths(daemonEnvironment()),
            exec: execFile,
            tempRoot: tmpdir(),
          };
          if (context.operation === "update") {
            return openUpdateChannel(channel, {
              ...dependencies,
              fetch: globalThis.fetch,
              getToken: githubToken,
            });
          }
          return openAddChannel(channel, dependencies);
        },
      },
    };
  },
};

export default plugin;

function githubToken(): string | null {
  return process.env["GITHUB_TOKEN"] ?? process.env["GH_TOKEN"] ?? null;
}

function daemonEnvironment(): Environment {
  return { home: homedir(), xdgStateHome: process.env["XDG_STATE_HOME"] };
}

function failure(code: string, message: string): PeerResponse {
  return { ok: false, error: { code, message } };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const hostFetch: FetchLike = async (url, init) => {
  const response = await fetch(url, { signal: init.signal });
  return { status: response.status, json: () => response.json() };
};
