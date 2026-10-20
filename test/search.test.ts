import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { FetchLike, SearchContext } from "../src/operations/search.ts";
import { searchSkills } from "../src/operations/search.ts";
import { handlePeerRequest } from "../src/server.ts";

const signal = new AbortController().signal;

type FakeFetch = {
  readonly fetch: FetchLike;
  readonly calls: string[];
};

/** A fetch that records its URL and answers with one canned response. */
function fetchReturning(
  payload: unknown,
  options: { readonly ok?: boolean; readonly status?: number } = {},
): FakeFetch {
  const calls: string[] = [];
  const fetch: FetchLike = async (url) => {
    calls.push(url);
    return {
      ok: options.ok ?? true,
      status: options.status ?? 200,
      json: async () => payload,
    };
  };
  return { fetch, calls };
}

function context(fetch: FetchLike, overrides: Partial<SearchContext> = {}): SearchContext {
  return { fetch, signal, ...overrides };
}

function row(id: string, name: string, source: string, installs: number): object {
  return { id, name, source, installs };
}

test("a valid response is returned sorted by installs descending", async () => {
  const { fetch, calls } = fetchReturning({
    skills: [
      row("owner/repo/alpha", "alpha", "owner/repo", 12),
      row("owner/repo/beta", "beta", "owner/repo", 300),
      row("other/repo/gamma", "gamma", "other/repo", 42),
    ],
  });

  const result = await searchSkills(context(fetch, { baseUrl: "https://search.test" }), "git");

  assert.deepEqual(result, {
    ok: true,
    value: {
      results: [
        { id: "owner/repo/beta", name: "beta", source: "owner/repo", installs: 300 },
        { id: "other/repo/gamma", name: "gamma", source: "other/repo", installs: 42 },
        { id: "owner/repo/alpha", name: "alpha", source: "owner/repo", installs: 12 },
      ],
    },
  });
  assert.equal(calls.length, 1);
  const url = new URL(calls[0] ?? "");
  assert.equal(`${url.origin}${url.pathname}`, "https://search.test/api/search");
  assert.equal(url.searchParams.get("q"), "git");
  assert.equal(url.searchParams.get("limit"), "20");
});

test("the query is trimmed and URL-encoded, and the base URL is honoured", async () => {
  const { fetch, calls } = fetchReturning({ skills: [] });

  const response = await handlePeerRequest(
    { operation: "search", input: { query: "  react hooks & more  " }, signal },
    { home: "/tmp/pi-web-skills-home" },
    { fetch, searchBaseUrl: "http://127.0.0.1:8080/" },
  );

  assert.deepEqual(response, { ok: true, value: { results: [] } });
  assert.deepEqual(calls, [
    "http://127.0.0.1:8080/api/search?q=react+hooks+%26+more&limit=20",
  ]);
});

test("every string is sanitised and long strings are capped", async () => {
  const { fetch } = fetchReturning({
    skills: [
      {
        id: "\u001b]0;title\u0007owner/repo/alpha",
        name: "\u001b[31mred\u001b[0m\nnext  ",
        source: "\u001b[2Jowner/repo",
        installs: 1,
      },
      {
        id: `owner/repo/${"i".repeat(300)}`,
        name: "n".repeat(300),
        source: "s".repeat(300),
        installs: 2,
      },
    ],
  });

  const result = await searchSkills(context(fetch), "git");

  assert.equal(result.ok, true);
  if (!result.ok) return;
  const sanitised = result.value.results.find((entry) => entry.installs === 1);
  assert.deepEqual(sanitised, {
    id: "owner/repo/alpha",
    name: "red next",
    source: "owner/repo",
    installs: 1,
  });
  const capped = result.value.results.find((entry) => entry.installs === 2);
  assert.ok(capped !== undefined);
  assert.ok(capped.name.length <= 80, `name capped, got ${String(capped.name.length)}`);
  assert.ok(capped.id.length <= 120, `id capped, got ${String(capped.id.length)}`);
  assert.ok(capped.source.length <= 200, `source capped, got ${String(capped.source.length)}`);
});

test("malformed rows are dropped and the result count is capped", async () => {
  const malformed: unknown[] = [
    "nope",
    null,
    { id: 1, name: "a", source: "s", installs: 1 },
    { id: "a", name: 2, source: "s", installs: 1 },
    { id: "a", name: "b", source: null, installs: 1 },
    { id: "a", name: "b", source: "s" },
    { id: "a", name: "b", source: "s", installs: "12" },
    { id: "a", name: "b", source: "s", installs: Number.NaN },
  ];
  const { fetch } = fetchReturning({
    skills: [...malformed, row("good/repo/valid", "valid", "good/repo", 7)],
  });

  const result = await searchSkills(context(fetch), "git");

  assert.deepEqual(result, {
    ok: true,
    value: { results: [{ id: "good/repo/valid", name: "valid", source: "good/repo", installs: 7 }] },
  });

  const many = Array.from({ length: 25 }, (_value, index) =>
    row(`owner/repo/skill-${String(index)}`, `skill-${String(index)}`, "owner/repo", index),
  );
  const cappedFetch = fetchReturning({ skills: many });
  const capped = await searchSkills(context(cappedFetch.fetch), "git");
  assert.equal(capped.ok, true);
  if (capped.ok) {
    assert.equal(capped.value.results.length, 20);
    assert.equal(capped.value.results[0]?.installs, 24, "the cap keeps the most-installed rows");
  }
});

test("a malformed response is search-invalid-response", async () => {
  const rejects: FetchLike = async () => ({
    ok: true,
    status: 200,
    json: () => Promise.reject(new SyntaxError("Unexpected token <")),
  });
  const missingSkills = fetchReturning({ results: [] });
  const wrongSkills = fetchReturning({ skills: "nope" });
  const notAnObject = fetchReturning(["skills"]);

  for (const fetch of [rejects, missingSkills.fetch, wrongSkills.fetch, notAnObject.fetch]) {
    const result = await searchSkills(context(fetch), "git");
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "search-invalid-response");
  }
});

test("a non-2xx response is search-unavailable", async () => {
  const { fetch } = fetchReturning({ skills: [] }, { ok: false, status: 503 });

  const result = await searchSkills(context(fetch), "git");

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "search-unavailable");
    assert.match(result.error.message, /503/);
  }
});

test("an aborted request is a cancellation, not a failure", async () => {
  const controller = new AbortController();
  controller.abort();
  const { fetch, calls } = fetchReturning({ skills: [] });

  const aborted = await searchSkills(context(fetch, { signal: controller.signal }), "git");
  assert.equal(aborted.ok, false);
  if (!aborted.ok) assert.equal(aborted.error.code, "cancelled");
  assert.deepEqual(calls, [], "no request is sent for an already-aborted signal");

  const during = new AbortController();
  const hangUntilAbort: FetchLike = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener(
        "abort",
        () => reject(new DOMException("Aborted", "AbortError")),
        { once: true },
      );
    });
  const pending = searchSkills(context(hangUntilAbort, { signal: during.signal }), "git");
  during.abort();
  const cancelled = await pending;
  assert.equal(cancelled.ok, false);
  if (!cancelled.ok) assert.equal(cancelled.error.code, "cancelled");
});

test("a request that outlives the timeout is search-unavailable with a retry hint", async () => {
  const hangUntilAbort: FetchLike = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener(
        "abort",
        () => reject(new DOMException("Timed out", "TimeoutError")),
        { once: true },
      );
    });

  const result = await searchSkills(context(hangUntilAbort, { timeoutMs: 5 }), "git");

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "search-unavailable");
    assert.match(result.error.message, /timed out/i);
    assert.match(result.error.message, /retry/i);
  }
});

test("a search request rejects malformed input before any fetch", async () => {
  const malformed = [null, {}, { query: "" }, { query: "   " }, { query: 3 }, { query: "x", extra: 1 }];
  for (const input of malformed) {
    const { fetch, calls } = fetchReturning({ skills: [] });
    const response = await handlePeerRequest(
      { operation: "search", input: input as never, signal },
      { home: "/tmp/pi-web-skills-home" },
      { fetch },
    );
    assert.deepEqual(response, {
      ok: false,
      error: { code: "invalid-input", message: "search takes { query: string }" },
    });
    assert.deepEqual(calls, [], "malformed input never reaches skills.sh");
  }
});

test("a search request returns results and writes nothing", async () => {
  const home = await mkdtemp(join(tmpdir(), "pi-web-skills-search-"));
  try {
    const { fetch, calls } = fetchReturning({
      skills: [row("owner/repo/alpha", "alpha", "owner/repo", 12)],
    });

    const response = await handlePeerRequest(
      { operation: "search", input: { query: "react" }, signal },
      { home },
      { fetch, searchBaseUrl: "https://search.test" },
    );

    assert.deepEqual(response, {
      ok: true,
      value: { results: [{ id: "owner/repo/alpha", name: "alpha", source: "owner/repo", installs: 12 }] },
    });
    assert.equal(new URL(calls[0] ?? "").origin, "https://search.test");
    await assert.rejects(stat(join(home, ".agents")), /ENOENT/, "no managed directory is created");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
