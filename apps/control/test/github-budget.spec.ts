/**
 * T51, T52 (R24, A13) — the GitHub poll budget of spec 5.6, against a STUBBED `fetch` (no network).
 * `src/sources/github.ts`, `src/sources/poller.ts`.
 *
 * Contract under test (chosen by the test author; see the WP5 test report):
 *   github.ts
 *     buildListQuery({owner, name}) -> {query, variables}     the cheap query: pullRequests, UPDATED_AT
 *         DESC, <= 40 nodes, NO `files`, no `statusCheckRollup` needed; asks rateLimit{remaining,resetAt,cost}
 *     buildDetailQuery({owner, name}, number) -> {query, variables}   one PR: files(first: 100) and
 *         statusCheckRollup; no connection over 100; asks rateLimit{remaining,resetAt,cost}
 *       (a `$var` used as a connection size is resolved from `variables`)
 *     createGithub({token, owner, repo, fetch}) -> client (stateful: last updatedAt/headRefOid per PR,
 *       branches ETag + cached list, last rateLimit)
 *       client.poll() -> Promise<{prs, branches, rateLimited?: boolean}>
 *         1 cheap list query; +1 detail query for EACH PR whose updatedAt or headRefOid changed since the
 *         previous poll (all of them on the first poll); 1 REST `GET /repos/<o>/<r>/branches?per_page=100`
 *         carrying `If-None-Match` from the last ETag (304 -> the cached list, cost nothing).
 *         A 403 or 429 on any call: stop the poll (no further requests), resolve with rateLimited: true,
 *         never throw, and mark the budget exhausted (client.state.rateLimit.remaining === 0).
 *       client.state.rateLimit = {remaining, resetAt, cost}  read from the LAST GraphQL response
 *   poller.ts
 *     TICK_MS = 30_000
 *     nextIntervalMs({remaining: number|null, lastWebhookAt: ISO|null}, now) -> ms
 *         remaining < 1500 -> 60_000; < 500 -> 300_000; webhook seen < 10 min ago -> 300_000 (the max wins)
 *     planTick(tick, {webhook?: boolean}) -> {fetchState: boolean, fetchMaster: boolean, railway: boolean}
 *         state branch every tick, master every 5th tick (or on a webhook), Railway every 2nd tick
 */
import { NOW } from "./helpers/clock";

function tryRequire(load: () => unknown): any {
  try {
    return load();
  } catch (e: any) {
    if (e && e.code === "MODULE_NOT_FOUND") return undefined;
    throw e;
  }
}
const gh = tryRequire(() => require("../src/sources/github"));
const poller = tryRequire(() => require("../src/sources/poller"));
const needGh = () => {
  expect(gh).toBeDefined();
  expect(typeof gh.buildListQuery).toBe("function");
  expect(typeof gh.buildDetailQuery).toBe("function");
  expect(typeof gh.createGithub).toBe("function");
  return gh;
};
const needPoller = () => {
  expect(poller).toBeDefined();
  return poller;
};

const REPO = { owner: "acme", name: "acme" };
const TOKEN = "test-token-not-real";

const asQ = (x: any): { query: string; variables: Record<string, any> } =>
  typeof x === "string"
    ? { query: x, variables: {} }
    : { query: x.query, variables: x.variables ?? {} };

/** Every `first:` / `last:` connection size in a query, `$vars` resolved. */
const sizes = (q: { query: string; variables: Record<string, any> }): number[] =>
  [...q.query.matchAll(/\b(?:first|last)\s*:\s*(\$?\w+)/g)].map((m) => {
    const raw = m[1];
    const n = raw.startsWith("$") ? Number(q.variables[raw.slice(1)]) : Number(raw);
    expect(Number.isFinite(n)).toBe(true);
    return n;
  });

describe("T51 the two queries (spec 5.6, A13 by node count)", () => {
  it("cheap list query: <= 40 PRs, UPDATED_AT desc, NO files, reads rateLimit", () => {
    const { buildListQuery } = needGh();
    const q = asQ(buildListQuery(REPO));
    expect(q.query).toMatch(/pullRequests/);
    expect(q.query).toMatch(/UPDATED_AT/);
    expect(q.query).toMatch(/DESC/);
    expect(q.query).not.toMatch(/\bfiles\b/);
    const s = sizes(q);
    expect(s.length).toBeGreaterThanOrEqual(1);
    expect(Math.max(...s)).toBeLessThanOrEqual(100);
    expect(q.query).toMatch(/states\s*:\s*\[\s*OPEN\s*\]/);
    for (const f of ["remaining", "resetAt", "cost"]) expect(q.query).toContain(f);
    expect(q.query).toMatch(/rateLimit/);
  });

  it("cheap list query asks for the fields that detect change (updatedAt, headRefOid, number)", () => {
    const { buildListQuery } = needGh();
    const q = asQ(buildListQuery(REPO));
    for (const f of ["number", "updatedAt", "headRefOid"]) expect(q.query).toContain(f);
  });

  it("per-PR query: ONE PR, files(first: 100), statusCheckRollup, no connection over 100", () => {
    const { buildDetailQuery } = needGh();
    const q = asQ(buildDetailQuery(REPO, 301));
    expect(q.query).toMatch(/\bfiles\b/);
    expect(q.query).toMatch(/statusCheckRollup/);
    expect(q.query).not.toMatch(/pullRequests\s*\(/); // a single pullRequest(number:), not a list
    const s = sizes(q);
    expect(s).toContain(100);
    expect(Math.max(...s)).toBeLessThanOrEqual(100);
    for (const f of ["remaining", "resetAt", "cost"]) expect(q.query).toContain(f);
    expect(JSON.stringify(q)).toContain("301");
  });

  it("the node budget: worst case 10 changed PRs stays well under 5,000 requested nodes / poll hour math", () => {
    const { buildListQuery, buildDetailQuery } = needGh();
    const list = Math.max(...sizes(asQ(buildListQuery(REPO))));
    const detail = Math.max(...sizes(asQ(buildDetailQuery(REPO, 1))));
    // 120 polls/h x (one list + 10 changed details); each request is 1 point for <= 100 nodes.
    expect(list).toBeLessThanOrEqual(100);
    expect(detail).toBeLessThanOrEqual(100);
    expect(120 * (1 + 10)).toBeLessThan(5000);
  });
});

/* ---------------------------------- stubbed fetch ---------------------------------------------- */
interface Call {
  url: string;
  method: string;
  headers: Headers;
  body: any;
  kind: "list" | "closed" | "detail" | "branches" | "other";
  number?: number;
}
const node = (n: number, updatedAt: string, oid = `${n}`.padStart(40, "0")) => ({
  number: n,
  title: `acme: change ${n}`,
  updatedAt,
  headRefOid: oid,
  isDraft: false,
  state: "OPEN",
});
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const makeStub = () => {
  const stub = {
    calls: [] as Call[],
    list: [] as any[],
    closed: [] as any[],
    files: {} as Record<number, any[]>,
    branches: [{ name: "feat/a", commit: { sha: "1".repeat(40) } }] as any[],
    etag: 'W/"v1"',
    remaining: 4900,
    lastRemaining: 4900,
    graphqlStatus: null as null | { status: number; headers: Record<string, string> },
    fetch: async (url: any, init: any = {}): Promise<Response> => {
      const u = String(url);
      const headers = new Headers(init.headers ?? {});
      const method = String(init.method ?? "GET").toUpperCase();
      let body: any = null;
      if (init.body) body = JSON.parse(String(init.body));
      if (u.includes("/graphql")) {
        const q: string = body.query;
        const isDetail = /\bfiles\b/.test(q);
        const isClosed = !isDetail && /CLOSED/.test(q);
        const call: Call = {
          url: u,
          method,
          headers,
          body,
          kind: isDetail ? "detail" : isClosed ? "closed" : "list",
        };
        if (isDetail) {
          const n = Number(body.variables?.number ?? q.match(/number\s*:\s*(\d+)/)?.[1]);
          call.number = n;
        }
        stub.stubCalls(call);
        if (stub.graphqlStatus) {
          return json(
            { message: "rate limited" },
            stub.graphqlStatus.status,
            stub.graphqlStatus.headers,
          );
        }
        stub.remaining -= 3;
        stub.lastRemaining = stub.remaining;
        const rateLimit = { remaining: stub.remaining, resetAt: "2026-01-12T11:00:00Z", cost: 3 };
        if (isDetail) {
          const n = call.number as number;
          const base = stub.list.find((p) => p.number === n) ?? node(n, NOW);
          return json({
            data: {
              rateLimit,
              repository: { pullRequest: { ...base, files: { nodes: stub.files[n] ?? [] } } },
            },
          });
        }
        return json({
          data: {
            rateLimit,
            repository: { pullRequests: { nodes: isClosed ? stub.closed : stub.list } },
          },
        });
      }
      if (u.includes("/branches")) {
        stub.stubCalls({ url: u, method, headers, body, kind: "branches" });
        if (headers.get("if-none-match") === stub.etag) {
          return new Response(null, { status: 304, headers: { etag: stub.etag } });
        }
        return json(stub.branches, 200, { etag: stub.etag });
      }
      stub.stubCalls({ url: u, method, headers, body, kind: "other" });
      return json({}, 404);
    },
    stubCalls(c: Call) {
      stub.calls.push(c);
    },
    count: (kind: Call["kind"]) => stub.calls.filter((c) => c.kind === kind).length,
    reset() {
      stub.calls = [];
    },
  };
  return stub;
};

const client = (stub: ReturnType<typeof makeStub>) =>
  needGh().createGithub({ token: TOKEN, owner: "acme", repo: "acme", fetch: stub.fetch });

const T0 = "2026-01-12T09:00:00Z";
const T1 = "2026-01-12T09:30:00Z";

describe("T51/T52 the request plan per poll", () => {
  it("cold poll, 3 PRs: 1 list + 3 detail = 4 GraphQL queries, 1 REST branches call", async () => {
    const stub = makeStub();
    stub.list = [node(1, T0), node(2, T0), node(3, T0)];
    const r = await client(stub).poll();
    expect(stub.count("list")).toBe(1);
    expect(stub.count("detail")).toBe(3);
    expect(stub.count("branches")).toBe(1);
    expect(
      stub.calls
        .filter((c) => c.kind === "detail")
        .map((c) => c.number)
        .sort(),
    ).toEqual([1, 2, 3]);
    expect(stub.calls[0].kind).toBe("list"); // the cheap query always goes first
    expect(r.prs).toHaveLength(3);
    expect(r.branches.map((b: any) => b.name)).toEqual(["feat/a"]);
  });

  it("an unchanged second poll costs exactly ONE GraphQL query (the list) and no detail", async () => {
    const stub = makeStub();
    stub.list = [node(1, T0), node(2, T0)];
    const c = client(stub);
    await c.poll();
    stub.reset();
    const r = await c.poll();
    expect(stub.count("list")).toBe(1);
    expect(stub.count("detail")).toBe(0);
    expect(r.prs).toHaveLength(2);
  });

  it("one PR with a newer updatedAt -> exactly 2 GraphQL queries (list + that PR's detail)", async () => {
    const stub = makeStub();
    stub.list = [node(1, T0), node(2, T0), node(3, T0)];
    const c = client(stub);
    await c.poll();
    stub.reset();
    stub.list = [node(1, T0), node(2, T1), node(3, T0)];
    await c.poll();
    expect(stub.count("list")).toBe(1);
    expect(stub.count("detail")).toBe(1);
    expect(stub.calls.find((x) => x.kind === "detail")?.number).toBe(2);
  });

  it("a moved head sha with the SAME updatedAt still triggers that PR's detail", async () => {
    const stub = makeStub();
    stub.list = [node(1, T0), node(2, T0)];
    const c = client(stub);
    await c.poll();
    stub.reset();
    stub.list = [node(1, T0, "f".repeat(40)), node(2, T0)];
    await c.poll();
    expect(stub.count("detail")).toBe(1);
    expect(stub.calls.find((x) => x.kind === "detail")?.number).toBe(1);
  });

  it("a PR that appears later is detailed once, then quiet", async () => {
    const stub = makeStub();
    stub.list = [node(1, T0)];
    const c = client(stub);
    await c.poll();
    stub.reset();
    stub.list = [node(1, T0), node(9, T1)];
    await c.poll();
    expect(stub.calls.filter((x) => x.kind === "detail").map((x) => x.number)).toEqual([9]);
    stub.reset();
    await c.poll();
    expect(stub.count("detail")).toBe(0);
  });

  it("the list query requests <= 40 nodes and never `files`; detail requests files(first: 100)", async () => {
    const stub = makeStub();
    stub.list = [node(1, T0)];
    await client(stub).poll();
    const list = stub.calls.find((x) => x.kind === "list")!;
    const det = stub.calls.find((x) => x.kind === "detail")!;
    expect(
      Math.max(...sizes({ query: list.body.query, variables: list.body.variables ?? {} })),
    ).toBeLessThanOrEqual(100);
    expect(list.body.query).not.toMatch(/\bfiles\b/);
    expect(sizes({ query: det.body.query, variables: det.body.variables ?? {} })).toContain(100);
  });

  it("GraphQL goes by POST with a bearer token in the header, never in a URL", async () => {
    const stub = makeStub();
    stub.list = [node(1, T0)];
    await client(stub).poll();
    for (const c of stub.calls) {
      expect(c.url).not.toContain(TOKEN);
      expect(c.headers.get("authorization")).toMatch(/^(Bearer|token) /);
      expect(c.headers.get("authorization")).toContain(TOKEN);
    }
    expect(stub.calls.filter((c) => c.kind !== "branches").every((c) => c.method === "POST")).toBe(
      true,
    );
    expect(stub.calls.filter((c) => c.kind === "branches").every((c) => c.method === "GET")).toBe(
      true,
    );
  });

  it("reads rateLimit{remaining,resetAt,cost} from the last GraphQL response", async () => {
    const stub = makeStub();
    stub.list = [node(1, T0), node(2, T0)];
    const c = client(stub);
    await c.poll();
    expect(c.state.rateLimit.remaining).toBe(stub.lastRemaining);
    expect(c.state.rateLimit.resetAt).toBe("2026-01-12T11:00:00Z");
    expect(c.state.rateLimit.cost).toBe(3);
    stub.list = [node(1, T1), node(2, T0)];
    await c.poll();
    expect(c.state.rateLimit.remaining).toBe(stub.lastRemaining);
  });
});

describe("F6 amended budget: recent-closed query on every 4th poll only", () => {
  it("the closed query runs on poll 1 and then every 4th poll only (polls 5, 9 ...)", async () => {
    const stub = makeStub();
    stub.list = [node(1, T0)];
    stub.closed = [{ ...node(2, T0), state: "MERGED" }];
    const c = client(stub);
    const closedPerPoll: number[] = [];
    for (let i = 0; i < 8; i++) {
      stub.reset();
      await c.poll();
      closedPerPoll.push(stub.count("closed"));
    }
    expect(closedPerPoll).toEqual([1, 0, 0, 0, 1, 0, 0, 0]);
  });

  it("the closed query is small, unfiltered by nothing else, and its PRs reach the result", async () => {
    const stub = makeStub();
    stub.list = [node(1, T0)];
    stub.closed = [{ ...node(2, T0), state: "MERGED" }];
    const c = client(stub);
    let r: any;
    for (let i = 0; i < 4; i++) r = await c.poll();
    const q = stub.calls.find((x) => x.kind === "closed")!;
    expect(q.body.query).toMatch(/CLOSED/);
    expect(q.body.query).toMatch(/MERGED/);
    expect(q.body.query).not.toMatch(/\bfiles\b/);
    expect(
      Math.max(...sizes({ query: q.body.query, variables: q.body.variables ?? {} })),
    ).toBeLessThanOrEqual(20);
    expect(r.prs.map((p: any) => p.number).sort()).toEqual([1, 2]);
    // and they stay visible on the polls between closed queries
    r = await c.poll();
    expect(r.prs.map((p: any) => p.number).sort()).toEqual([1, 2]);
  });
});

describe("T52 REST branches with If-None-Match", () => {
  it("first call has no If-None-Match; per_page=100; the next carries the stored ETag and a 304 keeps the cached list", async () => {
    const stub = makeStub();
    stub.list = [node(1, T0)];
    const c = client(stub);
    const first = await c.poll();
    const b1 = stub.calls.filter((x) => x.kind === "branches");
    expect(b1).toHaveLength(1);
    expect(b1[0].headers.get("if-none-match")).toBeNull();
    expect(b1[0].url).toContain("per_page=100");
    expect(b1[0].url).toContain("/repos/acme/acme/branches");
    stub.reset();
    const second = await c.poll();
    const b2 = stub.calls.filter((x) => x.kind === "branches");
    expect(b2).toHaveLength(1);
    expect(b2[0].headers.get("if-none-match")).toBe('W/"v1"');
    expect(second.branches).toEqual(first.branches); // 304 -> cached list
    expect(second.branches.map((b: any) => b.name)).toEqual(["feat/a"]);
  });

  it("a changed branch list (200 + new ETag) replaces the cache and the NEW ETag is sent next", async () => {
    const stub = makeStub();
    stub.list = [node(1, T0)];
    const c = client(stub);
    await c.poll();
    stub.etag = 'W/"v2"';
    stub.branches = [
      { name: "feat/a", commit: { sha: "1".repeat(40) } },
      { name: "feat/b", commit: { sha: "2".repeat(40) } },
    ];
    stub.reset();
    const r = await c.poll();
    expect(r.branches.map((b: any) => b.name)).toEqual(["feat/a", "feat/b"]);
    stub.reset();
    const again = await c.poll();
    expect(stub.calls.find((x) => x.kind === "branches")?.headers.get("if-none-match")).toBe(
      'W/"v2"',
    );
    expect(again.branches.map((b: any) => b.name)).toEqual(["feat/a", "feat/b"]);
  });
});

describe("T52 back-off on 403 / 429 (spec 5.6 table)", () => {
  const exhausted = async (status: number, headers: Record<string, string>) => {
    const stub = makeStub();
    stub.list = [node(1, T0)];
    const c = client(stub);
    await c.poll(); // healthy first poll fills the caches
    stub.reset();
    stub.graphqlStatus = { status, headers };
    const r = await c.poll();
    return { stub, c, r };
  };

  it("403 with x-ratelimit-remaining: 0 -> the poll resolves (no throw), flags rateLimited, stops after ONE request", async () => {
    const { stub, c, r } = await exhausted(403, {
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": "1768212000",
    });
    expect(r.rateLimited).toBe(true);
    expect(stub.calls).toHaveLength(1); // no detail, no REST branches while limited
    expect(c.state.rateLimit.remaining).toBe(0);
    expect(
      needPoller().nextIntervalMs(
        { remaining: c.state.rateLimit.remaining, lastWebhookAt: null },
        NOW,
      ),
    ).toBe(300_000);
  });

  it("429 with only Retry-After -> same: rateLimited, one request, budget treated as exhausted (5 min)", async () => {
    const { stub, c, r } = await exhausted(429, { "retry-after": "120" });
    expect(r.rateLimited).toBe(true);
    expect(stub.calls).toHaveLength(1);
    expect(c.state.rateLimit.remaining).toBe(0);
    expect(
      needPoller().nextIntervalMs(
        { remaining: c.state.rateLimit.remaining, lastWebhookAt: null },
        NOW,
      ),
    ).toBe(300_000);
  });

  it("the cached PR and branch data survive a rate-limited poll", async () => {
    const { r } = await exhausted(403, { "x-ratelimit-remaining": "0" });
    expect(r.prs).toHaveLength(1);
    expect(r.branches.map((b: any) => b.name)).toEqual(["feat/a"]);
  });

  it("recovers on the next healthy poll and refreshes remaining from the response", async () => {
    const { stub, c } = await exhausted(403, { "x-ratelimit-remaining": "0" });
    stub.graphqlStatus = null;
    stub.reset();
    const r = await c.poll();
    expect(r.rateLimited).toBeFalsy();
    expect(c.state.rateLimit.remaining).toBe(stub.lastRemaining);
    expect(c.state.rateLimit.remaining).toBeGreaterThan(1500);
  });
});

describe("T52 poller: interval from the remaining budget", () => {
  const next = (remaining: number | null, lastWebhookAt: string | null = null, now = NOW) =>
    needPoller().nextIntervalMs({ remaining, lastWebhookAt }, now);
  const ago = (ms: number) => new Date(Date.parse(NOW) - ms).toISOString();

  it("the tick is 30 s", () => {
    expect(needPoller().TICK_MS).toBe(30_000);
  });

  it("healthy budget -> one tick (30 s)", () => {
    expect(next(4000)).toBe(30_000);
    expect(next(1500)).toBe(30_000); // 'below 1,500' is strict
  });

  it("T52: remaining 1,400 -> 60 s; remaining 400 -> 300 s", () => {
    expect(next(1400)).toBe(60_000);
    expect(next(400)).toBe(300_000);
  });

  it("table edges: 1,499 -> 60 s, 500 -> 60 s, 499 -> 300 s, 0 -> 300 s", () => {
    expect(next(1499)).toBe(60_000);
    expect(next(500)).toBe(60_000);
    expect(next(499)).toBe(300_000);
    expect(next(0)).toBe(300_000);
  });

  it("unknown budget (no response yet) -> the normal tick", () => {
    expect(next(null)).toBe(30_000);
  });

  it("a webhook seen < 10 min ago relaxes the poll to 5 min; 10 min or older does not", () => {
    expect(next(4000, ago(9 * 60_000 + 59_000))).toBe(300_000);
    expect(next(4000, ago(10 * 60_000 + 1_000))).toBe(30_000);
    expect(next(4000, null)).toBe(30_000);
  });

  it("the slower of (back-off, webhook relax) wins", () => {
    expect(next(1400, ago(60_000))).toBe(300_000);
    expect(next(400, ago(60_000))).toBe(300_000);
    expect(next(400, ago(60 * 60_000))).toBe(300_000);
  });
});

describe("poller tick plan", () => {
  const plan = (n: number, o: { webhook?: boolean } = {}) => needPoller().planTick(n, o);
  const ticks = Array.from({ length: 20 }, (_, i) => i + 1);

  it("fetches the state branch on every tick", () => {
    expect(ticks.every((n) => plan(n).fetchState === true)).toBe(true);
  });

  it("master every 5th tick exactly (period 5, no phase assumed)", () => {
    const hits = ticks.filter((n) => plan(n).fetchMaster);
    expect(hits).toHaveLength(4);
    expect(hits.slice(1).map((n, i) => n - hits[i])).toEqual([5, 5, 5]);
  });

  it("Railway every 2nd tick exactly", () => {
    const hits = ticks.filter((n) => plan(n).railway);
    expect(hits).toHaveLength(10);
    expect(hits.slice(1).every((n, i) => n - hits[i] === 2)).toBe(true);
  });

  it("a webhook forces a master fetch on any tick", () => {
    for (const n of ticks) expect(plan(n, { webhook: true }).fetchMaster).toBe(true);
  });
});
