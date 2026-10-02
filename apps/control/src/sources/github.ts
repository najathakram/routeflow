/**
 * GitHub source (spec 5.6): a cheap GraphQL list query, a per-PR detail query only for PRs that
 * changed, REST branches with `If-None-Match`, and a back-off on 403/429. `fetch` is injected so no
 * test path touches the network; the token only ever travels in the Authorization header and is
 * never logged or put in an error message.
 */
import { dig, type PRFile } from "../domain/prs";

export interface RepoRef {
  owner: string;
  name: string;
}

export interface GithubQuery {
  query: string;
  variables: Record<string, unknown>;
}

export interface RateLimit {
  remaining: number | null;
  resetAt: string | null;
  cost: number | null;
}

export interface GithubConfig {
  token: string;
  owner: string;
  repo: string;
  fetch?: typeof fetch;
  /** Defaults to https://api.github.com (GraphQL at `/graphql`). */
  apiUrl?: string;
  now?: () => number;
}

/** Raw REST branch item (`{name, commit: {sha}}`); committedDate/ahead come from the git clone. */
export interface RawBranch {
  name: string;
  commit?: { sha?: string };
  [key: string]: unknown;
}

export type RawPR = Record<string, unknown>;

export interface PollResult {
  prs: RawPR[];
  branches: RawBranch[];
  /** Files per PR number (string keys) from the cached detail nodes. */
  files: Record<string, PRFile[]>;
  rateLimited?: boolean;
  warnings?: string[];
}

const RATE = "rateLimit { remaining resetAt cost }";
const PR_SCALARS =
  "number title url isDraft state headRefName headRefOid baseRefName createdAt updatedAt closedAt mergedAt";

/** The cheap query: up to 40 PRs, newest activity first, no `files`. Reads the change-detect fields. */
export function buildListQuery(repo: RepoRef): GithubQuery {
  return {
    query: `query ($owner: String!, $name: String!) {
  ${RATE}
  repository(owner: $owner, name: $name) {
    pullRequests(first: 100, states: [OPEN], orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        ${PR_SCALARS}
        mergeable
        reviewDecision
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      }
    }
  }
}`,
    variables: { owner: repo.owner, name: repo.name },
  };
}

/** The small recent-closed query (every 4th poll): newest 20 CLOSED/MERGED PRs, no `files`. */
export function buildClosedQuery(repo: RepoRef): GithubQuery {
  return {
    query: `query ($owner: String!, $name: String!) {
  ${RATE}
  repository(owner: $owner, name: $name) {
    pullRequests(first: 20, states: [CLOSED, MERGED], orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        ${PR_SCALARS}
        mergeable
        reviewDecision
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      }
    }
  }
}`,
    variables: { owner: repo.owner, name: repo.name },
  };
}

/** One PR with `files(first: 100)` and `statusCheckRollup`. */
export function buildDetailQuery(repo: RepoRef, number: number): GithubQuery {
  return {
    query: `query ($owner: String!, $name: String!, $number: Int!) {
  ${RATE}
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      ${PR_SCALARS}
      mergeCommit { oid }
      mergeable
      reviewDecision
      body
      changedFiles
      labels(first: 20) { nodes { name } }
      files(first: 100) { nodes { path additions deletions } }
      commits(last: 1) { nodes { commit { committedDate message statusCheckRollup { state } } } }
    }
  }
}`,
    variables: { owner: repo.owner, name: repo.name, number },
  };
}

/** One-time ledger backfill page: every state, 100 per page, no `files`. */
export function buildBackfillQuery(repo: RepoRef, after: string | null): GithubQuery {
  return {
    query: `query ($owner: String!, $name: String!, $after: String) {
  ${RATE}
  repository(owner: $owner, name: $name) {
    pullRequests(first: 100, after: $after, states: [MERGED, CLOSED, OPEN], orderBy: {field: CREATED_AT, direction: ASC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        ${PR_SCALARS}
        mergeCommit { oid }
        mergeable
        reviewDecision
        body
        commits(last: 1) { nodes { commit { committedDate message statusCheckRollup { state } } } }
      }
    }
  }
}`,
    variables: { owner: repo.owner, name: repo.name, after },
  };
}

class Limited extends Error {
  constructor() {
    super("github rate limited");
  }
}

/** Detail calls per poll; the rest wait for the next tick (worst case stays inside the budget). */
export const MAX_DETAILS_PER_POLL = 8;
/** The recent-closed query runs on every Nth poll (about 2 min at a 30 s cadence). */
export const CLOSED_EVERY_N_POLLS = 4;
const MAX_BRANCH_PAGES = 10;

const listRollup = (n: RawPR): unknown =>
  dig(n, "commits", "nodes", 0, "commit", "statusCheckRollup", "state");

const arr = (v: unknown): unknown[] => (Array.isArray(v) ? (v as unknown[]) : []);

export function createGithub(cfg: GithubConfig) {
  const doFetch: typeof fetch = cfg.fetch ?? globalThis.fetch;
  const api = (cfg.apiUrl ?? "https://api.github.com").replace(/\/+$/, "");
  const repo: RepoRef = { owner: cfg.owner, name: cfg.repo };
  const nowMs = cfg.now ?? (() => Date.now());
  const restBase = `${api}/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}`;

  const state: { rateLimit: RateLimit; etag: string | null } = {
    rateLimit: { remaining: null, resetAt: null, cost: null },
    etag: null,
  };
  const cache = new Map<number, { sig: string; mergeable: unknown; node: RawPR }>();
  const pageCache = new Map<string, { etag: string; list: RawBranch[]; next: string | null }>();
  let lastOrder: number[] = [];
  let lastListNodes = new Map<number, RawPR>();
  let branches: RawBranch[] = [];
  let pollCount = 0;
  let closedNodes: RawPR[] = [];

  const redact = (m: string): string => (cfg.token ? m.split(cfg.token).join("***") : m);
  const safeMessage = (e: unknown): string =>
    redact(e instanceof Error ? e.message : String(e)).slice(0, 200);

  const baseHeaders = (): Record<string, string> => ({
    authorization: `Bearer ${cfg.token}`,
    accept: "application/vnd.github+json",
    "user-agent": "routeflow-control",
  });

  /** Retry-After first, then x-ratelimit-reset. */
  const markLimited = (res: Response): void => {
    let resetAt = state.rateLimit.resetAt;
    const retry = Number(res.headers.get("retry-after"));
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    if (Number.isFinite(retry) && retry > 0)
      resetAt = new Date(nowMs() + retry * 1000).toISOString();
    else if (Number.isFinite(reset) && reset > 0) resetAt = new Date(reset * 1000).toISOString();
    state.rateLimit = { remaining: 0, resetAt, cost: state.rateLimit.cost };
  };

  /**
   * 429 is always a rate limit. 403 only when it says so (remaining 0, Retry-After, or a
   * "secondary" rate-limit message); any other 403 is a permission problem: a warning, not a back-off.
   */
  const limitedBy = async (res: Response): Promise<boolean> => {
    if (res.status === 429) return true;
    if (res.status !== 403) return false;
    if (res.headers.get("retry-after") !== null) return true;
    if (res.headers.get("x-ratelimit-remaining") === "0") return true;
    try {
      return /secondary/i.test(await res.clone().text());
    } catch {
      return false;
    }
  };

  const gql = async (q: GithubQuery): Promise<unknown> => {
    const res = await doFetch(`${api}/graphql`, {
      method: "POST",
      headers: { ...baseHeaders(), "content-type": "application/json" },
      body: JSON.stringify(q),
    });
    if (await limitedBy(res)) {
      markLimited(res);
      throw new Limited();
    }
    if (!res.ok) throw new Error(`github graphql HTTP ${res.status}`);
    const body = (await res.json()) as {
      data?: Record<string, unknown>;
      errors?: Array<{ type?: string; message?: string }>;
    };
    const rl = body.data?.rateLimit as Partial<RateLimit> | undefined;
    if (rl) {
      state.rateLimit = {
        remaining: typeof rl.remaining === "number" ? rl.remaining : null,
        resetAt: typeof rl.resetAt === "string" ? rl.resetAt : null,
        cost: typeof rl.cost === "number" ? rl.cost : null,
      };
    }
    if (body.errors?.some((e) => e.type === "RATE_LIMITED")) {
      state.rateLimit = { ...state.rateLimit, remaining: 0 };
      throw new Limited();
    }
    if (!body.data)
      throw new Error(`github graphql: ${body.errors?.[0]?.message ?? "no data"}`.slice(0, 200));
    return body.data;
  };

  /** The list's scalars (always fresh) over the cached detail node (files, body, message). */
  const merged = (listNode: RawPR, cached: RawPR | undefined): RawPR => {
    if (!cached) return listNode;
    const { commits: listCommits, ...scalars } = listNode;
    const out: RawPR = { ...cached, ...scalars };
    if (scalars.mergeable === "UNKNOWN" && cached.mergeable !== undefined) {
      out.mergeable = cached.mergeable; // a flapping UNKNOWN never replaces a known value
    }
    const rollup = dig(listCommits, "nodes", 0, "commit", "statusCheckRollup");
    const cachedCommit = dig(cached, "commits", "nodes", 0, "commit");
    if (rollup !== undefined && cachedCommit && typeof cachedCommit === "object") {
      out.commits = {
        nodes: [{ commit: { ...(cachedCommit as RawPR), statusCheckRollup: rollup } }],
      };
    }
    return out;
  };

  const snapshot = (extra: Partial<PollResult> = {}): PollResult => {
    const prs: RawPR[] = [];
    const files: Record<string, PRFile[]> = Object.create(null) as Record<string, PRFile[]>;
    for (const n of lastOrder) {
      const listNode = lastListNodes.get(n);
      const node = listNode ? merged(listNode, cache.get(n)?.node) : cache.get(n)?.node;
      if (!node) continue;
      prs.push(node);
      const f = dig(node, "files", "nodes");
      if (Array.isArray(f)) files[String(n)] = f as PRFile[];
    }
    return { prs, branches, files, ...extra };
  };

  /** Branches, paged through the Link header, one ETag per page; 304 pages cost nothing. */
  const pollBranches = async (warnings: string[]): Promise<void> => {
    const all: RawBranch[] = [];
    let url: string | null = `${restBase}/branches?per_page=100`;
    let first = true;
    for (let page = 0; url && page < MAX_BRANCH_PAGES; page++) {
      const cached = pageCache.get(url);
      const headers = baseHeaders();
      if (cached) headers["if-none-match"] = cached.etag;
      let res: Response;
      try {
        res = await doFetch(url, { method: "GET", headers });
      } catch (e) {
        warnings.push(`branches: ${safeMessage(e)}`);
        return;
      }
      let entry = cached;
      if (res.status === 304 && cached) {
        entry = cached;
      } else if (await limitedBy(res)) {
        markLimited(res);
        throw new Limited();
      } else if (!res.ok) {
        warnings.push(`branches: HTTP ${res.status}`);
        return;
      } else {
        const list = (await res.json()) as unknown;
        if (!Array.isArray(list)) {
          warnings.push("branches: unexpected response");
          return;
        }
        const link = res.headers.get("link") ?? "";
        const m = /<([^>]+)>\s*;\s*rel="next"/.exec(link);
        // never follow a next link off the repo's own branches endpoint (token stays on GitHub)
        const next = m && m[1].startsWith(`${restBase}/branches`) ? m[1] : null;
        entry = { etag: res.headers.get("etag") ?? "", list: list as RawBranch[], next };
        if (entry.etag) pageCache.set(url, entry);
        else pageCache.delete(url);
      }
      if (first) state.etag = entry.etag || null;
      first = false;
      all.push(...entry.list);
      url = entry.next;
    }
    branches = all;
  };

  /** One poll: list, then detail for each changed PR (capped), then branches. Never throws. */
  async function poll(): Promise<PollResult> {
    const warnings: string[] = [];
    try {
      const data = await gql(buildListQuery(repo));
      const open = arr(dig(data, "repository", "pullRequests", "nodes")) as RawPR[];
      pollCount++;
      if ((pollCount - 1) % CLOSED_EVERY_N_POLLS === 0) {
        const c = await gql(buildClosedQuery(repo));
        closedNodes = arr(dig(c, "repository", "pullRequests", "nodes")) as RawPR[];
      }
      const openNums = new Set(open.map((n) => Number(n.number)));
      const nodes = [...open, ...closedNodes.filter((n) => !openNums.has(Number(n.number)))];
      lastOrder = nodes.map((n) => Number(n.number));
      lastListNodes = new Map(nodes.map((n) => [Number(n.number), n]));
      let details = 0;
      for (const n of nodes) {
        const num = Number(n.number);
        const prev = cache.get(num);
        const mergeable = n.mergeable === "UNKNOWN" && prev ? prev.mergeable : n.mergeable;
        const sig = [n.updatedAt, n.headRefOid, mergeable, n.reviewDecision, listRollup(n)].join(
          "|",
        );
        if (prev?.sig === sig) continue;
        if (details >= MAX_DETAILS_PER_POLL) continue; // deferred to the next poll, not dropped
        details++;
        try {
          const d = await gql(buildDetailQuery(repo, num));
          const node = dig(d, "repository", "pullRequest") as RawPR | null | undefined;
          if (node) cache.set(num, { sig, mergeable, node });
        } catch (e) {
          if (e instanceof Limited) throw e;
          warnings.push(`detail #${num}: ${safeMessage(e)}`); // retried next poll (not cached)
        }
      }
      await pollBranches(warnings);
    } catch (e) {
      if (e instanceof Limited) return snapshot({ rateLimited: true, warnings });
      warnings.push(`github: ${safeMessage(e)}`);
    }
    return snapshot(warnings.length ? { warnings } : {});
  }

  /** One-time backfill of every PR (paged 100); stops early, `complete: false`, when rate limited. */
  async function backfill(): Promise<{ prs: RawPR[]; complete: boolean }> {
    const prs: RawPR[] = [];
    let after: string | null = null;
    try {
      for (let page = 0; page < 500; page++) {
        const data = await gql(buildBackfillQuery(repo, after));
        const conn = dig(data, "repository", "pullRequests") as
          | { nodes?: RawPR[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } }
          | undefined;
        prs.push(...(conn?.nodes ?? []));
        if (!conn?.pageInfo?.hasNextPage || !conn.pageInfo.endCursor)
          return { prs, complete: true };
        after = conn.pageInfo.endCursor;
      }
    } catch (e) {
      if (e instanceof Limited) return { prs, complete: false };
      throw e;
    }
    return { prs, complete: false };
  }

  return { poll, backfill, state };
}

export type Github = ReturnType<typeof createGithub>;
