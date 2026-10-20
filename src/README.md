# Source layout

```
src/
├── browser/
│   └── index.ts          PI WEB panel contribution (host-provided html)
├── server.ts             PI WEB server entry; peer requests
├── operations/
│   ├── add.ts            resolve source -> select -> install -> lock entry
│   ├── list.ts           present + lock -> managed / unmanaged / broken
│   ├── update.ts         remote hash vs lock -> replace changed installs
│   └── remove.ts         remove install + entry; remove stale entry
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
