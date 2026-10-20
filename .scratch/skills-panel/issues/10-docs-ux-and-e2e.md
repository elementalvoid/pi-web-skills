# 10: Docs, final UX states, and end-to-end verification

**What to build:** The plugin is documented as implemented, every panel state is coherent, and the package loads in an isolated PI WEB test instance with its server entry active and its browser bundle served. This is the polish and verification ticket, not a new feature.

**Blocked by:** 05 (Add — install and write lock entries), 06 (Remove and broken-entry cleanup), 07 (Update managed installs), 08 (Search skills.sh), 09 (Upstream parity suite).

**Status:** resolved

**Pointers:** `.scratch/skills-panel/spec.md` sections *Product surface*, *Build and test*, *Testing Decisions*, *Further Notes*; `docs/local-development.md`; `README.md`; `docs/agents/issue-tracker.md`.

- [x] `README.md` no longer says "design scaffold": it describes the implemented panel, the five operations, the machine-wide scope, the read-only unmanaged rule, the reload reminder, and the v1 limitations.
- [x] `src/README.md` matches the implemented module layout, including any protocol, session, or search modules added.
- [x] Panel review covers: machine-wide copy, loading, empty, error, invalid frontmatter, unmanaged read-only, broken cleanup, overwrite confirmation, update confirmation, cancel, partial failure, and the dismissible `/reload` reminder.
- [x] No panel action can run without the required confirmation; no error shows a stack trace; no success path leaves stale rows.
- [x] Add a Playwright browser smoke test (separate from `npm test`) against the isolated instance: open a workspace, open the Skills panel, verify the machine-wide notice and resolved paths, verify empty or populated list states, then add one skill from a local git fixture and remove it. Record the test command and any environment prerequisites.
- [x] The isolated test-instance recipe is followed (separate HOME, `PI_CODING_AGENT_DIR`, `PI_WEB_DATA_DIR`, socket, and port): the plugin is discovered, the server entry activates without errors, and the browser bundle route serves the built module.
- [x] A short manual UI checklist is added near the local-development docs, including the daemon-restart and `/reload` expectations. The hosting daemon is not restarted.
- [x] `npm run build`, `npm run typecheck`, and `npm test` pass.
- [x] The working tree has no leftover temp clones in the OS temp directory and no build artifacts outside `dist/` and `node_modules/`.

## Result

Implementation commit: `e85c995` (docs, panel-state fixes, Playwright smoke test).

### Delivered

- `README.md` describes the implemented panel: five operations, machine-wide scope,
  resolved paths, unmanaged read-only rule, overwrite/update/remove confirmations,
  dismissible `/reload` reminder, and v1 limits.
- `src/README.md` lists the final source layout, including `status.ts`,
  `add-channel.ts`, `update-channel.ts`, `search.ts`, `sanitize-name.ts`, and the
  e2e file, plus the browser-root import rule.
- `docs/local-development.md` documents `npm run test:e2e`, its isolated-instance
  behaviour, the Playwright/Chromium prerequisite, and a manual UI checklist with
  daemon-restart and `/reload` expectations.
- Panel fixes found while reviewing the states:
  - browser code no longer imports `operations/matching.ts`; the host only serves
    `dist/browser`, so that import 404'd the whole panel bundle. A browser-local
    `sanitize-name.ts` plus a parity test keeps the folder rule in sync.
  - machine status refreshes after Add/Update/Remove, can retry an error, and has
    a generation guard so a refresh during loading is not stranded.
  - list errors have Retry; remove/`/reload` notices are dismissible.
  - Add clears the previous install's `/reload` reminder on a new resolve and
    replaces a dead progress line with a clear message if the channel closes
    before the operation finishes.
- `e2e/skills-panel.e2e.mjs` starts an isolated PI WEB instance (temp HOME, agent
  dir, data dir, socket, and free port), seeds a managed/unmanaged/invalid/broken
  list and a local `file://` git source, opens the panel in Chromium, and checks:
  machine-wide notice and resolved paths; managed/unmanaged/broken/invalid rows;
  unmanaged read-only; Add resolve, selection, overwrite confirmation, install,
  and on-disk install + lock entry; dismissible `/reload`; Remove; broken-entry
  cleanup; and Update confirmation/cancel. It cleans up children, browser, temp
  tree, and symlink on success and failure, and blocks non-localhost browser
  traffic. No E2E blocker.

### Commands

All passed:

```sh
npm run build
npm run typecheck
npm test                 # 210 tests
npm run test:e2e         # Skills panel smoke test passed
```

### Environment notes

- The ticket suggested Playwright 1.64.1, but that release expects Chromium
  revision 1248; the image cache is revision 1243. Playwright is pinned to
  `1.63.0`, which expects 1243.
- Chromium system libraries were installed once with
  `PLAYWRIGHT_BROWSERS_PATH=/data/home/.cache/ms-playwright npx playwright install-deps chromium`.
- The test daemon must start after `npm run build`; a daemon started before a
  package change reports `staleRevision` and withholds the browser entry.
- The hosting daemon, `/data/pi-web`, and port 8505 were not touched. No temp
  clones or build artifacts remain outside `dist/` and `node_modules/`.
