# Upstream parity

Verified against `vercel-labs/skills` v1.7.4, commit `a80e4c9d12d607631249d4d7d059f835d4b2f13a`.

## Why there is no library import

- The published `skills` package has no `main`, `module`, `exports`, or `types`; `files` is only `dist`, `bin`, `docs`.
- `dist/cli.mjs` is a single rolldown bundle with `export {}`. Importing it runs the CLI.
- Upstream status:
  - #2401 merged: extracted non-interactive primitives; `installFromSource` is exported from `add.ts` (project scope, still uses `@clack/prompts`).
  - #1430 open: adds `src/index.ts` with 71 exports and package `exports`/`types`.
  - #2455 open: requests `resolveSkills`/`installFromSource` with typed errors instead of `process.exit`.

The vendored subset is a backport, not a fork. When an exported API lands, the operation layer can be replaced without UI changes.

## Global lock

Path: `~/.agents/.skill-lock.json`, or `$XDG_STATE_HOME/skills/.skill-lock.json` when `XDG_STATE_HOME` is set.

```json
{
  "version": 3,
  "skills": {
    "<name>": {
      "source": "owner/repo",
      "sourceType": "github",
      "sourceUrl": "https://github.com/owner/repo.git",
      "ref": "optional branch, tag, or commit",
      "skillPath": "skills/foo/SKILL.md",
      "skillFolderHash": "<git tree SHA, or content hash for non-GitHub>",
      "installedAt": "ISO timestamp",
      "updatedAt": "ISO timestamp",
      "pluginName": "optional group"
    }
  },
  "dismissed": {},
  "lastSelectedAgents": []
}
```

- `skillFolderHash` for GitHub is the git tree object SHA of the skill folder. For generic git it is upstream's SHA-256 content hash.
- There is no project lock here. `skills-lock.json` is a separate, project-scoped file and is out of scope.
- Preserve `dismissed` and `lastSelectedAgents` when rewriting.

## Operation mapping

| UI action | Upstream behavior we reproduce |
| --- | --- |
| Add | `add <source> -g -a pi -y [--skill <name>...]` |
| List | `ls -g --json`, plus direct lock reads for `ref`, hash, and timestamps |
| Update | `update -g -y [<name>...]` |
| Remove | `remove -g -a pi -y <name>` |
| Search | `GET https://skills.sh/api/search?q=<query>&limit=20` |

### Add

- Resolve the source (GitHub shorthand/URL, generic git URL, or local path).
- Discover skills, select names, and copy each skill directory to `~/.agents/skills/<sanitized-name>`.
- Pi is a universal agent: a global install copies to the canonical directory and creates no symlink.
- Write one lock entry per installed skill with the fields above.
- Preserve the upstream "overwrites" warning: an existing skill directory is replaced, not merged.

### Update

- Only entries with `sourceType: "github"`, a `skillPath`, and a non-empty `skillFolderHash` are checked automatically.
- Upstream skips local paths, generic git URLs, well-known sources, entries without a hash, entries without a path, and sources with no version tracking. Show the skip reason.
- Re-fetch the lock's `ref`, compare the remote folder hash, and replace only changed installs.
- Deleted upstream skills are reported, not deleted non-interactively.
- `skills check` is not read-only: in 1.7.4 it dispatches to the same `runUpdate` path. Do not expose a separate Check button.

### Remove

- Remove the canonical directory and the lock entry.
- When the directory is already missing, remove the stale lock entry (`repair = remove`).
- Never touch another agent's directory or copy.

### List

- Present skills are directories containing `SKILL.md` under the managed directory, discovered recursively.
- Managed = present and has a lock entry. Unmanaged = present without one. Broken = entry without a directory.
- Validate frontmatter for display; a skill Pi will not load is marked, not blocked.

## Vendored subset

Copy from the pinned commit into `src/vendor/skills/`, with upstream `LICENSE` and a `PROVENANCE.md` recording the commit and file list.

- `source-parser.ts`
- `github-host.ts`
- `blob.ts`
- `skills.ts`
- `frontmatter.ts`
- `sanitize.ts`
- `constants.ts`
- `plugin-manifest.ts`
- `skill-lock.ts`
- `local-lock.ts` (for `computeSkillFolderHash` only)
- `update-source.ts`
- `types.ts`

Not vendored:

- `add.ts`, `update.ts`, `remove.ts`, `cli.ts`: prompts, `process.exit`, ANSI output, telemetry.
- `agents.ts`: we hard-code the Pi target and the shared directory.
- `installer.ts`: we write a small safe copier (no symlink escape, no `.git`/`node_modules`).
- `telemetry.ts`: no telemetry.

Process spawning (git clone, `gh api`) goes through the host's bounded `execFile`; no shell.

## Runtime dependencies

- `yaml` (frontmatter parsing in the vendored subset).
- No runtime dependency on `skills`.

`skills@1.7.4` is a dev dependency for parity fixtures only.

## Parity tests

- Install the same source/ref into a temporary `HOME` with the real CLI, then with the plugin, and compare the global lock (excluding timestamps).
- Fixture sources are local git repositories; GitHub tree hashing is covered by a mocked API response.
- Update decisions are tested against lock entries with changed and unchanged folder hashes.
- Removal, broken-entry cleanup, and unmanaged protection are filesystem tests.
