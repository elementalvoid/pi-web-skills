# Spec: Skills panel for PI WEB

Synthesised from `README.md`, `GLOSSARY.md`, `docs/adr/0001`–`0004`, `docs/upstream-parity.md`, `docs/local-development.md`, and `src/README.md`. Those documents remain the primary sources; this spec turns them into one buildable plan.

## Problem Statement

A machine running Pi accumulates agent skills in `~/.agents/skills`, tracked by `~/.agents/.skill-lock.json`. Today the only way to add, inspect, update, or remove them is the `skills` CLI in a terminal. From PI WEB, a user must leave the UI, remember CLI flags, and read human-oriented output to answer basic questions: which skills are present, which are managed by the lockfile, which are unmanaged or broken, what source and ref each came from, and what an update would change. The CLI has no read-only check: in 1.7.4 `skills check` dispatches to the same update path, so there is no safe "what would change" action. Installing from a source requires choosing among discovered skills and understanding overwrite behaviour, which the CLI only expresses interactively.

The panel is machine-wide, but PI WEB is workspace-hosted. A user can easily mistake a project-scoped action for a machine-wide one, or expect installed skills to appear in running sessions without a reload.

## Solution

A PI WEB plugin with a server entry in the session daemon and a machine-scoped browser panel. The panel lists present skills classified as managed, unmanaged, or broken; adds skills from a source with an explicit selection and overwrite confirmation; updates managed installs by comparing the remote folder hash at the locked ref; removes managed installs and broken entries; and searches skills.sh. It writes only the managed directory, the standard global lock, and OS-temp clones it cleans up, follows upstream skills.sh semantics, never executes the `skills` CLI at runtime, and tells the user when a `/reload` is needed.

Unmanaged skills are read-only for Update and Remove. Add may replace an existing directory, including an unmanaged one, only after an explicit overwrite confirmation in the panel. Update is explicit and confirmed. Every operation is safe to retry; a disconnected long operation cancels, Update leaves the install it was replacing intact, and Add reports only completed installs.

## User Stories

### Scope and visibility

1. As a PI WEB user, I want a Skills panel in the workspace, so that I can manage Pi skills without leaving the UI.
2. As a PI WEB user, I want the panel to state that it manages the whole machine, so that I don't mistake it for a workspace-scoped tool.
3. As a PI WEB user, I want to see the managed directory and lockfile paths, so that I know exactly what state the panel reads and writes.
4. As a PI WEB user, I want the panel to work for any workspace on the machine, so that a machine-wide tool is not tied to one project.
5. As a PI WEB user, I want the panel to survive a page reload and re-read state from the server, so that I never rely on stale browser state.

### List

6. As a PI WEB user, I want to see every present skill directory, including ones the lockfile does not know, so that I understand what Pi can load.
7. As a PI WEB user, I want each skill classified as managed, unmanaged, or broken, so that I know which actions are allowed.
8. As a PI WEB user, I want managed rows to show source, ref, and update time, so that I can judge where a skill came from.
9. As a PI WEB user, I want unmanaged skills to be read-only for Update and Remove, so that the panel never changes or deletes something it did not install.
10. As a PI WEB user, I want broken entries shown even though their directory is missing, so that I can clean up stale lock state.
11. As a PI WEB user, I want a skill with invalid frontmatter marked rather than hidden, so that I can fix it.
12. As a PI WEB user, I want empty, loading, and error states, so that I can tell the difference between "nothing installed" and "the server failed".

### Add

13. As a PI WEB user, I want to add from a GitHub shorthand, a GitHub or GitLab URL, or a generic git URL, so that common sources work without CLI flags.
14. As a PI WEB user, I want local directory sources rejected with a clear reason, so that I don't expect a v1 feature that does not exist.
15. As a PI WEB user, I want to see the skills discovered in a source before installing, so that I choose what lands on my machine.
16. As a PI WEB user, I want to select one, several, or all discovered skills, so that I don't install a whole source by accident.
17. As a PI WEB user, I want a warning before an existing skill directory is replaced, so that I understand the overwrite is not a merge.
18. As a PI WEB user, I want add to write one standard lock entry per installed skill, so that the `skills` CLI and other tools still understand the state.
19. As a PI WEB user, I want add to skip `.git` and `node_modules` and refuse paths outside the skill directory, so that installing a source cannot smuggle in unrelated or sensitive files.
20. As a PI WEB user, I want duplicate names in one selection rejected before anything is written, so that one skill cannot silently overwrite another.

### Search

21. As a PI WEB user, I want to search skills.sh by keyword, so that I can find a source without knowing its owner and repository.
22. As a PI WEB user, I want search results to show name, source, and install count, so that I can choose a credible source.
23. As a PI WEB user, I want to start an Add from a search result, so that finding and installing is one flow.

### Update

24. As a PI WEB user, I want Update to check the locked ref and replace only skills whose remote folder changed, so that unchanged installs are not rewritten.
25. As a PI WEB user, I want Update to show the upstream skip reason for entries it cannot check, so that I know why some skills stay put.
26. As a PI WEB user, I want Update to report skills deleted upstream without deleting them automatically, so that I stay in control.
27. As a PI WEB user, I want to confirm Update before it can overwrite a local edit, so that I don't lose work by a stray click.
28. As a PI WEB user, I want Update to refresh the lock's `updatedAt` only for changed installs, so that the lock reflects reality.
29. As a PI WEB user, I want Update to follow a skill that moved within its source, so that an upstream reorganisation does not strand an install.

30. As a PI WEB user, I want Check for updates to report what would change without writing anything, so that I can preview an update safely.

### Remove

31. As a PI WEB user, I want Remove to delete both the directory and its lock entry, so that the skill is fully gone.
32. As a PI WEB user, I want Remove on a broken entry to delete only the stale entry, so that cleanup does not require a global restore.
33. As a PI WEB user, I want Remove unavailable for unmanaged skills, so that the panel cannot delete hand-managed files.
34. As a PI WEB user, I want a confirmation before Remove, so that a misclick does not destroy an install.

### Long operations

35. As a PI WEB user, I want a progress view for Add and Update, so that a slow clone does not look like a hung panel.
36. As a PI WEB user, I want to cancel a running Add or Update, so that I can stop a slow or mistaken operation.
37. As a PI WEB user, I want the previous install left intact if an update is cancelled or fails mid-copy, so that I never end up with a half-written skill.
38. As a PI WEB user, I want a clear error when a source cannot be resolved, cloned, or read, so that I can correct the input.

### Trust and machine state

39. As a PI WEB user, I want to be told that installed skills need `/reload` in each idle session, so that I know why Pi has not picked them up.
40. As a machine owner, I want the plugin to write only the managed directory and the global lock, so that no other agent's directory is touched.
41. As a machine owner, I want the plugin to preserve lock fields it does not understand, so that upgrading does not drop `dismissed` or `lastSelectedAgents`.
42. As a machine owner, I want the plugin to send no telemetry and make no network calls except git operations, GitHub tree lookups, and skills.sh search, so that I can reason about its network surface.
43. As a Pi agent, I want the same lock format the `skills` CLI writes, so that the CLI and the panel agree on what is installed.
44. As a plugin maintainer, I want the vendored upstream modules pinned and provably unmodified, so that upstream fixes can be re-applied without guessing what changed.
45. As a plugin maintainer, I want operation tests to run against a temporary HOME and local git sources, so that tests are deterministic and never touch the real machine.
46. As a plugin maintainer, I want parity tests against the real CLI, so that lock-compatibility regressions fail before release.

## Implementation Decisions

### Product surface

- One browser contribution: a workspace panel with id `skills`, title **Skills**, visible for every workspace on the selected machine. The panel is hosted inside a workspace but is not workspace-scoped; it never reads or writes workspace files.
- The panel always shows a machine-wide notice and the resolved managed-directory and lockfile paths.
- Sections, in order: source input (Add), search, managed skills, unmanaged skills, broken entries. Broken entries have no directory, so they are never grouped with present skills.
- The plugin has no settings in v1. GitHub authentication comes from the daemon environment (`GITHUB_TOKEN` or `GH_TOKEN`) and, for tree lookups, the `gh` CLI; there is no token UI.
- The browser entry uses the host-provided `html` template tag. It does not import Lit or bundle a UI framework.

### Host integration

- Browser entry API v4, server entry API v3, dual entry with `machineSpecific: true`. The server entry is imported once per session-daemon start; server changes require a daemon restart.
- One package peer carries all browser-to-server traffic. There is no workspace provider, no session capability, no terminal helper, no host file helper, and no companion Pi extension.
- Requests are bounded (the host allows roughly 10 s for a request and 25 s for dispatch). Channels are long-lived (up to 12 h) and stream frames. The split below respects those bounds; no operation relies on a request outliving its budget.
- The server derives state from its own environment, not from workspace authority. `project` and `workspace` in peer contexts are ignored.
- The managed directory is `<home>/.agents/skills`. The lockfile is `$XDG_STATE_HOME/skills/.skill-lock.json` when `XDG_STATE_HOME` is set, otherwise `<home>/.agents/.skill-lock.json`. `home` is the daemon user's home. Paths are resolved through one injectable resolver so tests can supply a temporary HOME.
- No project scope. `skills-lock.json` is never read or written. `$PI_CODING_AGENT_DIR/skills` is never read or written. Installs target the shared universal directory and create no symlink into another agent's directory.

### Peer contract

Requests:

- `status` → resolved paths, existence flags, and whether the lock is readable.
- `list` → the read model described below.
- `remove` → `{ names: string[] }` → per-name outcome.
- `search` → `{ query: string }` → sanitised results from skills.sh.

Channels:

- `add` → client opens with `{ source: string }`. The server resolves and streams candidates in bounded pages (about 25 per frame) ending with a `candidates-end` frame, so one frame never approaches the host's 64 KiB channel limit. The client sends `{ type: "install", sourcePaths: string[] }`. The server sends `{ type: "progress", phase, name, index, total }` per skill, then `{ type: "done", installed, replaced, failed }`. The client may send `{ type: "cancel" }` at any point. A terminal `done` or `error` frame completes the channel; the server removes the temp clone before the host closes it.
- `update` → client opens with `{ names?: string[], checkOnly?: boolean }`; omitted names and an explicit empty list both mean every managed entry. `checkOnly` runs the preflight and never writes. The server sends `{ type: "progress", name, state, reason? }` with state `checking | updating | available | unchanged | skipped | deleted | failed`, then `{ type: "done", updated, available, unchanged, skipped, deleted, failed }`. The client may send `{ type: "cancel" }`.
- Every frame and every request input is validated against a small typed schema. Unknown operations, unknown frame types, and malformed payloads produce a structured error rather than a crash.
- A channel frame is JSON only and bounded to the host's 64 KiB frame size. Results are summaries; descriptions are capped and sanitised; long lists are paged.
- The host bounds each channel open and receive callback to about 10 s. Those handlers return immediately; clone, install, and update work runs asynchronously on the channel lifetime signal and streams progress. No long operation is awaited inside an open or receive callback.
- Closing a channel aborts its operation through the channel signal. Temp clones are removed. Update applies one skill atomically, so an abort leaves the previous install intact and may leave earlier skills updated. Both operations are safe to retry.
- There is no job registry, no polling, and no background work after a channel closes in v1. The panel tells the user the operation stopped and offers a retry.

### Operation seam

- Every operation is a plain module that takes an operation context and returns a JSON value or drives a session event stream. The context carries: managed directory, lockfile path, a bounded `execFile` adapter, an injectable `fetch`, an injectable clock, a logger, a token resolver, and an `AbortSignal`.
- Operations never call `process.exit`, prompt, print to stdout, read `process.argv`, or send telemetry. Errors are structured `{ code, message, details? }` values with stable codes such as `unsupported-source`, `clone-failed`, `auth-required`, `rate-limited`, `not-managed`, `unsafe-path`, `lock-unreadable`, `search-unavailable`, and `invalid-input`.
- The peer layer is a thin adapter: it validates JSON, calls the operation or drives the session, and maps errors to frames. The browser layer is a thin adapter over peer requests and channels.
- Long operations are modelled as sessions with an event callback and `start` / `install` / `cancel` methods. Tests drive the session directly without a browser or a peer.
- Writes are atomic: lockfiles are written to a temp file in the same directory and renamed; skill directories are copied to a temp sibling and swapped; temp sources live under the OS temp directory and are removed on success, error, and cancellation.

### Read model

- A **present** skill is a directory containing a regular `SKILL.md`, discovered recursively under the managed directory. Discovery is bounded to five levels and skips `node_modules`, `.git`, `dist`, `build`, and `__pycache__`.
- Each present skill parses `name` and `description` from YAML frontmatter. A missing or non-string field marks the skill **invalid** with a reason; it is still shown. YAML parse failures are invalid, not fatal.
- **Managed** = present and matched to a lock entry. **Unmanaged** = present with no entry. **Broken** = an entry with no present directory.
- Matching tries the exact lock key, then the sanitised key, then the sanitised directory name, because a displayed name can sanitise to a different folder name (for example a colon becomes a hyphen). Lock keys win.
- A row returns: name, folder name, description, state, invalid reason, source, source type, ref, skill path, installed time, updated time, and plugin name when present.
- `list` is strictly read-only. It never creates the managed directory, never creates or repairs the lockfile, and never detects drift.
- Sort managed rows by name, then unmanaged, then broken. Return counts for each state.

### Lockfile

- Read and write the upstream version 3 global lock shape. A missing lockfile is an empty lock, not an error. A malformed lock is `lock-unreadable` and blocks mutations; the panel can still show present skills with a warning.
- Preserve unknown top-level fields and unknown per-entry fields. Preserve `dismissed` and `lastSelectedAgents` verbatim. Write `version: 3`, but never lower an existing higher version: the written version is `Math.max(3, existing)`. Keep every entry not being changed.
- An entry carries exactly the upstream fields: `source`, `sourceType`, `sourceUrl`, optional `ref`, `skillPath`, `skillFolderHash`, `installedAt`, `updatedAt`, and optional `pluginName`. No custom fields, no sidecar files, no metadata extensions.
- Add preserves `installedAt` when replacing an existing entry and sets `updatedAt` now. Update preserves `installedAt`, sets `updatedAt` only when the install changed, and updates `skillPath` when the skill moved. Remove deletes only the named key.
- All mutations re-read the lock immediately before writing and use an atomic rename. Lock mutations are serialized in-process per lockfile so two operations cannot lose each other's updates. A failed copy does not write an entry for that skill.

### Add

- Accepted source types: GitHub shorthand (`owner/repo`), GitHub or GitLab HTTPS URLs (including tree URLs with a subpath), generic git URLs (including `file://` for tests), with an optional `#ref` and `@skill` fragment. Rejected with `unsupported-source`: local paths, well-known skill URLs, hosted archive or raw-file URLs, and malformed input.
- Resolution parses the source, clones it to a temp directory at the requested ref (shallow when possible; fetch the commit when the ref is a full SHA and `--branch` cannot target it), and discovers every directory containing `SKILL.md`. Each candidate carries name, description, source path, sanitised install folder name, computed folder hash, and the existing target state (`none`, `managed`, or `unmanaged`). Existing-target detection uses the same recursive present-skill discovery as List, so a nested present skill matches its destination.
- Folder hash for GitHub and GitLab sources is the git tree object SHA of the skill folder (`git rev-parse HEAD:<folder>`), or the repository tree SHA for a root-level skill. Folder hash for generic git sources is the vendored SHA-256 content hash. GitHub tree hashing must never silently fall back to a different hash shape, because Update uses a 40-hex hash as its "checkable" signal.
- Install copies each selected skill directory into `<managedDirectory>/<sanitised name>`. Copying includes regular files and directories with their file modes, skips symlinks, `.git`, and `node_modules`, and rejects any path that resolves outside the source skill directory. The destination is staged as a temp sibling and swapped in; an existing directory is replaced, never merged. A root-level skill copies the repository root with the same exclusions.
- Replacing an existing directory is a panel decision: the panel asks for overwrite confirmation before it sends an install that targets an existing folder, including an unmanaged one. The server never prompts; after the fact it reports `replaced` names so the UI can prove what happened.
- Duplicate sanitised names within one selection fail before any copy or lock write.
- The channel owns the temp clone until installation finishes or the channel closes. All exit paths clean it up; a terminal `done` or `error` frame completes the channel and removes the clone before the host closes it.
- One lock entry is written per successfully installed skill. The entry's `source` is the normalized `owner/repo` for GitHub and GitLab sources and the clone URL for generic git; `sourceUrl` is the clone URL; `sourceType` is the parsed type. A later failure leaves earlier successes installed and recorded; the result lists failures with messages.

### Update

- Checkable entries are exactly those with `sourceType: "github"`, a non-empty `skillPath`, and a non-empty `skillFolderHash`. Everything else is skipped with the upstream reason strings: `Local path`, `Git URL`, `Well-known skill`, `Private or deleted repo`, `No skill path recorded`, `No version tracking`. A checkable entry whose install directory is missing is also skipped, with `Install directory is missing`, and is never reinstalled.
- Entries are grouped by source and ref. A URL taken from lock state that carries an `ext::` transport is rejected before any clone. For each group, fetch the GitHub tree at the locked ref through the GitHub API using the token resolver and, when needed, `gh api` through the bounded `execFile` adapter. Use the vendored tree parser/hash helper, but not any vendored function that spawns its own process. If the API is unavailable, clone at the ref and compute hashes from the checkout.
- Compare each entry's `skillFolderHash` with the remote folder hash. Match by skill name across the current source before declaring anything deleted: a name found at a different path is relocated, not deleted. A name absent from the current source marks the skill deleted upstream: report it, never delete its install or entry.
- If the skill is found at a different path in the same source, mark it relocated: update `skillPath` as part of the update.
- Apply only changed and relocated skills. Clone the group at the ref when content is needed, then replace each install through the same safe copier and atomic swap used by Add. Preserve `installedAt`; set `updatedAt` now for each replaced skill.
- Update all is not a dry run. The panel confirms before starting, stating that a remote change can overwrite a local edit. Cancellation stops after the current skill and reports partial results.
- Check for updates is a read-only preflight. It fetches the locked ref, compares the same folder hashes, and reports `available`, `unchanged`, `skipped`, `deleted`, and `failed` entries without copying, swapping, or writing the lock. It needs no confirmation because it changes nothing. See ADR 0005.
- A group that cannot be fetched is reported as failed with a reason; other groups continue.

### Remove

- Remove resolves each requested name to a managed or broken identity using the same matching rules as List, preferring lock keys.
- A managed install removes its directory recursively, then its lock entry. A broken entry removes only the entry. An unmanaged directory is `not-managed` and is never touched. An unknown name is `not-found`.
- Every removal path must resolve inside the managed directory after symlink resolution. A symlinked *present* skill is refused with `unsafe-path` rather than followed. A *broken* entry whose folder name is a symlink is cleaned up by deleting only the lock entry; removal never follows the link and never deletes the link or its target.
- The lock write preserves unknown fields. If the directory is already missing, removing the entry still succeeds; the result says the directory was absent.

### Search

- Query `GET https://skills.sh/api/search?q=<query>&limit=20`, with the base URL overridable for tests. Validate the JSON shape (`skills[]` with `id`, `name`, `source`, `installs`), sanitise every string, drop malformed rows, and sort by installs descending.
- Cap the response and apply an 8 s timeout with the request signal, leaving headroom inside the host's request bound. A non-2xx response is `search-unavailable`; malformed JSON is `search-invalid-response`; an aborted request is a cancellation, not an error banner.
- "Add" from a result prefills the Add source and preselects the result's skill after resolution. Search itself never writes.

### Safety

- No shell anywhere. Git, `gh`, and any other process run through the host `execFile` with argv arrays, a working directory, a timeout, and output bounds. Set `GIT_TERMINAL_PROMPT=0` and `GIT_OPTIONAL_LOCKS=0`; reject `ext::` transports.
- Clone timeout is requested at 120 s, subject to the host's lower maximum; GitHub API calls use 10 s and search uses 8 s. A timeout is a structured error with a retry hint.
- All user-supplied names are sanitised before use as a path. Containment checks run before any copy, delete, or rename. Never write outside the managed directory, the resolved lockfile path, and validated OS-temp clone paths.
- Temp clones use a unique OS temp prefix. Cleanup validates that the path is inside the OS temp directory before removing it.
- No telemetry, analytics, session messaging, or automatic `/reload`. No writes to another agent's directory, no Claude/Cursor/OpenCode copies.

### Vendoring

- Vendor the pinned pure modules from `vercel-labs/skills` v1.7.4, commit `a80e4c9d12d607631249d4d7d059f835d4b2f13a`, verbatim: source parser, GitHub host, blob/tree, skills, frontmatter, sanitize, constants, plugin manifest, skill lock, local lock, update source, and types. Include upstream `LICENSE` and a `PROVENANCE.md` with source URL, commit, file list, and the "copied verbatim; do not edit" rule.
- The vendored modules are a backport, not a fork. If behaviour must change, wrap or replace at the operation layer; do not patch vendor files. When upstream ships an exported API, the operation layer can be replaced without UI changes.
- `yaml` is the only runtime dependency. `skills@1.7.4` stays a dev dependency for parity fixtures. No runtime execution of the CLI.
- The vendored files assign `undefined` to optional properties, so the repo turns `exactOptionalPropertyTypes` off; every other strict flag stays on. Do not patch vendor files or add a second tsconfig project just for this.

### Build and test

- Add `npm test` using Node's built-in test runner (`node --test`), which discovers `test/**/*.test.ts` under the repo's Node floor. Tests import source with explicit `.ts` extensions, matching the existing tsconfig. Keep the Playwright smoke test in a separate command so unit tests stay fast and hermetic.
- Extend typechecking to tests with a test tsconfig that includes `src` and `test` and emits nothing.
- The operation session is the single seam. Tests create a temporary HOME, a temporary managed directory and lock, local git fixture sources, a fake clock, and a fake or local HTTP server for GitHub/search, then drive the session and assert its emitted frames. No test touches the real HOME, the real lock, or the network. The peer adapter is a thin JSON mapping tested only for validation and prompt return.
- Add Playwright as a dev dependency for one isolated-instance panel smoke test. Reuse the cached Chromium revision; do not make the default unit command depend on a browser.

## Testing Decisions

Good tests assert external behaviour: the contents of the managed directory, the bytes and shape of the lockfile, the structured result of an operation, and the frames a session emits. They do not assert private helper calls, internal file layout, or log strings.

- **Path resolver:** default and XDG lock paths, with HOME supplied by the test.
- **List:** fixtures for managed, unmanaged, broken, invalid frontmatter, nested skills, and a lock key that sanitises to a different folder name. Assert classifications and that no files change.
- **Lockfile:** missing, malformed, unknown fields, atomic write, preserved `dismissed` / `lastSelectedAgents`, and no version downgrade.
- **Add:** local git fixture with one and several skills; candidates and hashes; install and lock entry; overwrite of managed and unmanaged targets; duplicate names; symlink and `.git` exclusion; cleanup on success, error, and cancel. A GitHub source uses a fake tree response; a generic git source uses the content hash.
- **Update:** changed and unchanged hashes; every skip reason; deleted upstream reported and not removed; relocated path; local edit overwritten only when the remote changed; `updatedAt` only on change; cancellation after a completed skill; check-only reports available changes while leaving the install, lock, and timestamps untouched.
- **Remove:** managed removal, broken cleanup, unmanaged refusal, missing directory, symlink refusal, preserved lock extras.
- **Search:** valid response, non-2xx, malformed JSON, abort, sanitisation, sort order.
- **Parity:** install the same generic git source into two temporary HOMEs, one with the real `skills` CLI and one with the plugin, and compare the lock after normalising timestamps. Cover update decisions with changed/unchanged hashes and a mocked GitHub tree. Cover removal, broken cleanup, and unmanaged protection as filesystem tests.
- **Panel smoke:** one Playwright run against an isolated PI WEB instance: open a workspace, open the Skills panel, verify the machine-wide notice, paths, and list states, then exercise one add and one remove against a local git fixture.
- **Prior art:** upstream's vitest suite is a reference for fixture shapes, but no test code is copied. There is no existing test harness in this repo; the operation seam is new and deliberately the only new seam.

## Out of Scope

- Project installs, `skills-lock.json`, workspace-scoped skills, and any notion of a project root.
- The Pi-native directory (`$PI_CODING_AGENT_DIR/skills`) and any other agent's directory.
- Local directory sources, well-known skill URLs, archives, direct file downloads, and hosted artifact URLs.
- Adoption of unmanaged skills, pinning or unpinning, candidate/version scanning, drift detection, sidecars, extra lock fields, and global restore.
- Collision warnings across scopes, because there is only one scope.
- Automatic session reload, session messaging, a companion Pi extension, and telemetry.
- Broad browser test matrices, screenshot baselines, and cross-browser coverage. One Playwright smoke test of the panel is in scope; it is not a browser test suite.
- Remote-machine-specific behaviour beyond `machineSpecific: true`.
- Publishing to npm.

## Further Notes

- The plugin panel is hosted in a workspace, but the managed state is machine-wide. The UI copy must make that difference obvious; this is the most likely source of user confusion.
- The host's request/dispatch timeouts are why Add and Update use channels. If the host lowers its channel lifetime or frame bound, the session adapters must degrade to a clear error rather than buffering unbounded output.
- `skills check` is not read-only in 1.7.4. Do not expose it, and do not describe Update as a preview.
- Upstream's lock is the contract. Anything the panel writes must remain readable by the CLI, and anything the CLI writes must remain readable by the panel.
- Verified against the installed PI WEB public contracts (`plugin-api` v4, `server-plugin-api` v3). Only those entrypoints may be imported; internal routes and `dist/**` imports are unsupported.
- The isolated test-instance recipe in `docs/local-development.md` is the manual verification path. The hosting daemon must not be restarted as part of this build.