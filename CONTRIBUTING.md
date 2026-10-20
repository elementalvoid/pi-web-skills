# Contributing

## Development setup

Requirements: Node.js 22.20 or newer, npm, `git`, and a PI WEB install for the
browser smoke test.

```sh
git clone https://github.com/elementalvoid/pi-web-skills.git
cd pi-web-skills
npm install
npm run build
npm run typecheck
npm test
```

`npm test` is hermetic: temporary HOMEs, local git fixtures, no real
`~/.agents` state, and no network. The real-browser test is separate:

```sh
npm run test:e2e
```

It builds the package, starts an isolated PI WEB instance on a free port with a
temporary `HOME`, `PI_CODING_AGENT_DIR`, and `PI_WEB_DATA_DIR`, then exercises the
panel in Chromium. If Playwright does not have Chromium cached, run
`npx playwright install chromium`; system libraries may need
`npx playwright install-deps chromium`. See
[docs/local-development.md](docs/local-development.md) for the test-instance
recipe and the manual UI checklist.

## Loading a local build

Use either PI WEB route; both require `npm install && npm run build` first because
PI WEB does not compile TypeScript for local packages:

- **Pi package:** add the absolute checkout path under **Settings → Pi packages**,
  or run `pi install "$PWD"`.
- **Local plugin directory:** symlink the checkout into
  `${PI_WEB_DATA_DIR:-$HOME/.pi-web}/plugins`.

The detailed recipe, including how to run a second isolated instance, is in
[docs/local-development.md](docs/local-development.md#load-from-disk).

## Restarting the session daemon

Server plugins are imported once per session-daemon start. `/reload` and a
web/API restart do not load new server plugin code.

- Browser bundle or panel change: rebuild and reload the page.
- Server module (`dist/server.js`) or `package.json` `piWeb` metadata change:
  rebuild if needed, restart the session daemon, then reload the page.
- Installed skills: run `/reload` in each idle Pi session.

For routine plugin iteration, use the isolated test instance in
[docs/local-development.md](docs/local-development.md) and restart only that
daemon. Restarting a daemon interrupts every active session and terminal,
including the agent run that requested the restart.

### Native installs

```sh
systemctl --user restart pi-web-sessiond
```

If your install provides `pi-web restart`, that command may be simpler. It
manages native service definitions; it is not available in every deployment.

### Container installs

Find the session-daemon container and restart it from the host:

```sh
docker ps --format '{{.ID}}\t{{.Names}}\t{{.Command}}' | grep pi-web-sessiond
docker restart <sessiond-container>
```

The web/API process can stay up; reload the page after the daemon returns. If the
container uses `restart: unless-stopped`, a process exit also brings it back, but
an explicit restart is clearer. Replace `docker` with your container runtime's
command if you do not use Docker.

### From inside the container

This ends the current turn because the shell is a child of the session daemon.
Prefer the host command above.

```sh
ps -eo pid,ppid,args | grep '[p]i-web-sessiond'
tr '\0' '\n' < /proc/<pid>/environ | grep -E '^PI_WEB_(DATA_DIR|SESSIOND_SOCKET)='
```

Confirm the daemon owns the data directory and socket you expect before killing
it. Then send `SIGTERM`:

```sh
kill -TERM <pid>
```

The daemon flushes state and exits; the container init and restart policy bring
the container back. Use `kill -KILL <pid>` only if TERM does not exit within a
few seconds. Do not signal PID 1 directly: PID 1 receives only the signals it
handles, so signal the session-daemon child instead.

### Before restarting a shared daemon

1. Prove the change on an isolated test daemon first.
2. Confirm how the daemon will come back, for example
   `docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' <sessiond-container>`.
3. Keep a host shell or container-manager fallback available.
4. Accept that every active session and terminal ends, including the run that
   issued the restart.

To schedule a restart after the current run, use your service manager. On a
systemd host managing Docker, for example:

```sh
systemd-run --on-active=60 --unit=pi-web-sessiond-restart docker restart <sessiond-container>
```

Do not restart a shared hosting daemon for routine browser-only iteration.
