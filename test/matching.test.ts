import assert from "node:assert/strict";
import test from "node:test";
import { matchSkillName, sanitizeName } from "../src/operations/matching.ts";

test("a name sanitiser produces the install folder name upstream would use", () => {
  assert.equal(sanitizeName("ce:review"), "ce-review");
  assert.equal(sanitizeName("React Best Practices!"), "react-best-practices");
  assert.equal(sanitizeName("  .hidden.name  "), "hidden.name");
  assert.equal(sanitizeName("../escape"), "escape");
  assert.equal(sanitizeName("###"), "unnamed-skill");
  assert.equal(sanitizeName("x".repeat(300)).length, 255);
});

test("a lock key wins over an exact folder name", () => {
  assert.deepEqual(
    matchSkillName("ce:review", { lockKeys: ["ce:review"], folderNames: ["ce-review"] }),
    { lockKey: "ce:review", folderName: "ce-review" },
  );
});

test("a sanitised lock key matches a folder whose name only differs by punctuation", () => {
  assert.deepEqual(
    matchSkillName("ce:review", { lockKeys: ["ce-review"], folderNames: ["ce-review"] }),
    { lockKey: "ce-review", folderName: "ce-review" },
  );
});

test("a present folder resolves the lock key that sanitises to it", () => {
  assert.deepEqual(
    matchSkillName("ce-review", { lockKeys: ["ce:review"], folderNames: ["ce-review"] }),
    { lockKey: "ce:review", folderName: "ce-review" },
  );
});

test("an exact lock key beats a sanitised one", () => {
  assert.equal(
    matchSkillName("ce-review", { lockKeys: ["ce:review", "ce-review"], folderNames: [] })?.lockKey,
    "ce-review",
  );
});

test("a sanitised folder name is found when the requested name differs", () => {
  assert.deepEqual(matchSkillName("CE Review", { lockKeys: [], folderNames: ["ce-review"] }), {
    lockKey: null,
    folderName: "ce-review",
  });
});

test("an unmanaged folder resolves without a lock key", () => {
  assert.deepEqual(matchSkillName("demo", { lockKeys: [], folderNames: ["demo"] }), {
    lockKey: null,
    folderName: "demo",
  });
});

test("a broken entry resolves without a folder", () => {
  assert.deepEqual(matchSkillName("demo", { lockKeys: ["demo"], folderNames: [] }), {
    lockKey: "demo",
    folderName: null,
  });
});

test("an unknown name resolves nothing", () => {
  assert.equal(matchSkillName("absent", { lockKeys: ["demo"], folderNames: ["demo"] }), null);
});
