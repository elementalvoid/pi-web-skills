# Local development and testing

PI WEB loads local packages directly. No npm publish and no PI WEB rebuild is
required.

## Load from disk

### Local plugin directory (fastest loop)

From the package checkout:

```sh
PLUGIN_DIR="${PI_WEB_DATA_DIR:-$HOME/.pi-web}/plugins"
mkdir -p "$PLUGIN_DIR"
ln -s "$PWD" "$PLUGIN_DIR/pi-web-skills"
```

- `PI_WEB_DATA_DIR` defaults to `~/.pi-web`.
- The symlink name must match `^[a-z][a-z0-9.-]*$`. `pi-web-skills` qualifies.
- The package must contain built JavaScript: `npm install && npm run build`.
- Both the web/API process and the session daemon discover plugins from
  `$PI_WEB_DATA_DIR/plugins`.
- No **Settings → Pi packages** entry and no Pi settings change. Local plugins
  are enabled by default; `plugins.<id>.enabled` in PI WEB config can disable one.

### Pi package from a local path (production-like)

```sh
pi install "$PWD"
```

or enter the absolute path under **Settings → Pi packages**.

- Pi records the resolved absolute path in its settings; it does not copy the
  package.
- Pi does not install dependencies for local packages. Run `npm install` in the
  package.
- Built JavaScript is required.
- PI WEB discovers the package's `piWeb.plugins` entries like any installed Pi
  package.

## What reloads what

| Change | Action |
| --- | --- |
| Browser bundle / panel | Rebuild, reload the page |
| Server module (`dist/server.js`) | Rebuild, restart the session daemon, reload the page |
| `package.json` `piWeb` metadata | Restart the session daemon, reload the page |
| Plugin enable/disable/settings | Server-backed: restart session daemon. Browser-only: reload page |
| Installed skills | `/reload` in each idle Pi session |

There is no file watcher. A page reload re-fetches browser assets (the revision is
a SHA-256 of the package contents), but the daemon imports server modules once per
start. `/reload` and a web/API restart do not load new server plugin code.

## Test instance

Run a second instance with distinct state; never reuse the normal instance's data
directory, socket, or port.

```sh
ROOT=$(mktemp -d)
export HOME="$ROOT/home"
export PI_CODING_AGENT_DIR="$ROOT/agent"
export PI_WEB_DATA_DIR="$ROOT/data"
export PI_WEB_SESSIOND_SOCKET="$PI_WEB_DATA_DIR/sessiond.sock"
export PI_WEB_PORT=8515   # a free port; never reuse the normal instance's port

mkdir -p "$PI_WEB_DATA_DIR/plugins" "$HOME" "$PI_CODING_AGENT_DIR"
ln -s "$PWD" "$PI_WEB_DATA_DIR/plugins/pi-web-skills"

pi-web-sessiond &
pi-web-server &
# Open http://127.0.0.1:8515 and add a throwaway project/workspace.
```

- Run this from the package checkout, or replace `$PWD` with the checkout's
  absolute path.
- `HOME` isolates the plugin's `~/.agents/skills` and the global lock.
- `PI_CODING_AGENT_DIR` isolates Pi auth, models, sessions, and packages.
- The panel is workspace-hosted, so the test instance needs at least one project
  and workspace.
- Restart only the test instance's session daemon when server code changes.
- Never point `PI_WEB_DATA_DIR`, the socket, or the port at the normal instance.
- `npm run build` after starting the daemon leaves it on the old package revision;
  restart the test daemon so the server revision and the browser bundle revision
  agree. A mismatched revision withholds the browser entry.

### Playwright smoke test

```sh
npm run test:e2e
```

- The command builds the package, starts its own isolated instance (temporary
  `HOME`, `PI_CODING_AGENT_DIR`, `PI_WEB_DATA_DIR`, socket, and a free port), and
  removes every child process, temporary directory, and plugin symlink on success
  and failure.
- It seeds a throwaway git workspace and a local `file://` git source, then
  exercises the machine-wide notice and paths, managed/unmanaged/broken/invalid
  rows, Add with an overwrite confirmation, the dismissible `/reload` reminder,
  Remove, broken-entry cleanup, and Update's confirmation and cancel. Search is
  not exercised because it needs skills.sh on the network.
- The test makes no network calls outside `127.0.0.1` and the local git fixtures.
  It never touches a running PI WEB instance or its data directory or port.
- Playwright uses its default browser cache (`~/.cache/ms-playwright`) unless
  `PLAYWRIGHT_BROWSERS_PATH` is set. If Chromium is missing, run
  `npx playwright install chromium`; system libraries may need
  `npx playwright install-deps chromium`.
- The dev dependency is pinned to a Playwright version with a matching Chromium
  revision. If your cache has a different revision, install the browser for the
  pinned version or update the dependency deliberately.
- Do not run the browser test as part of `npm test`.

### Manual UI checklist

Use an isolated instance, not your normal PI WEB instance.

- [ ] Open a workspace and the **Skills** tab. The panel says it manages the whole
  machine, not the workspace, and shows the resolved managed directory and
  lockfile paths.
- [ ] If the directories are absent, the status says `missing`; after a successful
  Add it says `exists` without a page reload.
- [ ] Seed one managed, one unmanaged, one invalid-frontmatter, and one broken
  entry. The list groups them as Managed, Unmanaged, and Broken; the invalid row
  is marked, not hidden.
- [ ] Unmanaged rows have no Remove action and say the lockfile does not track
  them.
- [ ] Clicking a skill name, description, or state pill toggles the details, as
  does **Details & actions**.
- [ ] Add from a local `file://` git fixture. Resolve lists every skill; selecting
  one, several, or all changes the Install count. Selecting a skill that already
  exists shows the overwrite confirmation and writes nothing before **Overwrite
  and install**.
- [ ] Cancel while Add is resolving or installing. The operation stops, temporary
  clones are removed, and the panel says the operation stopped or was cancelled.
- [ ] After a successful Add, the new row appears without a page reload, and a
  dismissible `/reload` reminder is shown. Dismiss removes it.
- [ ] **Check for updates** reports available, unchanged, skipped, deleted-upstream,
  and failed entries without changing the managed directory or lockfile, and
  without a `/reload` reminder.
- [ ] **Update all** shows the confirmation that a remote change can overwrite a
  local edit. **Cancel** returns to the idle state without opening a channel. A
  confirmed Update reports updated, unchanged, skipped, deleted-upstream, and
  failed entries separately.
- [ ] Remove asks first, then deletes the directory and lock entry and reminds you
  to `/reload`. Removing a broken entry deletes only its stale lock entry and
  shows no `/reload` reminder.
- [ ] `/reload` expectation: the panel does not reload sessions. Run `/reload` in
  each idle Pi session; a new session sees installed skills without one.
- [ ] Daemon-restart expectation: a browser-only change needs a page reload. A
  change to `dist/server.js` or `package.json` metadata needs a restart of the
  isolated session daemon, then a page reload. Restarting your normal PI WEB
  daemon is not part of this checklist.

## Restarting the session daemon

Server plugin code loads once per daemon start. A browser-only change needs a page
reload; a server-module or `package.json` metadata change needs a daemon restart.
See [Restarting the session daemon](../CONTRIBUTING.md#restarting-the-session-daemon)
for native, container, and in-session options. For iteration, use the isolated
test instance above and restart only that daemon.

## Unit tests first

Most behavior is filesystem and git work. Test the operation layer directly with a
temporary `HOME` and local git repositories; no PI WEB instance is needed. Reserve
end-to-end tests for panel and peer wiring.

## Gotchas

- PI WEB does not compile TypeScript for local plugins. Build first.
- Local Pi packages do not get their dependencies installed.
- The browser artifact scanner hashes the entire package root except `.git` and
  `node_modules`, with limits of 4096 entries and 16 MiB. Keep large fixtures out
  of the package root; otherwise discovery fails.
- `browserRoot`, `module`, and `serverModule` must resolve inside the package root.
  A symlink that escapes it is rejected.
- A paired browser entry is withheld while the running server revision differs.
  Restart the daemon after server changes.
- Both processes must see the same local plugin path. In containers, mount the
  package at the same path in both the web/API and session-daemon containers.
