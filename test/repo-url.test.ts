import assert from "node:assert/strict";
import test from "node:test";
import { skillFileUrl } from "../src/browser/repo-url.ts";

test("a GitHub skill links to its file view at the recorded ref", () => {
  assert.equal(
    skillFileUrl({
      sourceType: "github",
      source: "longbridge/gpui-kit",
      ref: "main",
      skillPath: "skills/gpui-kit/SKILL.md",
    }),
    "https://github.com/longbridge/gpui-kit/blob/main/skills/gpui-kit/SKILL.md",
  );
});

test("a missing ref falls back to the default branch", () => {
  assert.equal(
    skillFileUrl({
      sourceType: "github",
      source: "owner/repo",
      ref: null,
      skillPath: "SKILL.md",
    }),
    "https://github.com/owner/repo/blob/HEAD/SKILL.md",
  );
});

test("a GitLab skill keeps the namespace separator and nested groups", () => {
  assert.equal(
    skillFileUrl({
      sourceType: "gitlab",
      source: "group/sub/repo",
      ref: "v1.2.0",
      skillPath: "skills/demo/SKILL.md",
    }),
    "https://gitlab.com/group/sub/repo/-/blob/v1.2.0/skills/demo/SKILL.md",
  );
});

test("path segments and refs are encoded without losing their separators", () => {
  assert.equal(
    skillFileUrl({
      sourceType: "github",
      source: "owner/repo",
      ref: "feature/add panel",
      skillPath: "skills/my skill/SKILL.md",
    }),
    "https://github.com/owner/repo/blob/feature/add%20panel/skills/my%20skill/SKILL.md",
  );
});

test("a source with no known file view stays unlinked", () => {
  for (const location of [
    { sourceType: "git", source: "https://example.com/owner/repo.git", ref: null, skillPath: "SKILL.md" },
    { sourceType: "local", source: "/home/me/repo", ref: null, skillPath: "SKILL.md" },
    { sourceType: "github", source: "https://github.com/owner/repo", ref: null, skillPath: "SKILL.md" },
    { sourceType: "github", source: "owner", ref: null, skillPath: "SKILL.md" },
    { sourceType: null, source: "owner/repo", ref: null, skillPath: "SKILL.md" },
    { sourceType: "github", source: "owner/repo", ref: null, skillPath: null },
    { sourceType: "github", source: null, ref: null, skillPath: "SKILL.md" },
  ]) {
    assert.equal(skillFileUrl(location), null, JSON.stringify(location));
  }
});
