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
      "branches",
      "bugs",
      "ci",
      "decisions",
      "generatedAt",
      "items",
      "lanes",
      "machine",
      "map",
      "ownerQueue",
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
  });
  assert.equal(s.bugs[1].area, "api:invoices");
});

test("trains: members union of item.members and train field", () => {
  const s = build();
  assert.deepEqual(s.trains, [
    { id: "R1", title: "R1 product window", status: "building", eta: "10-25", members: ["525"] },
  ]);
});

test("lanes: config plus seen, now/next/silent", () => {
  const s = build();
  const ids = s.lanes.map((l) => l.id);
  assert.deepEqual(
    ids.slice(0, 7),
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
  assert.deepEqual(s.ownerQueue, [
    {
      id: "600",
      title: "Pick the plan wording",
      gate: "Owner decision needed",
      eta: null,
      status: "planned",
    },
  ]);
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
  assert.equal(got["status-behind-merge:525"], "error");
  assert.equal(got["claim-conflict:700"], "error");
  assert.equal(got["anomaly:999"], "error");
  assert.equal(got["anomaly:700"], "error"); // fold records the claim conflict as an anomaly too
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
