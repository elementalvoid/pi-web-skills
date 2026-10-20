# Update follows upstream, without a pin model

**Amended by [ADR 0005](0005-read-only-update-check.md):** the panel adds a separate read-only Check for updates preflight. Update all itself remains non-dry-run as described here.

The lock records the source ref used at install. Update re-fetches that ref, compares the remote folder hash with the lock, and rewrites only changed installs. We expose that behavior and nothing more: no semver candidate scanning, no pin/unpin model, no local-drift detection, and no reinstall from the lock. Entries upstream cannot check are shown with the upstream skip reason. A broken entry is cleaned up with Remove, not repaired. The UI asks for confirmation before Update because a remote change can overwrite local edits.

## Consequences

- `Update` is not a dry run. In 1.7.4, `skills check` dispatches to the same update path, so there is no read-only check to expose.
- Version stability comes from choosing a tag or commit in the source ref, not from plugin metadata.
- When upstream changes update behavior, this plugin follows it rather than diverging.
