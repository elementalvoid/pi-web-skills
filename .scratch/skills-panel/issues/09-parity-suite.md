# 09: Upstream parity suite

**What to build:** A parity suite that proves the plugin and the real `skills` CLI agree on the global lock and on update/remove decisions. This is verification work; production behaviour changes only when a test exposes a parity bug, and then the fix lands with the failing test.

**Blocked by:** 05 (Add — install and write lock entries), 06 (Remove and broken-entry cleanup), 07 (Update managed installs).

**Status:** ready-for-agent

**Pointers:** `.scratch/skills-panel/spec.md` sections *Testing Decisions*, *Vendoring*; `docs/upstream-parity.md` *Parity tests* and the lock shape; `docs/adr/0002-upstream-parity-thin-reimplementation.md`; `skills@1.7.4` is already a dev dependency.

- [ ] A parity test installs the same generic git source and ref into two temporary HOMEs, one with the real CLI and one with the plugin, and compares the global lock after excluding `installedAt`/`updatedAt`.
- [ ] Fixture sources are local git repositories served through `file://`; the test verifies that both the CLI and the plugin resolve the same source and produce the same `skillPath` and folder-hash shape.
- [ ] GitHub tree hashing is covered with a mocked API response, including a changed hash, an unchanged hash, a deleted path, and a relocated path.
- [ ] Removal, broken-entry cleanup, and unmanaged protection are covered as filesystem comparisons.
- [ ] A provenance test asserts the vendored file list matches `PROVENANCE.md` and that a committed SHA-256 manifest still matches every vendor file.
- [ ] The suite skips with a clear message if the `skills` CLI is not installed, rather than failing for an unrelated reason.
- [ ] No test touches the real HOME, the real lock, or the network.
- [ ] Any production bug found gets a red test first and a minimal fix in the same ticket.
- [ ] `npm run build`, `npm run typecheck`, and `npm test` pass with the parity suite included.
