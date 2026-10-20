import { sanitizeMetadata } from "../vendor/skills/sanitize.ts";
import type { JsonValue, Result } from "./errors.ts";
import { operationError } from "./errors.ts";

/** skills.sh base URL; tests override it with a local fake. */
const SEARCH_BASE_URL = "https://skills.sh";

/** Upstream requests 20 rows and the panel shows at most that many. */
const SEARCH_RESULT_LIMIT = 20;

/** Leaves headroom inside the host's ~10 s request bound. */
const SEARCH_TIMEOUT_MS = 8_000;

const QUERY_LIMIT = 200;
const ID_LIMIT = 120;
const NAME_LIMIT = 80;
const SOURCE_LIMIT = 200;

const TIMEOUT_MESSAGE = "The skills.sh search timed out. Retry in a moment.";

/** One row of the skills.sh search response, sanitised and bounded. */
export type SearchResult = {
  readonly id: string;
  readonly name: string;
  readonly source: string;
  readonly installs: number;
};

export type SearchPayload = { readonly results: readonly SearchResult[] };

/** The slice of `fetch` search needs, so a test supplies a local fake. */
export type FetchResponse = {
  readonly status: number;
  json(): Promise<unknown>;
};

export type FetchLike = (
  url: string,
  init: { readonly signal: AbortSignal },
) => Promise<FetchResponse>;

export type SearchContext = {
  readonly signal: AbortSignal;
  readonly fetch: FetchLike;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
};

/** Validate a search request input; null means malformed input. */
export function readSearchQuery(input: JsonValue): string | null {
  if (!isRecord(input) || Object.keys(input).length !== 1) return null;
  const query = input["query"];
  if (typeof query !== "string") return null;
  const trimmed = query.trim();
  if (trimmed === "" || trimmed.length > QUERY_LIMIT) return null;
  return trimmed;
}

/**
 * Query skills.sh. Every string is sanitised, a malformed row is dropped, and
 * the valid rows are capped and sorted by installs. Search never writes.
 */
export async function searchSkills(
  context: SearchContext,
  query: string,
): Promise<Result<SearchPayload>> {
  if (context.signal.aborted) return cancelled();

  const timeout = AbortSignal.timeout(context.timeoutMs ?? SEARCH_TIMEOUT_MS);
  const signal = AbortSignal.any([context.signal, timeout]);
  let response: FetchResponse;
  try {
    response = await context.fetch(searchUrl(context.baseUrl ?? SEARCH_BASE_URL, query), {
      signal,
    });
  } catch {
    if (context.signal.aborted) return cancelled();
    return unavailable(
      timeout.aborted
        ? TIMEOUT_MESSAGE
        : "The skills.sh search failed. Check the connection and retry.",
    );
  }
  if (context.signal.aborted) return cancelled();
  if (response.status < 200 || response.status > 299) {
    return unavailable(`skills.sh answered ${String(response.status)}. Retry in a moment.`);
  }

  let body: unknown;
  try {
    body = await readBody(response, signal);
  } catch {
    if (context.signal.aborted) return cancelled();
    return timeout.aborted ? unavailable(TIMEOUT_MESSAGE) : invalidResponse();
  }
  if (context.signal.aborted) return cancelled();

  const skills = isRecord(body) ? body["skills"] : undefined;
  if (!Array.isArray(skills)) return invalidResponse();

  const results: SearchResult[] = [];
  for (const entry of skills) {
    const result = readResult(entry);
    if (result !== null) results.push(result);
  }
  results.sort((left, right) => right.installs - left.installs);
  return { ok: true, value: { results: results.slice(0, SEARCH_RESULT_LIMIT) } };
}

function readResult(value: unknown): SearchResult | null {
  if (!isRecord(value)) return null;
  const { id, name, source, installs } = value;
  if (typeof id !== "string" || typeof name !== "string" || typeof source !== "string") return null;
  if (typeof installs !== "number" || !Number.isFinite(installs)) return null;
  const result = {
    id: truncate(sanitizeMetadata(id), ID_LIMIT),
    name: truncate(sanitizeMetadata(name), NAME_LIMIT),
    source: truncate(sanitizeMetadata(source), SOURCE_LIMIT),
    installs,
  };
  // An empty field would render a blank row and a handoff with no source.
  if (result.id === "" || result.name === "" || result.source === "") return null;
  return result;
}

function searchUrl(baseUrl: string, query: string): string {
  const params = new URLSearchParams({ q: query, limit: String(SEARCH_RESULT_LIMIT) });
  return `${baseUrl.replace(/\/+$/, "")}/api/search?${params.toString()}`;
}

/** Read the body under the request's signal, so a stalled body also times out. */
function readBody(response: FetchResponse, signal: AbortSignal): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const onAbort = () => {
      reject(new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    response.json().then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : value.slice(0, limit);
}

function cancelled(): Result<SearchPayload> {
  return { ok: false, error: operationError("cancelled", "The search was cancelled.") };
}

function unavailable(message: string): Result<SearchPayload> {
  return { ok: false, error: operationError("search-unavailable", message) };
}

function invalidResponse(): Result<SearchPayload> {
  return {
    ok: false,
    error: operationError("search-invalid-response", "skills.sh returned an unexpected response."),
  };
}

function isRecord(value: unknown): value is { readonly [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
