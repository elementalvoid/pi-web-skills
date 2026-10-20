# 02: Foundation — vendored upstream subset and standard lockfile

**What to build:** The mechanical base every later ticket uses: the pinned upstream modules copied verbatim with provenance, the standard global lockfile reader/writer, the name-matching rules, and the path-containment helpers. No user-facing behaviour yet; this is the prefactor that makes Add, List, Remove, and Update small.

**Blocked by:** 01 (Plugin shell and machine status).

**Status:** ready-for-agent

**Pointers:** `.scratch/skills-panel/spec.md` sections *Lockfile*, *Vendoring*, *Safety*; `GLOSSARY.md` terms *Entry*, *Lockfile*, *Managed*, *Broken*; `docs/upstream-parity.md` (global lock shape and vendored file list); `src/README.md` (source rules); pinned upstream checkout at `/tmp/skills-upstream` (commit `a80e4c9d12d607631249d4d7d059f835d4b2f13a`) if still present, otherwise clone `vercel-labs/skills` at that commit.

- [ ] Vendor the 12 pinned modules listed in `docs/upstream-parity.md` verbatim under `src/vendor/skills/`, with upstream `LICENSE` and `PROVENANCE.md` recording source URL, commit, file list, and the do-not-edit rule.
- [ ] Vendored files typecheck and import with the repo's `.ts` extension rules; vendor files are not edited.
- [ ] Lockfile module reads version 3, treats a missing file as an empty lock, reports malformed JSON/shape as `lock-unreadable`, and exposes an atomic writer that preserves unknown top-level fields, unknown entry fields, `dismissed`, and `lastSelectedAgents`.
- [ ] Writer never downgrades `version`; mutations re-read before writing, are serialized in-process per lockfile, and preserve unrelated entries.
- [ ] Matching resolves a requested name to an exact lock key, then a sanitised key, then a sanitised folder name; lock keys win. A key like `ce:review` matches folder `ce-review`.
- [ ] Containment helpers reject paths escaping the managed directory, refuse symlinked skill directories, and validate temp paths before cleanup.
- [ ] Tests prove the lock round-trip with unknown fields, malformed input, missing file, name matching, path containment, and the provenance file list.
- [ ] `npm run build`, `npm run typecheck`, and `npm test` pass.
