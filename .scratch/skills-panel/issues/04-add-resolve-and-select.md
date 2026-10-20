# 04: Add — resolve a source and select skills

**What to build:** The first half of Add. A user enters a source, the server resolves it, and the panel lists the discovered skills with descriptions and an "already installed" marker so the user can choose what to install. No copy or lock write happens in this ticket.

**Blocked by:** 02 (Foundation — vendored upstream subset and standard lockfile).

**Status:** resolved

**Pointers:** `.scratch/skills-panel/spec.md` sections *Peer contract* (`add` channel), *Operation seam*, *Add*; `docs/upstream-parity.md` operation mapping; `src/vendor/skills/source-parser.ts`, `skills.ts`, `local-lock.ts`, `blob.ts`; upstream `src/git.ts` for clone/hash edge cases.

- [x] An `add` channel accepts `{ source }` and streams candidates in bounded pages (about 25 per frame) ending with `candidates-end`, or a structured `error`, then keeps the temp clone open for a possible install.
- [x] Accepted: GitHub shorthand, GitHub/GitLab HTTPS URLs (including tree URLs with a subpath), generic git URLs including `file://`, optional `#ref` and `@skill` fragments.
- [x] Rejected with `unsupported-source`: local paths, well-known URLs, hosted archive/raw-file URLs, malformed input.
- [x] Clone runs through the host `execFile` adapter with argv only, `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0`, a timeout, and a temp directory under the OS temp root. `ext::` is rejected.
- [x] Discovery finds every `SKILL.md` in the clone and returns name, description, source path, sanitised folder name, folder hash, and existing target state (`none`, `managed`, `unmanaged`).
- [x] The channel open and receive handlers return before cloning; resolution work runs on the channel lifetime signal and streams candidates, so the host's 10 s callback bound never cancels it.
- [x] GitHub/GitLab folder hash is a 40-hex git tree SHA; generic git uses the vendored SHA-256 content hash. The shape is never silently mixed.
- [x] The panel has a source input, resolve action, candidate list with select-all/select-one, descriptions, existing-target badges, inline errors, and a disabled install action until the user selects something.
- [x] Cancel closes the channel and removes the clone; a clone/discovery failure also removes it. A test asserts no temp directory remains after success, failure, and cancel.
- [x] Tests use local git fixture sources for discovery and a fake exec/fetch for GitHub tree hashing; no test reaches the network.
- [x] `npm run build`, `npm run typecheck`, and `npm test` pass.

## Result

- Commit `92fd100` — `feat: resolve add sources and stream skill candidates`.
- `src/operations/add.ts`: source resolution, vendored discovery, content/tree folder hashing, and the paged candidate session that keeps the clone open.
- `src/operations/add-channel.ts`: `add` channel adapter. Open and receive validate and return; resolve/clone/discovery run on the channel lifetime signal. An `install` frame answers `not-implemented` until ticket 05.
- `src/upstream/git.ts`: bounded `execFile` git clone/fetch/checkout, `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0`, 120 s requested timeout, validated temp directory, and 40-hex tree hashing.
- `src/browser/add-panel.ts`: source input, resolve/cancel, paged candidates, per-skill and select-all checkboxes, descriptions, existing-target badges, inline errors, and an install action disabled until a selection exists.
- `src/server.ts` and `src/browser/index.ts`: composition lines only. `src/operations/errors.ts` gains the new stable error codes; `src/README.md` lists the new modules.
- Install/copy/lock writes were not added; ticket 05 owns them.

Commands:

- `npm run build` — pass.
- `npm run typecheck` — pass.
- `npm test` — pass, 85 tests total; 31 new (source parsing, local git clone and candidate paging, existing-target states, folder-hash shapes, cleanup on success/failure/cancel, channel validation and prompt return, plugin channel wiring).

## Comments

Review fixes on `ticket/04-fix`, after merging `integration/skills-panel`:

- Every candidate string is now sanitised with the vendored `sanitizeMetadata` and capped by UTF-8 bytes: `name` 80, `description` 400, `sourcePath` 300. `folderName` stays the `sanitizeName` output (ASCII, 255 max). The theoretical worst case for 25 candidates with every escapable byte is 49,482 bytes, so a page stays safely under the host's 64 KiB frame bound.
- An unreadable lock now fails resolution with `lock-unreadable` instead of pretending there are no entries. The catch-all discovery error no longer masks it.
- The existing-target badge uses the same three matching rungs as List and receives the present folder names. A lock key without its install folder (a broken entry) is `none`, not `managed`; a present folder that only matches after sanitising is `unmanaged`.
- `add-panel.ts` holds an `AbortController` for the in-flight `openChannel`, passes its signal to the peer, and aborts it on Cancel. A channel that resolves after the cancel is closed instead of adopted.
- The Add panel says an overwrite confirmation will come before install, and the install action stays disabled until ticket 05; a note states that selecting skills writes nothing. No install, copy, or lock write was added.
- Git calls pass `--end-of-options` to `rev-parse` and `unsetEnv: ["GIT_DIR", "GIT_WORK_TREE"]`, so an inherited daemon environment cannot redirect the clone.
- `upstream/git.ts` uses the realpath-aware `isRealPathInside` containment helper; the duplicate `isInside` and `exists` helpers are gone.

Commands:

- `npm run build` — pass.
- `npm run typecheck` — pass.
- `npm test` — pass, 111 tests total after merging the ticket 03 fixes; 6 new in this branch (malformed lock, broken and sanitised-directory targets, hostile candidate page bound, pending-open cancel, disabled install copy).
