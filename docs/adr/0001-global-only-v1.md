# V1 manages global installs only

Pi discovers project skills by walking from a session's working directory to the repository root. In PI WEB, Git workspaces are worktrees in sibling directories, so a project install in one workspace is invisible to the others, and "project" would have to mean workspace, git top-level, or PI WEB project — each with a different blast radius. V1 avoids the ambiguity by managing only machine-wide installs in the shared universal directory, tracked by the global lockfile. Project installs and `skills-lock.json` are out of scope.

## Consequences

- The lockfile is per-machine state, not a committed, shareable artifact.
- Project skills, Pi-package skills, and hand-added directories are invisible to the UI.
- Cross-scope collision warnings are unnecessary.
- Any future project mode must first define its root and its relationship to worktrees.
