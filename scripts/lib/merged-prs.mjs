// Every PR merged since a floor date, WITHOUT GitHub search.
//
// `gh pr list --search merged:a..b` reads the search index, which can answer 0 for a repo with 200+
// merges (11-02: the scoreboard counted 0; a visibility flip drops and rebuilds that index). This walks
// GraphQL `pullRequests(states: MERGED, orderBy: UPDATED_AT DESC)` instead, which reads the repo itself.
// A PR merged at or after the floor was also updated at or after it, so the walk stops on the first page
// whose last row was updated before the floor. Hitting the page cap first throws (never a silent
// under-count), and so does a missing repository or a GraphQL error (never "zero PRs").
//
// Callers pass the GraphQL node fields they need; `mergedAt` and `updatedAt` are always added.

export const PAGE_SIZE = 100;
export const MAX_PAGES = 60;

const BASE_FIELDS = ["number", "mergedAt", "updatedAt"];

/** The GraphQL query for one page of merged PRs, newest update first. */
export function mergedPrsQuery(fields) {
  // `fields` may hold nested selections (`mergeCommit { oid }`), so it is kept whole: only a base field the
  // caller did not name is added, never a token-wise de-duplication (that would collapse the braces).
  const asked = fields.trim();
  const named = (f) => new RegExp(`(^|\\s)${f}(\\s|\\{|$)`).test(asked);
  const want = [...BASE_FIELDS.filter((f) => !named(f)), asked].filter(Boolean).join(" ");
  return `query($owner: String!, $name: String!, $first: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: MERGED, first: $first, after: $after, orderBy: {field: UPDATED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes { ${want} }
    }
  }
}`;
}

/**
 * A page fetcher over `gh api graphql`. `runGh(args)` returns gh's stdout or throws.
 * Returns ({ after, first }) => { nodes, pageInfo }.
 */
export function ghMergedPrPages(runGh, repo, fields) {
  const [owner, name] = repo.split("/");
  const query = mergedPrsQuery(fields);
  return ({ after, first }) => {
    const args = ["api", "graphql", "-f", `query=${query}`, "-f", `owner=${owner}`];
    args.push("-f", `name=${name}`, "-F", `first=${first}`);
    if (after) args.push("-f", `after=${after}`);
    const reply = JSON.parse(runGh(args));
    if (reply.errors?.length) {
      throw new Error(`gh graphql: ${reply.errors.map((e) => e.message).join("; ")}`);
    }
    const conn = reply.data?.repository?.pullRequests;
    if (!conn) throw new Error(`gh graphql: no pullRequests for ${repo} (no access?)`);
    return conn;
  };
}

/** A page fetcher over an in-memory list (fixtures and tests): sorted like GitHub, cursor = offset. */
export function pagesFromList(prs) {
  const at = (p) => Date.parse(p.updatedAt ?? p.mergedAt);
  const sorted = [...prs].sort((a, b) => at(b) - at(a));
  return ({ after, first }) => {
    const start = after ? Number(after) : 0;
    const nodes = sorted
      .slice(start, start + first)
      .map((p) => ({ ...p, updatedAt: p.updatedAt ?? p.mergedAt }));
    const end = start + nodes.length;
    return { nodes, pageInfo: { hasNextPage: end < sorted.length, endCursor: String(end) } };
  };
}

/**
 * Every PR merged at or after `floorMs`, newest update first, each number once.
 * fetchPage({ after, first }) -> { nodes, pageInfo: { hasNextPage, endCursor } }.
 *
 * A PR updated while the walk runs jumps to the front and shifts later pages up, so the cursor can step
 * over one row. After a walk of more than one page, the top is read again down to the newest update the
 * first page saw: anything updated since is there.
 */
export function listMergedPrsSince(
  floorMs,
  fetchPage,
  { pageSize = PAGE_SIZE, maxPages = MAX_PAGES } = {},
) {
  const byNumber = new Map();
  const at = (p) => Date.parse(p?.updatedAt);
  // walk from the top until a page's last row satisfies done(row); returns { pages, top }
  const walk = (done) => {
    let after = null;
    let top = -Infinity;
    for (let page = 1; page <= maxPages; page++) {
      const { nodes, pageInfo } = fetchPage({ after, first: pageSize });
      if (!Array.isArray(nodes)) throw new Error(`merged PRs: page ${page} has no nodes`);
      for (const p of nodes) {
        if (page === 1) top = Math.max(top, at(p));
        const merged = Date.parse(p.mergedAt);
        if (Number.isFinite(merged) && merged >= floorMs && !byNumber.has(p.number)) {
          byNumber.set(p.number, p);
        }
      }
      const last = nodes.at(-1);
      if (!pageInfo?.hasNextPage || !last || done(last)) return { pages: page, top };
      after = pageInfo.endCursor;
    }
    throw new Error(
      `merged PRs: ${maxPages} pages of ${pageSize} did not reach ${new Date(floorMs).toISOString()}: truncated`,
    );
  };
  const first = walk((last) => at(last) < floorMs);
  if (first.pages > 1) walk((last) => at(last) <= first.top);
  return [...byNumber.values()];
}
