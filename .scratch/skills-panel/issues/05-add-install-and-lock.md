# 05: Add — install and write lock entries

**What to build:** The second half of Add. The user's selected skills are copied safely into the managed directory, one standard lock entry is written per skill, and the panel reports installed, replaced, and failed names. Existing targets require an explicit overwrite confirmation.

**Blocked by:** 03 (Inventory and read-only list), 04 (Add — resolve a source and select skills).

**Status:** ready-for-agent

**Pointers:** `.scratch/skills-panel/spec.md` sections *Add*, *Lockfile*, *Safety*; `docs/upstream-parity.md` *Add* and the global lock shape; `GLOSSARY.md` terms *Install*, *Entry*, *Managed directory*; upstream `src/installer.ts` (clean/replace behaviour) and `src/skill-lock.ts` (`addSkillToLock`).

- [ ] The `add` channel accepts `{ type: "install", names }`, copies each selected skill into `<managedDirectory>/<sanitised name>`, and writes one version 3 lock entry per success.
- [ ] Install runs asynchronously on the channel lifetime signal; the receive callback returns immediately and progress is streamed, so a long copy is not bounded by the host's 10 s callback timeout.
- [ ] The safe copier copies regular files/directories with their file modes, skips symlinks, `.git`, and `node_modules`, rejects any resolved path outside the source skill folder, and rejects a destination outside the managed directory.
- [ ] Replacement stages a temp sibling and swaps it in; an existing directory is replaced, never merged. A failure during copy leaves the previous install intact.
- [ ] Overwrite of an existing managed or unmanaged target is reported to the UI before install and requires an explicit confirmation in the panel. The server reports `replaced` names.
- [ ] Entries carry exactly `source`, `sourceType`, `sourceUrl`, optional `ref`, `skillPath`, `skillFolderHash`, `installedAt`, `updatedAt`, optional `pluginName`. `source` is normalized `owner/repo` for GitHub/GitLab and the clone URL for generic git; `sourceUrl` is the clone URL. `installedAt` is preserved when replacing an existing entry; `updatedAt` is now.
- [ ] Duplicate sanitised names in one selection fail before any copy or write.
- [ ] The lock write preserves unknown fields and `dismissed`/`lastSelectedAgents`, and is atomic.
- [ ] The panel shows overwrite confirmation, install progress, a result summary, a refreshed list, and the `/reload` reminder.
- [ ] Tests use a local git fixture: install one and several skills, verify the lock shape and folder contents, overwrite a managed target, overwrite an unmanaged target after confirmation, reject duplicates, exclude a symlink and a `.git` directory, and verify no partial target remains after a copy failure.
- [ ] `npm run build`, `npm run typecheck`, and `npm test` pass.
