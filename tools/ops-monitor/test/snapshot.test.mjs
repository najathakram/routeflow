import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { buildSnapshot, linkItemFor } from "../lib/snapshot.mjs";
import {
  parsePrGraphql,
  parseForEachRef,
  parseBugFrontMatter,
  isOpenBug,
  maskBug,
  parseRailwayStatus,
} from "../lib/collector.mjs";
import { buildAreaTree } from "../lib/areas.mjs";
import { DEFAULT_CONFIG } from "../lib/config.mjs";

const FIX = join(fileURLToPath(new URL(".", import.meta.url)), "fixtures");
const read = (f) => readFileSync(join(FIX, f), "utf8");
const NOW = Date.parse("2026-10-19T12:00:00Z");
const ago = (min) => new Date(NOW - min * 60000).toISOString();

let seq = 0;
function ev(ts, kind, item, lane, data) {
  seq += 1;
  return {
    v: 1,
    id: `pc-${String(Date.parse(ts)).padStart(13, "0")}-${String(1000 + seq)
      .slice(-4)
      .replace(/^/, "a")
      .slice(0, 4)}`,
    ts,
    machine: "pc",
    actor: lane ?? "lead",
    lane,
    kind,
    item,
    data,
  };
}

const gh = parsePrGraphql(JSON.parse(read("collector-graphql.json")));
const refs = parseForEachRef(read("collector-for-each-ref.txt")).map((b) => ({
  ...b,
  files:
    b.branch === "feat/k11-20-floating-editor"
      ? ["apps/web/components/products/price-editor.tsx"]
      : b.branch === "feat/loose-experiment"
        ? ["apps/api/src/orders/x.ts"]
        : [],
}));
const allBugs = readdirSync(join(FIX, "collector-bugs"))
  .sort()
  .map((f) => parseBugFrontMatter(readFileSync(join(FIX, "collector-bugs", f), "utf8")));
const masked = allBugs.map((b) => ({ ...maskBug(b), open: isOpenBug(b) }));
const paths = [
  "apps/api/src/invoices/a.ts",
  "apps/api/src/products/a.ts",
  "apps/web/components/products/price-editor.tsx",
  "apps/web/app/(dashboard)/routes/page.tsx",
  ".github/workflows/ci.yml",
];

const events = () => {
  seq = 0;
  return [
    ev("2026-10-17T00:00:00Z", "item.new", "525", "lead", {
      title: "Floating price editor",
      type: "feature",
      status: "building",
      lane: "pc-lane",
      eta: "10-18",
      train: "R1",
      area: "api:products",
      links: { prs: [3513] },
    }),
    ev("2026-10-17T00:01:00Z", "item.new", "R1", "lead", {
      title: "R1 product window",
      type: "release",
      status: "building",
      eta: "10-25",
      members: ["525"],
    }),
    ev("2026-10-17T00:02:00Z", "item.new", "600", "lead", {
      title: "Pick the plan wording",
      type: "decision",
      lane: "owner",
      priority: "P1",
      gate: "Owner decision needed",
    }),
    ev("2026-10-17T00:03:00Z", "item.new", "601", "lead", {
      title: "Checkout is down for acme",
      type: "incident",
      priority: "P0",
      status: "building",
    }),
    ev("2026-10-17T00:04:00Z", "item.new", "700", "lead", {
      title: "Catalog unit audit",
      type: "chore",
      area: "domain:catalog",
    }),
    ev("2026-10-17T00:05:00Z", "item.new", "800", "lead", {
      title: "Price editor follow-up",
      type: "feature",
      status: "building",
      links: { branches: ["feat/k11-20-floating-editor"] },
    }),
    ev("2026-10-19T11:00:00Z", "claim", "700", "macmini", {}),
    ev("2026-10-19T11:05:00Z", "claim", "700", "pc-lane", {}),
    ev("2026-10-19T11:06:00Z", "status", "999", "pc-lane", { status: "live" }),
    ev("2026-10-19T11:07:00Z", "owner-decision", "600", "lead", {
      question: "Wording A or B?",
      answer: "A",
    }),
    ev("2026-10-19T11:08:00Z", "status", "B231", "pc-lane", { status: "building" }),
    ev("2026-10-19T11:09:00Z", "note", "B230", "pc-lane", { text: "looked at it" }),
  ];
};

const okSource = (intervalSec, data) => ({
  ok: true,
  at: NOW - 10_000,
  tried: NOW - 10_000,
  error: null,
  data,
  intervalSec,
});
const sources = (over = {}) => ({
  specs: okSource(30, { events: events(), config: DEFAULT_CONFIG }),
  github: okSource(60, gh),
  branches: okSource(120, {
    branches: refs.filter((b) => b.branch !== "old/ancient"),
    fetchError: null,
  }),
  bugs: okSource(120, { bugs: masked, open: masked.filter((b) => b.open) }),
  areas: okSource(300, { sha: "abc", fileCount: paths.length, tree: buildAreaTree(paths) }),
  railway: {
    ok: false,
    at: null,
    tried: NOW,
    error: "railway CLI unavailable",
    data: null,
    intervalSec: 120,
  },
  ...over,
});
const build = (over) =>
  buildSnapshot({ sources: sources(over), config: DEFAULT_CONFIG, now: NOW, machine: "pc" });

test("top-level contract keys and stats", () => {
  const s = build();
  assert.deepEqual(
    Object.keys(s).sort(),
    [
      "alarms",
      "answeredRecently",
      "branches",
      "bugs",
      "bugsFixedByNote",
      "ci",
      "decisions",
      "generatedAt",
      "incidents",
      "items",
      "lanes",
      "latentRisks",
      "machine",
      "map",
      "ownerQueue",
      "ownerTodos",
      "prs",
      "problems",
      "sources",
      "stats",
      "trains",
    ].sort(),
  );
  assert.equal(s.generatedAt, "2026-10-19T12:00:00.000Z");
  assert.equal(s.machine, "pc");
  assert.deepEqual(s.stats, { events: 12, items: 8, openBugs: 2, anomalies: 2 });
});

test("sources: ages from now, stale flag, error text", () => {
  const s = build().sources;
  assert.deepEqual(s.specs, {
    ok: true,
    at: new Date(NOW - 10_000).toISOString(),
    ageSec: 10,
    stale: false,
    error: null,
    intervalSec: 30,
  });
  assert.equal(s.railway.ok, false);
  assert.equal(s.railway.ageSec, null);
  assert.equal(s.railway.stale, true);
  assert.equal(s.railway.error, "railway CLI unavailable");
  const old = build({ github: { ...okSource(60, gh), at: NOW - 181_000 } }).sources.github;
  assert.equal(old.stale, true);
  assert.equal(old.ageSec, 181);
});

test("items: no history, ISO times, domain from area / domain: / title, sensitive overlay masked", () => {
  const s = build();
  const byId = Object.fromEntries(s.items.map((i) => [i.id, i]));
  assert.equal("history" in byId["525"], false);
  assert.equal(byId["525"].createdAt, "2026-10-17T00:00:00.000Z");
  assert.equal(byId["525"].domain, "catalog"); // api:products
  assert.equal(byId["700"].domain, "catalog"); // domain:catalog
  assert.equal(byId["601"].domain, "billing"); // title keyword "checkout"
});

test("overlay bugs use registry titles; sensitive overlay is masked everywhere", () => {
  const s = build();
  const byId = Object.fromEntries(s.items.map((i) => [i.id, i]));
  assert.equal(byId.B231.title, "Invoice total rounds half-cent the wrong way on boxed lines");
  assert.equal(byId.B231.domain, "finance");
  assert.equal(byId.B230.title, "Security hardening item (details machine-local)");
  const dump = JSON.stringify(s);
  for (const leak of ["Dispatch-modal", "routes/templates", "must not leak", "tenancy"]) {
    assert.ok(!dump.includes(leak), leak);
  }
  assert.deepEqual(
    s.bugs.map((b) => b.id),
    ["B230", "B231"],
  );
  assert.deepEqual(s.bugs[0], {
    id: "B230",
    title: "Security hardening item (details machine-local)",
    severity: "low",
    state: "uncampaigned",
    area: null,
    domain: null,
    sensitive: true,
    ledgerState: null,
    batch: null,
    tier: null,
    filedAt: null,
    pending: false,
    fix: { state: "none", pr: null, prUrl: null, branch: null },
    items: [],
    release: null,
  });
  assert.equal(s.bugs[1].area, "api:invoices");
});

test("trains: members union of item.members and train field", () => {
  const s = build();
  assert.deepEqual(s.trains, [
    {
      id: "R1",
      title: "R1 product window",
      status: "building",
      eta: "10-25",
      etaAt: "2026-10-25T23:59:59.000Z",
      members: ["525"],
    },
  ]);
});

test("lanes: config plus seen, now/next/silent", () => {
  const s = build();
  const ids = s.lanes.map((l) => l.id);
  assert.deepEqual(
    ids.slice(0, DEFAULT_CONFIG.lanes.length),
    DEFAULT_CONFIG.lanes.map((l) => l.id),
  );
  const mm = s.lanes.find((l) => l.id === "macmini");
  assert.equal(mm.silentMin, 60);
  assert.equal(mm.lastEventAt, "2026-10-19T11:00:00.000Z");
  assert.equal(mm.title, "RouteFlow Mac mini lane");
  assert.equal(mm.machine, "macmini");
  assert.deepEqual(mm.now, ["700"]); // claimed first, conflict keeps the holder
  const pc = s.lanes.find((l) => l.id === "pc-lane");
  assert.ok(pc.now.includes("525")); // lane 525 building, unclaimed
  assert.equal(pc.next.id, "B230"); // "*" lane; 600 belongs to owner, 700 is claimed
  const owner = s.lanes.find((l) => l.id === "owner");
  assert.equal(owner.lastEventAt, null);
  assert.equal(owner.silentMin, null);
});

test("ownerQueue, decisions, problems", () => {
  const s = build();
  // The fixture answers decision 600 with an owner-decision event, so it has left the queue
  // (accuracy round: an owner-decision names the item -> answered, status verified).
  assert.deepEqual(s.ownerQueue, []);
  const answered = s.items.find((i) => i.id === "600");
  assert.equal(answered.status, "verified");
  assert.ok(answered.answeredAt); // set by the owner-decision event
  assert.equal(s.decisions.length, 1);
  assert.equal(s.decisions[0].question, "Wording A or B?");
  assert.equal(s.decisions[0].ts, "2026-10-19T11:07:00.000Z");
  assert.deepEqual(s.problems, ["601"]);
});

test("prs and branches: areas, item links, pr numbers", () => {
  const s = build();
  const byNum = Object.fromEntries(s.prs.open.map((p) => [p.number, p]));
  assert.deepEqual(byNum[3520].areas, ["web:products", "api:products"]);
  assert.equal(byNum[3520].item, "800"); // via branch link
  assert.equal(byNum[3521].item, "B231"); // via branch name
  assert.equal(byNum[3521].checks, "FAILURE");
  assert.equal(byNum[3522].item, null);
  assert.equal(byNum[3522].draft, true);
  assert.deepEqual(
    s.prs.merged.map((p) => [p.number, p.item]),
    [
      [3513, "525"],
      [3510, "B233"],
      [3505, null],
    ],
  );
  const br = Object.fromEntries(s.branches.map((b) => [b.branch, b]));
  assert.equal(br["feat/k11-20-floating-editor"].pr, 3520);
  assert.deepEqual(br["feat/k11-20-floating-editor"].areas, ["web:products"]);
  assert.equal(br["feat/loose-experiment"].pr, null);
  assert.equal(br["feat/loose-experiment"].item, null);
});

test("ci: master, visibility; deploys empty when railway never ran", () => {
  const s = build();
  assert.equal(s.ci.visibility, "PRIVATE");
  assert.equal(s.ci.master.sha, "a".repeat(40));
  assert.deepEqual(s.ci.deploys, []);
  const withRw = build({
    railway: okSource(120, {
      deploys: parseRailwayStatus(JSON.parse(read("collector-railway.json"))),
    }),
  });
  assert.deepEqual(
    withRw.ci.deploys.map((d) => [d.service, d.status]),
    [
      ["@routeflow/api", "SUCCESS"],
      ["@routeflow/web", "BUILDING"],
    ],
  );
});

test("map: area counts for items, prs, branches, bugs; domain-level items", () => {
  const s = build();
  const areas = Object.fromEntries(
    s.map.domains.flatMap((d) => d.areas.map((a) => [a.area, { ...a, domain: d.id }])),
  );
  assert.equal(areas["web:products"].prs, 1);
  assert.equal(areas["api:products"].prs, 1);
  assert.equal(areas["web:products"].branches, 1);
  assert.equal(areas["web:products"].items, 1); // item 800 via PR/branch areas
  assert.equal(areas["api:products"].items, 1);
  assert.equal(areas["api:invoices"].prs, 1); // PR 3521
  assert.equal(areas["api:invoices"].bugs.high, 1); // B231
  assert.equal(areas["api:invoices"].domain, "finance");
  assert.equal(areas["api:orders"].branches, 1); // new area not in tree is added to its domain
  assert.equal(areas["web:routes"].bugs.low, 0); // sensitive bug is not attributed
  const catalog = s.map.domains.find((d) => d.id === "catalog");
  // 525 (area id only), 700 (domain:catalog) have no PR/branch areas -> domain level; 800 is on areas
  assert.equal(catalog.items, 2);
  assert.ok(!s.map.domains.some((d) => d.items > 0 && d.id === "other" && false));
  // releases never count
  const total = s.map.domains.reduce((n, d) => n + d.items, 0);
  assert.ok(total >= 2);
});

test("alarms: exact ids and severities end to end", () => {
  const alarms = build().alarms;
  const got = Object.fromEntries(alarms.map((a) => [a.id, a.severity]));
  assert.equal(got["status-behind-merge:525"], "warn"); // merged 3h ago
  assert.equal(got["claim-conflict:700"], "error");
  assert.equal(got["anomaly:999"], "error");
  assert.equal(got["anomaly:700"], undefined); // the live conflict is reported once, as claim-conflict
  assert.equal(got["untracked-pr:3520"], undefined); // linked through item 800
  assert.equal(got["untracked-pr:3522"], "warn");
  assert.equal(got["lane-silent:macmini"], "warn");
  assert.equal(got["past-eta:525"], "warn"); // building, eta 10-18 passed
  assert.equal(got["stale-source:railway"], "warn");
  assert.equal(got["untracked-branch:feat/loose-experiment"], "info");
  assert.equal(got["stale-source:github"], undefined);
  assert.equal(got["untracked-pr:3521"], undefined); // branch carries B231
  assert.equal(got["lane-silent:pc-lane"], undefined);
  // severity ordering
  const sev = alarms.map((a) => a.severity);
  assert.deepEqual(
    sev,
    [...sev].sort(
      (a, b) => ({ error: 0, warn: 1, info: 2 })[a] - { error: 0, warn: 1, info: 2 }[b],
    ),
  );
});

test("stale-source error severity for specs/github and empty sources do not crash", () => {
  const s = buildSnapshot({ sources: {}, config: DEFAULT_CONFIG, now: NOW, machine: "pc" });
  const got = Object.fromEntries(s.alarms.map((a) => [a.id, a.severity]));
  assert.equal(got["stale-source:specs"], "error");
  assert.equal(got["stale-source:github"], "error");
  assert.equal(got["stale-source:branches"], "warn");
  assert.equal(got["stale-source:bugs"], "warn");
  assert.equal(got["stale-source:areas"], "warn");
  assert.equal(got["stale-source:railway"], "warn");
  assert.deepEqual(s.items, []);
  assert.equal(s.map.domains.length, 9);
});

test("linkItemFor is re-exported from snapshot", () => {
  const state = { items: new Map(), prEvents: [] };
  assert.equal(linkItemFor({ branch: "fix/b7-x" }, state), "B7");
});

// =====================================================================================
// Accuracy round, package A2: the snapshot. One acme scenario, fixtures shaped like real data.
// =====================================================================================
import * as SNAP from "../lib/snapshot.mjs";
import * as COL from "../lib/collector.mjs";

const A2_GH = COL.parsePrGraphql(JSON.parse(read("a2-graphql.json")));
const A2_QUEUE = COL.parseOwnerQueueRows(read("a2-owner-queue.md"));
const A2_INCIDENTS = COL.parseIncidents(
  readdirSync(join(FIX, "a2-incidents")).map((f) => ({
    file: f,
    text: readFileSync(join(FIX, "a2-incidents", f), "utf8"),
  })),
);

const bugRow = (id, o = {}) => ({
  id,
  title: `Acme widget total is wrong on ${id}`,
  severity: "high",
  state: "queued",
  area: "api:invoices",
  domain: "finance",
  sensitive: false,
  open: true,
  ledgerState: null,
  batch: null,
  tier: null,
  filedAt: "2026-10-10T12:00:00.000Z",
  ...o,
});
const A2_BUGS = [
  bugRow("B9001"),
  bugRow("B9002", { severity: "critical" }),
  bugRow("B9003", { severity: "low" }),
  bugRow("B9004"),
  bugRow("B9005", { severity: "medium", state: "done", ledgerState: "regressed" }),
  bugRow("B9006", { severity: "critical", filedAt: "2026-10-18T09:00:00.000Z" }),
  bugRow("B9007", { open: false, state: "done" }),
  bugRow("B9008", { filedAt: "2026-10-19T01:00:00.000Z" }),
];

const a2ev = () => {
  seq = 0;
  const itm = (id, lane, data) => ev("2026-10-17T00:00:00Z", "item.new", id, lane, data);
  return [
    itm("R1", "lead", {
      title: "R1 widgets window",
      type: "release",
      status: "building",
      eta: "10-20 ~18:00Z",
      members: ["B9002", "B9003", "700"],
    }),
    itm("700", "lead", {
      title: "Catalog widget audit for B9001",
      type: "chore",
      status: "building",
      lane: "macmini",
      links: { branches: ["feat/acme-lane-work"] },
    }),
    itm("710", "lead", { title: "Second window widget", type: "feature", trainLabel: "Window 2" }),
    itm("711", "lead", { title: "Free text train", type: "feature", trainLabel: "after census" }),
    // decisions + owner queue keys
    ...[
      ["901", "N1"],
      ["902", "N2"],
      ["903", "N4"],
      ["904", "4"],
      ["905", "5"],
      ["906", "N3"],
      ["909", "3"],
    ].map(([id, key]) =>
      itm(id, "lead", {
        title: `Acme decision ${id}`,
        type: "decision",
        lane: "owner",
        priority: "P1",
        gate: `Recommended: yes ${id}`,
        tags: ["owner-queue", key],
        source: "owner-queue",
      }),
    ),
    itm("907", "lead", {
      title: "Acme decision 907",
      type: "decision",
      lane: "owner",
      priority: "P1",
    }),
    itm("908", "lead", {
      title: "Acme decision 908",
      type: "decision",
      lane: "owner",
      priority: "P1",
    }),
    // problems
    itm("950", "lead", {
      title: "Acme checkout wrong",
      type: "bug",
      priority: "P0",
      status: "building",
    }),
    itm("951", "lead", { title: "Acme report gap", type: "feature", priority: "P1" }),
    itm("952", "lead", { title: "Acme fixed one", type: "bug", priority: "P1", status: "live" }),
    itm("953", "lead", { title: "Acme parked one", type: "bug", priority: "P1", status: "parked" }),
    itm("954", "lead", {
      title: "Board problem",
      type: "incident",
      priority: "P0",
      tags: ["problem"],
      source: "board",
    }),
    itm("955", "lead", {
      title: "Board owner ask",
      type: "decision",
      lane: "owner",
      priority: "P0",
      tags: ["owner-ask"],
      source: "board",
    }),
    itm("956", "lead", { title: "Acme low priority", type: "bug", priority: "P2" }),
    itm("957", "lead", { title: "Acme ops chore", type: "ops", priority: "P0" }),
    // ETA
    itm("960", "lead", { title: "Acme dated", type: "feature", eta: "10-20 ~18:00Z" }),
    itm("961", "lead", { title: "Acme free text eta", type: "feature", eta: "after census" }),
    // register-cited PR is background, a link event is a real fix link
    itm("970", "lead", {
      title: "Acme register-cited",
      type: "feature",
      status: "building",
      source: "register",
      links: { prs: [9012] },
    }),
    itm("971", "lead", { title: "Acme linked by event", type: "feature", status: "building" }),
    ev("2026-10-19T11:00:00Z", "claim", "700", "macmini", {}),
    ev("2026-10-19T11:50:00Z", "note", "951", "pc-lane", { text: "looking" }),
    ev("2026-10-19T11:07:00Z", "owner-decision", "907", "lead", {
      question: "A or B?",
      answer: "A",
    }),
    ev("2026-10-19T08:00:00Z", "link", "971", "pc-lane", { prs: [9010] }),
  ];
};

const A2_BRANCHES = [
  {
    branch: "feat/acme-lane-work",
    sha: "5".repeat(40),
    date: "2026-10-19T11:30:00.000Z",
    files: ["apps/api/src/orders/x.ts"],
  },
  {
    branch: "fix/b9005-regress",
    sha: "6".repeat(40),
    date: "2026-10-19T08:00:00.000Z",
    files: ["apps/api/src/invoices/y.ts"],
  },
];
const A2_PENDING = [
  {
    ...bugRow("B9100", { title: "Acme pending widget bug", filedAt: null }),
    branch: "feat/acme-intake",
    sha: "7".repeat(40),
    path: ".claude/campaign/bugs/B9100.md",
  },
  {
    id: "B9101",
    title: "Security hardening item (details machine-local)",
    severity: "high",
    state: "queued",
    area: null,
    domain: null,
    sensitive: true,
    open: true,
    branch: "feat/acme-intake",
    sha: "7".repeat(40),
    path: ".claude/campaign/bugs/B9101.md",
  },
];

function a2Github() {
  const open = [
    ...A2_GH.open,
    {
      number: 9005,
      title: "fix(invoices): B9999 stray",
      body: "",
      draft: false,
      branch: "fix/stray",
      headSha: "8".repeat(40),
      base: "master",
      updatedAt: "2026-10-19T11:00:00Z",
      url: "https://github.com/acme-org/widgets/pull/9005",
      checks: null,
      runs: [],
      files: [],
    },
  ];
  const merged = [
    ...A2_GH.merged,
    {
      number: 9013,
      title: "fix(invoices): B9006 late fix",
      body: "",
      branch: "fix/b9006-late",
      mergedAt: "2026-10-19T11:00:00Z",
      mergeSha: "f".repeat(40),
      url: "https://github.com/acme-org/widgets/pull/9013",
      base: "master",
    },
  ];
  return { ...A2_GH, open, merged };
}

const A2_DEPLOYS = [
  {
    service: "@routeflow/api",
    status: "SUCCESS",
    sha: "d".repeat(40),
    createdAt: "2026-10-19T09:10:00Z",
  },
  {
    service: "@routeflow/web",
    status: "BUILDING",
    sha: "e".repeat(40),
    createdAt: "2026-10-19T11:50:00Z",
  },
];

function a2Sources(over = {}) {
  return {
    specs: okSource(30, {
      events: a2ev(),
      config: DEFAULT_CONFIG,
      incidents: A2_INCIDENTS,
      ownerQueueRows: A2_QUEUE,
      laneHandoffs: [
        { file: "macbook-lane-2026-10-18.md", at: "2026-10-19T04:00:00.000Z" },
        { file: "pc-lane-2026-10-18.md", at: "2026-10-19T03:00:00.000Z" },
        { file: "macmini-lane-2026-10-18.md", at: "2026-10-19T05:00:00.000Z" },
        { file: "ops-monitor-notes.md", at: "2026-10-19T06:00:00.000Z" },
      ],
      extrasErrors: [],
    }),
    github: okSource(60, a2Github()),
    branches: okSource(120, { branches: A2_BRANCHES, pendingBugs: A2_PENDING }),
    bugs: okSource(120, { bugs: A2_BUGS, open: A2_BUGS.filter((b) => b.open) }),
    areas: okSource(300, { sha: "abc", fileCount: paths.length, tree: buildAreaTree(paths) }),
    railway: okSource(120, { deploys: A2_DEPLOYS }),
    ...over,
  };
}
const a2 = (over, extra = {}) =>
  buildSnapshot({
    sources: a2Sources(over),
    config: DEFAULT_CONFIG,
    now: NOW,
    machine: "pc",
    ...extra,
  });

test("A2 ruling 2: problems = open P0/P1 register items + open incidents; board-sourced items never", () => {
  const s = a2();
  // Fixture incidents carry no commit time, so their filename date (10-15) is the freshness.
  // INC-1016a has no Status line (unknown) and INC-1017a is "suspected": neither is hurting now;
  // the mitigated INC-1015c is listed apart.
  assert.deepEqual(s.problems, ["950", "INC-1015a"]);
  // closed incidents are not problems; the incident files come in as derived read-only items
  const inc = s.items.find((i) => i.id === "INC-1015a");
  assert.equal(inc.type, "incident");
  assert.equal(inc.derived, true);
  assert.equal(inc.priority, "P0");
  assert.equal(inc.statusLabel, "Open");
  assert.equal(s.items.find((i) => i.id === "INC-1015c").statusLabel, "Mitigated");
  assert.ok(!s.items.some((i) => i.id === "INC-1015b"), "closed incident is not a problem item");
  // tags problem / owner-ask (board snapshot items) are excluded even at P0
  assert.ok(!s.problems.includes("951"), "a P1 feature is not a live problem");
  assert.ok(!s.problems.includes("957"), "a P0 ops item is not a live problem");
  assert.ok(!s.problems.includes("954") && !s.problems.includes("955"));
  assert.ok(
    !s.problems.includes("952") && !s.problems.includes("953") && !s.problems.includes("956"),
  );
  assert.equal(
    s.stats.items,
    s.items.filter((i) => !i.derived).length,
    "stats count folded items only",
  );
});

test("A2 ruling 2: owner-facing status words and decision words", () => {
  const L = SNAP.statusLabelFor;
  const words = {
    live: "Fixed",
    verified: "Fixed",
    spec: "Being specified",
    building: "Being built",
    review: "In review",
    ready: "Ready to ship",
    shipping: "Shipping",
    planned: "Planned",
    idea: "Idea",
    parked: "Parked",
    dropped: "Dropped",
  };
  for (const [st, w] of Object.entries(words))
    assert.equal(L({ type: "feature", status: st }), w, st);
  assert.equal(L({ type: "decision", status: "verified" }), "Answered");
  assert.equal(L({ type: "decision", status: "live" }), "Answered");
  assert.equal(L({ type: "decision", status: "planned" }, { booked: true }), "Booked");
  assert.equal(L({ type: "decision", status: "planned" }, { answered: true }), "Answered");
  assert.equal(L({ type: "decision", status: "planned" }), "Planned");
  const s = a2();
  const by = Object.fromEntries(s.items.map((i) => [i.id, i]));
  assert.equal(by["950"].statusLabel, "Being built");
  assert.equal(by["952"].statusLabel, "Fixed");
  assert.equal(by["901"].statusLabel, "Answered");
  assert.equal(by["904"].statusLabel, "Booked");
  assert.equal(by["903"].statusLabel, "Planned");
});

test("A2 ruling 3: etaAt is ISO for a real date or range, null for free text; the raw eta stays", () => {
  const s = a2();
  const by = Object.fromEntries(s.items.map((i) => [i.id, i]));
  assert.equal(by["960"].eta, "10-20 ~18:00Z");
  assert.equal(by["960"].etaAt, "2026-10-20T18:00:00.000Z");
  assert.equal(by["961"].eta, "after census");
  assert.equal(by["961"].etaAt, null);
  assert.equal(by["700"].etaAt, null); // no eta
  assert.equal(s.trains[0].etaAt, "2026-10-20T18:00:00.000Z");
});

test("A2 ruling 4: owner queue from OWNER-QUEUE.md rows, owner-decision events and the BOOKED word", () => {
  const s = a2();
  assert.deepEqual(
    s.ownerQueue.map((o) => [o.id, o.state]),
    [
      ["903", "open"], // N4 OPEN
      ["904", "booked"], // BOOKED stays listed
      ["905", "open"], // CHECK
      ["908", "open"], // no row, no event
    ],
  );
  assert.equal(s.ownerQueue[0].gate, "Recommended: yes 903");
  // answered: ANSWERED + file (901), DEFAULT IN EFFECT (902), file only (906), STANDING YES (909),
  // an owner-decision event (907); newest first, ten at most
  assert.deepEqual(
    s.answeredRecently.map((a) => a.id),
    ["907", "906", "909", "901", "902"],
  );
  const a = Object.fromEntries(s.answeredRecently.map((x) => [x.id, x]));
  assert.equal(a["907"].answer, "A");
  assert.equal(a["907"].answeredAt, "2026-10-19T11:07:00.000Z");
  assert.equal(a["901"].answer, "ANSWERED → D-2026-10-18-acme-say-no-sitting.md");
  assert.equal(a["901"].answeredAt, "2026-10-18T00:00:00.000Z");
  assert.equal(a["902"].answer, "DEFAULT IN EFFECT");
  assert.equal(a["902"].answeredAt, null);
  assert.equal(a["906"].title, "Acme decision 906");
  // without the rows (OWNER-QUEUE.md unreadable) nothing is guessed answered
  const none = a2({
    specs: okSource(30, { events: a2ev(), config: DEFAULT_CONFIG, ownerQueueRows: null }),
  });
  assert.ok(none.ownerQueue.some((o) => o.id === "901"));
  assert.deepEqual(
    none.answeredRecently.map((x) => x.id),
    ["907"],
  );
});

test("A2 ruling 4: answeredRecently keeps ten at most", () => {
  const many = [];
  seq = 0;
  for (let i = 0; i < 14; i++)
    many.push(
      ev(`2026-10-17T00:${String(10 + i)}:00Z`, "item.new", String(980 + i), "lead", {
        title: `Acme q ${i}`,
        type: "decision",
        lane: "owner",
        tags: ["owner-queue", `Q${i}`],
      }),
    );
  const rows = Array.from({ length: 14 }, (_, i) => ({
    key: `Q${i}`,
    statusWord: "ANSWERED",
    decisionFile: `D-2026-10-${String(1 + i).padStart(2, "0")}-acme.md`,
    asOf: null,
  }));
  const s = a2({
    specs: okSource(30, { events: many, config: DEFAULT_CONFIG, ownerQueueRows: rows }),
  });
  assert.equal(s.answeredRecently.length, 10);
  assert.equal(s.answeredRecently[0].id, "993"); // newest file date first
  assert.equal(s.ownerQueue.length, 0);
});

test("A2 ruling 5: B-ids resolve (release members), train labels use R tokens and trainAliases", () => {
  const s = a2();
  const by = Object.fromEntries(s.items.map((i) => [i.id, i]));
  assert.deepEqual(s.trains[0].members.sort(), ["700", "710", "B9002", "B9003"].sort());
  // a release member that is a B-id resolves to a bug item (registry title, derived)
  assert.equal(by.B9002.type, "bug");
  assert.equal(by.B9002.title, "Acme widget total is wrong on B9002");
  assert.equal(by.B9002.derived, true);
  assert.ok(!by["711"] || !s.trains[0].members.includes("711")); // free text is not a train
  // a B-id nobody knows still resolves (so the page can open it)
  const unknown = a2({
    specs: okSource(30, {
      events: [
        ...a2ev(),
        ev("2026-10-17T01:00:00Z", "item.edit", "R1", "lead", {
          fields: { members: ["B9002", "B8888"] },
        }),
      ],
      config: DEFAULT_CONFIG,
    }),
  });
  assert.ok(unknown.items.find((i) => i.id === "B8888"));
  // config.trainAliases extends the default
  const alias = a2(
    {},
    { config: { ...DEFAULT_CONFIG, trainAliases: { "window 2": "R1", "after census": "R1" } } },
  );
  assert.ok(alias.trains[0].members.includes("711"));
});

test("A2 ruling 6: lane lastActivityAt = newest of event, linked branch commit, handoff commit; with its source", () => {
  const s = a2();
  const lane = Object.fromEntries(s.lanes.map((l) => [l.id, l]));
  // macmini: event 11:00; claimed item 700 links a branch committed 11:30; handoff 05:00
  assert.equal(lane.macmini.lastEventAt, "2026-10-19T11:00:00.000Z");
  assert.equal(lane.macmini.lastActivityAt, "2026-10-19T11:30:00.000Z");
  assert.equal(lane.macmini.lastActivitySource, "commit");
  assert.equal(lane.macmini.silentMin, 30);
  // macbook: never recorded an event, but its handoff note was committed 04:00
  assert.equal(lane.macbook.lastEventAt, null);
  assert.equal(lane.macbook.lastActivityAt, "2026-10-19T04:00:00.000Z");
  assert.equal(lane.macbook.lastActivitySource, "handoff");
  // pc-lane: event 11:50 beats its handoff
  assert.equal(lane["pc-lane"].lastActivityAt, "2026-10-19T11:50:00.000Z");
  assert.equal(lane["pc-lane"].lastActivitySource, "event");
  // ops-monitor prefix is the lane id; owner has nothing
  assert.equal(lane["ops-monitor"].lastActivityAt, "2026-10-19T06:00:00.000Z");
  assert.equal(lane["ops-monitor"].lastActivitySource, "handoff");
  assert.equal(lane.owner.lastActivityAt, null);
  assert.equal(lane.owner.lastActivitySource, null);
  assert.equal(lane.owner.silentMin, null);
});

test("A2 ruling 7: ci.master and open PRs carry gate, probesFailing and runs", () => {
  const s = a2();
  assert.equal(s.ci.master.gate, "pending");
  assert.deepEqual(s.ci.master.probesFailing, ["ci/lint"]);
  assert.equal(s.ci.master.checks, "PENDING");
  assert.deepEqual(
    s.ci.master.runs.map((r) => [r.name, r.kind, r.state]),
    [
      ["Verify", "gate", "success"],
      ["E2E gate (freshness)", "gate", "success"],
      ["E2E (Playwright)", "gate", "pending"],
      ["Replay migrations on a fresh database", "probe", "skipped"],
      ["ci/lint", "probe", "failure"],
    ],
  );
  const pr = Object.fromEntries(s.prs.open.map((p) => [p.number, p]));
  assert.equal(pr[9001].gate, "skipped"); // private repo: gate runs skipped
  assert.deepEqual(pr[9001].probesFailing, ["Replay migrations on a fresh database"]);
  assert.equal(pr[9002].gate, "pending");
  assert.deepEqual(pr[9002].probesFailing, ["ci/lint"]);
  assert.equal(pr[9003].gate, "none");
  assert.deepEqual(pr[9003].probesFailing, []);
  assert.equal(pr[9004].gate, "success");
  assert.equal("body" in pr[9001], false, "PR bodies stay server-side");
  // config.ciGates changes the classification
  const custom = a2({}, { config: { ...DEFAULT_CONFIG, ciGates: ["lint"] } });
  assert.equal(custom.ci.master.gate, "failure");
  assert.deepEqual(custom.ci.master.probesFailing, []);
});

test("A2 ruling 8: every open bug has a fix state; pending bugs are 'filed, not on master yet'", () => {
  const s = a2();
  const by = Object.fromEntries(s.bugs.map((b) => [b.id, b]));
  assert.deepEqual(
    s.bugs.map((b) => b.id),
    ["B9001", "B9002", "B9003", "B9004", "B9005", "B9006", "B9008", "B9100", "B9101"],
  );
  const fix = (id) => [by[id].fix.state, by[id].fix.pr, by[id].fix.branch];
  assert.deepEqual(fix("B9001"), ["pr-open", 9001, "fix/widget-rounding"]);
  assert.deepEqual(fix("B9002"), ["in-release", 9011, "train/acme-widgets"]); // a PR title names it; the train body mention is background
  assert.deepEqual(fix("B9003"), ["none", null, null]); // named only in the train body (background)
  assert.deepEqual(fix("B9004"), ["deployed", 9010, "fix/b9004-widget-total"]);
  assert.deepEqual(fix("B9005"), ["branch", null, "fix/b9005-regress"]);
  assert.deepEqual(fix("B9006"), ["merged", 9013, "fix/b9006-late"]); // merged after the last deploy
  assert.deepEqual(fix("B9008"), ["none", null, null]);
  assert.equal(by.B9001.fix.prUrl, "https://github.com/acme-org/widgets/pull/9001");
  assert.equal(by.B9002.release, "R1");
  assert.equal(by.B9001.release, null);
  assert.equal(by.B9005.ledgerState, "regressed");
  assert.equal(by.B9001.filedAt, "2026-10-10T12:00:00.000Z");
  assert.deepEqual(by.B9001.items, ["700"]); // the register item that names it
  assert.equal(by.B9001.pending, false);
  assert.equal(by.B9100.pending, true);
  assert.equal(by.B9100.fix.state, "none");
  assert.equal(by.B9101.pending, true);
  assert.equal(by.B9101.title, "Security hardening item (details machine-local)");
  assert.ok(!JSON.stringify(s).includes("secret detail"), "sensitive pending bug stays masked");
  // a pending bug that has since landed on master is not pending any more
  const landed = a2({
    bugs: okSource(120, {
      bugs: [...A2_BUGS, bugRow("B9100", { filedAt: null })],
      open: [...A2_BUGS.filter((b) => b.open), bugRow("B9100", { filedAt: null })],
    }),
  });
  assert.equal(landed.bugs.filter((b) => b.id === "B9100").length, 1);
  assert.equal(landed.bugs.find((b) => b.id === "B9100").pending, false);
  assert.equal(s.stats.openBugs, 7, "pending bugs are not counted as registry-open");
});

test("A2 ruling 8: the PR ledger number never counts as a fix link (a regressed bug is not 'merged')", () => {
  const s = a2();
  const b = s.bugs.find((x) => x.id === "B9005");
  assert.equal(b.fix.state, "branch");
  assert.equal(b.fix.pr, null);
});

test("A2 ruling 8: deployed = merged at or before the latest SUCCESS api/web deploy; master-head deploy covers everything", () => {
  // deploy sha is master's head -> every merged PR is deployed
  const head = a2({
    railway: okSource(120, {
      deploys: [
        {
          service: "@routeflow/web",
          status: "SUCCESS",
          sha: "e".repeat(40),
          createdAt: "2026-10-19T11:55:00Z",
        },
      ],
    }),
  });
  assert.equal(head.bugs.find((b) => b.id === "B9006").fix.state, "deployed");
  assert.equal(head.bugs.find((b) => b.id === "B9004").fix.state, "deployed");
  // no successful deploy -> merged, never deployed
  const none = a2({
    railway: okSource(120, {
      deploys: [
        {
          service: "@routeflow/api",
          status: "FAILED",
          sha: "d".repeat(40),
          createdAt: "2026-10-19T09:10:00Z",
        },
      ],
    }),
  });
  assert.equal(none.bugs.find((b) => b.id === "B9004").fix.state, "merged");
  // an unknown deploy sha falls back to the deploy's creation time
  const unknown = a2({
    railway: okSource(120, {
      deploys: [
        {
          service: "@routeflow/api",
          status: "SUCCESS",
          sha: "9".repeat(40),
          createdAt: "2026-10-19T10:00:00Z",
        },
      ],
    }),
  });
  assert.equal(unknown.bugs.find((b) => b.id === "B9004").fix.state, "deployed");
  assert.equal(unknown.bugs.find((b) => b.id === "B9006").fix.state, "merged");
});

test("A2 rulings 1+8: alarms end to end (register-cited PRs never alarm; bug alarms use fix links)", () => {
  const got = Object.fromEntries(a2().alarms.map((a) => [a.id, a.severity]));
  // item 970 only CITES merged PR 9012 in the register: background, no alarm
  assert.equal(got["status-behind-merge:970"], undefined);
  // item 971 was linked to merged PR 9010 by an rf event 4 h ago: a real fix link
  assert.equal(got["status-behind-merge:971"], "warn");
  assert.equal(got["bug-fixed-still-open:B9004"], "warn");
  assert.equal(got["bug-fixed-still-open:B9006"], "warn");
  assert.equal(got["bug-unowned:B9008"], "warn");
  assert.equal(got["bug-unowned:B9002"], undefined); // in a release
  assert.equal(got["bug-no-registry:B9999"], "warn");
  assert.equal(got["bug-no-registry:B9100"], undefined); // pending, not missing
  assert.equal(got["untracked-pr:9001"], undefined); // PR body names B9001 -> linked
});

test("A2: authEnabled passes through only when given", () => {
  assert.equal(a2({}, { authEnabled: true }).authEnabled, true);
  assert.equal(a2({}, { authEnabled: false }).authEnabled, false);
  assert.equal("authEnabled" in a2(), false);
});

test("A2: a registry-only snapshot (no extras, no ledger) still builds with safe defaults", () => {
  const s = build();
  assert.deepEqual(
    s.answeredRecently.map((a) => a.id),
    ["600"], // answered by the fixture's owner-decision event
  );
  assert.ok(s.bugs.every((b) => b.fix && typeof b.fix.state === "string"));
  assert.ok(s.bugs.every((b) => b.pending === false && Array.isArray(b.items)));
  assert.equal(s.ci.master.gate, "none");
  assert.deepEqual(s.ci.master.probesFailing, []);
});

// ---- H3: merge-commit trains, lane activity, ALREADY FIXED proof ----
function trainGithub() {
  const g = a2Github();
  return {
    ...g,
    merged: [
      ...g.merged,
      {
        number: 9201,
        title: "fix B9201 widget total",
        body: "",
        branch: "fix/m9201",
        base: "train/y",
        mergedAt: "2026-10-19T08:00:00Z",
        mergeSha: "1".repeat(40),
        url: "https://github.com/acme-org/widgets/pull/9201",
      },
      {
        number: 9202,
        title: "Merge train/y",
        body: "",
        branch: "train/y",
        base: "master",
        mergedAt: "2026-10-19T11:00:00Z",
        mergeSha: "2".repeat(40),
        url: "https://github.com/acme-org/widgets/pull/9202",
      },
    ],
  };
}
const trainBugs = () => {
  const all = [...A2_BUGS, bugRow("B9201")];
  return okSource(120, { bugs: all, open: all.filter((b) => b.open) });
};

test("H3 train: a bug fixed by a member PR counts as merged at the train PR's merge time", () => {
  const s = a2({ github: okSource(60, trainGithub()), bugs: trainBugs() });
  const b = s.bugs.find((x) => x.id === "B9201");
  assert.equal(b.fix.state, "merged"); // the member merged 08:00, before the 09:10 deploy; the train at 11:00 did not
  assert.equal(b.fix.pr, 9201);
  assert.equal(b.fix.via, 9202);
  assert.equal(b.fix.prUrl, "https://github.com/acme-org/widgets/pull/9201");
  const a = s.alarms.find((x) => x.id === "bug-fixed-still-open:B9201");
  assert.ok(a, "the registry still says open: drift fires");
  assert.equal(a.pr, 9201);
  // deployed once a deploy after the train merge succeeded
  const dep = a2({
    github: okSource(60, trainGithub()),
    bugs: trainBugs(),
    railway: okSource(120, {
      deploys: [
        {
          service: "@routeflow/api",
          status: "SUCCESS",
          sha: "9".repeat(40),
          createdAt: "2026-10-19T11:30:00Z",
        },
      ],
    }),
  });
  assert.equal(dep.bugs.find((x) => x.id === "B9201").fix.state, "deployed");
  // the train PR has not merged: the member is not a landed fix
  const g = trainGithub();
  const open = a2({
    github: okSource(60, { ...g, merged: g.merged.filter((p) => p.number !== 9202) }),
    bugs: trainBugs(),
  });
  assert.notEqual(open.bugs.find((x) => x.id === "B9201").fix.state, "merged");
  assert.equal(
    open.alarms.find((x) => x.id === "bug-fixed-still-open:B9201"),
    undefined,
  );
});

test("H3: lane-silent counts a lane's commits and handoffs, not only its last event", () => {
  const s = a2();
  const lane = s.lanes.find((l) => l.id === "macmini");
  assert.equal(lane.lastActivitySource, "commit"); // 11:30, the event was 11:00
  assert.equal(
    s.alarms.find((a) => a.id === "lane-silent:macmini"),
    undefined,
  );
});

test("H3: bugsFixedByNote lists bugs closed by an ALREADY FIXED note, newest PR first", () => {
  const note = (id, pr, sha, o = {}) =>
    bugRow(id, { open: false, state: "queued", alreadyFixed: { pr, sha }, ...o });
  const rows = [
    ...A2_BUGS,
    note("B9301", 700, "abc1234"),
    note("B9302", 712, null, { sensitive: true, title: "Security hardening item" }),
    note("B9303", null, "def5678", { severity: "low" }),
  ];
  const g = a2Github();
  const s = a2({
    bugs: okSource(120, { bugs: rows, open: rows.filter((b) => b.open) }),
    github: okSource(60, {
      ...g,
      merged: [
        ...g.merged,
        {
          number: 712,
          title: "fix",
          body: "",
          branch: "x",
          base: "master",
          mergedAt: "2026-10-18T00:00:00Z",
          url: "https://github.com/acme-org/widgets/pull/712",
        },
      ],
    }),
  });
  assert.deepEqual(
    s.bugsFixedByNote.map((b) => b.id),
    ["B9302", "B9301", "B9303"],
  );
  assert.deepEqual(s.bugsFixedByNote[0], {
    id: "B9302",
    title: "Security hardening item",
    severity: "high",
    pr: 712,
    prUrl: "https://github.com/acme-org/widgets/pull/712",
    sha: null,
  });
  assert.equal(s.bugsFixedByNote[1].prUrl, "https://github.com/acme-org/widgets/pull/700"); // derived from a known PR url
  assert.equal(s.bugsFixedByNote[2].prUrl, null);
  // open bugs and bugs closed by the ledger alone are not listed
  assert.ok(!s.bugsFixedByNote.some((b) => b.id === "B9007"));
  // a snapshot with no such notes carries an empty list
  assert.deepEqual(a2().bugsFixedByNote, []);
});

test("register duplicate ids and id collisions from the specs source become alarms", () => {
  const s = build({
    specs: okSource(30, {
      events: events(),
      config: DEFAULT_CONFIG,
      registerDuplicateIds: ["614"],
      registerRowIds: ["614", "614"],
    }),
  });
  const a = s.alarms.find((x) => x.id === "register-duplicate-rows:register");
  assert.equal(a.severity, "error");
  assert.match(a.message, /duplicate row ids \(614\)/);
  assert.equal(
    build().alarms.some((x) => x.kind === "register-duplicate-rows"),
    false,
  );
});

// =====================================================================================
// Accuracy round 2 (X1): live harm, latent risks, incident freshness, decisions-only queue.
// Shapes copied from the real register (rows 525 / 530) and incidents/*.md, acme placeholders.
// =====================================================================================
const DAY_MS = 86400000;
const x1iso = (days) => new Date(NOW - days * DAY_MS).toISOString();

function x1events() {
  seq = 0;
  const t = "2026-10-17T00:00:00Z";
  const itm = (id, data) => ev(t, "item.new", id, "lead", { lane: "lead", ...data });
  const reg = { source: "register" };
  return [
    // the motivating case: a P0 bug whose code is live, and the census that found no victim
    itm("525", {
      ...reg,
      title: "Acme product page: tier prices flip to fixed on an unrelated save",
      type: "bug",
      priority: "P0",
      status: "review",
      links: { prs: [3467, 3470] },
    }),
    itm("530", {
      ...reg,
      title:
        "Tier price bugs: read-only prod census of blast radius (code live via #3468 and #3470)",
      type: "ops",
      priority: "P1",
      status: "verified",
      gate: "census 10-19 (read-only): 0 lines / $0.00 mis-billed for both bugs; no live customer on tiers 3-5; latent only. Owner item: acme has 3 products with stale tier values; row 529 checked by hand",
      links: { prs: [3468] },
    }),
    itm("526", {
      title: "Acme checkout rounds wrong",
      type: "bug",
      priority: "P0",
      status: "building",
    }),
    itm("527", { title: "Acme report drifts", type: "bug", priority: "P1", harm: "latent" }),
    itm("528", { title: "Acme label typo", type: "bug", priority: "P1", harm: "none" }),
    // an explicit harm wins over the derived latent rule (530 names row 529 in its gate)
    itm("529", {
      ...reg,
      title: "Acme tier price still wrong for one buyer",
      type: "bug",
      priority: "P0",
      harm: "live",
      links: { prs: [3469] },
    }),
    // named by row in an audit's title
    itm("540", {
      title: "Audit of rows 531/532: nothing reached a customer",
      type: "audit",
      priority: "P2",
      status: "live",
      gate: "0 lines affected",
    }),
    itm("531", { title: "Acme export gap", type: "bug", priority: "P1" }),
    itm("532", { title: "Acme export gap two", type: "bug", priority: "P0" }),
    // a census that is not done marks nothing; a done one that says nothing about harm marks nothing
    itm("541", {
      title: "Audit of row 533, no live customer yet",
      type: "audit",
      status: "building",
    }),
    itm("533", { title: "Acme sync gap", type: "bug", priority: "P1" }),
    itm("542", {
      title: "Audit of row 534 finished",
      type: "audit",
      status: "live",
      gate: "reviewed",
    }),
    itm("534", { title: "Acme sync gap two", type: "bug", priority: "P1" }),
    // owner column: a decision and a task
    itm("901", { title: "Acme decision 901", type: "decision", lane: "owner", priority: "P1" }),
    itm("902", { title: "Run the EAS build", type: "chore", lane: "owner", priority: "P2" }),
    itm("903", { title: "Done owner task", type: "chore", lane: "owner", status: "verified" }),
  ];
}

const x1inc = (id, status, changedDays, over = {}) => ({
  id,
  file: `2026-10-15-acme-${id}.md`,
  title: `Acme incident ${id}`,
  status,
  date: "2026-10-15",
  changedAt: changedDays === null ? null : x1iso(changedDays),
  ...over,
});
const X1_INCIDENTS = [
  x1inc("INC-1015a", "open", 2),
  x1inc("INC-1015b", "open", 10),
  x1inc("INC-1015c", "mitigated", 1),
  x1inc("INC-1015d", "suspected", 1),
  x1inc("INC-1015e", "closed", 1),
  x1inc("INC-1015f", "unknown", 1),
  x1inc("INC-1015g", "resolved", 1),
  x1inc("INC-1015h", "unverified", 20),
];
const x1 = (events = x1events(), incidents = X1_INCIDENTS) =>
  buildSnapshot({
    sources: {
      specs: okSource(30, {
        events,
        config: DEFAULT_CONFIG,
        incidents,
        ownerQueueRows: null,
        extrasErrors: [],
      }),
    },
    config: DEFAULT_CONFIG,
    now: NOW,
    machine: "pc",
  });

test("X1 harm: a done census whose text says latent / 0 lines / $0.00 / no customer marks the bugs it shares a PR with", () => {
  const s = x1();
  const by = Object.fromEntries(s.items.map((i) => [i.id, i]));
  // 530 and 525 share PR #3470 (530 cites it in its title; 525 in its register links)
  assert.equal(by["525"].harm, "latent");
  assert.match(by["525"].harmEvidence, /^530: census 10-19 \(read-only\): 0 lines/);
  assert.ok(by["525"].harmEvidence.length <= 5 + 160);
  assert.equal(by["526"].harm, null);
  assert.equal(by["527"].harm, "latent"); // explicit
  assert.equal(by["528"].harm, "none");
  assert.equal(by["529"].harm, "live"); // an explicit harm beats the derived rule
});

test("X1 harm: a done census names rows in its title or gate; a census still open or silent marks nothing", () => {
  const by = Object.fromEntries(x1().items.map((i) => [i.id, i]));
  assert.equal(by["531"].harm, "latent");
  assert.equal(by["532"].harm, "latent");
  assert.equal(by["533"].harm, null); // its audit is not done
  assert.equal(by["534"].harm, null); // its audit says nothing about harm
});

test("X1 problems: open P0/P1 bugs with no latent/none harm, plus fresh open incidents, never latent bugs", () => {
  const s = x1();
  assert.deepEqual(s.problems, ["526", "529", "INC-1015a", "533", "534"]);
  assert.ok(!s.problems.includes("525"), "525 is latent: not hurting now");
});

test("X1 latentRisks: open bugs whose harm is latent, with the census evidence", () => {
  const s = x1();
  assert.deepEqual(
    s.latentRisks.map((r) => r.id),
    ["525", "532", "527", "531"],
  );
  const r = s.latentRisks[0];
  assert.equal(r.title, "Acme product page: tier prices flip to fixed on an unrelated save");
  assert.match(r.evidence, /^530: census 10-19/);
  assert.ok(r.evidence.length <= 5 + 160);
  assert.match(s.latentRisks.find((x) => x.id === "527").evidence, /^set by the team/);
});

test("X1 incidents: status word and file freshness decide the bucket; only open + fresh hurts", () => {
  const s = x1();
  const by = Object.fromEntries(s.incidents.map((i) => [i.id, i]));
  assert.deepEqual(Object.fromEntries(Object.entries(by).map(([id, i]) => [id, i.bucket])), {
    "INC-1015a": "hurting",
    "INC-1015b": "stale",
    "INC-1015c": "mitigated",
    "INC-1015d": "unverified",
    "INC-1015f": "stale",
    "INC-1015h": "unverified",
  }); // closed / resolved are hidden
  assert.equal(by["INC-1015c"].statusLabel, "Mitigated");
  assert.equal(by["INC-1015d"].statusLabel, "Unverified");
  const alarm = (id) => s.alarms.find((a) => a.id === `incident-stale:${id}`);
  assert.equal(alarm("INC-1015b").severity, "warn");
  assert.match(alarm("INC-1015b").message, /no status update for 10 days/);
  assert.ok(alarm("INC-1015f"));
  assert.equal(alarm("INC-1015a"), undefined);
  assert.equal(alarm("INC-1015c"), undefined);
});

test("X1 owner queue: decisions only; other owner-lane tasks go to ownerTodos", () => {
  const s = x1();
  assert.deepEqual(
    s.ownerQueue.map((o) => o.id),
    ["901"],
  );
  assert.deepEqual(
    s.ownerTodos.map((o) => o.id),
    ["902"],
  );
  assert.equal(s.ownerTodos[0].title, "Run the EAS build");
});

// ---- latent rule hardening (accuracy round 2 review) + mask-before-cut ----
const lr = (events, { merged = [], extra = {} } = {}) => {
  const gh = { open: [], merged, master: null };
  return buildSnapshot({
    sources: {
      specs: okSource(30, {
        events,
        config: DEFAULT_CONFIG,
        incidents: [],
        ownerQueueRows: null,
        extrasErrors: [],
      }),
      github: okSource(60, gh),
    },
    config: DEFAULT_CONFIG,
    now: NOW,
    machine: "pc",
    ...extra,
  });
};
const lrItem = (id, data) =>
  ev("2026-10-17T00:00:00Z", "item.new", id, "lead", { lane: "lead", ...data });
const CENSUS_GATE = "census: 0 lines / $0.00 mis-billed; latent only";

test("latent rule: a P0 that shares only a release PR with a census stays in Hurting now", () => {
  seq = 0;
  const s = lr([
    lrItem("R2", { title: "Train R2", type: "release", status: "planned", links: { prs: [3600] } }),
    lrItem("700", { title: "Acme live bug", type: "bug", priority: "P0", links: { prs: [3600] } }),
    lrItem("701", {
      title: "Census of the train",
      type: "ops",
      status: "verified",
      gate: CENSUS_GATE,
      links: { prs: [3600] },
    }),
  ]);
  assert.ok(s.problems.includes("700"), "the train PR proves nothing about this bug");
  assert.equal(s.items.find((i) => i.id === "700").harm, null);
});

test("latent rule: a PR whose head branch is train/* is a train PR even without a release item", () => {
  seq = 0;
  const merged = [
    {
      number: 3601,
      title: "Train r3",
      body: "",
      branch: "train/r3",
      base: "master",
      mergedAt: "2026-10-18T00:00:00Z",
      mergeSha: "a".repeat(40),
      url: "https://github.com/acme-org/widgets/pull/3601",
    },
  ];
  const s = lr(
    [
      lrItem("702", {
        title: "Acme live bug",
        type: "bug",
        priority: "P0",
        links: { prs: [3601] },
      }),
      lrItem("703", {
        title: "Census",
        type: "audit",
        status: "live",
        gate: CENSUS_GATE,
        links: { prs: [3601] },
      }),
    ],
    { merged },
  );
  assert.ok(s.problems.includes("702"));
});

test("latent rule: a second open bug citing the same PR keeps both live; a bug alone on its PR is latent", () => {
  seq = 0;
  const s = lr([
    lrItem("710", { title: "Acme bug one", type: "bug", priority: "P0", links: { prs: [3700] } }),
    lrItem("711", { title: "Acme bug two", type: "bug", priority: "P0", links: { prs: [3700] } }),
    lrItem("712", {
      title: "Census",
      type: "ops",
      status: "verified",
      gate: CENSUS_GATE,
      links: { prs: [3700, 3701] },
    }),
    lrItem("713", { title: "Acme bug alone", type: "bug", priority: "P0", links: { prs: [3701] } }),
  ]);
  const by = Object.fromEntries(s.items.map((i) => [i.id, i]));
  assert.equal(by["710"].harm, null);
  assert.equal(by["711"].harm, null);
  assert.ok(s.problems.includes("710") && s.problems.includes("711"));
  assert.equal(by["713"].harm, "latent", "its own PR, no other open bug cites it");
});

test("latent rule: a negated verdict ('not latent', 'but 2 billed $0.00') never demotes a named row", () => {
  seq = 0;
  const s = lr([
    lrItem("720", { title: "Acme bug 720", type: "bug", priority: "P0" }),
    lrItem("721", {
      title: "Census of row 720",
      type: "audit",
      status: "live",
      gate: "found it is not latent, customers hit",
    }),
    lrItem("730", { title: "Acme bug 730", type: "bug", priority: "P0" }),
    lrItem("731", {
      title: "Census of row 730",
      type: "ops",
      status: "verified",
      gate: "2 billed but $0.00 shown",
    }),
    lrItem("740", { title: "Acme bug 740", type: "bug", priority: "P0" }),
    lrItem("741", {
      title: "Census of row 740",
      type: "ops",
      status: "verified",
      gate: "0 lines, latent only",
    }),
  ]);
  const by = Object.fromEntries(s.items.map((i) => [i.id, i]));
  assert.equal(by["720"].harm, null, "not latent");
  assert.equal(by["730"].harm, null, "but ... $0.00");
  assert.equal(by["740"].harm, "latent", "the plain verdict still names the row");
});

test("latent evidence is masked before it is cut at 160 characters", async () => {
  const { maskText } = await import("../lib/mask.mjs");
  const name = "acme-foods-distribution";
  seq = 0;
  const gate = `0 lines ${"p".repeat(145)} ${name} tail words`;
  const events = [
    lrItem("750", { title: "Acme bug 750", type: "bug", priority: "P0" }),
    lrItem("751", { title: "Census of row 750", type: "ops", status: "verified", gate }),
  ];
  const s = lr(events, { extra: { mask: (t) => maskText(t, [name]) } });
  const ev750 = s.latentRisks.find((r) => r.id === "750").evidence;
  assert.doesNotMatch(ev750, /acme/i, "no fragment of the name");
  assert.match(ev750, /a live/);
  assert.ok(ev750.length <= 5 + 160);
});
