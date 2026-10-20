/** Strict JSON value carried by error details; operations never exchange functions or classes. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/** Structured failure carried by operations instead of a thrown error. */
export type OperationErrorCode =
  | "lock-unreadable"
  | "unsafe-path"
  | "invalid-input"
  | "unknown-operation"
  | "unsupported-source"
  | "clone-failed"
  | "auth-required"
  | "folder-hash-failed"
  | "discovery-failed"
  | "install-failed"
  | "skill-not-found"
  | "not-found"
  | "not-managed"
  | "remove-failed";

export type OperationError = {
  readonly code: OperationErrorCode;
  readonly message: string;
  readonly details?: JsonValue;
};

/** One operation outcome: a JSON-friendly value or a structured error. */
export type ResultFailure = { readonly ok: false; readonly error: OperationError };

export type Result<T> = { readonly ok: true; readonly value: T } | ResultFailure;

export function operationError(
  code: OperationErrorCode,
  message: string,
  details?: JsonValue,
): OperationError {
  return details === undefined ? { code, message } : { code, message, details };
}
