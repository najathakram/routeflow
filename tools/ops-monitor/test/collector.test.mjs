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
    body: "",
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
    runs: [],
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
  assert.deepEqual(c.sources.specs.data.events, [{ id: "e1" }]);
  assert.deepEqual(c.sources.specs.data.config, { dir: "/specs" });
  // the extras ride along; "/specs" does not exist here, so each piece reports its error
  assert.deepEqual(c.sources.specs.data.incidents, []);
  assert.equal(c.sources.specs.data.ownerQueueRows, null);
  assert.ok(c.sources.specs.data.extrasErrors.length >= 2);
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

test("specs: the sync runs under tryWithSpecsLock; when the lock is busy it is skipped and events are still read", async () => {
  const seen = [];
  const mkDeps = (busy) => ({
    store: {
      tryWithSpecsLock: async (fn) => {
        seen.push(busy ? "lock-busy" : "lock-free");
        if (busy) return { ran: false };
        return { ran: true, value: await fn() };
      },
      ensureClone: async (o) => seen.push(["clone", o.dir]),
      syncSpecs: async (d) => seen.push(["sync", d]),
      readAllEvents: async (d) => (seen.push(["read", d]), [{ id: "e1" }]),
    },
    config: { specsRemote: () => "remote" },
    loadConfig: (d) => ({ dir: d }),
  });
  const busy = mk({ deps: mkDeps(true) });
  await busy.c.runOnce("specs");
  assert.deepEqual(seen, ["lock-busy", ["read", "/specs"]]);
  assert.equal(busy.c.sources.specs.ok, true, busy.c.sources.specs.error);
  assert.deepEqual(busy.c.sources.specs.data.events, [{ id: "e1" }]);
  seen.length = 0;
  const free = mk({ deps: mkDeps(false) });
  await free.c.runOnce("specs");
  assert.deepEqual(seen, [
    "lock-free",
    ["clone", "/specs"],
    ["sync", "/specs"],
    ["read", "/specs"],
  ]);
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

// =====================================================================================
// Accuracy round, package A2. Fixtures are a2-* (acme placeholders shaped like real data).
// New exports are read through the COL namespace so each test fails on its own.
// =====================================================================================
import * as COL from "../lib/collector.mjs";
import { mkdtempSync, mkdirSync, cpSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const A2 = JSON.parse(read("a2-graphql.json"));
const bugFile = (id) => readFileSync(join(FIX, "a2-bugs", `${id}.md`), "utf8");
const ledgerFile = (f) => readFileSync(join(FIX, "a2-ledger", f), "utf8");
const EMPTY_BLOB = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";

test("A2 GraphQL: asks for PR bodies and check contexts (CheckRun + StatusContext) for open PRs and master", () => {
  assert.match(COL.GRAPHQL_QUERY, /body/);
  assert.match(COL.GRAPHQL_QUERY, /contexts\(first: 50\)/);
  assert.match(COL.GRAPHQL_QUERY, /\.\.\. on CheckRun \{ name conclusion status \}/);
  assert.match(COL.GRAPHQL_QUERY, /\.\.\. on StatusContext \{ context state \}/);
  // master and the open PRs both carry contexts
  assert.equal((COL.GRAPHQL_QUERY.match(/contexts\(first: 50\)/g) ?? []).length, 2);
});

test("A2 parsePrGraphql: bodies (truncated to 4000, null -> empty) and per-name check runs", () => {
  const r = COL.parsePrGraphql(A2);
  assert.equal(r.open[0].body, "Fixes B9001\n\nAlso closes row 700.");
  assert.equal(r.open[2].body, "");
  assert.equal(r.open[3].body.length, 4000);
  assert.equal(r.merged[0].body, "Fixes B9004");
  assert.equal(r.merged[0].base, "master");
  // one run per name: a skipped duplicate never hides the real result
  assert.deepEqual(r.master.runs, [
    { name: "Verify", state: "success" },
    { name: "E2E gate (freshness)", state: "success" },
    { name: "E2E (Playwright)", state: "pending" },
    { name: "Replay migrations on a fresh database", state: "skipped" },
    { name: "ci/lint", state: "failure" },
  ]);
  assert.deepEqual(r.open[0].runs, [
    { name: "Verify", state: "skipped" },
    { name: "E2E gate (freshness)", state: "skipped" },
    { name: "Replay migrations on a fresh database", state: "failure" },
    { name: "CodeQL", state: "success" },
  ]);
  assert.deepEqual(
    r.open[1].runs.map((x) => x.state),
    ["success", "pending", "failure", "pending"],
  );
  assert.deepEqual(r.open[2].runs, []); // no rollup at all
  assert.equal(r.master.checks, "PENDING"); // the rollup state is still carried
});

test("A2 classifyCheck: default gates are /verify/i and /e2e/i; config.ciGates replaces them", () => {
  assert.equal(COL.classifyCheck("Verify"), "gate");
  assert.equal(COL.classifyCheck("E2E (Playwright)", {}), "gate");
  assert.equal(COL.classifyCheck("E2E gate (freshness)", {}), "gate");
  assert.equal(COL.classifyCheck("Replay migrations on a fresh database", {}), "probe");
  assert.equal(COL.classifyCheck("CodeQL", {}), "probe");
  assert.equal(
    COL.classifyCheck("Replay migrations on a fresh database", { ciGates: ["replay"] }),
    "gate",
  );
  assert.equal(COL.classifyCheck("Verify", { ciGates: ["/replay/i"] }), "probe");
  assert.equal(COL.classifyCheck("Verify", { ciGates: ["(bad"] }), "probe"); // bad pattern ignored
});

test("A2 summarizeChecks: gate vs probes, never 'checks fail' for a probe-only failure", () => {
  const r = COL.parsePrGraphql(A2);
  // master: Verify success, E2E gate success, Playwright pending -> gate pending; lint probe failing
  assert.deepEqual(COL.summarizeChecks(r.master.runs, {}), {
    gate: "pending",
    probesFailing: ["ci/lint"],
    runs: [
      { name: "Verify", kind: "gate", state: "success" },
      { name: "E2E gate (freshness)", kind: "gate", state: "success" },
      { name: "E2E (Playwright)", kind: "gate", state: "pending" },
      { name: "Replay migrations on a fresh database", kind: "probe", state: "skipped" },
      { name: "ci/lint", kind: "probe", state: "failure" },
    ],
  });
  // PR 9001 (private repo): the gate runs were skipped, one probe failed -> gate skipped, probe named
  const pr1 = COL.summarizeChecks(r.open[0].runs, {});
  assert.equal(pr1.gate, "skipped");
  assert.deepEqual(pr1.probesFailing, ["Replay migrations on a fresh database"]);
  // a probe-only failure does NOT fail the gate
  assert.equal(
    COL.summarizeChecks([
      { name: "Verify", state: "success" },
      { name: "x", state: "failure" },
    ]).gate,
    "success",
  );
  // a failing gate fails it
  assert.equal(
    COL.summarizeChecks([
      { name: "Verify", state: "failure" },
      { name: "E2E", state: "success" },
    ]).gate,
    "failure",
  );
  assert.equal(COL.summarizeChecks([]).gate, "none");
  assert.equal(COL.summarizeChecks([{ name: "only-a-probe", state: "success" }]).gate, "none");
  // custom gates
  assert.equal(
    COL.summarizeChecks([{ name: "ci/lint", state: "failure" }], { ciGates: ["lint"] }).gate,
    "failure",
  );
});

test("A2 check states: CheckRun status/conclusion and StatusContext state map to success|failure|pending|skipped|cancelled", () => {
  const n = COL.normalizeContext;
  const cr = (status, conclusion) => ({ __typename: "CheckRun", name: "a", status, conclusion });
  assert.deepEqual(n(cr("COMPLETED", "SUCCESS")), { name: "a", state: "success" });
  assert.equal(n(cr("COMPLETED", "NEUTRAL")).state, "success");
  assert.equal(n(cr("COMPLETED", "SKIPPED")).state, "skipped");
  assert.equal(n(cr("COMPLETED", "CANCELLED")).state, "cancelled");
  for (const c of ["FAILURE", "TIMED_OUT", "STARTUP_FAILURE"])
    assert.equal(n(cr("COMPLETED", c)).state, "failure", c);
  for (const s of ["IN_PROGRESS", "QUEUED", "WAITING", "PENDING", "REQUESTED"])
    assert.equal(n(cr(s, null)).state, "pending", s);
  assert.equal(
    n({ __typename: "StatusContext", context: "ci/x", state: "SUCCESS" }).state,
    "success",
  );
  assert.equal(
    n({ __typename: "StatusContext", context: "ci/x", state: "ERROR" }).state,
    "failure",
  );
  assert.equal(
    n({ __typename: "StatusContext", context: "ci/x", state: "EXPECTED" }).state,
    "pending",
  );
  assert.equal(n(null), null);
  assert.equal(n({ __typename: "CheckRun" }), null); // no name
});

test("A2 isOpenBug: the ledger state wins over the front matter; proven states are closed", () => {
  // regressed in the ledger although the front matter was closed -> open again
  assert.equal(
    COL.isOpenBug({ closed: "2026-10-01", state: "done", ledgerState: "regressed" }),
    true,
  );
  // front matter says queued, the ledger says done -> closed
  assert.equal(COL.isOpenBug({ closed: "", state: "queued", ledgerState: "done" }), false);
  for (const s of ["proven", "proven-pending-deploy", "verified", "live"])
    assert.equal(COL.isOpenBug({ closed: "", state: "queued", ledgerState: s }), false, s);
  assert.equal(COL.isOpenBug({ closed: "", state: "uncampaigned" }), true);
  assert.equal(COL.isOpenBug({ closed: "", state: "queued", ledgerState: "queued" }), true);
});

test("A2 parseLedgerFiles: latest row per id wins by file order; blank and bad lines skipped", () => {
  const rows = COL.parseLedgerFiles([
    { path: ".claude/campaign/status/F02.jsonl", text: ledgerFile("F02.jsonl") },
    { path: ".claude/campaign/status/F01.jsonl", text: ledgerFile("F01.jsonl") + "not json\n" },
    {
      path: ".claude/campaign/status/F10.jsonl",
      text: JSON.stringify({ id: "B9006", state: "done", batch: "F10" }) + "\n",
    },
  ]);
  assert.equal(rows.get("B9001").state, "proven"); // F02 after F01
  assert.equal(rows.get("B9001").batch, "F02");
  assert.equal(rows.get("B9005").state, "regressed");
  assert.equal(rows.get("B9006").state, "done"); // F10 sorts after F02 numerically
  assert.equal(rows.size, 4);
});

test("A2 git-log parsers: filedAt takes the oldest add per bug; lane handoffs the newest per file", () => {
  const filed = COL.parseBugFiledAt(read("a2-gitlog-bugs.txt"));
  assert.deepEqual(Object.keys(filed).sort(), ["B9002", "B9003", "B9004"]);
  assert.equal(filed.B9002, "2026-10-10T12:00:00.000Z"); // added twice: the first filing
  assert.equal(filed.B9003, "2026-10-18T17:00:00.000Z");
  assert.equal(filed.B9004, "2026-10-15T13:30:00.000Z");
  const ho = COL.parseHandoffLog(read("a2-gitlog-handoff.txt"));
  assert.deepEqual(
    ho.map((h) => [h.file, h.at]),
    [
      ["ops-monitor-owner-secret-steps.md", "2026-10-19T05:13:27.000Z"],
      ["macmini-lane-2026-10-18.md", "2026-10-19T05:12:27.000Z"],
      ["macmini-inventory-2026-10-19.md", "2026-10-19T04:36:24.000Z"],
      ["pc-lane-2026-10-18.md", "2026-10-19T02:23:42.000Z"],
    ],
  );
});

// ---------- bugs source: ledger + filedAt ----------

function a2BugExec({ logOut, calls = [] } = {}) {
  const ids = ["B9001", "B9002", "B9003", "B9004", "B9005", "B9006", "B9007"];
  const bugSha = Object.fromEntries(ids.map((id, i) => [id, `b${i + 1}`.repeat(20)]));
  const ledgerNames = ["F00.jsonl", "F01.jsonl", "F02.jsonl"];
  const ledgerSha = {
    "F00.jsonl": EMPTY_BLOB,
    "F01.jsonl": "f1".repeat(20),
    "F02.jsonl": "f2".repeat(20),
  };
  const blobs = new Map();
  for (const id of ids) blobs.set(bugSha[id], bugFile(id));
  for (const f of ledgerNames) blobs.set(ledgerSha[f], ledgerFile(f));
  const exec = async (cmd, args, opts) => {
    const line = `${cmd} ${args.join(" ")}`;
    calls.push({ line, args, opts });
    if (line.startsWith("git rev-parse origin/master:.claude/campaign/bugs"))
      return { code: 0, stdout: "bugtree1\nledgertree1\n", stderr: "" };
    if (line === "git ls-tree origin/master .claude/campaign/bugs/")
      return {
        code: 0,
        stdout: ids
          .map((id) => `100644 blob ${bugSha[id]}\t.claude/campaign/bugs/${id}.md`)
          .join("\n"),
        stderr: "",
      };
    if (line === "git ls-tree origin/master .claude/campaign/status/")
      return {
        code: 0,
        stdout: ledgerNames
          .map((f) => `100644 blob ${ledgerSha[f]}\t.claude/campaign/status/${f}`)
          .join("\n"),
        stderr: "",
      };
    if (line === "git cat-file --batch") {
      const want = String(opts.input).split("\n").filter(Boolean);
      const out = want.map(
        (sha) => `${sha} blob ${Buffer.byteLength(blobs.get(sha))}\n${blobs.get(sha)}\n`,
      );
      return { code: 0, stdout: out.join(""), stderr: "" };
    }
    if (line.startsWith("git log "))
      return logOut === null
        ? { code: 128, stdout: "", stderr: "bad" }
        : { code: 0, stdout: logOut ?? read("a2-gitlog-bugs.txt"), stderr: "" };
    return { code: 1, stdout: "", stderr: `unexpected: ${line}` };
  };
  return { exec, calls };
}

test("A2 bugs source: ledger rows (latest per id), ledgerState wins, filedAt from ONE git log, one cat-file", async () => {
  const { exec, calls } = a2BugExec();
  const c = createCollector({
    repoRoot: "/repo",
    specsDir: "/specs",
    exec,
    now: () => NOW,
    env: {},
  });
  await c.runOnce("bugs");
  assert.equal(c.sources.bugs.ok, true, c.sources.bugs.error);
  const d = c.sources.bugs.data;
  const by = Object.fromEntries(d.bugs.map((b) => [b.id, b]));
  assert.equal(by.B9001.ledgerState, "proven"); // F02 row beats F01; closed
  assert.equal(by.B9001.open, false);
  assert.equal(by.B9005.state, "done"); // front matter closed ...
  assert.equal(by.B9005.ledgerState, "regressed"); // ... the ledger reopens it
  assert.equal(by.B9005.open, true);
  assert.equal(by.B9003.ledgerState, null); // no ledger row: front matter decides
  assert.equal(by.B9003.open, true);
  assert.equal(by.B9007.open, false);
  assert.equal(by.B9002.open, false); // ledger: done
  assert.deepEqual(
    d.open.map((b) => b.id),
    ["B9003", "B9004", "B9005", "B9006"],
  );
  assert.equal(by.B9006.batch, "F02");
  assert.equal(by.B9002.filedAt, "2026-10-10T12:00:00.000Z");
  assert.equal(by.B9004.filedAt, "2026-10-15T13:30:00.000Z");
  assert.equal(by.B9006.filedAt, null); // older than the 30-day window
  const logs = calls.filter((x) => x.line.startsWith("git log "));
  assert.equal(logs.length, 1);
  assert.equal(
    logs[0].line,
    "git log --since=30.days --diff-filter=A --format=%cI --name-only origin/master -- .claude/campaign/bugs",
  );
  assert.equal(calls.filter((x) => x.line === "git cat-file --batch").length, 1);
  // the ledger tree is part of the cache key: unchanged trees -> only the rev-parse
  const before = calls.length;
  await c.runOnce("bugs");
  assert.equal(calls.length, before + 1);
});

test("A2 bugs source: a failing git log keeps the bugs and reports filedAtError (no silent drop)", async () => {
  const { exec } = a2BugExec({ logOut: null });
  const c = createCollector({
    repoRoot: "/repo",
    specsDir: "/specs",
    exec,
    now: () => NOW,
    env: {},
  });
  await c.runOnce("bugs");
  assert.equal(c.sources.bugs.ok, true);
  assert.match(c.sources.bugs.data.filedAtError, /git log/);
  assert.equal(c.sources.bugs.data.bugs.find((b) => b.id === "B9004").filedAt, null);
});

// ---------- branches source: pending registry ----------

test("A2 branches: bug files ADDED on unmerged branches are read via git cat-file (sha:path), masked, cached, capped at 50", async () => {
  const calls = [];
  const sha1 = "1".repeat(40);
  const sha2 = "2".repeat(40);
  const exec = async (cmd, args, opts) => {
    const line = `${cmd} ${args.join(" ")}`;
    calls.push({ line, args, opts });
    if (line.startsWith("git fetch")) return { code: 0, stdout: "", stderr: "" };
    if (line.startsWith("git for-each-ref"))
      return {
        code: 0,
        stdout: `origin/feat/acme-intake\t${sha1}\t2026-10-19T10:00:00+00:00\norigin/feat/acme-other\t${sha2}\t2026-10-19T09:00:00+00:00`,
        stderr: "",
      };
    if (line.startsWith("git diff"))
      return {
        code: 0,
        stdout: args[2].endsWith(sha1)
          ? "apps/api/src/x.ts\n.claude/campaign/bugs/B9100.md\n.claude/campaign/bugs/B9101.md\n.claude/campaign/bugs/notes.txt\n"
          : "apps/web/y.tsx\n",
        stderr: "",
      };
    if (line === "git cat-file --batch") {
      const specs = String(opts.input).split("\n").filter(Boolean);
      const out = specs.map((s) => {
        const id = /(B\d+)\.md$/.exec(s)[1];
        const t = bugFile(id);
        return `${"9".repeat(40)} blob ${Buffer.byteLength(t)}\n${t}\n`;
      });
      return { code: 0, stdout: out.join(""), stderr: "" };
    }
    return { code: 1, stdout: "", stderr: `unexpected: ${line}` };
  };
  const c = createCollector({
    repoRoot: "/repo",
    specsDir: "/specs",
    exec,
    now: () => NOW,
    env: {},
  });
  await c.runOnce("branches");
  assert.equal(c.sources.branches.ok, true, c.sources.branches.error);
  const cat = calls.filter((x) => x.line === "git cat-file --batch");
  assert.equal(cat.length, 1);
  assert.equal(
    cat[0].opts.input,
    `${sha1}:.claude/campaign/bugs/B9100.md\n${sha1}:.claude/campaign/bugs/B9101.md\n`,
  );
  const p = c.sources.branches.data.pendingBugs;
  assert.deepEqual(
    p.map((b) => [b.id, b.branch, b.sensitive]),
    [
      ["B9100", "feat/acme-intake", false],
      ["B9101", "feat/acme-intake", true],
    ],
  );
  assert.equal(p[0].title, "Acme pending widget bug");
  assert.equal(p[0].severity, "high");
  assert.equal(p[0].open, true);
  const dump = JSON.stringify(c.sources.branches.data);
  assert.ok(
    !dump.includes("secret detail must not leak"),
    "sensitive title never leaves the collector",
  );
  await c.runOnce("branches");
  assert.equal(
    calls.filter((x) => x.line === "git cat-file --batch").length,
    1,
    "cached by sha:path",
  );
});

test("A2 branches: at most 50 pending bug files are read per run", async () => {
  const sha = "3".repeat(40);
  let asked = 0;
  const files = Array.from({ length: 70 }, (_, i) => `.claude/campaign/bugs/B${9200 + i}.md`);
  const exec = async (cmd, args, opts) => {
    const line = `${cmd} ${args.join(" ")}`;
    if (line.startsWith("git fetch")) return { code: 0, stdout: "", stderr: "" };
    if (line.startsWith("git for-each-ref"))
      return {
        code: 0,
        stdout: `origin/feat/acme-bulk\t${sha}\t2026-10-19T10:00:00+00:00`,
        stderr: "",
      };
    if (line.startsWith("git diff")) return { code: 0, stdout: files.join("\n"), stderr: "" };
    if (line === "git cat-file --batch") {
      const specs = String(opts.input).split("\n").filter(Boolean);
      asked = specs.length;
      return { code: 0, stdout: specs.map((s) => `${s} missing\n`).join(""), stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "x" };
  };
  const c = createCollector({
    repoRoot: "/repo",
    specsDir: "/specs",
    exec,
    now: () => NOW,
    env: {},
  });
  await c.runOnce("branches");
  assert.equal(asked, 50);
  assert.deepEqual(c.sources.branches.data.pendingBugs, []);
});

// ---------- specs extras: incidents, owner queue rows, lane handoff times ----------

test("A2 parseIncidents: title from '# ', Status word (default open), derived INC-MMDDx ids, README skipped", () => {
  const dir = join(FIX, "a2-incidents");
  const files = readdirSync(dir).map((f) => ({
    file: f,
    text: readFileSync(join(dir, f), "utf8"),
  }));
  const inc = COL.parseIncidents(files);
  assert.deepEqual(
    inc.map((i) => [i.id, i.status, i.date]),
    [
      ["INC-1015a", "open", "2026-10-15"],
      ["INC-1015b", "closed", "2026-10-15"],
      ["INC-1015c", "mitigated", "2026-10-15"],
      ["INC-1016a", "unknown", "2026-10-16"], // no Status line: unknown (never silently open)
      ["INC-1017a", "suspected", "2026-10-17"], // suspected / unverified keep their word
    ],
  );
  assert.equal(inc[0].title, "Acme catch-up billing stuck, awaiting the in-app Pay (2026-10-15)");
  assert.equal(inc[2].file, "2026-10-15-acme-tier-bug.md");
});

test("A2 parseOwnerQueueRows: key, status word, decision file, as-of date; only 'Recommended' tables", () => {
  const rows = COL.parseOwnerQueueRows(read("a2-owner-queue.md"));
  const by = Object.fromEntries(rows.map((r) => [r.key, r]));
  assert.deepEqual(
    Object.keys(by).sort(),
    ["1", "2", "3", "4", "5", "6", "7", "N1", "N2", "N3", "N4"].sort(),
  );
  assert.deepEqual(by.N1, {
    key: "N1",
    statusWord: "ANSWERED",
    decisionFile: "D-2026-10-18-acme-say-no-sitting.md",
    asOf: "10-18",
  });
  assert.equal(by.N2.statusWord, "DEFAULT IN EFFECT");
  assert.equal(by.N2.decisionFile, null);
  assert.equal(by.N3.statusWord, null); // "SAFE TIER APPROVED" is not a status word
  assert.equal(by.N3.decisionFile, "D-2026-10-19-acme-safe-tier.md");
  assert.equal(by.N4.statusWord, "OPEN");
  assert.equal(by["1"].statusWord, "ANSWERED");
  assert.equal(by["1"].decisionFile, null); // "STATUS 10-15 block" is not a decision file
  assert.equal(by["2"].statusWord, "DONE");
  assert.equal(by["3"].statusWord, "STANDING YES");
  assert.equal(by["4"].statusWord, "BOOKED");
  assert.equal(by["4"].decisionFile, "D-2026-10-18-acme-say-no-sitting.md");
  assert.equal(by["5"].statusWord, "CHECK");
  assert.equal(by["7"].statusWord, null);
  assert.equal(by["7"].decisionFile, null);
  // the step table (no Recommended column) contributes nothing
  assert.equal(rows.length, 11);
});

test("A2 readSpecsExtras: reads incidents/ and priorities/OWNER-QUEUE.md, ONE git log for handoff times", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a2-specs-"));
  try {
    cpSync(join(FIX, "a2-incidents"), join(dir, "incidents"), { recursive: true });
    mkdirSync(join(dir, "priorities"));
    cpSync(join(FIX, "a2-owner-queue.md"), join(dir, "priorities", "OWNER-QUEUE.md"));
    const calls = [];
    const exec = async (cmd, args, opts) => {
      calls.push({ line: `${cmd} ${args.join(" ")}`, cwd: opts?.cwd });
      return { code: 0, stdout: read("a2-gitlog-handoff.txt"), stderr: "" };
    };
    const x = await COL.readSpecsExtras({ dir, exec });
    assert.equal(x.incidents.length, 5);
    assert.equal(x.ownerQueueRows.length, 11);
    assert.equal(x.laneHandoffs.length, 4);
    assert.deepEqual(x.errors, []);
    // ONE git log for the handoff times and ONE for the incident files' last commit times
    assert.equal(calls.length, 2);
    const lines = calls.map((c) => c.line);
    assert.ok(
      lines.includes("git log --since=7.days --format=%x00%cI --name-only -- handoff/lanes"),
    );
    assert.ok(lines.includes("git log --format=%x00%cI --name-only -- incidents"));
    assert.ok(calls.every((c) => c.cwd === dir));
    // missing files are reported, never thrown
    const empty = mkdtempSync(join(tmpdir(), "a2-specs-empty-"));
    try {
      const y = await COL.readSpecsExtras({
        dir: empty,
        exec: async () => ({ code: 128, stdout: "", stderr: "no" }),
      });
      assert.deepEqual(y.incidents, []);
      assert.equal(y.ownerQueueRows, null);
      assert.deepEqual(y.laneHandoffs, []);
      assert.ok(y.errors.length >= 2);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("A2 specs source returns the extras beside events and config; an extras failure never fails the source", async () => {
  const deps = {
    store: {
      ensureClone: async () => {},
      syncSpecs: async () => {},
      readAllEvents: async () => [{ id: "e1" }],
    },
    config: { specsRemote: () => "remote" },
    loadConfig: () => ({ lanes: [] }),
    specsExtras: async () => ({
      incidents: [{ id: "INC-1015a" }],
      ownerQueueRows: [{ key: "N1" }],
      laneHandoffs: [{ file: "pc-lane-x.md", at: "2026-10-19T00:00:00.000Z" }],
      errors: [],
    }),
  };
  const { c } = mk({ deps });
  await c.runOnce("specs");
  assert.equal(c.sources.specs.ok, true, c.sources.specs.error);
  assert.deepEqual(c.sources.specs.data.incidents, [{ id: "INC-1015a" }]);
  assert.deepEqual(c.sources.specs.data.ownerQueueRows, [{ key: "N1" }]);
  assert.equal(c.sources.specs.data.laneHandoffs.length, 1);
  const bad = mk({
    deps: {
      ...deps,
      specsExtras: async () => {
        throw new Error("disk");
      },
    },
  });
  await bad.c.runOnce("specs");
  assert.equal(bad.c.sources.specs.ok, true);
  assert.deepEqual(bad.c.sources.specs.data.events, [{ id: "e1" }]);
  assert.match(bad.c.sources.specs.data.extrasErrors.join(" "), /disk/);
});

import { writeFileSync as writeRegisterFile } from "node:fs";

test("readSpecsExtras: counts duplicate register row ids and lists the row ids; a missing register is not an error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a2-specs-reg-"));
  try {
    mkdirSync(join(dir, "register"));
    const head =
      "| ID | Title | Type | Priority | Status | Lane | Train | Gate | ETA | Links | Updated |\n" +
      "|---|---|---|---|---|---|---|---|---|---|---|\n";
    const row = (id) => `| ${id} | Acme row ${id} | fix | P2 | planned | - | - | - | - | - | x |\n`;
    writeRegisterFile(
      join(dir, "register", "WORK-REGISTER.md"),
      head + row(500) + row(501) + row(500) + row(500),
    );
    const exec = async () => ({ code: 0, stdout: "", stderr: "" });
    const x = await COL.readSpecsExtras({ dir, exec });
    assert.deepEqual(x.registerDuplicateIds, ["500"]);
    assert.deepEqual(x.registerRowIds, ["500", "501", "500", "500"]);
    const none = mkdtempSync(join(tmpdir(), "a2-specs-noreg-"));
    try {
      const y = await COL.readSpecsExtras({ dir: none, exec });
      assert.deepEqual(y.registerDuplicateIds, []);
      assert.equal(y.registerRowIds, null);
      assert.ok(!y.errors.some((e) => /register/.test(e)), y.errors.join(";"));
    } finally {
      rmSync(none, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("specs source carries the register duplicate ids and row ids from the extras", async () => {
  const deps = {
    store: {
      ensureClone: async () => {},
      syncSpecs: async () => {},
      readAllEvents: async () => [],
    },
    config: { specsRemote: () => "remote" },
    loadConfig: () => ({ lanes: [] }),
    specsExtras: async () => ({
      registerDuplicateIds: ["500"],
      registerRowIds: ["500", "500"],
      errors: [],
    }),
  };
  const { c } = mk({ deps });
  await c.runOnce("specs");
  assert.deepEqual(c.sources.specs.data.registerDuplicateIds, ["500"]);
  assert.deepEqual(c.sources.specs.data.registerRowIds, ["500", "500"]);
});

// ---------- X1: incident status words and freshness ----------

test("X1 parseIncidents: first Status word open|mitigated|closed|resolved|suspected|unverified, else unknown", () => {
  const f = (text) => COL.parseIncidents([{ file: "2026-10-15-acme-x.md", text }])[0].status;
  assert.equal(f("# T\n\n**Status:** open. x"), "open");
  assert.equal(f("# T\n\n**Status:** Mitigated. x"), "mitigated");
  assert.equal(f("# T\n\n**Status:** closed (10-16)."), "closed");
  assert.equal(f("# T\n\n**Status:** resolved."), "resolved");
  assert.equal(f("# T\n\n**Status:** suspected, unverified."), "suspected");
  assert.equal(f("# T\n\n**Status:** unverified."), "unverified");
  assert.equal(f("# T\n\n**Symptom.** nothing here"), "unknown");
  assert.equal(f("# T\n\n**Status:** wibble"), "unknown");
});

test("X1 parseIncidents: changedAt comes from the file's newest commit (basename map)", () => {
  const inc = COL.parseIncidents(
    [{ file: "2026-10-15-acme-billing-stuck.md", text: "# T\n\n**Status:** open." }],
    { "2026-10-15-acme-billing-stuck.md": "2026-10-19T14:30:00.000Z" },
  );
  assert.equal(inc[0].changedAt, "2026-10-19T14:30:00.000Z");
  assert.equal(
    COL.parseIncidents([{ file: "2026-10-15-acme-z.md", text: "# T" }])[0].changedAt,
    null,
  );
});

test("X1 parseIncidentLog: newest commit time per incidents/ file", () => {
  assert.deepEqual(COL.parseIncidentLog(read("a2-gitlog-incidents.txt")), {
    "2026-10-15-acme-billing-stuck.md": "2026-10-19T14:30:00.000Z",
    "2026-10-17-acme-suspected.md": "2026-10-19T14:30:00.000Z",
    "2026-10-15-acme-tier-bug.md": "2026-10-18T15:00:00.000Z",
    "README.md": "2026-10-15T13:00:00.000Z",
  });
});

test("X1 readSpecsExtras: incidents carry changedAt from the incidents git log", async () => {
  const dir = mkdtempSync(join(tmpdir(), "x1-specs-"));
  try {
    cpSync(join(FIX, "a2-incidents"), join(dir, "incidents"), { recursive: true });
    mkdirSync(join(dir, "priorities"));
    cpSync(join(FIX, "a2-owner-queue.md"), join(dir, "priorities", "OWNER-QUEUE.md"));
    const exec = async (cmd, args) => ({
      code: 0,
      stdout: args.includes("incidents") ? read("a2-gitlog-incidents.txt") : "",
      stderr: "",
    });
    const x = await COL.readSpecsExtras({ dir, exec });
    const by = Object.fromEntries(x.incidents.map((i) => [i.id, i.changedAt]));
    assert.equal(by["INC-1015a"], "2026-10-19T14:30:00.000Z");
    assert.equal(by["INC-1015c"], "2026-10-18T15:00:00.000Z");
    assert.equal(by["INC-1016a"], null);
    assert.deepEqual(x.errors, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parseIncidents: ids are date + index only (no file-name slug, dated or not); the title is masked before its 300 cut", () => {
  const name = "acme-foods-distribution";
  const files = [
    {
      file: `2026-10-15-${name}-outage.md`,
      text: `# ${"t".repeat(290)} ${name} down\n\n**Status:** open\n`,
    },
    { file: `${name}-undated-note.md`, text: `# Note\n\n**Status:** open\n` },
    { file: `${name}-second-undated.md`, text: `# Second\n\n**Status:** closed\n` },
  ];
  const mask = (t) => t.replace(new RegExp(name, "gi"), "a live business");
  const out = COL.parseIncidents(files, {}, mask);
  // file order: the dated file, then the two undated ones (second-undated sorts before undated-note)
  assert.deepEqual(
    out.map((i) => i.id),
    ["INC-1015a", "INC-0000a", "INC-0000b"],
  );
  for (const i of out) assert.match(i.id, /^INC-\d{4}[a-z]$/, `no slug in ${i.id}`);
  assert.doesNotMatch(JSON.stringify(out.map((i) => i.id)), /acme|outage|note/i);
  const dated = out.find((i) => i.date === "2026-10-15");
  assert.equal(dated.id, "INC-1015a");
  assert.doesNotMatch(dated.title, /acme/i, "no fragment of the name survives the cut");
  assert.match(dated.title, /a live/);
});

// ---------- cloud: bounded git forks, honest spawn errors ----------

test("cloud bugs: ONE prefetch fetch + ONE cat-file for N files; no per-blob fan-out", async () => {
  const byBlob = Object.fromEntries(
    BUG_FILES.map((f, i) => [String(i + 1).repeat(40), bugText(f)]),
  );
  void byBlob;
  const { c, calls } = mk(
    { cloud: true },
    { "git cat-file --batch": () => ({ code: 0, stdout: "", stderr: "" }) },
  );
  await c.runOnce("bugs");
  const gits = calls.filter((x) => x.cmd === "git");
  assert.equal(gits.filter((x) => x.line.startsWith("git fetch")).length, 1);
  assert.equal(gits.filter((x) => x.line.startsWith("git cat-file")).length, 1);
  assert.equal(gits.filter((x) => x.line.startsWith("git cat-file blob")).length, 0);
  assert.ok(gits.length <= 7, "bounded git spawns: " + gits.length);
  const fetch = gits.find((x) => x.line.startsWith("git fetch"));
  for (let i = 1; i <= BUG_FILES.length; i++) assert.ok(fetch.args.includes(String(i).repeat(40)));
});

test("bugs: a git spawn failure surfaces as such, never as 'registry not found'", async () => {
  for (const msg of ["git spawn failed: EAGAIN", "git timed out after 120000ms"]) {
    const { c } = mk(
      {},
      {
        "git rev-parse origin/master:.claude/campaign/bugs": () => ({
          code: 1,
          stdout: "",
          stderr: msg,
        }),
      },
    );
    await c.runOnce("bugs");
    assert.equal(c.sources.bugs.ok, false);
    assert.ok(c.sources.bugs.error.includes(msg), c.sources.bugs.error);
    assert.ok(!/not found/.test(c.sources.bugs.error), c.sources.bugs.error);
  }
});
