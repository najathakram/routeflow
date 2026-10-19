import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  createCollector,
  parsePrGraphql,
  parseForEachRef,
  parseBugFrontMatter,
  isOpenBug,
  maskBug,
  parseCatFileBatch,
  parseRailwayStatus,
  CLOUD_INTERVALS,
  GRAPHQL_QUERY,
  RAILWAY_QUERIES,
  mergeDeploys,
  parseGithubDeployments,
  parseRailwayProject,
  railwayRequest,
} from "../lib/collector.mjs";

const FIX = join(fileURLToPath(new URL(".", import.meta.url)), "fixtures");
const read = (f) => readFileSync(join(FIX, f), "utf8");
const NOW = Date.parse("2026-10-19T12:00:00Z");
const BUG_FILES = readdirSync(join(FIX, "collector-bugs")).sort();
const bugText = (f) => readFileSync(join(FIX, "collector-bugs", f), "utf8");

test("parsePrGraphql: 3 open (failure, draft) and 3 merged, master, visibility", () => {
  const r = parsePrGraphql(JSON.parse(read("collector-graphql.json")));
  assert.equal(r.visibility, "PRIVATE");
  assert.deepEqual(
    r.open.map((p) => [p.number, p.checks, p.draft]),
    [
      [3520, "SUCCESS", false],
      [3521, "FAILURE", false],
      [3522, null, true],
    ],
  );
  assert.equal(r.open[0].branch, "feat/k11-20-floating-editor");
  assert.equal(r.open[0].headSha, "1".repeat(40));
  assert.deepEqual(r.open[1].files, ["apps/api/src/invoices/invoices.service.ts"]);
  assert.equal(r.merged.length, 3);
  assert.deepEqual(r.merged[0], {
    number: 3513,
    title: "Merge train/product-k11",
    branch: "train/product-k11",
    mergedAt: "2026-10-19T09:00:00Z",
    mergeSha: "a".repeat(40),
    url: "https://github.com/najathakram/routeflow/pull/3513",
    base: "master",
  });
  assert.equal(r.merged[2].mergeSha, null);
  assert.equal(r.merged[2].base, "train/product-k11");
  assert.deepEqual(r.master, {
    sha: "a".repeat(40),
    date: "2026-10-19T09:00:05Z",
    headline: "Merge train/product-k11 (#3513)",
    checks: "SUCCESS",
  });
  assert.deepEqual(parsePrGraphql({}), {
    visibility: null,
    open: [],
    merged: [],
    master: null,
    deploys: [],
  });
});

test("parseForEachRef drops origin, HEAD, master and strips origin/", () => {
  const r = parseForEachRef(read("collector-for-each-ref.txt"));
  assert.deepEqual(
    r.map((b) => b.branch),
    [
      "feat/k11-20-floating-editor",
      "fix/b231-boxed-rounding",
      "fix/b233-counter-promo",
      "feat/loose-experiment",
      "old/ancient",
    ],
  );
  assert.equal(r[1].sha, "2".repeat(40));
  assert.equal(r[1].date, "2026-10-19T10:00:00.000Z");
});

test("parseBugFrontMatter: sensitive bug, files with parens/brackets, CRLF", () => {
  const b = parseBugFrontMatter(bugText("B230.md"));
  assert.equal(b.id, "B230");
  assert.equal(b.sensitive, true);
  assert.equal(b.severity, "low");
  assert.equal(b.state, "uncampaigned");
  assert.equal(b.closed, "");
  assert.equal(b.location, "Route dispatch modals · web");
  assert.deepEqual(b.files, [
    "apps/web/app/(dashboard)/routes/page.tsx",
    "apps/web/app/(dashboard)/routes/templates/[id]/page.tsx",
  ]);
  const crlf = parseBugFrontMatter(bugText("B233.md").replace(/\n/g, "\r\n"));
  assert.equal(crlf.state, "already-fixed");
  assert.equal(crlf.severity, "critical");
  assert.equal(parseBugFrontMatter("no front matter").id, "");
});

test("isOpenBug: closed date, done-like states, open states", () => {
  const bugs = Object.fromEntries(
    BUG_FILES.map((f) => [f.slice(0, 4), parseBugFrontMatter(bugText(f))]),
  );
  assert.equal(isOpenBug(bugs.B230), true);
  assert.equal(isOpenBug(bugs.B231), true);
  assert.equal(isOpenBug(bugs.B232), false); // closed date set although state=fixing
  assert.equal(isOpenBug(bugs.B233), false); // already-fixed
  for (const state of ["done", "refuted", "closed", "fixed", "duplicate", "wontfix"]) {
    assert.equal(isOpenBug({ closed: "", state }), false, state);
  }
  assert.equal(isOpenBug({ closed: "", state: "fixing" }), true);
});

test("maskBug: sensitive hides title/area/domain; normal derives area and domain", () => {
  const s = maskBug(parseBugFrontMatter(bugText("B230.md")));
  assert.deepEqual(s, {
    id: "B230",
    title: "Security hardening item (details machine-local)",
    severity: "low",
    state: "uncampaigned",
    area: null,
    domain: null,
    sensitive: true,
  });
  assert.ok(!JSON.stringify(s).includes("routes"));
  const n = maskBug(parseBugFrontMatter(bugText("B231.md")));
  assert.equal(n.area, "api:invoices");
  assert.equal(n.domain, "finance");
  assert.equal(n.sensitive, false);
  assert.equal(
    maskBug({ id: "B1", title: "x", severity: "low", state: "s", files: [], sensitive: false })
      .area,
    null,
  );
  assert.equal(maskBug(parseBugFrontMatter(bugText("B231.md")), "web:orders").area, "web:orders");
});

test("parseCatFileBatch: byte sizes, multiple blobs, missing", () => {
  const a = "---\nid: B1\n---\n";
  const b = "héllo\n";
  const buf = Buffer.concat([
    Buffer.from(`${"a".repeat(40)} blob ${Buffer.byteLength(a)}\n${a}\n`),
    Buffer.from(`${"b".repeat(40)} missing\n`),
    Buffer.from(`${"c".repeat(40)} blob ${Buffer.byteLength(b)}\n${b}\n`),
  ]);
  const r = parseCatFileBatch(buf);
  assert.deepEqual(r, [
    { sha: "a".repeat(40), content: a },
    { sha: "c".repeat(40), content: b },
  ]);
  assert.deepEqual(parseCatFileBatch(""), []);
});

test("parseRailwayStatus: production @routeflow services only", () => {
  const r = parseRailwayStatus(JSON.parse(read("collector-railway.json")));
  assert.deepEqual(r, [
    {
      service: "@routeflow/api",
      status: "SUCCESS",
      sha: "a".repeat(40),
      createdAt: "2026-10-19T09:05:00.000Z",
    },
    {
      service: "@routeflow/web",
      status: "BUILDING",
      sha: "a".repeat(40),
      createdAt: "2026-10-19T09:06:00.000Z",
    },
  ]);
  assert.deepEqual(parseRailwayStatus({}), []);
});

// ---------- collector with a fake exec ----------

function bugBatch(shaByFile) {
  const parts = [];
  for (const f of BUG_FILES) {
    const t = bugText(f);
    parts.push(Buffer.from(`${shaByFile[f]} blob ${Buffer.byteLength(t)}\n${t}\n`));
  }
  return Buffer.concat(parts).toString("utf8");
}

function makeExec(over = {}) {
  const calls = [];
  const shaByFile = Object.fromEntries(BUG_FILES.map((f, i) => [f, String(i + 1).repeat(40)]));
  const lsTree = BUG_FILES.map(
    (f) => `100644 blob ${shaByFile[f]}\t.claude/campaign/bugs/${f}`,
  ).join("\n");
  const table = {
    "gh api graphql": () => ({ code: 0, stdout: read("collector-graphql.json"), stderr: "" }),
    "git fetch": () => ({ code: 0, stdout: "", stderr: "" }),
    "git for-each-ref": () => ({ code: 0, stdout: read("collector-for-each-ref.txt"), stderr: "" }),
    "git diff": (args) => ({
      code: 0,
      stdout: `files-of-${args[2].split("...")[1].slice(0, 4)}.ts\n`,
      stderr: "",
    }),
    "git rev-parse origin/master:.claude/campaign/bugs": () => ({
      code: 0,
      stdout: "treesha1\n",
      stderr: "",
    }),
    "git rev-parse origin/master": () => ({ code: 0, stdout: "headsha1\n", stderr: "" }),
    "git ls-tree -r": () => ({
      code: 0,
      stdout:
        "apps/api/src/invoices/a.ts\napps/web/app/(dashboard)/routes/page.tsx\n.github/workflows/ci.yml\n",
      stderr: "",
    }),
    "git ls-tree origin/master": () => ({ code: 0, stdout: lsTree, stderr: "" }),
    "git cat-file": () => ({ code: 0, stdout: bugBatch(shaByFile), stderr: "" }),
    "railway status": () => ({ code: 0, stdout: read("collector-railway.json"), stderr: "" }),
    ...over,
  };
  const exec = async (cmd, args, opts) => {
    // On Windows the collector runs the railway CLI through cmd.exe; match on the inner command.
    const line = `${cmd} ${args.join(" ")}`.replace(/^cmd\.exe \/d \/s \/c /, "");
    calls.push({ cmd, args, opts, line });
    const key = Object.keys(table)
      .filter((k) => line === k || line.startsWith(`${k} `) || line.startsWith(k))
      .sort((a, b) => b.length - a.length)[0];
    if (!key) return { code: 1, stdout: "", stderr: `unexpected: ${line}` };
    return table[key](args, opts);
  };
  return { exec, calls };
}

const mk = (over = {}, execOver = {}) => {
  const { exec, calls } = makeExec(execOver);
  const updates = [];
  const c = createCollector({
    repoRoot: "/repo",
    specsDir: "/specs",
    exec,
    now: () => NOW,
    onUpdate: (n) => updates.push(n),
    env: {},
    ...over,
  });
  return { c, calls, updates };
};

test("intervals default to spec values (github 60)", () => {
  const { c } = mk();
  assert.deepEqual(
    Object.fromEntries(Object.entries(c.sources).map(([k, v]) => [k, v.intervalSec])),
    { specs: 30, github: 60, branches: 120, bugs: 120, areas: 300, railway: 120 },
  );
});

test("github source: parsed data, uses gh api graphql, onUpdate fired", async () => {
  const { c, calls, updates } = mk();
  await c.runOnce("github");
  assert.equal(c.sources.github.ok, true);
  assert.equal(c.sources.github.at, NOW);
  assert.equal(c.sources.github.data.open.length, 3);
  assert.deepEqual(updates, ["github"]);
  assert.deepEqual(calls[0].args.slice(0, 3), ["api", "graphql", "-f"]);
  assert.match(calls[0].args[3], /^query=/);
  assert.match(calls[0].args[3], /owner: "najathakram"/);
});

test("failing run keeps last good data and sets error", async () => {
  let fail = false;
  const { c } = mk(
    {},
    {
      "gh api graphql": () =>
        fail
          ? { code: 1, stdout: "", stderr: "gh: not logged in" }
          : { code: 0, stdout: read("collector-graphql.json"), stderr: "" },
    },
  );
  await c.runOnce("github");
  fail = true;
  await c.runOnce("github");
  const s = c.sources.github;
  assert.equal(s.ok, false);
  assert.match(s.error, /not logged in/);
  assert.equal(s.data.open.length, 3);
  assert.equal(s.at, NOW);
});

test("runOnce never throws; onUpdate errors are swallowed", async () => {
  const { c } = mk(
    {
      onUpdate: () => {
        throw new Error("boom");
      },
    },
    {
      "gh api graphql": () => ({ code: 0, stdout: "{not json", stderr: "" }),
    },
  );
  await c.runOnce("github");
  assert.equal(c.sources.github.ok, false);
  assert.match(c.sources.github.error, /invalid JSON/);
});

test("branches: 14-day window, merged-PR heads and master excluded, files cached by sha", async () => {
  const { c, calls } = mk();
  await c.runOnce("github");
  await c.runOnce("branches");
  const names = c.sources.branches.data.branches.map((b) => b.branch);
  // old/ancient is >14d; fix/b233-counter-promo head predates its merge (merged PR branch)
  assert.deepEqual(names, [
    "feat/k11-20-floating-editor",
    "fix/b231-boxed-rounding",
    "feat/loose-experiment",
  ]);
  assert.deepEqual(c.sources.branches.data.branches[0].files, ["files-of-1111.ts"]);
  const diffs1 = calls.filter((x) => x.line.startsWith("git diff")).length;
  assert.equal(diffs1, 3);
  assert.equal(
    calls.find((x) => x.line.startsWith("git diff")).args[2],
    `origin/master...${"1".repeat(40)}`,
  );
  await c.runOnce("branches");
  assert.equal(calls.filter((x) => x.line.startsWith("git diff")).length, 3); // cached
});

test("branches: fetch on run 1 and every 5th only; skipped when RF_OPS_LIGHT=1", async () => {
  const { c, calls } = mk();
  for (let i = 0; i < 6; i++) await c.runOnce("branches");
  const fetches = calls.filter((x) => x.line === "git fetch origin --quiet").length;
  assert.equal(fetches, 2); // runs 1 and 6
  const light = mk({ env: { RF_OPS_LIGHT: "1" } });
  for (let i = 0; i < 6; i++) await light.c.runOnce("branches");
  assert.equal(light.calls.filter((x) => x.line.startsWith("git fetch")).length, 0);
});

test("branches: diff cap is 30 per run, remainder filled next run", async () => {
  const lines = [];
  for (let i = 0; i < 40; i++) {
    const sha = i.toString(16).padStart(40, "0");
    lines.push(`origin/feat/many-${i}\t${sha}\t2026-10-19T10:00:00+00:00`);
  }
  const { c, calls } = mk(
    {},
    {
      "git for-each-ref": () => ({ code: 0, stdout: lines.join("\n"), stderr: "" }),
    },
  );
  await c.runOnce("branches");
  assert.equal(calls.filter((x) => x.line.startsWith("git diff")).length, 30);
  assert.equal(c.sources.branches.data.branches.length, 40);
  assert.equal(c.sources.branches.data.branches.filter((b) => b.files.length === 0).length, 10);
  await c.runOnce("branches");
  assert.equal(calls.filter((x) => x.line.startsWith("git diff")).length, 40);
});

test("bugs: masked, open flag, sensitive never leaks, tree-sha cache skips re-read", async () => {
  const { c, calls } = mk();
  await c.runOnce("bugs");
  const d = c.sources.bugs.data;
  assert.deepEqual(
    d.bugs.map((b) => [b.id, b.open]),
    [
      ["B230", true],
      ["B231", true],
      ["B232", false],
      ["B233", false],
    ],
  );
  assert.deepEqual(
    d.open.map((b) => b.id),
    ["B230", "B231"],
  );
  assert.equal(d.open[0].title, "Security hardening item (details machine-local)");
  const dump = JSON.stringify(d);
  assert.ok(!dump.includes("Dispatch-modal"));
  assert.ok(!dump.includes("must not leak"));
  assert.equal(d.open[1].area, "api:invoices");
  const cat = calls.find((x) => x.line.startsWith("git cat-file"));
  assert.equal(cat.args.join(" "), "cat-file --batch");
  assert.match(cat.opts.input, /^1{40}\n/);
  const before = calls.length;
  await c.runOnce("bugs");
  assert.equal(calls.length, before + 1); // only the rev-parse
  assert.equal(c.sources.bugs.ok, true);
});

test("areas: tree built from ls-tree, cached by commit sha", async () => {
  const { c, calls } = mk();
  await c.runOnce("areas");
  const d = c.sources.areas.data;
  assert.equal(d.sha, "headsha1");
  assert.equal(d.fileCount, 3);
  assert.deepEqual(
    d.tree.domains.find((x) => x.id === "finance").areas.map((a) => a.area),
    ["api:invoices"],
  );
  assert.deepEqual(calls.find((x) => x.line.startsWith("git ls-tree -r")).args.slice(-7), [
    "apps",
    "packages",
    "scripts",
    "tools",
    ".claude",
    ".github",
    "docs",
  ]);
  const n = calls.length;
  await c.runOnce("areas");
  assert.equal(calls.length, n + 1);
});

test("railway: parsed; missing CLI reports 'railway CLI unavailable'", async () => {
  const { c } = mk();
  await c.runOnce("railway");
  assert.deepEqual(
    c.sources.railway.data.deploys.map((x) => x.service),
    ["@routeflow/api", "@routeflow/web"],
  );
  const missing = mk({}, { "railway status": () => ({ code: 127, stdout: "", stderr: "" }) });
  await missing.c.runOnce("railway");
  assert.equal(missing.c.sources.railway.ok, false);
  assert.equal(missing.c.sources.railway.error, "railway CLI unavailable");
});

test("specs: ensureClone, syncSpecs, readAllEvents, loadConfig via injected deps", async () => {
  const seen = [];
  const deps = {
    store: {
      ensureClone: async (o) => seen.push(["clone", o.dir]),
      syncSpecs: async (d) => seen.push(["sync", d]),
      readAllEvents: async (d) => (seen.push(["read", d]), [{ id: "e1" }]),
    },
    config: { specsRemote: () => "remote" },
    loadConfig: (d) => ({ dir: d }),
  };
  const { c } = mk({ deps });
  await c.runOnce("specs");
  assert.deepEqual(seen, [
    ["clone", "/specs"],
    ["sync", "/specs"],
    ["read", "/specs"],
  ]);
  assert.deepEqual(c.sources.specs.data, { events: [{ id: "e1" }], config: { dir: "/specs" } });
  const bad = mk({
    deps: {
      ...deps,
      store: {
        syncSpecs: async () => {
          throw new Error("offline");
        },
        readAllEvents: async () => [],
      },
    },
  });
  await bad.c.runOnce("specs");
  assert.equal(bad.c.sources.specs.ok, false);
  assert.equal(bad.c.sources.specs.error, "offline");
});

test("start/stop: timers run each source once immediately and stop cleanly", async () => {
  const { c, updates } = mk();
  c.start();
  await new Promise((r) => setTimeout(r, 200));
  c.stop();
  assert.ok(updates.includes("github") && updates.includes("railway") && updates.includes("bugs"));
});

test("bugs: falls back to per-blob cat-file when exec ignores stdin", async () => {
  const byBlob = Object.fromEntries(
    BUG_FILES.map((f, i) => [String(i + 1).repeat(40), bugText(f)]),
  );
  const { c, calls } = mk(
    {},
    {
      "git cat-file --batch": () => ({ code: 0, stdout: "", stderr: "" }),
      "git cat-file blob": (args) => ({ code: 0, stdout: byBlob[args[2]], stderr: "" }),
    },
  );
  await c.runOnce("bugs");
  assert.equal(c.sources.bugs.ok, true);
  assert.deepEqual(
    c.sources.bugs.data.open.map((b) => b.id),
    ["B230", "B231"],
  );
  assert.equal(calls.filter((x) => x.line.startsWith("git cat-file blob")).length, 4);
});

// ---------- cloud mode (P6): GitHub + Railway by API, read-only git ----------

const TOKEN = "github_pat_TESTTOKEN0123456789";
const RW_TOKEN = "railway-project-token-0123";
const okJson = (obj) => ({ ok: true, status: 200, text: async () => JSON.stringify(obj) });

const RAILWAY_PROJECT = {
  data: {
    project: {
      services: {
        edges: [
          {
            node: {
              name: "@routeflow/api",
              serviceInstances: {
                edges: [
                  {
                    node: {
                      environmentId: "env-staging",
                      latestDeployment: {
                        status: "FAILED",
                        createdAt: "2026-10-01T00:00:00Z",
                        meta: { commitHash: "0000000" },
                      },
                    },
                  },
                  {
                    node: {
                      environmentId: "env-prod",
                      latestDeployment: {
                        status: "SUCCESS",
                        createdAt: "2026-10-19T09:05:00.000Z",
                        meta: { commitHash: "a".repeat(40) },
                      },
                    },
                  },
                ],
              },
            },
          },
          {
            node: {
              name: "@routeflow/web",
              serviceInstances: {
                edges: [
                  {
                    node: {
                      environmentId: "env-prod",
                      latestDeployment: {
                        status: "BUILDING",
                        createdAt: "2026-10-19T09:06:00.000Z",
                        meta: { commitHash: "a".repeat(40) },
                      },
                    },
                  },
                ],
              },
            },
          },
          {
            node: {
              name: "postgres",
              serviceInstances: {
                edges: [{ node: { environmentId: "env-prod", latestDeployment: null } }],
              },
            },
          },
          { node: { name: "@routeflow/noprod", serviceInstances: { edges: [] } } },
        ],
      },
    },
  },
};

function fakeFetch(handlers = {}) {
  const calls = [];
  const f = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ url, init, body });
    if (url === "https://api.github.com/graphql") {
      return (handlers.github ?? (() => okJson(JSON.parse(read("collector-graphql.json")))))(
        init,
        body,
      );
    }
    if (url === "https://backboard.railway.com/graphql/v2") {
      if (/projectToken/.test(body.query)) {
        return okJson({
          data: { projectToken: { projectId: "proj-1", environmentId: "env-prod" } },
        });
      }
      return okJson(RAILWAY_PROJECT);
    }
    return { ok: false, status: 404, text: async () => "no" };
  };
  return { f, calls };
}

test("github source by API when GITHUB_TOKEN is set: fetch, no gh", async () => {
  const { f, calls: fc } = fakeFetch();
  const { c, calls } = mk({ env: { GITHUB_TOKEN: TOKEN }, fetch: f });
  await c.runOnce("github");
  assert.equal(c.sources.github.ok, true);
  assert.equal(c.sources.github.data.open.length, 3);
  assert.equal(calls.filter((x) => x.cmd === "gh").length, 0);
  assert.equal(fc.length, 1);
  assert.equal(fc[0].url, "https://api.github.com/graphql");
  assert.equal(fc[0].init.method, "POST");
  assert.equal(fc[0].init.headers.authorization, `bearer ${TOKEN}`);
  assert.equal(fc[0].init.headers["content-type"], "application/json");
  assert.equal(fc[0].init.headers["user-agent"], "routeflow-ops-monitor");
  assert.equal(fc[0].body.query, GRAPHQL_QUERY);
});

test("github by API: HTTP and GraphQL errors fail the source without leaking the token", async () => {
  const bad = fakeFetch({
    github: () => ({ ok: false, status: 401, text: async () => `Bad credentials ${TOKEN}` }),
  });
  const a = mk({ env: { GITHUB_TOKEN: TOKEN }, fetch: bad.f });
  await a.c.runOnce("github");
  assert.equal(a.c.sources.github.ok, false);
  assert.match(a.c.sources.github.error, /401/);
  assert.ok(!a.c.sources.github.error.includes(TOKEN));
  const gql = fakeFetch({
    github: () => okJson({ errors: [{ message: "Resource not accessible" }] }),
  });
  const b = mk({ env: { GITHUB_TOKEN: TOKEN }, fetch: gql.f });
  await b.c.runOnce("github");
  assert.match(b.c.sources.github.error, /Resource not accessible/);
  const thrown = mk({
    env: { GITHUB_TOKEN: TOKEN },
    fetch: async () => {
      throw new Error(`socket hang up for ${TOKEN}`);
    },
  });
  await thrown.c.runOnce("github");
  assert.equal(thrown.c.sources.github.ok, false);
  assert.ok(!thrown.c.sources.github.error.includes(TOKEN));
});

test("GraphQL query asks for deployments; parseGithubDeployments: source github, newest per service", () => {
  assert.match(
    GRAPHQL_QUERY,
    /deployments\(first: 10, orderBy: \{field: CREATED_AT, direction: DESC\}\) \{\s*nodes \{\s*environment commitOid createdAt latestStatus \{ state createdAt \}/,
  );
  const nodes = [
    {
      environment: "routeflow / @routeflow/api",
      commitOid: "b".repeat(40),
      createdAt: "2026-10-19T10:00:00Z",
      latestStatus: { state: "SUCCESS", createdAt: "2026-10-19T10:02:00Z" },
    },
    {
      environment: "routeflow / @routeflow/api",
      commitOid: "c".repeat(40),
      createdAt: "2026-10-18T10:00:00Z",
      latestStatus: { state: "FAILURE", createdAt: "2026-10-18T10:02:00Z" },
    },
    {
      environment: "production",
      commitOid: "d".repeat(40),
      createdAt: "2026-10-17T10:00:00Z",
      latestStatus: null,
    },
    null,
  ];
  assert.deepEqual(parseGithubDeployments(nodes), [
    {
      service: "@routeflow/api",
      status: "SUCCESS",
      sha: "b".repeat(40),
      createdAt: "2026-10-19T10:02:00Z",
      source: "github",
    },
    {
      service: "production",
      status: null,
      sha: "d".repeat(40),
      createdAt: "2026-10-17T10:00:00Z",
      source: "github",
    },
  ]);
  const r = parsePrGraphql({ data: { repository: { deployments: { nodes } } } });
  assert.equal(r.deploys.length, 2);
});

test("mergeDeploys: Railway status wins, GitHub's is kept; unmatched entries stay", () => {
  const gh = [
    {
      service: "@routeflow/api",
      status: "SUCCESS",
      sha: "b".repeat(40),
      createdAt: "t1",
      source: "github",
    },
    {
      service: "production",
      status: "SUCCESS",
      sha: "d".repeat(40),
      createdAt: "t0",
      source: "github",
    },
  ];
  const rw = [
    {
      service: "@routeflow/api",
      status: "BUILDING",
      sha: "e".repeat(40),
      createdAt: "t2",
      source: "railway",
    },
    {
      service: "@routeflow/web",
      status: "SUCCESS",
      sha: "e".repeat(40),
      createdAt: "t2",
      source: "railway",
    },
  ];
  const m = mergeDeploys(gh, rw);
  assert.deepEqual(
    m.find((d) => d.service === "@routeflow/api"),
    {
      service: "@routeflow/api",
      status: "BUILDING",
      sha: "e".repeat(40),
      createdAt: "t2",
      source: "railway",
      github: { status: "SUCCESS", sha: "b".repeat(40), createdAt: "t1" },
    },
  );
  assert.equal(m.find((d) => d.service === "@routeflow/web").source, "railway");
  assert.equal(m.find((d) => d.service === "production").source, "github");
  assert.equal(m.length, 3);
  assert.deepEqual(mergeDeploys(gh, []), gh);
  assert.deepEqual(mergeDeploys(undefined, undefined), []);
});

test("railway by API: projectToken then project, production env of the token only", async () => {
  const { f, calls: fc } = fakeFetch();
  const { c, calls } = mk({ env: { RAILWAY_API_TOKEN: RW_TOKEN }, fetch: f });
  await c.runOnce("railway");
  assert.equal(c.sources.railway.ok, true, c.sources.railway.error);
  assert.deepEqual(c.sources.railway.data.deploys, [
    {
      service: "@routeflow/api",
      status: "SUCCESS",
      sha: "a".repeat(40),
      createdAt: "2026-10-19T09:05:00.000Z",
      source: "railway",
    },
    {
      service: "@routeflow/web",
      status: "BUILDING",
      sha: "a".repeat(40),
      createdAt: "2026-10-19T09:06:00.000Z",
      source: "railway",
    },
  ]);
  assert.equal(calls.filter((x) => x.cmd === "railway").length, 0);
  assert.equal(fc.length, 2);
  for (const call of fc) {
    assert.equal(call.url, "https://backboard.railway.com/graphql/v2");
    assert.equal(call.init.method, "POST");
    assert.equal(call.init.headers["Project-Access-Token"], RW_TOKEN);
    assert.equal(call.init.headers.authorization, undefined);
  }
  assert.equal(fc[0].body.query, RAILWAY_QUERIES.projectToken);
  assert.equal(fc[1].body.query, RAILWAY_QUERIES.project);
  assert.deepEqual(fc[1].body.variables, { id: "proj-1" });
  assert.deepEqual(
    parseRailwayProject(RAILWAY_PROJECT, "env-prod").map((d) => d.service),
    ["@routeflow/api", "@routeflow/web"],
  );
  assert.deepEqual(parseRailwayProject({}, "env-prod"), []);
});

test("railway by API: errors fail the source without the token", async () => {
  const f = async () => ({ ok: false, status: 403, text: async () => `denied ${RW_TOKEN}` });
  const { c } = mk({ env: { RAILWAY_API_TOKEN: RW_TOKEN }, fetch: f });
  await c.runOnce("railway");
  assert.equal(c.sources.railway.ok, false);
  assert.match(c.sources.railway.error, /403/);
  assert.ok(!c.sources.railway.error.includes(RW_TOKEN));
});

test("Railway documents are read-only: queries only, runtime guard refuses mutations", async () => {
  assert.ok(Object.keys(RAILWAY_QUERIES).length >= 2);
  for (const [name, doc] of Object.entries(RAILWAY_QUERIES)) {
    assert.match(doc, /^\s*query\b/, name);
    assert.doesNotMatch(doc, /mutation|subscription/i, name);
  }
  let called = 0;
  const f = async () => (called++, okJson({ data: {} }));
  for (const doc of [
    'mutation { serviceDelete(id: "x") }',
    "  Mutation { a }",
    "query { a } mutation { b }",
    "subscription { a }",
    "{ a }",
    "",
  ]) {
    await assert.rejects(
      () => railwayRequest({ fetch: f, token: RW_TOKEN, doc }),
      /read-only|query/i,
      doc,
    );
  }
  assert.equal(called, 0, "refused before any request");
  const ok = await railwayRequest({ fetch: f, token: RW_TOKEN, doc: RAILWAY_QUERIES.projectToken });
  assert.deepEqual(ok, {});
  assert.equal(called, 1);
});

test("cloud collector: cloud intervals, fetch every run, specs by fetch+reset, never push/commit/rebase", async () => {
  assert.deepEqual(CLOUD_INTERVALS, {
    github: 120,
    specs: 120,
    branches: 300,
    bugs: 300,
    areas: 600,
    railway: 300,
  });
  const { f } = fakeFetch();
  const store = {
    readAllEvents: async () => [{ id: "e1" }],
    syncSpecs: async () => assert.fail("syncSpecs must not run in cloud"),
    ensureClone: async () => assert.fail("ensureClone must not run in cloud"),
  };
  const { c, calls } = mk(
    {
      cloud: true,
      env: { GITHUB_TOKEN: TOKEN, RAILWAY_API_TOKEN: RW_TOKEN },
      fetch: f,
      deps: { store, loadConfig: () => ({ lanes: [] }), config: {} },
    },
    {
      "git symbolic-ref": () => ({ code: 0, stdout: "origin/main\n", stderr: "" }),
      "git reset": () => ({ code: 0, stdout: "", stderr: "" }),
    },
  );
  assert.deepEqual(
    Object.fromEntries(Object.entries(c.sources).map(([k, v]) => [k, v.intervalSec])),
    CLOUD_INTERVALS,
  );
  for (const name of ["specs", "github", "branches", "bugs", "areas", "railway"]) {
    await c.runOnce(name);
    assert.equal(c.sources[name].ok, true, `${name}: ${c.sources[name].error}`);
  }
  await c.runOnce("branches");
  assert.equal(
    calls.filter((x) => x.line === "git fetch origin --quiet").length,
    2,
    "fetch on every run",
  );
  assert.ok(
    calls.some((x) => x.line.startsWith("git reset --hard")),
    "specs reset to origin",
  );
  assert.ok(calls.some((x) => x.line.startsWith("git fetch") && x.opts.cwd === "/specs"));
  for (const x of calls) {
    assert.doesNotMatch(x.args.join(" "), /\b(push|commit|rebase|pull|merge)\b/, x.line);
  }
  assert.equal(calls.filter((x) => x.cmd === "gh" || x.cmd === "railway").length, 0);
});

test("cloud collector exec is guarded: a write would throw before reaching exec", async () => {
  const { exec, calls } = makeExec();
  const c = createCollector({
    repoRoot: "/repo",
    specsDir: "/specs",
    exec,
    now: () => NOW,
    env: {},
    cloud: true,
  });
  assert.ok(c.guardedExec, "exposes the guarded exec for inspection");
  await assert.rejects(() => c.guardedExec("git", ["push", "origin", "x"], {}), /read-only/);
  await assert.rejects(() => c.guardedExec("git", ["commit", "-m", "x"], {}), /read-only/);
  await assert.rejects(() => c.guardedExec("git", ["rebase", "origin/main"], {}), /read-only/);
  assert.equal(calls.length, 0);
});
