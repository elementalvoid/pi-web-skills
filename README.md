# pi-web-skills

A PI WEB panel for managing the agent skills that Pi loads from `~/.agents/skills`.

**Status:** design scaffold. The plugin is not implemented yet.

## V1 scope

- **Global only.** One managed directory (`~/.agents/skills`) and one lockfile (`~/.agents/.skill-lock.json`).
- **Upstream behavior, not a new model.** Add, list, update, and remove follow skills.sh semantics. No pinning, candidate scanning, drift detection, sidecars, or extra lock fields.
- **Pi-only.** Installs target the shared universal directory and never another agent's directory. Other universal agents that read the same directory will see the skills.
- **Read-only for unmanaged skills.** Directories without a lock entry are shown but cannot be updated or removed.
- **Broken means remove.** A lock entry with no directory is cleaned up by removing the stale entry; there is no global restore.

Non-goals for v1: project installs, `skills-lock.json`, archives/direct URLs, local directory sources, adoption of unmanaged skills, collision warnings across scopes, and session reload automation.

## Decisions

- [ADR 0001: Global installs only](docs/adr/0001-global-only-v1.md)
- [ADR 0002: Upstream parity through a thin reimplementation](docs/adr/0002-upstream-parity-thin-reimplementation.md)
- [ADR 0003: "Pi-only" means the universal directory](docs/adr/0003-pi-only-uses-the-universal-directory.md)
- [ADR 0004: Update follows upstream](docs/adr/0004-upstream-update-semantics.md)
- [Vocabulary](GLOSSARY.md)
- [Verified upstream behavior and vendoring plan](docs/upstream-parity.md)

## How it runs

A PI WEB plugin package with:

- a **server entry** in the session daemon, which owns filesystem and git work and exposes peer requests;
- a **browser entry** contributing a machine-scoped workspace panel.

The panel is hosted inside a workspace, but the skills it manages are machine-wide. The UI says so.

Install and update through **Settings → Pi packages**. A server-module change requires a session-daemon restart. Skill changes require `/reload` in each idle session; the panel only reminds the user.

## Development

```sh
npm install
npm run build
npm run typecheck
```

Upstream source is pinned as a vendored subset; see [docs/upstream-parity.md](docs/upstream-parity.md). `skills@1.7.4` is a dev dependency used only for parity fixtures.
