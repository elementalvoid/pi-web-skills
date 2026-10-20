import assert from "node:assert/strict";
import test from "node:test";
import { operationError } from "../src/operations/errors.ts";

test("an operation error without details has no details key", () => {
  const error = operationError("lock-unreadable", "the file is not valid JSON");

  assert.deepEqual(error, {
    code: "lock-unreadable",
    message: "the file is not valid JSON",
  });
});
