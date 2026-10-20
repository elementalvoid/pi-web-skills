# 09: Upstream parity suite

**What to build:** A parity suite that proves the plugin and the real `skills` CLI agree on the global lock and on update/remove decisions. This is verification work; production behaviour changes only when a test exposes a parity bug, and then the fix lands with the failing test.

**Blocked by:** 05 (Add — install and write lock entries), 06 (Remove and broken-entry cleanup), 07 (Update managed installs).

**Status:** resolved

**Pointers:** `.scratch/skills-panel/spec.md` sections *Testing Decisions*, *Vendoring*; `docs/upstream-parity.md` *Parity tests* and the lock shape; `docs/adr/0002-upstream-parity-thin-reimplementation.md`; `skills@1.7.4` is already a dev dependency.

- [x] A parity test installs the same generic git source and ref into two temporary HOMEs, one with the real CLI and one with the plugin, and compares the global lock after excluding `installedAt`/`updatedAt`.
- [x] Fixture sources are local git repositories served through `file://`; the test verifies that both the CLI and the plugin resolve the same source and produce the same `skillPath` and folder-hash shape.
- [x] GitHub tree hashing is covered with a mocked API response, including a changed hash, an unchanged hash, a deleted path, and a relocated path.
- [x] Removal, broken-entry cleanup, and unmanaged protection are covered as filesystem comparisons.
- [x] A provenance test asserts the vendored file list matches `PROVENANCE.md` and that a committed SHA-256 manifest still matches every vendor file.
- [x] The suite skips with a clear message if the `skills` CLI is not installed, rather than failing for an unrelated reason.
- [x] No test touches the real HOME, the real lock, or the network.
- [x] Any production bug found gets a red test first and a minimal fix in the same ticket.
- [x] `npm run build`, `npm run typecheck`, and `npm test` pass with the parity suite included.

## Result

- Commit: `34898c0` (test: add the upstream parity suite).
- New `test/parity.test.ts`:
  - CLI vs plugin install of one generic git source and ref into separate temporary HOMEs: the
    global locks are deep-equal after removing `installedAt`/`updatedAt`, and the installed
    files are identical. Both entries are asserted for `source`, `sourceType`, `sourceUrl`,
    `ref`, `skillPath`, and the 64-hex content hash.
  - `file://` generic source: the CLI and plugin install identical files and the plugin records
    one content-hash entry per skill.
  - GitHub tree decisions via the update session's injectable `fetch`/`exec`, with real local
    clones for fallback: unchanged hash (no clone), changed hash (tree), deleted path (clone
    fallback, reported and kept), relocated path (clone fallback, path and hash updated, local
    edit replaced). Lock extras (`dismissed`, `lastSelectedAgents`) and unchanged entries are
    preserved.
  - Remove compared as filesystem snapshots: managed directory removed, broken entry cleaned
    without creating a directory, unmanaged directory refused and byte-identical, and lock
    extras, other entries, and unknown fields preserved.
- Extended `test/vendor.test.ts` with a directory-listing assertion, so the vendor directory
  holds exactly the files in the committed `PROVENANCE.md` SHA-256 manifest.
- Hermeticity: every HOME, lock, clone, and temp directory is under `mkdtemp`; the CLI child
  gets a private HOME/XDG/GIT config and a preload that makes `globalThis.fetch` throw; plugin
  git runs with `GIT_ALLOW_PROTOCOL=file`; the GitHub API is a local fake. No network.
- CLI tests skip with `the skills CLI is not installed at node_modules/.bin/skills; run npm
  install to run CLI parity tests` when the dev dependency is absent (verified by temporarily
  removing the bin symlink).
- No plugin bug was found, so no production code changed.

### Parity deviations recorded

- Upstream `skills` 1.7.4 writes no global lock entry for a `file://` generic source: its
  lock-write gate requires `getOwnerRepo()` to return an `owner/repo`, which a file URL cannot
  provide. The plugin does record such an entry (content hash), which is what
  `docs/upstream-parity.md` documents. The lock-equality test therefore uses a generic
  `https://<host>/owner/repo.git` URL configured with a local git `insteadOf` rewrite to the
  fixture; that is the form both writers record. The `file://` test asserts the installed
  files are identical and documents the missing CLI entry instead of hiding it.
- Upstream `skills remove` deletes an unmanaged directory in the same managed directory,
  while the plugin refuses (`not-managed`). This is the spec's deliberate unmanaged-protection
  choice; removal parity is therefore tested as plugin filesystem behavior, not against the CLI.

### Commands

- `npm install --no-package-lock` — pass.
- `npm run build` — pass.
- `npm run typecheck` — pass.
- `npm test` — pass: 199 tests, 0 fail (includes 4 parity tests and the extended vendor test).
