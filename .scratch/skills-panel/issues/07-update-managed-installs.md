# 07: Update managed installs

**What to build:** Update checks each managed entry at its locked ref, replaces only skills whose remote folder changed or that moved, reports deleted-upstream skills without deleting them, and shows the upstream skip reason for everything it cannot check. The user confirms first because a remote change can overwrite a local edit.

**Blocked by:** 03 (Inventory and read-only list), 04 (Add — resolve a source and select skills), 05 (Add — install and write lock entries).

**Status:** ready-for-agent

**Pointers:** `.scratch/skills-panel/spec.md` sections *Update*, *Peer contract* (`update` channel), *Lockfile*; `docs/adr/0004-upstream-update-semantics.md`; `docs/upstream-parity.md` *Update*; upstream `src/update.ts` for skip reasons, relocation, and deletion reporting; `src/vendor/skills/blob.ts` for tree hashing.

- [ ] An `update` channel accepts `{ names? }` (omitted means all managed) and emits per-skill progress plus a final summary.
- [ ] Check and replace work runs asynchronously on the channel lifetime signal; open/receive callbacks return immediately, so the host's 10 s callback bound never cancels an update.
- [ ] Checkable entries are only `sourceType: "github"` with non-empty `skillPath` and `skillFolderHash`.
- [ ] Skip reasons are the exact upstream strings: `Local path`, `Git URL`, `Well-known skill`, `Private or deleted repo`, `No skill path recorded`, `No version tracking`.
- [ ] Entries are grouped by source and ref. The GitHub tree at the locked ref is fetched through the API with the token resolver and `gh api` fallback via the bounded exec adapter; if unavailable, clone at the ref and compute hashes from the checkout. Use the vendored tree parser/hash helper, never a vendored function that spawns its own process.
- [ ] Changed hash → update. Match by skill name across the current source before declaring deletion; a name at a new path is relocated, and only a name absent from the source is `deleted` (reported, never removed).
- [ ] Changed and relocated installs are replaced through the safe copier and atomic swap; `installedAt` is preserved and `updatedAt` changes only for replaced skills.
- [ ] A group that cannot be fetched is reported failed; other groups continue. Cancel stops after the current skill and reports partial results.
- [ ] There is no Check-only action and no dry-run mode.
- [ ] The panel has an Update all action with an inline confirmation that names the local-edit risk, per-skill progress, grouped results (`updated`, `unchanged`, `skipped` with reasons, `deleted`, `failed`), a refresh, and the `/reload` reminder.
- [ ] Tests cover changed/unchanged hashes, every skip reason, deleted-upstream reporting without deletion, relocation, local-edit overwrite only when remote changed, `updatedAt` only on change, API-unavailable clone fallback, group failure isolation, and cancel after one completed skill.
- [ ] `npm run build`, `npm run typecheck`, and `npm test` pass.
