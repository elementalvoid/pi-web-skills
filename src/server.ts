import { homedir, tmpdir } from "node:os";
import type {
  JsonValue,
  PiWebServerPlugin,
  ServerPluginPeerRequestContext,
} from "@jmfederico/pi-web/server-plugin-api";
import { openAddChannel } from "./operations/add-channel.ts";
import type { Environment } from "./operations/paths.ts";
import { resolveSkillPaths } from "./operations/paths.ts";
import type { ListPayload } from "./operations/list.ts";
import { listSkills } from "./operations/list.ts";
import type { StatusPayload } from "./operations/status.ts";
import { getStatus } from "./operations/status.ts";

export type PeerRequest = {
  readonly operation: string;
  readonly input: JsonValue;
  readonly signal: AbortSignal;
};

export type PeerResponse =
  | { readonly ok: true; readonly value: StatusPayload | ListPayload }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };

/** Peer router: validate the request, then run the matching operation. */
export async function handlePeerRequest(
  request: PeerRequest,
  environment: Environment,
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
  apiVersion: 3,
  name: "Skills",
  activate({ pluginId, logger, execFile }) {
    logger.info("Activating Skills plugin", { pluginId });
    return {
      peer: {
        request: (context: ServerPluginPeerRequestContext) =>
          handlePeerRequest(
            { operation: context.operation, input: context.input, signal: context.signal },
            daemonEnvironment(),
          ),
        openChannel: (context) =>
          openAddChannel(
            {
              operation: context.operation,
              input: context.input,
              signal: context.signal,
              send: context.send,
            },
            {
              paths: resolveSkillPaths(daemonEnvironment()),
              exec: execFile,
              tempRoot: tmpdir(),
            },
          ),
      },
    };
  },
};

export default plugin;

function daemonEnvironment(): Environment {
  return { home: homedir(), xdgStateHome: process.env["XDG_STATE_HOME"] };
}

function failure(code: string, message: string): PeerResponse {
  return { ok: false, error: { code, message } };
}
