# Source layout

```
src/
├── browser/
│   ├── index.ts          PI WEB panel contribution (host-provided html)
│   └── add-panel.ts      Add source, candidates, and selection
├── server.ts             PI WEB server entry; peer requests and channels
├── operations/
│   ├── add.ts            resolve source -> discover -> candidates session
│   ├── add-channel.ts    add channel adapter over the add session
│   ├── list.ts           present + lock -> managed / unmanaged / broken
│   ├── update.ts         remote hash vs lock -> replace changed installs
│   ├── remove.ts         remove install + entry; remove stale entry
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

## Rules

- No `skills` CLI execution at runtime.
- No custom lock fields, sidecars, or metadata.
- All lock writes go through the standard global lock shape.
- Never write outside `~/.agents/skills` and `~/.agents/.skill-lock.json`.
- No telemetry.
- Browser code uses the host-provided `html` template tag; it does not import Lit.
- `src/vendor/skills/` is copied from the pinned commit, not edited. Add a `PROVENANCE.md` with the commit SHA and file list.
