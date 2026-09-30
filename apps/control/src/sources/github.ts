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
    pullRequests(first: 40, orderBy: {field: UPDATED_AT, direction: DESC}) {
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

const signature = (n: RawPR): string =>
  [
    n.updatedAt,
    n.headRefOid,
    n.mergeable,
    n.reviewDecision,
    dig(n, "commits", "nodes", 0, "commit", "statusCheckRollup", "state"),
  ].join("|");

const arr = (v: unknown): unknown[] => (Array.isArray(v) ? (v as unknown[]) : []);

const safeMessage = (e: unknown): string =>
  (e instanceof Error ? e.message : String(e)).slice(0, 200);

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
  const cache = new Map<number, { sig: string; node: RawPR }>();
  let lastOrder: number[] = [];
  let lastListNodes = new Map<number, RawPR>();
  let branches: RawBranch[] = [];

  const baseHeaders = (): Record<string, string> => ({
    authorization: `Bearer ${cfg.token}`,
    accept: "application/vnd.github+json",
    "user-agent": "routeflow-control",
  });

  const markLimited = (res: Response): void => {
    let resetAt = state.rateLimit.resetAt;
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    const retry = Number(res.headers.get("retry-after"));
    if (Number.isFinite(reset) && reset > 0) resetAt = new Date(reset * 1000).toISOString();
    else if (Number.isFinite(retry) && retry > 0)
      resetAt = new Date(nowMs() + retry * 1000).toISOString();
    state.rateLimit = { remaining: 0, resetAt, cost: state.rateLimit.cost };
  };

  const gql = async (q: GithubQuery): Promise<unknown> => {
    const res = await doFetch(`${api}/graphql`, {
      method: "POST",
      headers: { ...baseHeaders(), "content-type": "application/json" },
      body: JSON.stringify(q),
    });
    if (res.status === 403 || res.status === 429) {
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

  const snapshot = (extra: Partial<PollResult> = {}): PollResult => {
    const prs: RawPR[] = [];
    const files: Record<string, PRFile[]> = Object.create(null) as Record<string, PRFile[]>;
    for (const n of lastOrder) {
      const node = cache.get(n)?.node ?? lastListNodes.get(n);
      if (!node) continue;
      prs.push(node);
      const f = dig(node, "files", "nodes");
      if (Array.isArray(f)) files[String(n)] = f as PRFile[];
    }
    return { prs, branches, files, ...extra };
  };

  const pollBranches = async (warnings: string[]): Promise<void> => {
    const headers = baseHeaders();
    if (state.etag) headers["if-none-match"] = state.etag;
    let res: Response;
    try {
      res = await doFetch(`${restBase}/branches?per_page=100`, { method: "GET", headers });
    } catch (e) {
      warnings.push(`branches: ${safeMessage(e)}`);
      return;
    }
    if (res.status === 304) return;
    if (res.status === 403 || res.status === 429) {
      markLimited(res);
      throw new Limited();
    }
    if (!res.ok) {
      warnings.push(`branches: HTTP ${res.status}`);
      return;
    }
    const list = (await res.json()) as unknown;
    if (Array.isArray(list)) {
      branches = list as RawBranch[];
      state.etag = res.headers.get("etag") ?? null;
    }
  };

  /** One poll: list, then detail for each changed PR, then branches. Never throws on a rate limit. */
  async function poll(): Promise<PollResult> {
    const warnings: string[] = [];
    try {
      const data = await gql(buildListQuery(repo));
      const nodes = arr(dig(data, "repository", "pullRequests", "nodes")) as RawPR[];
      lastOrder = nodes.map((n) => Number(n.number));
      lastListNodes = new Map(nodes.map((n) => [Number(n.number), n]));
      for (const n of nodes) {
        const num = Number(n.number);
        const sig = signature(n);
        if (cache.get(num)?.sig === sig) continue;
        try {
          const d = await gql(buildDetailQuery(repo, num));
          const node = dig(d, "repository", "pullRequest") as RawPR | null | undefined;
          if (node) cache.set(num, { sig, node });
        } catch (e) {
          if (e instanceof Limited) throw e;
          warnings.push(`detail #${num}: ${safeMessage(e)}`); // retried next poll (not cached)
        }
      }
      await pollBranches(warnings);
    } catch (e) {
      if (e instanceof Limited) return snapshot({ rateLimited: true, warnings });
      throw e;
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
