# 03: Inventory and read-only list

**What to build:** The panel shows every **present** skill in the managed directory, classified as managed, unmanaged, or broken, with frontmatter name/description and lock metadata. Nothing can be changed from this screen yet.

**Blocked by:** 02 (Foundation — vendored upstream subset and standard lockfile).

**Status:** ready-for-agent

**Pointers:** `.scratch/skills-panel/spec.md` sections *Read model*, *Lockfile*, *Vendoring*; `GLOSSARY.md` terms *Present*, *Managed*, *Unmanaged*, *Broken*, *Entry*; `docs/upstream-parity.md`.

- [ ] Lockfile reads the standard shape via the foundation module; a malformed lock reports a warning and still allows present skills to render.
- [ ] Discovery finds regular `SKILL.md` files recursively (depth ≤ 5), skipping `node_modules`, `.git`, `dist`, `build`, and `__pycache__`.
- [ ] `list` returns counts plus rows with name, folder, description, state, invalid reason, source, source type, ref, skill path, installed/updated times, and plugin name when present.
- [ ] Matching uses the foundation rules (exact lock key, sanitised key, sanitised folder name; lock keys win). A key like `ce:review` matches folder `ce-review`.
- [ ] Invalid frontmatter (missing/non-string name or description, YAML failure) marks the row invalid but still shows it.
- [ ] Broken entries appear even when the directory is missing. `list` performs no writes and does not create the managed directory or lockfile.
- [ ] Panel renders managed, unmanaged, broken, and invalid states with empty/loading/error states and no action buttons yet.
- [ ] Tests cover managed/unmanaged/broken/invalid/nested fixtures, the sanitised-key match, missing lock, malformed lock, and an assertion that list leaves the filesystem untouched.
- [ ] `npm run build`, `npm run typecheck`, and `npm test` pass.
