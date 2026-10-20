import assert from "node:assert/strict";
import test from "node:test";
import { resolveAddSource } from "../src/operations/add.ts";

function accepted(source: string) {
  const result = resolveAddSource(source);
  assert.equal(result.ok, true, `${source} should be accepted: ${JSON.stringify(result)}`);
  if (!result.ok) throw new Error("unreachable");
  return result.value;
}

function rejected(source: string) {
  const result = resolveAddSource(source);
  assert.equal(result.ok, false, `${JSON.stringify(source)} should be rejected`);
  if (result.ok) throw new Error("unreachable");
  assert.equal(result.error.code, "unsupported-source");
  return result.error.message;
}

test("a GitHub shorthand resolves to the GitHub clone URL", () => {
  const parsed = accepted("vercel-labs/agent-skills");

  assert.equal(parsed.type, "github");
  assert.equal(parsed.url, "https://github.com/vercel-labs/agent-skills.git");
});

test("a shorthand keeps an optional #ref and @skill fragment", () => {
  const withRef = accepted("vercel-labs/agent-skills#v1.2.3");
  assert.equal(withRef.type, "github");
  assert.equal(withRef.ref, "v1.2.3");

  const withSkill = accepted("vercel-labs/agent-skills@pdf");
  assert.equal(withSkill.skillFilter, "pdf");
});

test("a GitHub tree URL resolves to a ref and a subpath", () => {
  const parsed = accepted("https://github.com/vercel-labs/agent-skills/tree/main/skills/pdf");

  assert.equal(parsed.type, "github");
  assert.equal(parsed.url, "https://github.com/vercel-labs/agent-skills.git");
  assert.equal(parsed.ref, "main");
  assert.equal(parsed.subpath, "skills/pdf");
});

test("a GitLab URL, including a tree URL, resolves to a GitLab source", () => {
  const plain = accepted("https://gitlab.com/group/repo");
  assert.equal(plain.type, "gitlab");
  assert.equal(plain.url, "https://gitlab.com/group/repo.git");

  const tree = accepted("https://gitlab.com/group/sub/repo/-/tree/main/skills/pdf");
  assert.equal(tree.type, "gitlab");
  assert.equal(tree.ref, "main");
  assert.equal(tree.subpath, "skills/pdf");
});

test("generic git URLs are accepted, including file:// with a #ref", () => {
  const file = accepted("file:///tmp/pi-web-skills-fixture");
  assert.equal(file.type, "git");
  assert.equal(file.url, "file:///tmp/pi-web-skills-fixture");

  const fileRef = accepted("file:///tmp/pi-web-skills-fixture#main");
  assert.equal(fileRef.type, "git");
  assert.equal(fileRef.url, "file:///tmp/pi-web-skills-fixture");
  assert.equal(fileRef.ref, "main");

  const ssh = accepted("ssh://git@example.com/owner/repo.git");
  assert.equal(ssh.type, "git");

  const scp = accepted("git@example.com:owner/repo.git");
  assert.equal(scp.type, "git");
  assert.equal(scp.url, "git@example.com:owner/repo.git");
});

test("local paths are rejected with an unsupported-source reason", () => {
  for (const source of ["/tmp/skills", "./skills", "../skills", "."]) {
    assert.match(rejected(source), /local/i);
  }
});

test("well-known and hosted artifact URLs are rejected", () => {
  rejected("https://example.com/skills/foo");
  rejected("https://github.com/owner/repo/archive/main.zip");
  rejected("https://raw.githubusercontent.com/owner/repo/main/SKILL.md");
});

test("ext:: transports, empty input, and malformed input are rejected", () => {
  rejected("ext::sh -c whoami");
  rejected("");
  rejected("   ");
  rejected("not a source");
  rejected("https://github.com/owner");
});

test("a subpath that escapes the repository is rejected", () => {
  rejected("https://github.com/owner/repo/tree/main/../../etc");
});
