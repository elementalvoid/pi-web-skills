# 01: Plugin shell and machine status

**What to build:** A loadable PI WEB plugin with a server entry and a browser entry. The browser contributes one **Skills** workspace panel that renders for every workspace, states that it manages the whole machine, shows the resolved managed-directory and lockfile paths from the server, and reports whether each exists. No filesystem writes yet.

**Blocked by:** None (can start immediately).

**Status:** resolved

**Pointers:** `.scratch/skills-panel/spec.md` sections *Product surface*, *Host integration*, *Peer contract*, *Operation seam*; `README.md`; `src/README.md`; the installed PI WEB public contracts at `/usr/local/lib/node_modules/@jmfederico/pi-web/dist/plugin-api.d.ts` and `server-plugin-api.d.ts`, plus `docs/plugins.md` and `examples/workspace-provider-plugin/` in the same package.

- [x] Server entry uses `PiWebServerPlugin` apiVersion 3 with a peer `request` router; browser entry uses `PiWebPlugin` apiVersion 4 with a workspace panel contribution (id `skills`, title `Skills`).
- [x] The existing `package.json` `piWeb.plugins` metadata resolves the built `dist/browser/index.js` and `dist/server.js`, keeps `browserRoot` narrow, and keeps `machineSpecific: true`; the built browser entry has no runtime import outside the browser root.
- [x] `status` request returns the managed directory, lockfile path, existence flags for each, and a readable/unreadable lock flag.
- [x] Path resolution is one injectable function: `<home>/.agents/skills` and `$XDG_STATE_HOME/skills/.skill-lock.json` when set, else `<home>/.agents/.skill-lock.json`. Production uses the daemon environment; tests pass a temp home and temp XDG value.
- [x] The panel renders header, machine-wide notice, both paths, and a loading/error state for the status request. It never claims to be workspace-scoped.
- [x] Unknown peer operations and malformed inputs return a structured error instead of throwing through the host.
- [x] Test harness exists: `npm test` runs `node --test`, `npm run typecheck` covers `src` and `test`, and a test proves both path variants without touching the real HOME.
- [x] `npm run build`, `npm run typecheck`, and `npm test` pass.
- [x] No operation writes to disk; nothing outside the host's plugin roots is touched.

## Result

Implemented on `ticket/01-plugin-shell`.

- `76c7ea0` feat: report machine skill paths and status from one operation
- `6b868dd` feat: serve the status operation through the server plugin peer
- `0bde66d` feat: add the machine-wide Skills workspace panel

Verification from `/data/home/projects/pi-web-skills-wt/01`:

- `git merge-base --is-ancestor integration/skills-panel HEAD` — pass before starting.
- `npm install --no-package-lock` — pass.
- `npm run build` — pass; emits `dist/server.js` and `dist/browser/index.js`.
- `npm run typecheck` — pass; `tsconfig.test.json` covers `src` and `test`.
- `npm test` — pass, 10/10 tests.
- `grep -nE "^(import|export .* from)|require\(" dist/browser/index.js` — no matches; the built browser entry has no runtime imports.

Tests cover both lock path variants from an injected home and XDG state directory,
missing and unreadable locks, structured peer errors for unknown operations and
malformed input, the browser contribution declaration, and the package metadata.
No test touches the real HOME, and no operation writes to disk.
