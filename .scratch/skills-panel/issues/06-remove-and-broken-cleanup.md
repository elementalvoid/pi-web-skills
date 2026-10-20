# 06: Remove and broken-entry cleanup

**What to build:** A user can remove a managed install (directory plus lock entry) or clean up a broken entry (stale lock entry only). Unmanaged directories have no removal action and are refused by the server.

**Blocked by:** 02 (Foundation — vendored upstream subset and standard lockfile), 03 (Inventory and read-only list).

**Status:** ready-for-agent

**Pointers:** `.scratch/skills-panel/spec.md` sections *Remove*, *Lockfile*, *Safety*; `GLOSSARY.md` terms *Remove*, *Broken*, *Unmanaged*; `docs/upstream-parity.md` *Remove*; upstream `src/remove.ts` for canonical name matching.

- [ ] `remove` request accepts `{ names }` and resolves each name with the List matching rules, preferring lock keys.
- [ ] Managed: remove the directory recursively, then the lock entry. Broken: remove the lock entry only. Missing directory still succeeds and reports it was absent.
- [ ] Unmanaged: `not-managed`, no filesystem change. Unknown: `not-found`.
- [ ] Removal refuses symlinked skill directories and any resolved path outside the managed directory with `unsafe-path`.
- [ ] The lock write preserves unknown fields and `dismissed`/`lastSelectedAgents`, removes only the named entry, and is atomic.
- [ ] The panel shows Remove on managed rows and Remove entry on broken rows, each with an inline confirmation. Unmanaged rows have no action and explain that they are not tracked by the lockfile.
- [ ] After a successful removal the list refreshes and the `/reload` reminder appears.
- [ ] Tests cover managed removal, broken cleanup, unmanaged refusal, missing directory, symlink refusal, unknown name, preserved lock extras, and a directory outside the managed root.
- [ ] `npm run build`, `npm run typecheck`, and `npm test` pass.
