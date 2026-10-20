# 08: Search skills.sh

**What to build:** A search box queries skills.sh and shows name, source, and install count. Choosing a result starts the Add flow with that source and preselects the matching skill. Search itself never writes.

**Blocked by:** 05 (Add — install and write lock entries).

**Status:** resolved

**Pointers:** `.scratch/skills-panel/spec.md` sections *Search*, *Peer contract*; `docs/upstream-parity.md` operation mapping; upstream `src/find.ts` (`searchSkillsAPI` response shape).

- [x] `search` request validates `{ query }`, calls `GET https://skills.sh/api/search?q=<query>&limit=20` with the base URL overridable for tests, and applies the request abort signal plus an 8 s timeout.
- [x] Response validation accepts only rows with string `id`, `name`, `source` and numeric `installs`; every string is sanitised; malformed rows are dropped; results sort by installs descending.
- [x] Non-2xx → `search-unavailable`; malformed JSON → `search-invalid-response`; abort → cancellation, not an error banner.
- [x] The panel has a search input, empty/loading/error states, result rows with name/source/install count, and an Add action that prefills the source and preselects the matching skill after resolution.
- [x] Search never writes to the managed directory or lockfile.
- [x] Tests cover a valid response, non-2xx, malformed JSON, abort, sanitisation, install-count sort order, and query encoding, all against a local fake fetch/server; no test reaches the network.
- [x] `npm run build`, `npm run typecheck`, and `npm test` pass.

## Result

**Commits:** `11771da` (feat: search skills.sh and start Add from a result), plus the commit recording this result.

**Files**

- `src/operations/search.ts` — `searchSkills` calls `GET <base>/api/search?q=<query>&limit=20` through an injected `fetch`, with the base URL and timeout overridable. It applies `AbortSignal.any([request signal, AbortSignal.timeout(8000)])`, returns `cancelled` when the request signal aborts, `search-unavailable` for a non-2xx, timeout, or transport failure, and `search-invalid-response` when `json()` rejects or `skills` is not an array. Each row keeps only a string `id`, `name`, `source` and a finite numeric `installs`; strings are sanitised with the vendored `sanitizeMetadata` and capped (id 120, name 80, source 200), and the sorted rows are capped at 20. `readSearchQuery` validates `{ query: string }` (trimmed, non-empty, at most 200 chars).
- `src/operations/errors.ts` — adds `search-unavailable`, `search-invalid-response`, and `cancelled`.
- `src/server.ts` — the `search` branch in the peer router, `SearchPayload` in the response union, and an injectable `PeerDependencies` carrying `fetch` and `searchBaseUrl`; production defaults to a thin adapter over the global `fetch`. No other change.
- `src/browser/search-panel.ts` — the keyword form, idle/loading/ready/empty/error states, result rows with name, source, and install count, and a per-row Add action. A malformed or rejected response is an alert; `cancelled` is a status line, not an alert. A request sequence number discards stale responses.
- `src/browser/add-handoff.ts` — one shared handoff box per activation: `{ source, skillName }`.
- `src/browser/add-panel.ts` — the Add panel takes the handoff box, prefills the source, starts the resolve, and on `candidates-end` selects the candidate whose name, sanitised name, or sanitised folder name matches; no match leaves every candidate unselected. A pending handoff waits while a resolve or install is busy so it never cancels running work.
- `src/browser/index.ts` — one handoff box shared by the Add and Search panels; the Search section renders between Add and the skill list.
- `test/search.test.ts` — valid response with install sort, trimmed and encoded query plus base URL, escape/newline sanitisation and string caps, malformed rows dropped and 20-row cap, malformed JSON shapes, non-2xx, aborted request before and during the fetch, timeout hint, malformed inputs rejected before any fetch, and an end-to-end request against a temporary HOME that creates no managed directory.
- `test/panel-search.test.ts` — idle/empty/loading/ready states, error banner for a failure, no banner for a cancellation, invalid response, Add handoff prefills the source and preselects the matching skill (install frame carries only that skill), no-match shows every candidate unselected with Install disabled, and a handoff waiting through a busy resolve.
- No test reaches the network: every request uses an injected fake fetch, and this branch does not touch `test/server.test.ts`.

**Commands**

- `npm run build` — pass.
- `npm run typecheck` — pass.
- `npm test` — pass: 160 tests, 0 failures.

**Notes**

- "Search never writes" holds by construction: the operation has no filesystem access and receives no paths; the end-to-end test checks the temporary HOME gains no `.agents` directory.
- Abort is represented as the stable `cancelled` code at the peer seam, so the panel can distinguish it from a failure; the browser also treats an `AbortError` rejection as a cancellation.
- The Add handoff relies on the render cycle: Search sets the pending handoff and requests a render; the Add panel consumes it on its next render. No new peer operation or channel frame is involved.
- The query is trimmed at the request boundary, so the operation seam always receives a clean, non-empty keyword.
