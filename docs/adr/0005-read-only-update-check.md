# Check for updates is a read-only preflight

Upstream's `skills check` is not read-only: in 1.7.4 it dispatches to the same update path. ADR 0004 therefore says Update has no dry run. That is still true of **Update all**, but the panel now also exposes **Check for updates**, a separate read-only mode of the update session.

Check fetches each managed entry's locked ref, compares the same folder hashes as Update, and reports `available`, `unchanged`, `skipped`, `deleted`, and `failed` entries. It never copies a skill, swaps a directory, or writes the lockfile. It can clone a source when the tree API is unavailable, but only to compute hashes; the clone is removed without being installed.

## Consequences

- Check and Update share the same decision code, so the check report matches what Update all would replace.
- Check needs no confirmation because it changes nothing; Update all still confirms that a remote change can overwrite a local edit.
- The upstream CLI still offers no read-only check. This is a panel-only extension, and the operation layer remains the place where upstream API changes land.
- A check can be slower than an update that finds everything unchanged, because it may fetch trees for several sources. It is still bounded by the update channel's lifetime and cancellation.
