# "Pi-only" means the universal directory

Pi reads both `$PI_CODING_AGENT_DIR/skills` and `~/.agents/skills`. The skills CLI's `-a pi` target is the shared universal directory, which other universal agents also read. The Pi-native directory is truly isolated but lies outside the skills.sh lockfile and is invisible to the CLI. We choose the shared directory because lockfile and CLI parity is the tool's purpose; "Pi-only" means we write no other agent's directory, not that other universal agents cannot read the result.

## Consequences

- Codex, Gemini CLI, Amp, and other universal agents on the machine will see installed skills.
- No Claude/Cursor/OpenCode copies or links are created.
- A future isolated mode would need its own lock and cannot reuse the global skills.sh lockfile.
