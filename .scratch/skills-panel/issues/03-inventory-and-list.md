# 03: Inventory and read-only list

**What to build:** The panel shows every **present** skill in the managed directory, classified as managed, unmanaged, or broken, with frontmatter name/description and lock metadata. Nothing can be changed from this screen yet.

**Blocked by:** 02 (Foundation — vendored upstream subset and standard lockfile).

**Status:** resolved

**Pointers:** `.scratch/skills-panel/spec.md` sections *Read model*, *Lockfile*, *Vendoring*; `GLOSSARY.md` terms *Present*, *Managed*, *Unmanaged*, *Broken*, *Entry*; `docs/upstream-parity.md`.

- [x] Lockfile reads the standard shape via the foundation module; a malformed lock reports a warning and still allows present skills to render.
- [x] Discovery finds regular `SKILL.md` files recursively (depth ≤ 5), skipping `node_modules`, `.git`, `dist`, `build`, and `__pycache__`.
- [x] `list` returns counts plus rows with name, folder, description, state, invalid reason, source, source type, ref, skill path, installed/updated times, and plugin name when present.
- [x] Matching uses the foundation rules (exact lock key, sanitised key, sanitised folder name; lock keys win). A key like `ce:review` matches folder `ce-review`.
- [x] Invalid frontmatter (missing/non-string name or description, YAML failure) marks the row invalid but still shows it.
- [x] Broken entries appear even when the directory is missing. `list` performs no writes and does not create the managed directory or lockfile.
- [x] Panel renders managed, unmanaged, broken, and invalid states with empty/loading/error states and no action buttons yet.
- [x] Tests cover managed/unmanaged/broken/invalid/nested fixtures, the sanitised-key match, missing lock, malformed lock, and an assertion that list leaves the filesystem untouched.
- [x] `npm run build`, `npm run typecheck`, and `npm test` pass.

## Result

**Commits:** `c5a54a3` (feat: list present skills as managed, unmanaged, or broken), plus the commit recording this result.

**Files**

- `src/operations/list.ts` — present discovery to five levels with the noise directories skipped, frontmatter parsing into name/description/invalid reason, foundation matching against lock keys, managed/unmanaged/broken rows with counts, and a `lockWarning` on a malformed lock. Read-only: no directory, lock, or temp writes.
- `src/server.ts` — `list` registered in the peer router with a null-input check; `PeerResponse` value widened to `StatusPayload | ListPayload`. No other change.
- `src/browser/list.ts` — machine-keyed list state and rendering for loading, ready (managed/unmanaged/broken groups, invalid markers, source/ref/plugin/updated metadata, lock warning), empty, and error states; no actions.
- `src/browser/index.ts` — one import and one render call for the list section.
- `test/list.test.ts` — empty machine and no-write snapshot, managed/unmanaged/broken fixture, invalid frontmatter (missing, non-string, YAML failure), nested discovery to depth 5 with skipped directories, sanitised-key (`ce:review` ↔ `ce-review`) and displayed-name matches, missing lock, malformed lock with warning and unchanged filesystem, broken entry with no managed directory.
- `test/panel-list.test.ts` — loading, ready/classification/invalid, empty, error, and lock-warning rendering with a fake peer and template tag; asserts no button markup.
- `test/server.test.ts` — `list` returns rows/counts, malformed list input is `invalid-input`, and the unknown-operation test now uses a genuinely unknown name.

**Commands**

- `npm run build` — pass.
- `npm run typecheck` — pass.
- `npm test` — pass: 70 tests, 0 failures.

**Notes**

- `PeerResponse` is still declared in `src/server.ts` because the repo has no separate protocol module; the added lines are the import, the widened union, and the `list` branch.
- Two present skills cannot claim the same lock entry twice; the first row in discovery order wins the entry and the second stays unmanaged. No ticket path depends on that ambiguity.
