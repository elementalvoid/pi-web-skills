# 06: Remove and broken-entry cleanup

**What to build:** A user can remove a managed install (directory plus lock entry) or clean up a broken entry (stale lock entry only). Unmanaged directories have no removal action and are refused by the server.

**Blocked by:** 02 (Foundation — vendored upstream subset and standard lockfile), 03 (Inventory and read-only list).

**Status:** resolved

**Pointers:** `.scratch/skills-panel/spec.md` sections *Remove*, *Lockfile*, *Safety*; `GLOSSARY.md` terms *Remove*, *Broken*, *Unmanaged*; `docs/upstream-parity.md` *Remove*; upstream `src/remove.ts` for canonical name matching.

- [x] `remove` request accepts `{ names }` and resolves each name with the List matching rules, preferring lock keys.
- [x] Managed: remove the directory recursively, then the lock entry. Broken: remove the lock entry only. Missing directory still succeeds and reports it was absent.
- [x] Unmanaged: `not-managed`, no filesystem change. Unknown: `not-found`.
- [x] Removal refuses symlinked skill directories and any resolved path outside the managed directory with `unsafe-path`.
- [x] The lock write preserves unknown fields and `dismissed`/`lastSelectedAgents`, removes only the named entry, and is atomic.
- [x] The panel shows Remove on managed rows and Remove entry on broken rows, each with an inline confirmation. Unmanaged rows have no action and explain that they are not tracked by the lockfile.
- [x] After a successful removal the list refreshes and the `/reload` reminder appears.
- [x] Tests cover managed removal, broken cleanup, unmanaged refusal, missing directory, symlink refusal, unknown name, preserved lock extras, and a directory outside the managed root.
- [x] `npm run build`, `npm run typecheck`, and `npm test` pass.

## Result

**Commits:** `9827739` (feat: remove managed installs and clean up broken entries), plus the commit recording this result.

**Files**

- `src/operations/remove.ts` — `removeSkills` reads the lock once to resolve names, then handles each name: managed rows delete the contained directory and their entry; broken rows delete only the entry and report `directory: "absent"`; unmanaged rows are `not-managed`; unknown names are `not-found`; a symlinked or escaping target is `unsafe-path` before any delete. An unreadable lock blocks the whole request with `lock-unreadable`, and every entry write goes through `mutateLockfile` (re-read, atomic rename, unknown fields and `dismissed`/`lastSelectedAgents` preserved, version never lowered). `readRemoveNames` validates `{ names: string[] }` (deduplicated, 1–100 names).
- `src/operations/errors.ts` — the `not-found`, `not-managed`, and `remove-failed` stable codes.
- `src/server.ts` — the `remove` branch in the peer router and `RemovePayload` in the response union; no other change.
- `src/browser/list.ts` — machine-keyed row action state and notices, Remove on managed rows and Remove entry on broken rows with inline confirm/cancel, the unmanaged explanation, a `force` refresh after success, and the `/reload` reminder. `src/browser/index.ts` is unchanged.
- `test/remove.test.ts` — managed removal, broken cleanup, missing managed directory, unmanaged refusal, unknown name, symlink refusal, traversal-shaped lock key, symlinked managed directory, unreadable lock, multi-name outcomes, and preserved lock extras.
- `test/panel-list.test.ts` — action affordances per state, unmanaged having no action, inline confirmation with cancel, confirm-then-refresh plus `/reload`, broken-entry identity, per-name refusal, and a rejected request; the panel's metadata test still pins source/ref/updated.
- `test/server.test.ts` — a `remove` request end to end and every malformed input shape.

**Commands**

- `npm run build` — pass.
- `npm run typecheck` — pass.
- `npm test` — pass: 130 tests, 0 failures.

**Notes**

- "Outside the managed directory" is prevented by construction: the removal folder comes from a present folder name or `sanitizeName(lock key)`, so it is a single segment, and `assertSafeSkillDirectory` refuses a symlinked folder and any target that resolves outside the real managed directory. Tests cover a symlinked skill folder to an outside directory (refused, target intact) and a lock key shaped like traversal (the outside directory is untouched).
- The panel sends the row's folder name for managed rows and its lock key for broken rows, so sanitised lock keys still resolve; the list read model is unchanged.
- A successful removal writes one lockfile per name, so a multi-name request makes one atomic write per removed entry.

## Comments

Review fixes on `ticket/06-fix`, after merging `integration/skills-panel`:

- A failed lock write no longer escapes `removeSkills`. Each name is handled inside a per-name boundary: a thrown lock write becomes a `remove-failed` result for that name, the remaining names still run, and the request still returns `{ results }` instead of rejecting. When the directory was already deleted, the failure carries `directory: "removed"` and the message says the lock entry remains, so the panel knows to refresh and show the now-broken row.
- Remove now discovers present folders with List's own discovery (`discoverSkillDirectories`): recursive, depth 5, skipping `node_modules`, `.git`, `dist`, `build`, and `__pycache__`. A nested unmanaged directory is `not-managed`, not `not-found`, and a nested managed install is deleted at its discovered path rather than a top-level guess. Path containment gained `assertSafePresentDirectory` for a discovered relative path.
- A broken entry whose canonical folder name is a symlink is cleaned up as an entry-only removal: the lock entry goes, and the symlink and its target are untouched. Removal deletes only a real present skill directory (a directory found by the same discovery List uses); it never follows or deletes a symlink. The `unsafe-path` containment check still applies to any matched present path.
- The operation result now distinguishes what happened on disk: managed success and a lock failure after deletion carry `directory: "removed"`; broken cleanup carries `directory: "absent"`. The panel shows the `/reload` reminder only when a directory changed.
- List refreshes are generation-guarded. Every load takes a new generation and only the newest response may write the list, error, notice, or row actions; `refreshSkillList` bumps the generation so it invalidates a load already in flight and the next render starts a fresh one.
- A successful list read clears the previous notice and row actions. A second Remove confirmation click while one request is in flight is ignored.
- The duplicate error code is unified: add's `skill-not-found` is now `not-found`, the same code remove already returns.

Tests added: a lock write that fails after the first directory removal (first name failed with `directory: "removed"`, second removed, failed entry remains); a failed write with several names returns one ordered result each; a nested unmanaged directory is `not-managed`; a nested managed skill removes the nested directory; a symlinked broken folder only loses its entry; the panel refreshes to the broken row after a lock failure and shows the structured message; broken cleanup shows no `/reload` reminder; a refresh starts a second load while the first is in flight and the older response cannot overwrite it; a successful refresh clears the old notice and row action; a second confirmation click sends one request; a missing `@skill` filter reports `not-found`.

Commands:

- `npm run build` — pass.
- `npm run typecheck` — pass.
- `npm test` — pass, 153 tests total; 8 new.
