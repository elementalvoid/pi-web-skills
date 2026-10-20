# 07: Update managed installs

**What to build:** Update checks each managed entry at its locked ref, replaces only skills whose remote folder changed or that moved, reports deleted-upstream skills without deleting them, and shows the upstream skip reason for everything it cannot check. The user confirms first because a remote change can overwrite a local edit.

**Blocked by:** 03 (Inventory and read-only list), 04 (Add — resolve a source and select skills), 05 (Add — install and write lock entries).

**Status:** resolved

**Pointers:** `.scratch/skills-panel/spec.md` sections *Update*, *Peer contract* (`update` channel), *Lockfile*; `docs/adr/0004-upstream-update-semantics.md`; `docs/upstream-parity.md` *Update*; upstream `src/update.ts` for skip reasons, relocation, and deletion reporting; `src/vendor/skills/blob.ts` for tree hashing.

- [x] An `update` channel accepts `{ names? }` (omitted means all managed) and emits per-skill progress plus a final summary.
- [x] Check and replace work runs asynchronously on the channel lifetime signal; open/receive callbacks return immediately, so the host's 10 s callback bound never cancels an update.
- [x] Checkable entries are only `sourceType: "github"` with non-empty `skillPath` and `skillFolderHash`.
- [x] Skip reasons are the exact upstream strings: `Local path`, `Git URL`, `Well-known skill`, `Private or deleted repo`, `No skill path recorded`, `No version tracking`.
- [x] Entries are grouped by source and ref. The GitHub tree at the locked ref is fetched through the API with the token resolver and `gh api` fallback via the bounded exec adapter; if unavailable, clone at the ref and compute hashes from the checkout. Use the vendored tree parser/hash helper, never a vendored function that spawns its own process.
- [x] Changed hash → update. Match by skill name across the current source before declaring deletion; a name at a new path is relocated, and only a name absent from the source is `deleted` (reported, never removed).
- [x] Changed and relocated installs are replaced through the safe copier and atomic swap; `installedAt` is preserved and `updatedAt` changes only for replaced skills.
- [x] A group that cannot be fetched is reported failed; other groups continue. Cancel stops after the current skill and reports partial results.
- [x] There is no Check-only action and no dry-run mode.
- [x] The panel has an Update all action with an inline confirmation that names the local-edit risk, per-skill progress, grouped results (`updated`, `unchanged`, `skipped` with reasons, `deleted`, `failed`), a refresh, and the `/reload` reminder.
- [x] Tests cover changed/unchanged hashes, every skip reason, deleted-upstream reporting without deletion, relocation, local-edit overwrite only when remote changed, `updatedAt` only on change, API-unavailable clone fallback, group failure isolation, and cancel after one completed skill.
- [x] `npm run build`, `npm run typecheck`, and `npm test` pass.

## Result

**Commits:** `94680ee` (feat: update managed installs at the locked ref), plus the commit recording this result.

**Files**

- `src/operations/update.ts` — `createUpdateSession` drives one update channel. It reads the lock once (an unreadable lock is a terminal error frame), applies the upstream checkable-entry rule, groups by `source\nref`, and per group tries the GitHub tree then falls back to a clone when the API is unavailable or a locked path vanished. Tree answers use the vendored `getSkillFolderHashFromTree`; clone answers use `computeGitFolderHash` through the host `execFile`. A skill is `unchanged` when its path and hash match, `deleted` when its name is absent from the source (reported, never removed), and otherwise replaced with `skillPath`/`skillFolderHash` updated. Two current paths with the locked name fail closed. Group failures mark all their members failed and the next group still runs. Cancel is checked before each skill and before each group, so the done frame carries partial results. `getSkipReason` reproduces the exact upstream reason strings and order.
- `src/operations/update-channel.ts` — validates `{ names?: string[] }` (deduplicated, at most 100 names), starts the session without awaiting it, and accepts only a `cancel` frame; unknown frames and unknown channels produce structured error frames.
- `src/upstream/github-tree.ts` — the tree read through the injectable `fetch` with the token resolver, then `gh api` through the bounded `execFile` with `GH_PROMPT_DISABLED=1` and the token in the environment, all bounded to 10 s. It returns a validated `RepoTree` or null; the caller clones on null.
- `src/browser/update-panel.ts` — Update all, an inline confirmation that states a remote change can overwrite a local edit, per-skill progress, grouped `Updated` / `Unchanged` / `Skipped` (with reasons) / `Deleted upstream (kept)` / `Failed` results, Cancel, a Refresh list action, and the `/reload` reminder. There is no Check or dry-run action.
- `src/browser/index.ts` — two added lines that render the update panel under Add.
- `src/server.ts` — routes the `update` channel to `openUpdateChannel` with `globalThis.fetch` and `GITHUB_TOKEN`/`GH_TOKEN`; Add stays on its existing path.
- `src/operations/errors.ts` — the `update-failed` stable code.
- `test/update.test.ts` — unchanged with no clone, changed replacement, preserved/overwritten local edits, every skip reason, deleted-upstream kept, relocation (including a tree that lost the locked path), ambiguity fails closed, API-unavailable `gh` then clone fallback, `gh` tree success without a clone, group failure isolation, cancel after one completed skill, the names filter, channel validation, and empty-input meaning all entries.
- `test/panel-update.test.ts` — confirmation before the channel opens, grouped results, the `/reload` reminder and dismiss, and cancel with partial results.
- `test/server.test.ts` — the real plugin routes the `update` channel and rejects malformed input without network work; the add-channel test now shares one activation helper.

**Commands**

- `npm run build` — pass.
- `npm run typecheck` — pass.
- `npm test` — pass: 163 tests, 0 failures at the feature commit; 178 after merging `integration/skills-panel` (ticket 08); 186 with ticket 06's review fixes merged in, 0 failures.

**Notes**

- Tests never reach the network: the GitHub tree is an injected fake `fetch`, `gh` is intercepted in the exec adapter, and clones use local `file://` git fixtures. The vendored `fetchRepoTree` is not called because it spawns its own process.
- The clone fallback reuses the entry's `sourceUrl` and `ref`, so a group pinned to a tag or commit updates from that exact ref. `source`/`sourceType`/unknown entry fields are preserved by the spread write.
- `updatedAt` is written once per replaced skill inside the atomic-swap commit callback, so a failed copy or lock write rolls the swap back and leaves the previous install.
- Ambiguous same-name matches (two paths with the locked name) are reported failed rather than relocated, because moving the wrong copy would overwrite the install.

## Comments

Review fixes on `ticket/07-fix`, after merging `integration/skills-panel`:

- Cancelling Update keeps the skills that already updated. A replaced skill streams only `updating`, so the panel settles it as updated when the next progress frame arrives (or the final `done` frame confirms it) instead of waiting for the summary. On cancel the interrupted skill's swap may or may not have happened, so it is never counted as updated; the accumulated results are shown, the list refreshes when anything was replaced, and the `/reload` reminder appears.
- Update resolves its install destination with `resolveInstallTarget`, the shared destination rule Add uses, instead of rebuilding `matchSkillName(...)?.folderName ?? sanitizeName(...)`.
- Update reads present folders with List's `discoverSkillDirectories` instead of a top-level `readdir` duplicate, so nested installs match and the depth/exclusion rules stay shared.
- The host tree reader is now `fetchGitHubTree`, so it cannot be confused with the vendored self-spawning `fetchRepoTree`.
- `SKIP_REASONS.noHash` is now `privateOrDeleted`, matching the "Private or deleted repo" message it produces. The `mutateLock` failure seam stays.

Test added: after two skills start updating, cancelling during the second keeps `Updated (1)`, never reports the interrupted skill as updated, and still shows the `/reload` reminder.

Commands:

- `npm run build` — pass.
- `npm run typecheck` — pass.
- `npm test` — pass, 187 tests total; 1 new.
