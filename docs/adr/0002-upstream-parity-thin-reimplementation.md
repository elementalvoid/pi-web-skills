# Upstream parity through a thin reimplementation

The published `skills` package has no library entry point; it ships a bundled CLI. Upstream has merged non-interactive primitives (#2401) and has open proposals for an exported API (#1430, #2455), but none are released. Executing the CLI would tie the UI to human-readable output for update and remove; vendoring the CLI's operation modules would mean neutralizing `process.exit`, prompts, and spinners, which is more fragile than owning the small operation surface. We vendor upstream's pure source-resolution, discovery, hashing, and lock modules at v1.7.4 (`a80e4c9d12d607631249d4d7d059f835d4b2f13a`) and implement Add, List, Update, and Remove in a thin layer that writes the standard global lock. There is no custom lock schema, sidecar, or metadata. The CLI is not executed at runtime; `skills` is a dev dependency for parity tests only.

## Considered options

- **Execute the CLI.** Exact behavior, but update and remove expose no structured output, and the runtime depends on an external process.
- **Vendor the operation modules.** No process, but we inherit `process.exit`, `@clack/prompts`, and spinners that must be neutralized or patched.
- **Wait for the upstream API.** Cleanest, but leaves no UI today.
- **Reimplement everything.** Rejected: more drift than vendoring the pure modules.

## Consequences

- Parity is our responsibility, covered by tests that compare our lock output with the CLI's.
- Update inherits upstream's limits: only entries with a folder hash and skill path are checked automatically.
- Process-spawning internals (git, `gh`) go through the host's bounded `execFile`; no shell.
- When upstream exports an API, the thin layer can be replaced without changing the UI.
