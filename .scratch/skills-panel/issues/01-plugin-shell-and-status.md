# 01: Plugin shell and machine status

**What to build:** A loadable PI WEB plugin with a server entry and a browser entry. The browser contributes one **Skills** workspace panel that renders for every workspace, states that it manages the whole machine, shows the resolved managed-directory and lockfile paths from the server, and reports whether each exists. No filesystem writes yet.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

**Pointers:** `.scratch/skills-panel/spec.md` sections *Product surface*, *Host integration*, *Peer contract*, *Operation seam*; `README.md`; `src/README.md`; the installed PI WEB public contracts at `/usr/local/lib/node_modules/@jmfederico/pi-web/dist/plugin-api.d.ts` and `server-plugin-api.d.ts`, plus `docs/plugins.md` and `examples/workspace-provider-plugin/` in the same package.

- [ ] Server entry uses `PiWebServerPlugin` apiVersion 3 with a peer `request` router; browser entry uses `PiWebPlugin` apiVersion 4 with a workspace panel contribution (id `skills`, title `Skills`).
- [ ] The existing `package.json` `piWeb.plugins` metadata resolves the built `dist/browser/index.js` and `dist/server.js`, keeps `browserRoot` narrow, and keeps `machineSpecific: true`; the built browser entry has no runtime import outside the browser root.
- [ ] `status` request returns the managed directory, lockfile path, existence flags for each, and a readable/unreadable lock flag.
- [ ] Path resolution is one injectable function: `<home>/.agents/skills` and `$XDG_STATE_HOME/skills/.skill-lock.json` when set, else `<home>/.agents/.skill-lock.json`. Production uses the daemon environment; tests pass a temp home and temp XDG value.
- [ ] The panel renders header, machine-wide notice, both paths, and a loading/error state for the status request. It never claims to be workspace-scoped.
- [ ] Unknown peer operations and malformed inputs return a structured error instead of throwing through the host.
- [ ] Test harness exists: `npm test` runs `node --test`, `npm run typecheck` covers `src` and `test`, and a test proves both path variants without touching the real HOME.
- [ ] `npm run build`, `npm run typecheck`, and `npm test` pass.
- [ ] No operation writes to disk; nothing outside the host's plugin roots is touched.
