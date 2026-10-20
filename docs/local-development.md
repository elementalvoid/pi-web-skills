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
export PI_WEB_PORT=8505

mkdir -p "$PI_WEB_DATA_DIR/plugins" "$HOME"
ln -s /data/home/projects/pi-web-skills "$PI_WEB_DATA_DIR/plugins/pi-web-skills"

pi-web-sessiond &
pi-web-server &
# Open http://127.0.0.1:8505 and add a throwaway project/workspace.
```

- `HOME` isolates the plugin's `~/.agents/skills` and the global lock.
- `PI_CODING_AGENT_DIR` isolates Pi auth, models, sessions, and packages.
- The panel is workspace-hosted, so the test instance needs at least one project and workspace.
- Restart only the test instance's session daemon when server code changes.

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
