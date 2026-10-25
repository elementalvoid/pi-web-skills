# Discovery keyword and supported PI WEB versions

Status: resolved

Reported as: add the `pi-web.dev-plugin` keyword; does the README list the
minimum PI WEB version; should the `@jmfederico/pi-web` dev dependency move?

## Findings

1. **Keyword** — the PI WEB community directory
   (<https://pi-web.dev/community-plugins>) asks authors to ship
   `["pi-web.dev-plugin", "pi-package", "pi-web-plugin"]` and says
   `pi-web.dev-plugin` is the one that identifies plugins for the directory.
   We had `pi-web-plugin` and `pi-package` but not `pi-web.dev-plugin`, so the
   package only appeared in the broad npm search, not the directory search.
   Keywords affect npm search indexing only, so the change reaches users on the
   next publish.

2. **Minimum version** — the README named browser API v4 and server API v3 plus
   "tested against 1.202610.1". It never stated a minimum release, and one
   cannot be derived from a "tested against" line. Both API levels first shipped
   together in `@jmfederico/pi-web` **1.202609.1** (1.202609.0 was browser v2 /
   server v1), verified against the published `plugin-api.d.ts` and
   `server-plugin-api.d.ts` of each release. The v5 move below raises the floor
   to 1.202610.5.

3. **Dependency** — `^1.202610.1` floats and the repo has no lockfile, so a
   fresh `npm install` already resolved 1.202610.6. Since 1.202610.5 the
   published `PiWebServerPlugin` is a union of server API v3 and v5, which broke
   `npm run typecheck` on a fresh install (`test/server.test.ts` typed the
   activation context unannotated, so the union collapsed the parameter type).
   Runtime was unaffected: build, 222 tests, and the e2e-free suite pass against
   the newest release.
   - 1.202610.4: Moonshot provider fix.
   - 1.202610.5: browser and server API v5, community directory links, base
     theme, shared UI styles v1, syntax highlighting, stylesheet contributions.
   - 1.202610.6: three chat-input fixes.

## Decision

Bump the dev dependency to `^1.202610.6`, annotate the test's activation calls so
the entry contract stays explicit, state the real version floor in the README.

Browser entry moved to API v5 to use the `stylesheets` contribution: the panel
CSS became a real file under `browserRoot` instead of a `<style>` element inside
every render. The host fetches and compiles it once per URL, adopts it in the
document and participating host shadow roots, and releases it when the plugin
unloads. Trade-off: loading is asynchronous, so a cold load can paint the panel
before the sheet applies (measured in e2e; resolved within the first polls).

Server entry also moved to API v5. Upstream marks v3 deprecated without a date
but states the intent plainly, and the migration is mechanical: `apiVersion: 5`
and the peer callbacks receive host-resolved `scope` instead of `project` plus
`workspace`. The handlers ignore scope because the panel is machine-wide, so
behavior is unchanged and the daemon no longer logs
`Server plugin API v3 is deprecated`. Not taken: `backend.forScope({ kind:
"machine" })` in the browser entry, which would drop the host's workspace-scope
resolution for every request. That is a behavior change with its own tests, not
part of migrating off the deprecated contract; it is the next step if requests
must survive a workspace disappearing.

## Result

- `package.json`: `pi-web.dev-plugin` keyword, dev dependency `^1.202610.6`, build
  now clears `dist` and copies `src/browser/skills-panel.css` into `dist/browser`.
- `README.md` (Requirements): browser and server API v5, floor 1.202610.5
  (first release with both v5 entries and the `stylesheets` field), tested
  1.202610.6.
- `src/browser/index.ts`: `apiVersion: 5`, `stylesheets: [{ id: "panel", url }]`
  next to the module URL; `renderSkillsStyles` and its inline `<style>` removed.
- `src/browser/styles.ts` (564 lines) replaced by `src/browser/skills-panel.css`.
- `src/server.ts`: `apiVersion: 5`, peer request typed with
  `ServerPluginPeerRequestContextV5`; nothing else in the handlers changed.
- `test/server.test.ts`: v5 activation context and machine scope, activation
  helper casts to the published v5 types.
- `test/plugin.test.ts`, `test/panel-status.test.ts`: v5 activation contexts, plus
  a test that the stylesheet contribution resolves to a scoped CSS file beside
  the module.
- `e2e/skills-panel.e2e.mjs`: asserts the panel's computed `display` is `grid`,
  which only the contributed sheet can produce.

Verified on `@jmfederico/pi-web` 1.202610.6: `npm run typecheck`, `npm run build`,
`npm test` (223 pass), and `npm run test:e2e` against a real isolated instance —
stylesheet served as `text/css` and adopted, and every peer request and channel
(`status`, `list`, `search`, `remove`, `add`, `update`) served by the v5 module
with no deprecation line in the daemon output. The test typing change also
passes against 1.202610.4 and 1.202609.1.
