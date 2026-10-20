# 02: Foundation — vendored upstream subset and standard lockfile

**What to build:** The mechanical base every later ticket uses: the pinned upstream modules copied verbatim with provenance, the standard global lockfile reader/writer, the name-matching rules, and the path-containment helpers. No user-facing behaviour yet; this is the prefactor that makes Add, List, Remove, and Update small.

**Blocked by:** 01 (Plugin shell and machine status).

**Status:** resolved

**Pointers:** `.scratch/skills-panel/spec.md` sections *Lockfile*, *Vendoring*, *Safety*; `GLOSSARY.md` terms *Entry*, *Lockfile*, *Managed*, *Broken*; `docs/upstream-parity.md` (global lock shape and vendored file list); `src/README.md` (source rules); pinned upstream checkout at `/tmp/skills-upstream` (commit `a80e4c9d12d607631249d4d7d059f835d4b2f13a`) if still present, otherwise clone `vercel-labs/skills` at that commit.

- [x] Vendor the 12 pinned modules listed in `docs/upstream-parity.md` verbatim under `src/vendor/skills/`, with upstream `LICENSE` and `PROVENANCE.md` recording source URL, commit, file list, and the do-not-edit rule.
- [x] Vendored files typecheck and import with the repo's `.ts` extension rules; vendor files are not edited.
- [x] Lockfile module reads version 3, treats a missing file as an empty lock, reports malformed JSON/shape as `lock-unreadable`, and exposes an atomic writer that preserves unknown top-level fields, unknown entry fields, `dismissed`, and `lastSelectedAgents`.
- [x] Writer never downgrades `version`; mutations re-read before writing, are serialized in-process per lockfile, and preserve unrelated entries.
- [x] Matching resolves a requested name to an exact lock key, then a sanitised key, then a sanitised folder name; lock keys win. A key like `ce:review` matches folder `ce-review`.
- [x] Containment helpers reject paths escaping the managed directory, refuse symlinked skill directories, and validate temp paths before cleanup.
- [x] Tests prove the lock round-trip with unknown fields, malformed input, missing file, name matching, path containment, and the provenance file list.
- [x] `npm run build`, `npm run typecheck`, and `npm test` pass.

## Result

Implemented on `ticket/02-foundation`.

- `e0c203c` feat: vendor the pinned upstream skills modules with provenance
- `f621674` feat: read, atomically write, and serialize the standard global lockfile
- `7f9433f` feat: match a requested skill name against lock keys and folders
- `b80599f` feat: add managed-directory and temp-path containment checks

Verification from `/data/home/projects/pi-web-skills-wt/02`:

- `git merge-base --is-ancestor integration/skills-panel HEAD` — failed on entry; `git reset --hard integration/skills-panel` applied (worktree predated the spec-only tip), then clean.
- `npm install --no-package-lock` — pass.
- `npm run build` — pass; emits the 12 vendored modules under `dist/vendor/skills/`.
- `npm run typecheck` — pass; `tsconfig.test.json` covers `src` and `test`.
- `npm test` — pass, 42/42 tests.

New seams:

- `src/operations/lockfile.ts` — `readLockfile` (missing file is an empty version 3 lock, malformed JSON or shape is `lock-unreadable`), `writeLockfile` (temp file plus rename, preserves unknown top-level and entry fields, `dismissed`, `lastSelectedAgents`, and never lowers `version`), `mutateLockfile` (per-path queue, re-read before write, throwing mutation writes nothing).
- `src/operations/matching.ts` — `sanitizeName` (upstream install-folder rules) and `matchSkillName` (exact lock key, sanitised lock key, sanitised folder name; a key like `ce:review` matches folder `ce-review`).
- `src/operations/containment.ts` — `resolveManagedPath` (single segment, strictly inside the managed directory), `assertSafeSkillDirectory` (refuses symlinked folders, accepts a missing folder for broken-entry cleanup), `removeTempDirectory` (removes only strictly inside the temp root).
- `src/operations/errors.ts` — `OperationError` with the `lock-unreadable` and `unsafe-path` codes.

Vendored subset: `src/vendor/skills/` holds the 12 pinned modules plus upstream `LICENSE` and `PROVENANCE.md`. `PROVENANCE.md` records the source URL, commit `a80e4c9d12d607631249d4d7d059f835d4b2f13a`, a sha256 per file, and the do-not-edit rule; `test/vendor.test.ts` recomputes every hash and imports four modules, so an edit to a vendor file fails the suite.

Note: `exactOptionalPropertyTypes` is now off in `tsconfig.json` with a comment. The verbatim upstream subset assigns `undefined` to optional properties, and vendor files must not be edited. Re-enable it if the subset is ever replaced by a typed package.
