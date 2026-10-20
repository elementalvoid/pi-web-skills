/** Structured failure carried by operations instead of a thrown error. */
export type OperationErrorCode = "lock-unreadable" | "unsafe-path";

export type OperationError = {
  readonly code: OperationErrorCode;
  readonly message: string;
};

export function operationError(code: OperationErrorCode, message: string): OperationError {
  return { code, message };
}
