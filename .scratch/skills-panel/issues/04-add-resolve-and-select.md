# 04: Add — resolve a source and select skills

**What to build:** The first half of Add. A user enters a source, the server resolves it, and the panel lists the discovered skills with descriptions and an "already installed" marker so the user can choose what to install. No copy or lock write happens in this ticket.

**Blocked by:** 02 (Foundation — vendored upstream subset and standard lockfile).

**Status:** ready-for-agent

**Pointers:** `.scratch/skills-panel/spec.md` sections *Peer contract* (`add` channel), *Operation seam*, *Add*; `docs/upstream-parity.md` operation mapping; `src/vendor/skills/source-parser.ts`, `skills.ts`, `local-lock.ts`, `blob.ts`; upstream `src/git.ts` for clone/hash edge cases.

- [ ] An `add` channel accepts `{ source }` and streams candidates in bounded pages (about 25 per frame) ending with `candidates-end`, or a structured `error`, then keeps the temp clone open for a possible install.
- [ ] Accepted: GitHub shorthand, GitHub/GitLab HTTPS URLs (including tree URLs with a subpath), generic git URLs including `file://`, optional `#ref` and `@skill` fragments.
- [ ] Rejected with `unsupported-source`: local paths, well-known URLs, hosted archive/raw-file URLs, malformed input.
- [ ] Clone runs through the host `execFile` adapter with argv only, `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0`, a timeout, and a temp directory under the OS temp root. `ext::` is rejected.
- [ ] Discovery finds every `SKILL.md` in the clone and returns name, description, source path, sanitised folder name, folder hash, and existing target state (`none`, `managed`, `unmanaged`).
- [ ] The channel open and receive handlers return before cloning; resolution work runs on the channel lifetime signal and streams candidates, so the host's 10 s callback bound never cancels it.
- [ ] GitHub/GitLab folder hash is a 40-hex git tree SHA; generic git uses the vendored SHA-256 content hash. The shape is never silently mixed.
- [ ] The panel has a source input, resolve action, candidate list with select-all/select-one, descriptions, existing-target badges, inline errors, and a disabled install action until the user selects something.
- [ ] Cancel closes the channel and removes the clone; a clone/discovery failure also removes it. A test asserts no temp directory remains after success, failure, and cancel.
- [ ] Tests use local git fixture sources for discovery and a fake exec/fetch for GitHub tree hashing; no test reaches the network.
- [ ] `npm run build`, `npm run typecheck`, and `npm test` pass.
