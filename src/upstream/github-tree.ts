import type { RepoTree, TreeEntry } from "../vendor/skills/blob.ts";
import type { ExecFile } from "./git.ts";

/** Requested GitHub API bound; the host may lower it. */
export const TREE_TIMEOUT_MS = 10_000;

/** The host's injectable fetch, narrowed to what a tree read needs. */
export type FetchLike = typeof fetch;

export type TreeRequest = {
  /** `owner/repo` from the lock entry, pinned to github.com. */
  readonly ownerRepo: string;
  readonly ref?: string | undefined;
  readonly fetch: FetchLike;
  readonly exec: ExecFile;
  readonly getToken: () => string | null;
  readonly signal: AbortSignal;
};

/**
 * Read the recursive git tree for one repository and ref through the GitHub API.
 * The token resolver is tried first, then `gh api` through the bounded exec
 * adapter; a null answer means the caller must clone and hash the checkout.
 */
export async function fetchGitHubTree(request: TreeRequest): Promise<RepoTree | null> {
  const branches = request.ref === undefined ? ["HEAD", "main", "master"] : [request.ref];
  const token = request.getToken();
  for (const branch of branches) {
    const tree = await fetchTreeWithToken(request, branch, token);
    if (tree !== null) return tree;
    if (request.signal.aborted) return null;
  }
  for (const branch of branches) {
    const tree = await fetchTreeWithGitHubCli(request, branch, token);
    if (tree !== null) return tree;
    if (request.signal.aborted) return null;
  }
  return null;
}

async function fetchTreeWithToken(
  request: TreeRequest,
  branch: string,
  token: string | null,
): Promise<RepoTree | null> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "pi-web-skills",
  };
  if (token !== null) headers["Authorization"] = `Bearer ${token}`;
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(TREE_TIMEOUT_MS)]);
  try {
    const response = await request.fetch(treeUrl(request.ownerRepo, branch), { headers, signal });
    if (!response.ok) return null;
    return parseTree(await response.json(), branch);
  } catch {
    return null;
  }
}

/**
 * `gh api` fallback for a caller whose token is unavailable or rejected. The
 * token, when there is one, travels in the environment; gh otherwise uses the
 * credentials it already stores.
 */
async function fetchTreeWithGitHubCli(
  request: TreeRequest,
  branch: string,
  token: string | null,
): Promise<RepoTree | null> {
  const endpoint = `repos/${request.ownerRepo}/git/trees/${encodeURIComponent(branch)}?recursive=1`;
  try {
    const result = await request.exec({
      file: "gh",
      args: ["api", endpoint, "--method", "GET", "--hostname", "github.com"],
      env: { GH_PROMPT_DISABLED: "1", ...(token === null ? {} : { GH_TOKEN: token }) },
      timeoutMs: TREE_TIMEOUT_MS,
      signal: request.signal,
    });
    if (result.exitCode !== 0) return null;
    return parseTree(JSON.parse(result.stdout), branch);
  } catch {
    return null;
  }
}

function treeUrl(ownerRepo: string, branch: string): string {
  const encodedOwnerRepo = ownerRepo
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `https://api.github.com/repos/${encodedOwnerRepo}/git/trees/${encodeURIComponent(branch)}?recursive=1`;
}

/** Accept only a tree whose entries carry the three fields the hash lookup reads. */
function parseTree(data: unknown, branch: string): RepoTree | null {
  if (!isRecord(data) || typeof data["sha"] !== "string") return null;
  const entries = data["tree"];
  if (!Array.isArray(entries)) return null;
  const tree: TreeEntry[] = [];
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const { path, type, sha } = entry;
    if (typeof path !== "string" || (type !== "blob" && type !== "tree") || typeof sha !== "string") {
      continue;
    }
    tree.push({ path, type, sha });
  }
  return { sha: data["sha"], branch, tree };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
