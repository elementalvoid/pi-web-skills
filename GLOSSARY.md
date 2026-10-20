# Skills manager

A machine-wide PI WEB panel for adding, listing, updating, and removing the agent skills that Pi loads from the shared universal directory.

## Language

### Objects

**Skill**:
A directory containing a `SKILL.md` file that Pi can load and follow. Its name and description come from frontmatter.
_Avoid_: package, plugin, prompt

**Source**:
A repository or URL that provides one or more skills. A source is not a skill.
_Avoid_: repo (when you mean source), install

**Install**:
One managed copy of one skill in the managed directory. An install is what a lockfile entry records.
_Avoid_: package, entry

**Entry**:
One lockfile record for one install.
_Avoid_: record, row

**Ref**:
The branch, tag, or commit a source was installed from. The lockfile stores it.
_Avoid_: pin, version, channel

### Locations

**Managed directory**:
The single machine-wide directory this tool reads and writes: `~/.agents/skills` on the host.
_Avoid_: global folder, agent dir

**Universal agent**:
An agent that reads the managed directory. Pi is one.
_Avoid_: shared agent

**Pi-native directory**:
`$PI_CODING_AGENT_DIR/skills`; read only by Pi. Not used in v1.
_Avoid_: private directory

**Global**:
The machine-wide scope; the only scope in v1.
_Avoid_: user, system

**Project**:
The repository scope tracked by `skills-lock.json`. Not managed in v1.
_Avoid_: workspace (when you mean project scope)

**Pi-only**:
Writing only the managed directory and never another agent's directory. It does not make installs invisible to other universal agents.
_Avoid_: isolated, exclusive

### State

**Lockfile**:
The machine's `~/.agents/.skill-lock.json`, recording each install's source, ref, path, content hash, and timestamps. Machine state, not committed.
_Avoid_: manifest, state file

**Managed**:
An install with a matching lockfile entry. Only managed installs can be updated or removed.
_Avoid_: tracked, owned

**Present**:
A skill directory in the managed directory, with or without a lockfile entry.
_Avoid_: installed (when you mean present)

**Unmanaged**:
Present without a lockfile entry. Shown read-only; never updated or removed.
_Avoid_: orphan, untracked, adopted

**Broken**:
A lockfile entry whose install directory is missing. The only action is removing the stale entry.
_Avoid_: orphan, missing, corrupt

**Drift**:
A local edit that makes an install differ from what its entry's hash describes. V1 does not detect it; Update may overwrite it when the remote changed.
_Avoid_: dirty, modified

### Operations

**Add**:
The workflow of resolving a source, choosing skills, and creating installs.
_Avoid_: install (as a verb for the whole flow), import

**Update**:
Re-fetching a locked source at its ref and replacing an install when the remote content changed.
_Avoid_: upgrade, sync, refresh, pin, candidate

**Skip reason**:
Why Update cannot check an entry automatically: a local path, a generic git URL, a missing hash, or a missing path.
_Avoid_: error, unsupported

**Remove**:
Deleting an install and its entry; for a broken entry, deleting the entry alone.
_Avoid_: uninstall, delete, repair

**Reload**:
The per-session action that makes Pi see skill changes. Installing does not reload running sessions.
_Avoid_: restart, refresh

**Search**:
Querying skills.sh for skills by keyword. A search result is a source plus a skill identifier, not an install.
_Avoid_: find, browse
