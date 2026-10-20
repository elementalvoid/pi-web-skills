# 10: Docs, final UX states, and end-to-end verification

**What to build:** The plugin is documented as implemented, every panel state is coherent, and the package loads in an isolated PI WEB test instance with its server entry active and its browser bundle served. This is the polish and verification ticket, not a new feature.

**Blocked by:** 05 (Add — install and write lock entries), 06 (Remove and broken-entry cleanup), 07 (Update managed installs), 08 (Search skills.sh), 09 (Upstream parity suite).

**Status:** ready-for-agent

**Pointers:** `.scratch/skills-panel/spec.md` sections *Product surface*, *Build and test*, *Testing Decisions*, *Further Notes*; `docs/local-development.md`; `README.md`; `docs/agents/issue-tracker.md`.

- [ ] `README.md` no longer says "design scaffold": it describes the implemented panel, the five operations, the machine-wide scope, the read-only unmanaged rule, the reload reminder, and the v1 limitations.
- [ ] `src/README.md` matches the implemented module layout, including any protocol, session, or search modules added.
- [ ] Panel review covers: machine-wide copy, loading, empty, error, invalid frontmatter, unmanaged read-only, broken cleanup, overwrite confirmation, update confirmation, cancel, partial failure, and the dismissible `/reload` reminder.
- [ ] No panel action can run without the required confirmation; no error shows a stack trace; no success path leaves stale rows.
- [ ] Add a Playwright browser smoke test (separate from `npm test`) against the isolated instance: open a workspace, open the Skills panel, verify the machine-wide notice and resolved paths, verify empty or populated list states, then add one skill from a local git fixture and remove it. Record the test command and any environment prerequisites.
- [ ] The isolated test-instance recipe is followed (separate HOME, `PI_CODING_AGENT_DIR`, `PI_WEB_DATA_DIR`, socket, and port): the plugin is discovered, the server entry activates without errors, and the browser bundle route serves the built module.
- [ ] A short manual UI checklist is added near the local-development docs, including the daemon-restart and `/reload` expectations. The hosting daemon is not restarted.
- [ ] `npm run build`, `npm run typecheck`, and `npm test` pass.
- [ ] The working tree has no leftover temp clones in the OS temp directory and no build artifacts outside `dist/` and `node_modules/`.
