import type { AddSession } from "./add.ts";
import { createAddSession } from "./add.ts";
import type { AddFrame } from "./add.ts";
import type { JsonValue, OperationErrorCode } from "./errors.ts";
import { operationError } from "./errors.ts";
import type { SkillPaths } from "./paths.ts";
import type { ExecFile } from "../upstream/git.ts";

/** The slice of the host's channel-open context this adapter needs. */
export type AddChannelContext = {
  readonly operation: string;
  readonly input: JsonValue;
  readonly signal: AbortSignal;
  readonly send: (data: JsonValue) => void;
};

export type AddChannelDependencies = {
  readonly paths: SkillPaths;
  readonly exec: ExecFile;
  readonly tempRoot: string;
};

export type AddPeerChannel = {
  readonly receive: (data: JsonValue, signal: AbortSignal) => void;
  readonly close: () => Promise<void>;
};

type AddChannelFrame =
  | { readonly type: "install"; readonly names: readonly string[] }
  | { readonly type: "cancel" };

/**
 * Peer adapter for the `add` channel. Open and receive validate and hand work
 * to the session, which runs on the channel lifetime signal; neither waits for
 * the clone or discovery.
 */
export function openAddChannel(
  context: AddChannelContext,
  dependencies: AddChannelDependencies,
): AddPeerChannel {
  let closed = false;
  let session: AddSession | null = null;

  const send = (frame: AddFrame): void => {
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

  if (context.operation !== "add") {
    fail("unknown-operation", `Unsupported channel "${context.operation}"`);
    return inertChannel(() => {
      closed = true;
    });
  }

  const source = readSourceInput(context.input);
  if (source === null) {
    fail("invalid-input", "add takes { source: string }.");
    return inertChannel(() => {
      closed = true;
    });
  }

  session = createAddSession(
    {
      source,
      paths: dependencies.paths,
      exec: dependencies.exec,
      tempRoot: dependencies.tempRoot,
      signal: context.signal,
    },
    send,
  );
  session.start();

  const active = session;
  return {
    receive(data) {
      if (closed) return;
      const frame = readFrame(data);
      if (frame === null) {
        fail("invalid-input", "Unsupported add frame.");
        return;
      }
      if (frame.type === "cancel") {
        active.cancel();
        return;
      }
      active.install(frame.names);
    },
    async close() {
      closed = true;
      await active.dispose();
    },
  };
}

function inertChannel(close: () => void): AddPeerChannel {
  return {
    receive() {},
    async close() {
      close();
    },
  };
}

function readSourceInput(input: JsonValue): string | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const record = input as { readonly [key: string]: JsonValue };
  if (Object.keys(record).length !== 1 || typeof record["source"] !== "string") return null;
  return record["source"];
}

function readFrame(data: JsonValue): AddChannelFrame | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const record = data as { readonly [key: string]: JsonValue };
  if (record["type"] === "cancel" && Object.keys(record).length === 1) return { type: "cancel" };
  if (record["type"] !== "install") return null;
  const names = record["names"];
  if (!Array.isArray(names) || !names.every((name) => typeof name === "string")) return null;
  return { type: "install", names };
}
