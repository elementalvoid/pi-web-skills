# Source layout

```
src/
├── browser/
│   ├── index.ts          PI WEB panel contribution (host-provided html)
│   ├── status.ts         machine paths, loading/error/retry, refresh after mutations
│   ├── list.ts           managed/unmanaged/broken rows, Remove confirmation, notices
│   ├── add-panel.ts      Add source, candidates, selection, overwrite confirmation
│   ├── add-handoff.ts    Search -> Add preselection, scoped to one hosted panel
│   ├── search-panel.ts   skills.sh search and Add from a result
│   ├── update-panel.ts   Update confirmation, progress, results, cancel
│   └── sanitize-name.ts  browser copy of the install-folder rule
├── server.ts             PI WEB server entry; peer requests and channels
├── operations/
│   ├── status.ts         resolved paths and lock readability
│   ├── list.ts           present + lock -> managed / unmanaged / broken
│   ├── add.ts            resolve source -> discover -> install session
│   ├── add-channel.ts    add channel adapter over the add session
│   ├── update.ts         remote hash vs lock -> replace changed installs
│   ├── update-channel.ts update channel adapter over the update session
│   ├── remove.ts         remove install + entry; remove stale entry
│   ├── search.ts         skills.sh search client with validated results
│   ├── paths.ts          managed directory and lockfile locations
│   ├── context.ts        what one operation may touch
│   ├── errors.ts         structured operation errors
│   ├── lockfile.ts       standard global lock read, atomic write, serialized mutation
│   ├── matching.ts       requested name -> lock key and folder name
│   └── containment.ts    managed-directory and temp-path checks
├── upstream/
│   ├── git.ts            bounded git/gh runner over host execFile
│   ├── github-tree.ts    repo tree fetch + folder tree SHA
│   └── install.ts        safe skill directory copier
└── vendor/
    └── skills/           pinned upstream modules (v1.7.4)
```

`e2e/skills-panel.e2e.mjs` is the isolated-instance Playwright smoke test. It is
outside `test/` so `npm test` stays browser-free.

## Rules

- No `skills` CLI execution at runtime.
- No custom lock fields, sidecars, or metadata.
- All lock writes go through the standard global lock shape.
- Never write outside `~/.agents/skills` and `~/.agents/.skill-lock.json`.
- No telemetry.
- Browser code uses the host-provided `html` template tag; it does not import Lit.
- Browser code imports only other modules under `browser/`. The host serves
  `dist/browser` and nothing outside it, so a runtime import of `operations/`,
  `upstream/`, or `vendor/` 404s in the browser. `sanitize-name.ts` exists for
  that reason; `test/matching.test.ts` keeps it equal to the operation rule.
- `src/vendor/skills/` is copied from the pinned commit, not edited. See its
  `PROVENANCE.md` for the commit SHA and file list.
