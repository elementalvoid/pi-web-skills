import type { JsonValue, OperationErrorCode } from "./errors.ts";
import { operationError } from "./errors.ts";
import type { SkillPaths } from "./paths.ts";
import type { UpdateFrame, UpdateSession } from "./update.ts";
import { createUpdateSession } from "./update.ts";
import type { ExecFile } from "../upstream/git.ts";
import type { FetchLike } from "../upstream/github-tree.ts";

/** The slice of the host's channel-open context this adapter needs. */
export type UpdateChannelContext = {
  readonly operation: string;
  readonly input: JsonValue;
  readonly signal: AbortSignal;
  readonly send: (data: JsonValue) => void;
};

export type UpdateChannelDependencies = {
  readonly paths: SkillPaths;
  readonly exec: ExecFile;
  readonly tempRoot: string;
  readonly fetch: FetchLike;
  readonly getToken: () => string | null;
  readonly now?: (() => Date) | undefined;
};

export type UpdatePeerChannel = {
  readonly receive: (data: JsonValue, signal: AbortSignal) => void;
  readonly close: () => Promise<void>;
};

const MAX_NAMES = 100;
const MAX_NAME_LENGTH = 255;

/**
 * Peer adapter for the `update` channel. Open validates and hands the work to
 * the session, which runs on the channel lifetime signal; the callback returns
 * immediately and the session streams progress.
 */
export function openUpdateChannel(
  context: UpdateChannelContext,
  dependencies: UpdateChannelDependencies,
): UpdatePeerChannel {
  let closed = false;
  let session: UpdateSession | null = null;

  const send = (frame: UpdateFrame): void => {
    if (closed) return;
    try {
      // SAFETY: UpdateFrame is a closed, JSON-safe union (strings and arrays of
      // strings only); the host clones and validates it at the channel boundary.
      context.send(frame as unknown as JsonValue);
    } catch {
      closed = true;
      session?.cancel();
    }
  };
  const fail = (code: OperationErrorCode, message: string): void => {
    send({ type: "error", error: operationError(code, message) });
  };

  if (context.operation !== "update") {
    fail("unknown-operation", `Unsupported channel "${context.operation}"`);
    return inertChannel(() => {
      closed = true;
    });
  }

  const input = readUpdateInput(context.input);
  if (input === null) {
    fail("invalid-input", "update takes { names?: string[], checkOnly?: boolean }.");
    return inertChannel(() => {
      closed = true;
    });
  }

  session = createUpdateSession(
    {
      paths: dependencies.paths,
      signal: context.signal,
      exec: dependencies.exec,
      tempRoot: dependencies.tempRoot,
      fetch: dependencies.fetch,
      getToken: dependencies.getToken,
      ...(input.names === undefined ? {} : { names: input.names }),
      ...(input.checkOnly ? { checkOnly: true } : {}),
      ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
    },
    send,
  );
  session.start();

  const active = session;
  return {
    receive(data) {
      if (closed) return;
      if (isCancel(data)) {
        active.cancel();
        return;
      }
      fail("invalid-input", "Unsupported update frame.");
    },
    async close() {
      closed = true;
      await active.dispose();
    },
  };
}

type UpdateInput = {
  readonly names?: readonly string[];
  readonly checkOnly: boolean;
};

/** Validate an update input; `undefined` or an empty names list means every managed entry. */
function readUpdateInput(input: JsonValue): UpdateInput | null {
  if (!isRecord(input)) return null;
  for (const key of Object.keys(input)) {
    if (key !== "names" && key !== "checkOnly") return null;
  }

  let names: readonly string[] | undefined;
  if ("names" in input) {
    const value = input["names"];
    if (!Array.isArray(value) || value.length > MAX_NAMES) return null;
    const requested: string[] = [];
    for (const name of value) {
      if (typeof name !== "string" || name === "" || name.length > MAX_NAME_LENGTH) return null;
      if (!requested.includes(name)) requested.push(name);
    }
    names = requested;
  }

  let checkOnly = false;
  if ("checkOnly" in input) {
    if (typeof input["checkOnly"] !== "boolean") return null;
    checkOnly = input["checkOnly"];
  }

  return { ...(names === undefined ? {} : { names }), checkOnly };
}

function isCancel(data: JsonValue): boolean {
  return isRecord(data) && data["type"] === "cancel" && Object.keys(data).length === 1;
}

function inertChannel(close: () => void): UpdatePeerChannel {
  return {
    receive() {},
    async close() {
      close();
    },
  };
}

function isRecord(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
