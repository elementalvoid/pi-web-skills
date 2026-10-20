# 08: Search skills.sh

**What to build:** A search box queries skills.sh and shows name, source, and install count. Choosing a result starts the Add flow with that source and preselects the matching skill. Search itself never writes.

**Blocked by:** 05 (Add — install and write lock entries).

**Status:** ready-for-agent

**Pointers:** `.scratch/skills-panel/spec.md` sections *Search*, *Peer contract*; `docs/upstream-parity.md` operation mapping; upstream `src/find.ts` (`searchSkillsAPI` response shape).

- [ ] `search` request validates `{ query }`, calls `GET https://skills.sh/api/search?q=<query>&limit=20` with the base URL overridable for tests, and applies the request abort signal plus an 8 s timeout.
- [ ] Response validation accepts only rows with string `id`, `name`, `source` and numeric `installs`; every string is sanitised; malformed rows are dropped; results sort by installs descending.
- [ ] Non-2xx → `search-unavailable`; malformed JSON → `search-invalid-response`; abort → cancellation, not an error banner.
- [ ] The panel has a search input, empty/loading/error states, result rows with name/source/install count, and an Add action that prefills the source and preselects the matching skill after resolution.
- [ ] Search never writes to the managed directory or lockfile.
- [ ] Tests cover a valid response, non-2xx, malformed JSON, abort, sanitisation, install-count sort order, and query encoding, all against a local fake fetch/server; no test reaches the network.
- [ ] `npm run build`, `npm run typecheck`, and `npm test` pass.
