/**
 * WP5 fix round 1 (Opus review): F1-F5, F7-F11, F13, F14 plus the coverage the review asked for
 * (repoGit, backfill, runTick, branchFacts, the Railway probe, GitHub-deployments mapping, token
 * absence). F6 (states:[OPEN] first:100 + a recent-closed query) conflicts with the committed
 * github-budget pins (list <= 40 nodes, one list query per poll) and waits for a test ruling.
 * F12 (revert detection) is deferred.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { NOW } from "./helpers/clock";
import { git as run } from "./helpers/temp-repo";

const rec = require("../src/domain/reconcile");
const waste = require("../src/domain/waste");
const prsMod = require("../src/domain/prs");
const gh = require("../src/sources/github");
const poller = require("../src/sources/poller");
const rw = require("../src/sources/railway");
const foldMod = require("../src/domain/fold");

const MIN = 60_000;
const H = 60 * MIN;
const D = 24 * H;
const ago = (ms: number) => new Date(Date.parse(NOW) - ms).toISOString();
const hex = (c: string) => c.repeat(40);

/* ------------------------------------------ fixtures ----------------------------------------- */
const d = (value: any, source = "reported", ref: string | null = null) => ({ value, source, ref });
const mkTask = (id: string, status: string, o: Record<string, any> = {}): any => ({
  id,
  title: `acme: ${id}`,
  kind: "feature",
  status: d(status, "reported", "lane-u#1"),
  priority: d("P2", "register"),
  release: d(null, "register"),
  lane: d("lane-u", "reported", "lane-u#1"),
  phase: d(null, "register"),
  areas: d([], "register"),
  dependsOn: [],
  related: d([], "register"),
  effort: "M",
  importance: 3,
  customerImpact: "none",
  ref: null,
  notes: null,
  pr: d(null, "register"),
  ...o,
});
const mkState = (tasks: any[] = []): any => ({
  tasks: Object.fromEntries(tasks.map((t) => [t.id, t])),
  lanes: {},
  releases: {},
  prs: [],
  branches: [],
  waste: [],
  overlap: [],
  piggyback: {},
  acks: {},
  superseded: {},
  timeline: [],
  warnings: [],
  sources: { events: 0, lanes: 0, github: false, railway: false },
  version: "",
});
const mkPR = (o: Record<string, any> = {}): any => ({
  pr: 7,
  title: "acme: change",
  state: "merged",
  headSha: hex("a"),
  headRef: "feat/RF-2-x",
  baseRef: "master",
  mergeSha: hex("b"),
  createdAt: ago(30 * H),
  updatedAt: ago(5 * H),
  mergedAt: ago(5 * H),
  closedAt: ago(5 * H),
  headCommittedAt: ago(6 * H),
  lane: "lane-u",
  links: { task: "RF-2", bug: null, feature: null, defers: null, issue: null },
  ci: "green",
  ciSince: ago(6 * H),
  review: "approved",
  mergeable: "clean",
  files: 1,
  filePaths: ["apps/api/a.ts"],
  areas: ["apps"],
  body: "",
  bookkeepingPending: false,
  deployed: false,
  ...o,
});

/* ---------------------------------------------- F1 ------------------------------------------- */
describe("F1: a reported status event newer than the merge blocks inference", () => {
  const infer = (reportedAt: Record<string, string> | undefined, status = "planned") =>
    rec.reconcile(
      mkState([mkTask("RF-2", status)]),
      { prs: [mkPR({ mergedAt: ago(5 * H) })], branches: [], deploys: null, reportedAt },
      NOW,
    );

  it("merged #7, then task.reopened (1 h ago): stays planned", () => {
    const out = infer({ "RF-2": ago(1 * H) });
    expect(out.tasks["RF-2"].status).toMatchObject({ value: "planned", source: "reported" });
    expect(JSON.stringify(out.timeline)).not.toContain("inferred from");
  });

  it("a reported event OLDER than the merge does not block it", () => {
    expect(infer({ "RF-2": ago(9 * H) }).tasks["RF-2"].status.value).toBe("code-complete");
  });

  it("no reportedAt entry: inference advances as before", () => {
    expect(infer(undefined).tasks["RF-2"].status.value).toBe("code-complete");
  });

  it("fold exports reportedStatusAt(eventsByLane): newest status-event ts per task, nothing else", () => {
    expect(typeof foldMod.reportedStatusAt).toBe("function");
    const ev = (seq: number, type: string, ts: string, o: Record<string, any> = {}) => ({
      seq,
      ts,
      lane: "lane-u",
      type,
      by: "lane-u",
      ...o,
    });
    const m = foldMod.reportedStatusAt({
      "lane-u": [
        ev(1, "task.started", ago(9 * H), { task: "RF-2" }),
        ev(2, "task.reopened", ago(1 * H), { task: "RF-2" }),
        ev(3, "lane.note", ago(0), { note: "x" }),
        ev(4, "task.priority", ago(0), { task: "RF-2", value: "P0" }),
      ],
    });
    expect(m["RF-2"]).toBe(ago(1 * H));
  });
});

/* ------------------------------------------ F2 / F3 ------------------------------------------ */
describe("F2/F3: per-service relevance for W7; a service with no live deploy is unknown", () => {
  let dir = "";
  let old = "";
  let m = "";
  let nw = "";
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ctl-wp5fix-"));
    run(dir, ["init", "-q", "--initial-branch=master"]);
    const c = (t: string) => {
      fs.writeFileSync(path.join(dir, "a.txt"), t);
      run(dir, ["add", "-A"]);
      run(dir, ["commit", "-q", "-m", t]);
      return run(dir, ["rev-parse", "HEAD"]).trim();
    };
    old = c("old");
    m = c("merge");
    nw = c("new");
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  const patterns = { api: ["apps/api/**"], web: ["apps/web/**"] };
  const at = "2026-01-12T09:00:00Z";
  const go = (prOver: Record<string, any>, deploys: any) => {
    const out = rec.reconcile(
      mkState([mkTask("RF-2", "in-progress")]),
      {
        prs: [mkPR({ mergeSha: m, mergedAt: ago(3 * H), ...prOver })],
        branches: [],
        deploys,
        repoDir: dir,
        watchPatterns: patterns,
      },
      NOW,
    );
    return { out, pr: out.prs[0] };
  };
  const apiOldWebNew = () => ({ api: { sha: old, at }, web: { sha: nw, at }, failedShas: [] });
  const w7 = (pr: any) =>
    waste
      .wasteItems({ prs: [pr], branches: [], tasks: [], acks: {}, superseded: {} }, NOW)
      .filter((i: any) => i.rule === "W7");

  it("web-only merge, api live on an older sha: touches web only, NO W7", () => {
    const { pr } = go({ filePaths: ["apps/web/x.ts"] }, apiOldWebNew());
    expect(pr.touches).toEqual({ api: false, web: true });
    expect(w7(pr)).toHaveLength(0);
  });

  it("the same merge touching api DOES fire W7 (api is not on it)", () => {
    const { pr } = go({ filePaths: ["apps/api/x.ts"] }, apiOldWebNew());
    expect(w7(pr)).toHaveLength(1);
  });

  it("docs-only PR: touches nothing, NO W7", () => {
    const { pr } = go(
      { filePaths: ["docs/a.md"] },
      { api: { sha: old, at }, web: { sha: old, at }, failedShas: [] },
    );
    expect(pr.touches).toEqual({ api: false, web: false });
    expect(w7(pr)).toHaveLength(0);
  });

  it("a truncated file list counts as touching every service", () => {
    const { pr } = go(
      { filePaths: ["docs/a.md"], filesTruncated: true },
      { api: { sha: old, at }, web: { sha: old, at }, failedShas: [] },
    );
    expect(pr.touches).toEqual({ api: true, web: true });
    expect(w7(pr)).toHaveLength(1);
  });

  it("no watchPatterns injected: touches everything (the old behaviour)", () => {
    const out = rec.reconcile(
      mkState([mkTask("RF-2", "in-progress")]),
      {
        prs: [mkPR({ mergeSha: m, mergedAt: ago(3 * H), filePaths: ["docs/a.md"] })],
        branches: [],
        deploys: apiOldWebNew(),
        repoDir: dir,
      },
      NOW,
    );
    expect(out.prs[0].touches).toEqual({ api: true, web: true });
  });

  it("N1: a newer reported DONE never blocks released (only regressive statuses overrule)", () => {
    const out = rec.reconcile(
      mkState([mkTask("RF-2", "code-complete")]),
      {
        prs: [mkPR({ mergeSha: m, mergedAt: ago(5 * H), filePaths: ["apps/web/x.ts"] })],
        branches: [],
        deploys: { api: { sha: nw, at }, web: { sha: nw, at }, failedShas: [] },
        repoDir: dir,
        watchPatterns: patterns,
        reportedAt: { "RF-2": ago(1 * H) },
      },
      NOW,
    );
    expect(out.tasks["RF-2"].status).toMatchObject({ value: "released", source: "inferred" });
  });

  it("N1: a newer reported regression (in-progress after the merge) still blocks", () => {
    const out = rec.reconcile(
      mkState([mkTask("RF-2", "in-progress")]),
      {
        prs: [mkPR({ mergeSha: m, mergedAt: ago(5 * H) })],
        branches: [],
        deploys: { api: { sha: nw, at }, web: { sha: nw, at }, failedShas: [] },
        repoDir: dir,
        reportedAt: { "RF-2": "2026-01-12T09:30:00.000Z" },
      },
      NOW,
    );
    expect(out.tasks["RF-2"].status).toMatchObject({ value: "in-progress", source: "reported" });
  });

  it("N2: a web-only PR with web live reaches deployed:true, deployedAt, and merge-to-deploy metrics", () => {
    const { pr } = go({ filePaths: ["apps/web/x.ts"] }, apiOldWebNew());
    expect(pr.deployed).toBe(true);
    expect(pr.deployedAt).toBe(at);
    const row = prsMod.ledgerRows([], [pr], NOW)[0];
    expect(row.deployed).toBe(true);
    expect(row.deployedAt).toBe(at);
    const mt = prsMod.prMetrics([pr], [{ id: "R1", from: null, to: null }], () => null);
    expect(mt.R1.mergeToDeploy.median).not.toBeNull();
  });

  it("N4: unknown files (no detail yet) touch ALL services", () => {
    const { pr } = go({ filePaths: [], files: 0 }, apiOldWebNew());
    expect(pr.touches).toEqual({ api: true, web: true });
  });

  it("N4: a merged PR with no merge sha is deployed 'unknown' and never W7", () => {
    const { pr } = go({ mergeSha: null, filePaths: ["apps/api/x.ts"] }, apiOldWebNew());
    expect(pr.deployed).toBe("unknown");
    expect(w7(pr)).toHaveLength(0);
  });

  it("F3: a service with no live deploy reads unknown, not false", () => {
    const { out, pr } = go(
      { filePaths: ["apps/api/x.ts"] },
      { api: null, web: { sha: nw, at }, failedShas: [] },
    );
    expect(pr.deployed).toBe("unknown");
    expect(out.tasks["RF-2"].deployed.api).toBe("unknown");
    expect(w7(pr)).toHaveLength(0);
  });
});

/* ---------------------------------------------- F4 ------------------------------------------- */
describe("F4/coverage: repoGit and relandedFor on a real temp repo", () => {
  let dir = "";
  const commit = (f: string, t: string, msg: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), t);
    run(dir, ["add", "-A"]);
    run(dir, ["commit", "-q", "-m", msg]);
    return run(dir, ["rev-parse", "HEAD"]).trim();
  };
  const tipOf = (b: string) => run(dir, ["rev-parse", b]).trim();
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ctl-wp5fix-rg-"));
    run(dir, ["init", "-q", "--initial-branch=master"]);
    commit("a.txt", "1\n2\n3\n", "c0");
    run(dir, ["update-ref", "refs/remotes/origin/master", "master"]);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const advance = () => run(dir, ["update-ref", "refs/remotes/origin/master", "master"]);

  it("cherry-pick, squash, rebased reland, never-landed, stale master, missing head", () => {
    const base = tipOf("master");
    run(dir, ["checkout", "-q", "-b", "pr-a", base]);
    const a1 = commit("a.txt", "1\n2\n3\nA\n", "A1");
    run(dir, ["checkout", "-q", "-b", "pr-b", base]);
    commit("b.txt", "b1\n", "B1");
    const b2 = commit("b.txt", "b1\nb2\n", "B2");
    run(dir, ["checkout", "-q", "-b", "pr-r", base]);
    const r1 = commit("r.txt", "r\n", "R1");
    run(dir, ["checkout", "-q", "-b", "pr-c", base]);
    const c1 = commit("c.txt", "c\n", "C1");
    run(dir, ["checkout", "-q", "master"]);
    commit("m.txt", "m1\n", "m1");
    advance();
    const g = waste.repoGit(dir);
    const re = waste.relandedFor(g);
    // stale master: nothing landed yet, all unlanded
    expect(re({ headSha: a1 })).toBe(false);
    // F4: advance master with a cherry-pick; the SAME repoGit must see it (cache keyed on the tip)
    run(dir, ["cherry-pick", a1]);
    advance();
    expect(re({ headSha: a1 })).toBe(true);
    // squash of pr-b (range patch-id)
    run(dir, ["merge", "--squash", "pr-b"]);
    run(dir, ["commit", "-q", "-m", "squash B"]);
    advance();
    expect(re({ headSha: b2 })).toBe(true);
    // rebased reland: the commit is replayed onto a newer master (new sha, same patch-id)
    run(dir, ["checkout", "-q", "pr-r"]);
    run(dir, ["rebase", "-q", "master"]);
    const r1Rebased = tipOf("pr-r");
    expect(r1Rebased).not.toBe(r1);
    run(dir, ["checkout", "-q", "master"]);
    run(dir, ["merge", "-q", "--ff-only", "pr-r"]);
    advance();
    expect(re({ headSha: r1 })).toBe(true);
    // never landed
    expect(re({ headSha: c1 })).toBe(false);
    // a head the clone does not hold is an unknown: never flagged
    expect(re({ headSha: hex("9") })).toBe(true);
    // not a sha at all
    expect(re({ headSha: "--upload-pack=x" })).toBe(true);
  });
});

/* ---------------------------------------------- F5 ------------------------------------------- */
describe("F5: W6 covered set comes from the ledger, not the 40-PR window", () => {
  const branch = { name: "feat/aged-out", oid: hex("c"), committedDate: ago(10 * D), ahead: 2 };
  const run6 = (over: Record<string, any>) =>
    waste
      .wasteItems(
        { prs: [], branches: [branch], tasks: [], acks: {}, superseded: {}, ...over },
        NOW,
      )
      .filter((i: any) => i.rule === "W6");

  it("a squash-merged branch whose PR aged out of the window is not flagged", () => {
    const ledger = [
      { pr: 11, at: ago(20 * D), state: "open", headRef: "feat/aged-out" },
      { pr: 11, at: ago(12 * D), state: "merged", headRef: "feat/aged-out" },
    ];
    expect(run6({ ledger })).toHaveLength(0);
  });

  it("without ledger coverage it is flagged, and a closed-unmerged ledger PR does not cover", () => {
    expect(run6({})).toHaveLength(1);
    expect(
      run6({ ledger: [{ pr: 11, at: ago(12 * D), state: "closed", headRef: "feat/aged-out" }] }),
    ).toHaveLength(1);
  });

  it("ledgerRows records headRef so the ledger can cover branches", () => {
    const row = prsMod.ledgerRows([], [mkPR({ state: "open" })], NOW)[0];
    expect(row.headRef).toBe("feat/RF-2-x");
  });
});

describe("W5 skipped for lack of a relanded predicate is a source warning", () => {
  it("wasteWarnings names it when a closed-unmerged PR exists and no predicate was given", () => {
    const pr = mkPR({ state: "closed", mergedAt: null, mergeSha: null });
    const w = waste.wasteWarnings({ prs: [pr], branches: [], tasks: [], acks: {}, superseded: {} });
    expect(w.join(" ")).toMatch(/W5/);
    expect(
      waste.wasteWarnings({
        prs: [pr],
        branches: [],
        tasks: [],
        acks: {},
        superseded: {},
        relanded: () => true,
      }),
    ).toEqual([]);
    expect(
      waste.wasteWarnings({ prs: [mkPR()], branches: [], tasks: [], acks: {}, superseded: {} }),
    ).toEqual([]);
  });
});

/* ------------------------------------------- github ------------------------------------------ */
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
const node = (n: number, o: Record<string, any> = {}) => ({
  number: n,
  title: `t${n}`,
  updatedAt: "2026-01-12T09:00:00Z",
  headRefOid: String(n).padStart(40, "0"),
  isDraft: false,
  state: "OPEN",
  ...o,
});
const gstub = () => {
  const s = {
    calls: [] as Array<{ url: string; kind: string; headers: Headers; number?: number }>,
    list: [] as any[],
    detail: (n: any): any => ({ ...n, files: { nodes: [{ path: "a.ts" }] }, changedFiles: 1 }),
    status: null as null | { status: number; headers?: Record<string, string>; body?: any },
    fetch: async (url: any, init: any = {}): Promise<Response> => {
      const u = String(url);
      const headers = new Headers(init.headers ?? {});
      if (u.includes("/graphql")) {
        const body = JSON.parse(String(init.body));
        const isDetail = /\bfiles\b/.test(body.query);
        s.calls.push({
          url: u,
          kind: isDetail ? "detail" : "list",
          headers,
          number: body.variables?.number,
        });
        if (s.status)
          return json(s.status.body ?? { message: "x" }, s.status.status, s.status.headers);
        const rateLimit = { remaining: 4000, resetAt: "2026-01-12T11:00:00Z", cost: 1 };
        if (isDetail) {
          const n = s.list.find((p) => p.number === body.variables.number);
          return json({ data: { rateLimit, repository: { pullRequest: s.detail(n) } } });
        }
        return json({ data: { rateLimit, repository: { pullRequests: { nodes: s.list } } } });
      }
      s.calls.push({ url: u, kind: "branches", headers });
      return json([], 200, { etag: 'W/"b"' });
    },
    count: (k: string) => s.calls.filter((c) => c.kind === k).length,
    reset: () => (s.calls = []),
  };
  return s;
};
const mk = (s: ReturnType<typeof gstub>, extra: Record<string, any> = {}) =>
  gh.createGithub({
    token: "tok-secret-123",
    owner: "acme",
    repo: "acme",
    fetch: s.fetch,
    now: () => Date.parse(NOW),
    ...extra,
  });

describe("F7: list scalars override the cached detail node", () => {
  it("a state change that does not move the detail signature still shows up", async () => {
    const s = gstub();
    s.list = [node(1)];
    const c = mk(s);
    await c.poll();
    s.list = [node(1, { state: "MERGED", mergedAt: "2026-01-12T09:30:00Z" })];
    const r = await c.poll();
    expect(r.prs[0].state).toBe("MERGED");
    expect(r.prs[0].files.nodes).toHaveLength(1); // detail-only data survives
  });
});

describe("F8: 403/429 handling", () => {
  const limited = async (st: any) => {
    const s = gstub();
    s.list = [node(1)];
    const c = mk(s);
    await c.poll();
    s.reset();
    s.status = st;
    return { r: await c.poll(), c, s };
  };
  it("a bare 403 (no remaining 0, no Retry-After, no 'secondary') is NOT a rate limit: warning with the status", async () => {
    const { r, c } = await limited({ status: 403, body: { message: "Resource not accessible" } });
    expect(r.rateLimited).toBeFalsy();
    expect(String(r.warnings)).toContain("403");
    expect(c.state.rateLimit.remaining).not.toBe(0);
  });
  it("403 whose body says 'secondary rate limit' is a rate limit", async () => {
    const { r } = await limited({
      status: 403,
      body: { message: "You have exceeded a secondary rate limit" },
    });
    expect(r.rateLimited).toBe(true);
  });
  it("Retry-After wins over x-ratelimit-reset for resetAt", async () => {
    const { c } = await limited({
      status: 429,
      headers: { "retry-after": "120", "x-ratelimit-reset": "1768212000" },
    });
    expect(c.state.rateLimit.resetAt).toBe(new Date(Date.parse(NOW) + 120_000).toISOString());
  });
  it("the scheduler honours resetAt when the budget is exhausted", () => {
    const reset = new Date(Date.parse(NOW) + 20 * MIN).toISOString();
    expect(poller.nextIntervalMs({ remaining: 0, lastWebhookAt: null, resetAt: reset }, NOW)).toBe(
      20 * MIN,
    );
    expect(
      poller.nextIntervalMs({ remaining: 4000, lastWebhookAt: null, resetAt: reset }, NOW),
    ).toBe(30_000);
  });
  it("no warning or error string ever carries the token", async () => {
    const { r } = await limited({ status: 500, body: { message: "boom tok-secret-123" } });
    expect(JSON.stringify(r.warnings ?? [])).not.toContain("tok-secret-123");
  });
});

describe("F9: detail signature ignores UNKNOWN mergeable flips; at most 8 details per tick", () => {
  it("MERGEABLE -> UNKNOWN -> MERGEABLE costs no detail call", async () => {
    const s = gstub();
    s.list = [node(1, { mergeable: "MERGEABLE" })];
    const c = mk(s);
    await c.poll();
    s.reset();
    s.list = [node(1, { mergeable: "UNKNOWN" })];
    await c.poll();
    s.list = [node(1, { mergeable: "MERGEABLE" })];
    await c.poll();
    expect(s.count("detail")).toBe(0);
  });
  it("12 new PRs: 8 details on the first poll, the other 4 on the next", async () => {
    const s = gstub();
    s.list = Array.from({ length: 12 }, (_, i) => node(i + 1));
    const c = mk(s);
    await c.poll();
    expect(s.count("detail")).toBe(8);
    s.reset();
    await c.poll();
    expect(s.count("detail")).toBe(4);
  });
});

describe("F11: branches paginate via the Link header with an ETag per page", () => {
  const mkBranchesFetch = () => {
    const seen: Array<{ url: string; inm: string | null }> = [];
    const pages: Record<string, { body: any[]; etag: string; link?: string }> = {
      "https://api.github.com/repos/acme/acme/branches?per_page=100": {
        body: [{ name: "a", commit: { sha: hex("1") } }],
        etag: 'W/"p1"',
        link: '<https://api.github.com/repos/acme/acme/branches?per_page=100&page=2>; rel="next"',
      },
      "https://api.github.com/repos/acme/acme/branches?per_page=100&page=2": {
        body: [{ name: "b", commit: { sha: hex("2") } }],
        etag: 'W/"p2"',
        link: '<https://evil.example/steal>; rel="next"',
      },
    };
    const f = async (url: any, init: any = {}): Promise<Response> => {
      const u = String(url);
      if (u.includes("/graphql")) {
        return json({
          data: {
            rateLimit: { remaining: 4000, resetAt: null, cost: 1 },
            repository: { pullRequests: { nodes: [] } },
          },
        });
      }
      const headers = new Headers(init.headers ?? {});
      seen.push({ url: u, inm: headers.get("if-none-match") });
      const p = pages[u];
      if (!p) return json({}, 404);
      if (headers.get("if-none-match") === p.etag)
        return new Response(null, { status: 304, headers: { etag: p.etag } });
      return json(p.body, 200, { etag: p.etag, ...(p.link ? { link: p.link } : {}) });
    };
    return { f, seen };
  };
  it("follows rel=next, sends a per-page If-None-Match on the next poll, never follows a foreign host", async () => {
    const { f, seen } = mkBranchesFetch();
    const c = gh.createGithub({ token: "t", owner: "acme", repo: "acme", fetch: f });
    const first = await c.poll();
    expect(first.branches.map((b: any) => b.name)).toEqual(["a", "b"]);
    expect(seen.map((x) => x.url)).toHaveLength(2);
    seen.length = 0;
    const second = await c.poll();
    expect(second.branches.map((b: any) => b.name)).toEqual(["a", "b"]);
    expect(seen.map((x) => x.inm)).toEqual(['W/"p1"', 'W/"p2"']);
  });
});

describe("F14: changedFiles is requested; a truncated file list is recorded", () => {
  it("the detail query asks for changedFiles", () => {
    expect(gh.buildDetailQuery({ owner: "a", name: "b" }, 1).query).toContain("changedFiles");
  });
  it("normalizePRs: changedFiles 250 with 100 files -> files 250, filesTruncated", () => {
    const raw = {
      ...node(5),
      headRefName: "x",
      changedFiles: 250,
      commits: {
        nodes: [{ commit: { committedDate: NOW, message: "m", statusCheckRollup: null } }],
      },
    };
    const files = Array.from({ length: 100 }, (_, i) => ({ path: `apps/api/f${i}.ts` }));
    const p = prsMod.normalizePRs([raw], {
      now: NOW,
      files: { "5": files },
      taskLane: () => null,
    })[0];
    expect(p.files).toBe(250);
    expect(p.filesTruncated).toBe(true);
    const q = prsMod.normalizePRs([{ ...raw, changedFiles: 100 }], {
      now: NOW,
      files: { "5": files },
      taskLane: () => null,
    })[0];
    expect(q.filesTruncated).toBe(false);
  });
});

/* --------------------------------------------- F10 ------------------------------------------- */
describe("F10: unknown carries the previous ledger value; ciSince is one pass", () => {
  it("a mergeable/deployed 'unknown' poll appends nothing and never replaces a known value", () => {
    const known = prsMod.normalizePRs([], { now: NOW, files: {}, taskLane: () => null });
    expect(known).toEqual([]);
    const base = mkPR({ state: "open", mergeable: "clean", deployed: false });
    const prev = prsMod.ledgerRows([], [base], ago(H));
    const flaky = { ...base, mergeable: "unknown" };
    expect(prsMod.ledgerRows(prev, [flaky], NOW)).toEqual([]);
    const moved = { ...flaky, ci: "red" };
    const added = prsMod.ledgerRows(prev, [moved], NOW);
    expect(added).toHaveLength(1);
    expect(added[0].mergeable).toBe("clean");
    const dep = prsMod.ledgerRows(
      [{ ...prev[0], state: "merged", deployed: true }],
      [{ ...base, state: "merged", deployed: "unknown" }],
      NOW,
    );
    expect(dep).toEqual([]);
  });
  it("ciSinceAll matches ciSince for every PR", () => {
    const rows = [
      { pr: 1, at: "2026-01-01T00:00:00Z", ci: "red" },
      { pr: 2, at: "2026-01-01T01:00:00Z", ci: "green" },
      { pr: 1, at: "2026-01-02T00:00:00Z", ci: "green" },
      { pr: 1, at: "2026-01-03T00:00:00Z", ci: "green" },
      { pr: 2, at: "2026-01-04T00:00:00Z", ci: "red" },
    ];
    const all = prsMod.ciSinceAll(rows);
    for (const n of [1, 2]) expect(all.get(n)).toBe(prsMod.ciSince(rows, n));
  });
});

/* --------------------------------------------- F13 ------------------------------------------- */
describe("F13: ids from trailers never index a plain map unguarded", () => {
  it("`Task: constructor` does not reach taskLane / taskRelease", () => {
    const table: Record<string, string> = { "RF-2": "lane-u" };
    const raw = {
      ...node(9),
      headRefName: "x",
      body: "Task: constructor\nBug: toString\n",
      commits: {
        nodes: [{ commit: { committedDate: NOW, message: "m", statusCheckRollup: null } }],
      },
    };
    const p = prsMod.normalizePRs([raw], {
      now: NOW,
      files: {},
      taskLane: (id: string) => table[id] ?? null,
    })[0];
    expect(p.lane).toBe("unattributed");
    const m = prsMod.prMetrics(
      [
        mkPR({
          links: { task: "constructor", bug: null, feature: null, defers: null, issue: null },
        }),
      ],
      [{ id: "R1", from: null, to: null }],
      (id: string) => (({}) as any)[id] ?? null,
    );
    expect(m.R1.count).toBe(1);
  });
});

/* ------------------------------------------ coverage ----------------------------------------- */
describe("backfill paging", () => {
  const pager = (failOnPage?: number) => {
    let page = 0;
    const f = async (_url: any, init: any): Promise<Response> => {
      page++;
      if (failOnPage === page)
        return json({ message: "limited" }, 403, { "x-ratelimit-remaining": "0" });
      const body = JSON.parse(String(init.body));
      const after = body.variables.after;
      const n = after === null ? 1 : Number(after);
      return json({
        data: {
          rateLimit: { remaining: 4000, resetAt: null, cost: 1 },
          repository: {
            pullRequests: {
              pageInfo: { hasNextPage: n < 3, endCursor: String(n + 1) },
              nodes: [node(n)],
            },
          },
        },
      });
    };
    return f;
  };
  it("pages until hasNextPage is false", async () => {
    const c = gh.createGithub({ token: "t", owner: "a", repo: "b", fetch: pager() });
    const r = await c.backfill();
    expect(r.complete).toBe(true);
    expect(r.prs.map((p: any) => p.number)).toEqual([1, 2, 3]);
  });
  it("a 403 mid-way returns what it has with complete:false", async () => {
    const c = gh.createGithub({ token: "t", owner: "a", repo: "b", fetch: pager(2) });
    const r = await c.backfill();
    expect(r.complete).toBe(false);
    expect(r.prs.map((p: any) => p.number)).toEqual([1]);
  });
});

describe("runTick", () => {
  it("a throwing source becomes a warning and the tick still yields nextMs", async () => {
    const deps = {
      github: {
        poll: async () => {
          throw new Error("net down");
        },
        state: { rateLimit: { remaining: 400 } },
      },
      fetchMaster: () => {
        throw new Error("fetch failed");
      },
      railway: async () => {
        throw new Error("probe 401");
      },
      now: () => NOW,
    };
    const r = await poller.runTick(deps, 1);
    expect(r.warnings.join("|")).toMatch(/net down/);
    expect(r.warnings.join("|")).toMatch(/fetch failed/);
    expect(r.warnings.join("|")).toMatch(/probe 401/);
    expect(r.nextMs).toBe(300_000);
  });
});

describe("N3: runTick honours the rate limit's resetAt", () => {
  it("remaining 0 with resetAt in 20 min -> nextMs 20 min", async () => {
    const reset = new Date(Date.parse(NOW) + 20 * MIN).toISOString();
    const deps = {
      github: {
        poll: async () => ({ prs: [], branches: [], files: {} }),
        state: { rateLimit: { remaining: 0, resetAt: reset } },
      },
      now: () => NOW,
    };
    expect((await poller.runTick(deps, 2)).nextMs).toBe(20 * MIN);
  });
});

describe("branchFacts", () => {
  it("omits a branch whose commit the clone lacks and a malformed sha", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ctl-wp5fix-bf-"));
    try {
      run(dir, ["init", "-q", "--initial-branch=master"]);
      fs.writeFileSync(path.join(dir, "a"), "1");
      run(dir, ["add", "-A"]);
      run(dir, ["commit", "-q", "-m", "c0"]);
      const c0 = run(dir, ["rev-parse", "HEAD"]).trim();
      run(dir, ["update-ref", "refs/remotes/origin/master", c0]);
      fs.writeFileSync(path.join(dir, "a"), "2");
      run(dir, ["commit", "-q", "-am", "c1"]);
      const c1 = run(dir, ["rev-parse", "HEAD"]).trim();
      const out = poller.branchFacts(dir, [
        { name: "have", commit: { sha: c1 } },
        { name: "missing", commit: { sha: hex("9") } },
        { name: "bad", commit: { sha: "--x" } },
        { name: "nosha" },
      ]);
      expect(out.map((b: any) => b.name)).toEqual(["have"]);
      expect(out[0].ahead).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("railway probe and GitHub deployments", () => {
  it("probe: bearer header, token never in the URL, non-2xx rejects, warning omits the token", async () => {
    const seen: any[] = [];
    const ok = async (url: any, init: any) => {
      seen.push({ url: String(url), auth: new Headers(init.headers).get("authorization") });
      return json({ data: { deployments: { edges: [] } } });
    };
    const probe = rw.createRailwayProbe({ token: "rw-secret-9", projectId: "p", fetch: ok });
    await probe();
    expect(seen[0].auth).toBe("Bearer rw-secret-9");
    expect(seen[0].url).not.toContain("rw-secret-9");
    const bad = rw.createRailwayProbe({
      token: "rw-secret-9",
      projectId: "p",
      fetch: async () => json({}, 401),
    });
    const r = await rw.readDeployState(bad);
    expect(r.state).toBeNull();
    expect(JSON.stringify(r.warnings)).not.toContain("rw-secret-9");
  });
  it("github deployments: success/failure/error mapped, service from the environment suffix", async () => {
    const f = async (url: any): Promise<Response> => {
      const u = String(url);
      if (u.includes("/statuses")) {
        const id = /deployments\/(\d+)\/statuses/.exec(u)![1];
        const st: Record<string, string> = { "1": "success", "2": "success", "3": "failure" };
        return json([{ state: st[id], created_at: `2026-01-12T0${id}:00:00Z` }]);
      }
      return json([
        {
          id: 1,
          sha: hex("1"),
          environment: "production / @routeflow/api",
          created_at: "2026-01-12T01:00:00Z",
        },
        {
          id: 2,
          sha: hex("2"),
          environment: "production / @routeflow/web",
          created_at: "2026-01-12T02:00:00Z",
        },
        {
          id: 3,
          sha: hex("3"),
          environment: "production / @routeflow/web",
          created_at: "2026-01-12T03:00:00Z",
        },
        { id: 4, sha: hex("4"), environment: "preview", created_at: "2026-01-12T04:00:00Z" },
      ]);
    };
    const out = await rw.createGithubDeployments({ token: "t", owner: "a", repo: "b", fetch: f })();
    expect(out.api.sha).toBe(hex("1"));
    expect(out.web.sha).toBe(hex("2"));
    expect(out.failedShas).toEqual([hex("3")]);
  });
});
