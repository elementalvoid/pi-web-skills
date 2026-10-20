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
  /** Resolves once a terminal frame is sent and the clone is cleaned up. */
  readonly closed: Promise<void>;
  readonly close: () => Promise<void>;
};

type AddChannelFrame =
  | { readonly type: "install"; readonly sourcePaths: readonly string[] }
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
  let resolveClosed: () => void = () => {};
  const closedSignal = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  let shutdownPromise: Promise<void> | null = null;

  const shutdown = (): Promise<void> => {
    shutdownPromise ??= (async () => {
      const active = session;
      session = null;
      try {
        if (active !== null) await active.dispose();
      } finally {
        resolveClosed();
      }
    })();
    return shutdownPromise;
  };

  const finish = (): void => {
    if (closed) return;
    closed = true;
    void shutdown().catch(() => undefined);
  };

  const send = (frame: AddFrame): void => {
    if (closed) return;
    try {
      context.send(frame as unknown as JsonValue);
    } catch {
      closed = true;
      session?.cancel();
      void shutdown().catch(() => undefined);
      return;
    }
    // `done` and `error` are terminal: the host closes the channel after them.
    if (frame.type === "done" || frame.type === "error") finish();
  };
  const fail = (code: OperationErrorCode, message: string): void => {
    send({ type: "error", error: operationError(code, message) });
  };

  const terminalChannel = (): AddPeerChannel => ({
    receive() {},
    closed: closedSignal,
    async close() {
      closed = true;
      await shutdown();
    },
  });

  if (context.operation !== "add") {
    fail("unknown-operation", `Unsupported channel "${context.operation}"`);
    return terminalChannel();
  }

  const source = readSourceInput(context.input);
  if (source === null) {
    fail("invalid-input", "add takes { source: string }.");
    return terminalChannel();
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
  const active = session;
  active.start();

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
      active.install(frame.sourcePaths);
    },
    closed: closedSignal,
    async close() {
      closed = true;
      await shutdown();
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
  const sourcePaths = record["sourcePaths"];
  if (!Array.isArray(sourcePaths) || !sourcePaths.every((value) => typeof value === "string")) {
    return null;
  }
  return { type: "install", sourcePaths };
}
