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

  const names = readUpdateNames(context.input);
  if (names === null) {
    fail("invalid-input", "update takes { names?: string[] }.");
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
      ...(names === undefined ? {} : { names }),
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

/** Validate an update input; `undefined` names means every managed entry. */
function readUpdateNames(input: JsonValue): readonly string[] | undefined | null {
  if (!isRecord(input)) return null;
  const keys = Object.keys(input);
  if (keys.length === 0) return undefined;
  if (keys.length !== 1 || keys[0] !== "names") return null;
  const names = input["names"];
  if (!Array.isArray(names) || names.length > MAX_NAMES) return null;
  const requested: string[] = [];
  for (const name of names) {
    if (typeof name !== "string" || name === "" || name.length > MAX_NAME_LENGTH) return null;
    if (!requested.includes(name)) requested.push(name);
  }
  return requested;
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
