# Local development and testing

PI WEB loads local packages directly. No npm publish and no PI WEB rebuild is required.

## Load from disk

### Local plugin directory (fastest loop)

Documented under **Plugins → Local development**:

```sh
mkdir -p /data/pi-web/plugins
ln -s /data/home/projects/pi-web-skills /data/pi-web/plugins/pi-web-skills
```

- `PI_WEB_DATA_DIR` defaults to `~/.pi-web`; in the TrueNAS image it is `/data/pi-web`.
- The symlink name must match `^[a-z][a-z0-9.-]*$`. `pi-web-skills` qualifies.
- The package must contain built JavaScript: `npm install && npm run build`.
- Both the web/API process and the session daemon discover plugins from `$PI_WEB_DATA_DIR/plugins`.
- No **Settings → Pi packages** entry and no Pi settings change. Local plugins are enabled by default; `plugins.<id>.enabled` in PI WEB config can disable one.

### Pi package from a local path (production-like)

```sh
pi install /data/home/projects/pi-web-skills
```

or enter the same path under **Settings → Pi packages**.

- Pi records the resolved absolute path in its settings; it does not copy the package.
- Pi does not install dependencies for local packages. Run `npm install` in the package.
- Built JavaScript is required.
- PI WEB discovers the package's `piWeb.plugins` entries like any installed Pi package.

## What reloads what

| Change | Action |
| --- | --- |
| Browser bundle / panel | Rebuild, reload the page |
| Server module (`dist/server.js`) | Rebuild, restart the session daemon, reload the page |
| `package.json` `piWeb` metadata | Restart the session daemon, reload the page |
| Plugin enable/disable/settings | Server-backed: restart session daemon. Browser-only: reload page |
| Installed skills | `/reload` in each idle Pi session |

There is no file watcher. A page reload re-fetches browser assets (the revision is a SHA-256 of the package contents), but the daemon imports server modules once per start. `/reload` and a web/API restart do not load new server plugin code.

## Test instance

Run a second instance with distinct state; never reuse the hosting instance's data directory, socket, or port.

```sh
export HOME=/tmp/pi-web-skills-home
export PI_CODING_AGENT_DIR=/tmp/pi-web-skills-agent
export PI_WEB_DATA_DIR=/tmp/pi-web-skills-data
export PI_WEB_SESSIOND_SOCKET=/tmp/pi-web-skills-data/sessiond.sock
export PI_WEB_PORT=8515   # a free port; never reuse the hosting instance's port

mkdir -p "$PI_WEB_DATA_DIR/plugins" "$HOME"
ln -s /data/home/projects/pi-web-skills "$PI_WEB_DATA_DIR/plugins/pi-web-skills"

pi-web-sessiond &
pi-web-server &
# Open http://127.0.0.1:8515 and add a throwaway project/workspace.
```

- `HOME` isolates the plugin's `~/.agents/skills` and the global lock.
- `PI_CODING_AGENT_DIR` isolates Pi auth, models, sessions, and packages.
- The panel is workspace-hosted, so the test instance needs at least one project and workspace.
- Restart only the test instance's session daemon when server code changes.
- Never point `PI_WEB_DATA_DIR`, the socket, or the port at the hosting instance.
- `npm run build` after starting the daemon leaves it on the old package revision; restart the
  test daemon so the server revision and the browser bundle revision agree. A mismatched revision
  withholds the browser entry.

### Playwright smoke test

```sh
PLAYWRIGHT_BROWSERS_PATH=/data/home/.cache/ms-playwright npm run test:e2e
```

- The command builds the package, starts its own isolated instance (temporary `HOME`,
  `PI_CODING_AGENT_DIR`, `PI_WEB_DATA_DIR`, socket, and a free port), and removes every child
  process, temporary directory, and plugin symlink on success and failure.
- It seeds a throwaway git workspace and a local `file://` git source, then exercises the
  machine-wide notice and paths, managed/unmanaged/broken/invalid rows, Add with an overwrite
  confirmation, the dismissible `/reload` reminder, Remove, broken-entry cleanup, and Update's
  confirmation and cancel. Search is not exercised because it needs skills.sh on the network.
- The test makes no network calls outside `127.0.0.1` and the local git fixtures. It never
  touches `/data/pi-web`, the hosting daemon, or the hosting port.
- Playwright is pinned to `1.63.0`, which expects Chromium revision `1243` in the image cache.
  If your cache has a different revision, install the matching browser with
  `npx playwright install chromium` and use the Playwright version that reports it.
- Chromium's system libraries must be present once per image:
  `PLAYWRIGHT_BROWSERS_PATH=/data/home/.cache/ms-playwright npx playwright install-deps chromium`.
  Do not run the browser test as part of `npm test`.

### Manual UI checklist

Use an isolated instance, not the hosting one.

- [ ] Open a workspace and the **Skills** tab. The panel says it manages the whole machine, not
  the workspace, and shows the resolved managed directory and lockfile paths.
- [ ] If the directories are absent, the status says `missing`; after a successful Add it says
  `exists` without a page reload.
- [ ] Seed one managed, one unmanaged, one invalid-frontmatter, and one broken entry. The list
  groups them as Managed, Unmanaged, and Broken; the invalid row is marked, not hidden.
- [ ] Unmanaged rows have no Remove action and say the lockfile does not track them.
- [ ] Add from a local `file://` git fixture. Resolve lists every skill; selecting one, several,
  or all changes the Install count. Selecting a skill that already exists shows the overwrite
  confirmation and writes nothing before **Overwrite and install**.
- [ ] Cancel while Add is resolving or installing. The operation stops, temporary clones are
  removed, and the panel says the operation stopped or was cancelled.
- [ ] After a successful Add, the new row appears without a page reload, and a dismissible
  `/reload` reminder is shown. Dismiss removes it.
- [ ] **Update all** shows the confirmation that a remote change can overwrite a local edit.
  **Cancel** returns to the idle state without opening a channel. A confirmed Update reports
  updated, unchanged, skipped, deleted-upstream, and failed entries separately.
- [ ] Remove asks first, then deletes the directory and lock entry and reminds you to `/reload`.
  Removing a broken entry deletes only its stale lock entry and shows no `/reload` reminder.
- [ ] `/reload` expectation: the panel does not reload sessions. Run `/reload` in each idle Pi
  session; a new session sees installed skills without one.
- [ ] Daemon-restart expectation: a browser-only change needs a page reload. A change to
  `dist/server.js` or `package.json` metadata needs a restart of the isolated session daemon,
  then a page reload. Restarting the hosting daemon is not part of this checklist.

## Restarting the hosting session daemon

There is no in-process reload. The daemon handles `SIGTERM`, but server plugins are imported once per daemon start; `/reload` and a web/API restart do not load new server plugin code. `pi-web restart` is not usable in this image: it manages systemd/launchd user services and reports "not installed".

From the TrueNAS host:

```sh
docker ps --format '{{.ID}}\t{{.Names}}\t{{.Command}}' | grep pi-web-sessiond
docker restart <sessiond-container>
```

This interrupts every active session and terminal, including the agent run that requested the restart. The web container stays up; reload the page after the daemon returns. The compose service uses `restart: unless-stopped`, so the container returns after a process exit as well.

Killing the daemon from inside the container also restarts it via that policy, but it ends the current run immediately and its output is lost. Prefer the host command.

### From inside the container (ends the current turn)

Find the daemon and confirm which state it owns:

```sh
ps -eo pid,ppid,args | grep '[p]i-web-sessiond'
tr '\0' '\n' < /proc/<pid>/environ | grep -E '^PI_WEB_(DATA_DIR|SESSIOND_SOCKET)='
```

The production daemon owns `/data/pi-web`. Then:

```sh
kill -TERM <pid>   # graceful: sessiond flushes state, tini forwards and exits
kill -KILL <pid>   # forced; only if TERM does not exit within a few seconds
```

The shell that runs the command is a child of sessiond, so it dies with it: the command does not return, and the current turn's output is lost. Tini exits when its child exits, and `restart: unless-stopped` starts the container again.

Do not use `kill -KILL 1`. PID 1 in a container receives only signals it handles, and tini does not handle `SIGKILL`. Kill the sessiond child (PID 7 today); tini exits when that child exits. From the host, `docker kill -s KILL <sessiond-container>` is the forced equivalent.

### Before using it on the hosting daemon

1. Prove the plugin change on an isolated test daemon: kill it, restart it, and confirm the new plugin revision loads. A test daemon started from a shell is not managed by Docker, so this proves the signal path and reload, not the container restart policy.
2. On the host, confirm `docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' <sessiond-container>` returns `unless-stopped`.
3. Keep a host shell available as a fallback: `docker start <sessiond-container>`, or the TrueNAS app Start action.
4. Accept that every active session and terminal ends, including the run that issued the kill.

To schedule a restart after this run has finished, run this on the host (systemd):

```sh
systemd-run --on-active=60 --unit=pi-web-sessiond-restart docker restart <sessiond-container>
```

For plugin iteration, do not restart the hosting daemon at all. Use the isolated test instance above and restart only that daemon.

## Unit tests first

Most behavior is filesystem and git work. Test the operation layer directly with a temporary `HOME` and local git repositories; no PI WEB instance is needed. Reserve end-to-end tests for panel and peer wiring.

## Gotchas

- PI WEB does not compile TypeScript for local plugins. Build first.
- Local Pi packages do not get their dependencies installed.
- The browser artifact scanner hashes the entire package root except `.git` and `node_modules`, with limits of 4096 entries and 16 MiB. Keep large fixtures out of the package root; otherwise discovery fails.
- `browserRoot`, `module`, and `serverModule` must resolve inside the package root. A symlink that escapes it is rejected.
- A paired browser entry is withheld while the running server revision differs. Restart the daemon after server changes.
- Both processes must see the same local plugin path. In the TrueNAS compose both services mount `/data`, so this holds for `/data/...` paths.
