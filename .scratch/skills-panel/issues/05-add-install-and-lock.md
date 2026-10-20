# 05: Add — install and write lock entries

**What to build:** The second half of Add. The user's selected skills are copied safely into the managed directory, one standard lock entry is written per skill, and the panel reports installed, replaced, and failed names. Existing targets require an explicit overwrite confirmation.

**Blocked by:** 03 (Inventory and read-only list), 04 (Add — resolve a source and select skills).

**Status:** resolved

**Pointers:** `.scratch/skills-panel/spec.md` sections *Add*, *Lockfile*, *Safety*; `docs/upstream-parity.md` *Add* and the global lock shape; `GLOSSARY.md` terms *Install*, *Entry*, *Managed directory*; upstream `src/installer.ts` (clean/replace behaviour) and `src/skill-lock.ts` (`addSkillToLock`).

- [x] The `add` channel accepts `{ type: "install", names }`, copies each selected skill into `<managedDirectory>/<sanitised name>`, and writes one version 3 lock entry per success.
- [x] Install runs asynchronously on the channel lifetime signal; the receive callback returns immediately and progress is streamed, so a long copy is not bounded by the host's 10 s callback timeout.
- [x] The safe copier copies regular files/directories with their file modes, skips symlinks, `.git`, and `node_modules`, rejects any resolved path outside the source skill folder, and rejects a destination outside the managed directory.
- [x] Replacement stages a temp sibling and swaps it in; an existing directory is replaced, never merged. A failure during copy leaves the previous install intact.
- [x] Overwrite of an existing managed or unmanaged target is reported to the UI before install and requires an explicit confirmation in the panel. The server reports `replaced` names.
- [x] Entries carry exactly `source`, `sourceType`, `sourceUrl`, optional `ref`, `skillPath`, `skillFolderHash`, `installedAt`, `updatedAt`, optional `pluginName`. `source` is normalized `owner/repo` for GitHub/GitLab and the clone URL for generic git; `sourceUrl` is the clone URL. `installedAt` is preserved when replacing an existing entry; `updatedAt` is now.
- [x] Duplicate sanitised names in one selection fail before any copy or write.
- [x] The lock write preserves unknown fields and `dismissed`/`lastSelectedAgents`, and is atomic.
- [x] The panel shows overwrite confirmation, install progress, a result summary, a refreshed list, and the `/reload` reminder.
- [x] Tests use a local git fixture: install one and several skills, verify the lock shape and folder contents, overwrite a managed target, overwrite an unmanaged target after confirmation, reject duplicates, exclude a symlink and a `.git` directory, and verify no partial target remains after a copy failure.
- [x] `npm run build`, `npm run typecheck`, and `npm test` pass.

## Result

- Commit `62fb61f` — `feat: install selected skills and write one lock entry each`.
- `src/upstream/install.ts` (new): safe copier. Regular files and directories are copied with their modes; symlinks, `.git`, and `node_modules` are skipped; every source path is checked against the real source folder; the destination is resolved through the real managed directory and a symlink destination is refused with `unsafe-path`. The copy is staged in a `.pi-web-skills-*.tmp` sibling, the previous directory is renamed aside, the staging directory is renamed into place, and the backup is removed. A copy or swap failure puts the previous install back and removes the staging directory.
- `src/operations/matching.ts`: `resolveInstallTarget` is the one destination rule for the existing-target badge and the installer (exact lock key, sanitised key, sanitised folder name; lock key and folder name are reused so a legacy folder stays the target). Add no longer computes the badge separately.
- `src/operations/add.ts`: `install` frame handling runs asynchronously on the channel signal after candidates are resolved. Re-reads the lock and present folders, rejects duplicate sanitised names, target folders, or target keys before any write, streams `progress` (`installing`/`installed`, name, index, total) per skill, and ends with `done { installed, replaced, failed }`; failures carry per-name messages. One `mutateLockfile` call per installed skill preserves unknown fields, `dismissed`, `lastSelectedAgents`, and `installedAt` on replace; `updatedAt` is now; the entry has exactly the upstream fields plus an absent `ref`/`pluginName` when the source has none.
- `src/browser/add-panel.ts`: selecting an existing managed or unmanaged target switches to an explicit "Overwrite and install" confirmation and sends no frame before it. Progress, installed/replaced/failed result text, updated candidate badges, the `/reload` reminder (dismissible), and a list refresh after a successful install. `src/browser/index.ts` was not changed.
- `src/browser/list.ts`: `refreshSkillList(context)` drops the cached machine list and requests a render after a mutation.
- Tests: local git fixtures for a single and a multi-skill install with `#ref`, lock shape, managed overwrite (unknown fields, `installedAt`, other entries, stale-file removal), unmanaged overwrite, legacy sanitised folder target, duplicate sanitised names, symlink/`.git`/`node_modules` exclusions with mode checks, a source-copy failure that leaves the previous install and entry intact, copier containment and symlink-destination refusal, channel progress/done streaming with a non-blocking receive, and panel confirmation, progress, result, refresh, and dismissible reminder.

Commands:

- `npm run build` — pass.
- `npm run typecheck` — pass.
- `npm test` — pass, 122 tests total; 12 new (one replaced the ticket 04 "install disabled" placeholder).

## Comments

Review fixes on `ticket/05-fix`, after merging `integration/skills-panel`:

- Install selection is now keyed by the candidate's `sourcePath`, not its name, end to end: the `add` channel frame is `{ type: "install", sourcePaths }`, the panel sends each selected candidate's `sourcePath`, and the session resolves the installable candidate by that value. Two same-named skills in different folders no longer collapse onto the first one. The id is the capped display path, so two paths sharing their first 300 bytes would collide; a comment records that limit.
- A failed copy or lock write can no longer escape the install session. The install promise never rejects: each skill is wrapped so a failure is recorded as `failed` with a message while earlier successes stay, and `done` is emitted once on every path after validation. Validation errors (duplicate destination, unreadable lock) still end with an `error` frame and no copy.
- The safe copier now treats the lock write as the commit step: stage, swap (the previous directory is retained as `.pi-web-skills-*.old`), write the lock entry, then delete the backup. Any post-swap failure rolls back — the backup is renamed back, or the new directory is removed when there was no previous install — so a failed lock write keeps the old content and the old entry, and writes no entry for the new skill.
- `installSkillDirectory` takes an optional `InstallCommit` callback (default: nothing), so the copier owns the backup lifecycle. A throwing or failing commit returns a failure and rolls back before returning.
- A replacement no longer keeps a stale `pluginName`: the entry is written with the source's plugin group when discovery found one (covered by a plugin-manifest fixture), and the field is deleted when it did not. `ref` already behaved this way. Unknown per-entry fields still survive.
- The vacuous lexical `isInside` check in `copyTree` is gone; the symlink skip is the containment rule, and the comment now says so. The unused `sourceRoot` parameter went with it.
- The duplicate checks and messages are unified: `selectionConflict(targets)` checks the resolved install folder and then the lock key, and one `conflictError(subject, value)` builds both messages. The earlier sanitised-name pre-check was redundant; the resolved-folder check catches the same selection after the destination rule runs.
- `AddContext.mutateLock` is an optional lock-mutation seam so a test can force a failed write after the swap. It defaults to `mutateLockfile`.
- No change to `src/vendor/skills/**`, and no remove/update/search behavior was added.

Tests added: two same-named skills install from the selected `sourcePath` with the right content and folder hash; a throwing lock write fails only the second skill, keeps the first install and entry, removes the new directory, sends `done`, and raises no unhandled rejection; a failed write after replacing a target restores the old content and old lock entry; a plugin-manifest source records its `pluginName`. The managed-overwrite test now also asserts the stale `pluginName` is gone. Existing session tests select by `sourcePath`.

Commands:

- `npm run build` — pass.
- `npm run typecheck` — pass.
- `npm test` — pass, 126 tests total; 4 new.
