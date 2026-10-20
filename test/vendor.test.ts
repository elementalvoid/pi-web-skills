import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseFrontmatter } from "../src/vendor/skills/frontmatter.ts";
import { getGitHubHost } from "../src/vendor/skills/github-host.ts";
import { computeSkillFolderHash } from "../src/vendor/skills/local-lock.ts";
import { sanitizeMetadata } from "../src/vendor/skills/sanitize.ts";

const vendorDirectory = new URL("../src/vendor/skills/", import.meta.url);
const provenancePath = new URL("../src/vendor/skills/PROVENANCE.md", import.meta.url);

const pinnedCommit = "a80e4c9d12d607631249d4d7d059f835d4b2f13a";
const pinnedModules = [
  "source-parser.ts",
  "github-host.ts",
  "blob.ts",
  "skills.ts",
  "frontmatter.ts",
  "sanitize.ts",
  "constants.ts",
  "plugin-manifest.ts",
  "skill-lock.ts",
  "local-lock.ts",
  "update-source.ts",
  "types.ts",
];

async function provenanceTable(): Promise<Map<string, string>> {
  const provenance = await readFile(provenancePath, "utf8");
  const rows = new Map<string, string>();
  for (const line of provenance.split("\n")) {
    const match = /^\|\s*([\w.-]+\.ts|LICENSE)\s*\|\s*([0-9a-f]{64})\s*\|$/.exec(line.trim());
    if (match?.[1] && match[2]) rows.set(match[1], match[2]);
  }
  return rows;
}

test("PROVENANCE records the source URL, pinned commit, and do-not-edit rule", async () => {
  const provenance = await readFile(provenancePath, "utf8");

  assert.match(provenance, /https:\/\/github\.com\/vercel-labs\/skills/);
  assert.match(provenance, new RegExp(pinnedCommit));
  assert.match(provenance, /do not edit/i);
  for (const module of pinnedModules) assert.match(provenance, new RegExp(module.replace(/\./g, "\\.")));
});

test("PROVENANCE lists exactly the pinned modules plus the upstream LICENSE", async () => {
  const listed = [...(await provenanceTable()).keys()].sort();

  assert.deepEqual(listed, [...pinnedModules, "LICENSE"].sort());
});

test("the vendor directory holds exactly the files PROVENANCE records", async () => {
  const onDisk = (await readdir(vendorDirectory)).sort();

  assert.deepEqual(onDisk, [...pinnedModules, "LICENSE", "PROVENANCE.md"].sort());
});

test("every vendored file matches its recorded hash, so vendor files are unedited", async () => {
  const listed = await provenanceTable();

  for (const [name, recorded] of listed) {
    const content = await readFile(new URL(name, vendorDirectory));
    assert.equal(
      createHash("sha256").update(content).digest("hex"),
      recorded,
      `${name} was edited after vendoring`,
    );
  }
});

test("vendored modules import and behave as upstream", async () => {
  assert.match(await readFile(new URL("LICENSE", vendorDirectory), "utf8"), /MIT License/);

  assert.deepEqual(parseFrontmatter("---\nname: demo\ndescription: A demo\n---\nbody").data, {
    name: "demo",
    description: "A demo",
  });
  assert.equal(sanitizeMetadata("  demo\u001b[31m-red\u001b[0m\n"), "demo-red");
  assert.equal(getGitHubHost(), "github.com");

  const folder = await mkdtemp(join(tmpdir(), "pi-web-skills-vendor-"));
  try {
    await writeFile(join(folder, "SKILL.md"), "---\nname: demo\n---\n");
    assert.match(await computeSkillFolderHash(folder), /^[0-9a-f]{64}$/);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
