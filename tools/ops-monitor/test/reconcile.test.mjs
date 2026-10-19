import test from "node:test";
import assert from "node:assert/strict";
import { reconcile, linkItemFor } from "../lib/reconcile.mjs";
import { DEFAULT_CONFIG } from "../lib/config.mjs";

const NOW = Date.parse("2026-10-19T12:00:00Z");
const MIN = 60000;
const HOUR = 60 * MIN;

function item(id, over = {}) {
  return {
    id,
    title: `Item ${id}`,
    type: "feature",
    priority: "P2",
    status: "building",
    lane: null,
    train: null,
    area: null,
    parent: null,
    eta: null,
    gate: null,
    trainLabel: null,
    source: null,
    tags: [],
    members: [],
    related: [],
    links: { prs: [], branches: [], urls: [] },
    children: [],
    claimedBy: null,
    claimedAt: null,
    claimConflict: null,
    blocked: null,
    createdAt: 0,
    updatedAt: 0,
    history: [],
    overlay: false,
    ...over,
  };
}
function mkState(items = [], over = {}) {
  return {
    items: new Map(items.map((i) => [i.id, i])),
    lanes: new Map(),
    decisions: [],
    rulings: [],
    notes: [],
    pushes: [],
    prEvents: [],
    anomalies: [],
    eventCount: 0,
    lastEventAt: null,
    machines: {},
    ...over,
  };
}
const freshSources = () => ({
  specs: { ok: true, at: NOW - 10_000, intervalSec: 30 },
  github: { ok: true, at: NOW - 10_000, intervalSec: 45 },
  railway: { ok: true, at: NOW - 10_000, intervalSec: 120 },
});
const run = (over = {}) =>
  reconcile({
    state: mkState(),
    prs: { open: [], merged: [] },
    branches: [],
    sources: freshSources(),
    config: DEFAULT_CONFIG,
    now: NOW,
    ...over,
  });
const find = (alarms, id) => alarms.find((a) => a.id === id);

test("clean world has no alarms", () => {
  assert.deepEqual(run(), []);
});

test("status-behind-merge: error with exact id and suggestion", () => {
  const state = mkState([item("525", { links: { prs: ["3467"], branches: [], urls: [] } })]);
  const prs = {
    open: [],
    merged: [
      {
        number: 3467,
        branch: "feat/x",
        mergedAt: new Date(NOW - 3 * HOUR).toISOString(),
        base: "master",
      },
    ],
  };
  const a = find(run({ state, prs }), "status-behind-merge:525");
  assert.equal(a.severity, "error");
  assert.equal(a.suggest, "rf status 525 live");
  assert.match(a.message, /PR #3467 merged 3h ago but item is building/);
});

test("status-behind-merge: via prEvents; negatives (done, idea, non-master base)", () => {
  const prs = {
    open: [],
    merged: [
      { number: 9, branch: "b", mergedAt: new Date(NOW - HOUR).toISOString(), base: "master" },
    ],
  };
  const viaEvent = mkState([item("7")], {
    prEvents: [{ ts: 1, number: 9, action: "create", item: "7" }],
  });
  assert.ok(find(run({ state: viaEvent, prs }), "status-behind-merge:7"));
  for (const status of ["live", "verified", "idea"]) {
    const s = mkState([item("7", { status, links: { prs: [9], branches: [], urls: [] } })]);
    assert.equal(find(run({ state: s, prs }), "status-behind-merge:7"), undefined, status);
  }
  const s = mkState([item("7", { links: { prs: [9], branches: [], urls: [] } })]);
  const other = { open: [], merged: [{ ...prs.merged[0], base: "train/x" }] };
  assert.equal(find(run({ state: s, prs: other }), "status-behind-merge:7"), undefined);
});

test("untracked-pr: warn when nothing links it; tracked by link, branch link, or branch id", () => {
  const pr = { number: 3500, title: "t", branch: "feat/orphan", draft: false };
  const a = find(run({ prs: { open: [pr], merged: [] } }), "untracked-pr:3500");
  assert.equal(a.severity, "warn");
  assert.equal(a.suggest, "rf event link <id> --pr 3500");
  const byPr = mkState([item("1", { links: { prs: [3500], branches: [], urls: [] } })]);
  assert.equal(
    find(run({ state: byPr, prs: { open: [pr], merged: [] } }), "untracked-pr:3500"),
    undefined,
  );
  const byBranch = mkState([
    item("1", { links: { prs: [], branches: ["feat/orphan"], urls: [] } }),
  ]);
  assert.equal(
    find(run({ state: byBranch, prs: { open: [pr], merged: [] } }), "untracked-pr:3500"),
    undefined,
  );
  const byName = { ...pr, branch: "fix/b230-dispatch" };
  assert.equal(find(run({ prs: { open: [byName], merged: [] } }), "untracked-pr:3500"), undefined);
  const byNumeric = { ...pr, branch: "feat/525-thing" };
  assert.equal(
    find(
      run({ state: mkState([item("525")]), prs: { open: [byNumeric], merged: [] } }),
      "untracked-pr:3500",
    ),
    undefined,
  );
});

test("untracked-branch: info within 48h without PR/item; negatives", () => {
  const b = { branch: "feat/loose", sha: "abc1234", date: new Date(NOW - 5 * HOUR).toISOString() };
  const a = find(run({ branches: [b] }), "untracked-branch:feat/loose");
  assert.equal(a.severity, "info");
  const old = { ...b, date: new Date(NOW - 49 * HOUR).toISOString() };
  assert.equal(find(run({ branches: [old] }), "untracked-branch:feat/loose"), undefined);
  assert.equal(
    find(run({ branches: [{ ...b, pr: 12 }] }), "untracked-branch:feat/loose"),
    undefined,
  );
  const withPr = { open: [{ number: 1, branch: "feat/loose" }], merged: [] };
  assert.equal(find(run({ branches: [b], prs: withPr }), "untracked-branch:feat/loose"), undefined);
  const linked = mkState([item("3", { links: { prs: [], branches: ["feat/loose"], urls: [] } })]);
  assert.equal(
    find(run({ branches: [b], state: linked }), "untracked-branch:feat/loose"),
    undefined,
  );
});

test("claim-conflict: error per conflicted item only", () => {
  const state = mkState([item("5", { claimConflict: ["pc-lane", "macmini"] }), item("6")]);
  const alarms = run({ state });
  assert.equal(find(alarms, "claim-conflict:5").severity, "error");
  assert.equal(find(alarms, "claim-conflict:6"), undefined);
});

test("lane-silent: warn only with claims and past the threshold", () => {
  const lanes = new Map([
    [
      "pc-lane",
      { id: "pc-lane", lastEventAt: NOW - 31 * MIN, lastEventKind: "note", claims: ["5"] },
    ],
    [
      "macmini",
      { id: "macmini", lastEventAt: NOW - 29 * MIN, lastEventKind: "note", claims: ["6"] },
    ],
    ["lead", { id: "lead", lastEventAt: NOW - 5 * HOUR, lastEventKind: "note", claims: [] }],
  ]);
  const alarms = run({ state: mkState([], { lanes }) });
  assert.equal(find(alarms, "lane-silent:pc-lane").severity, "warn");
  assert.equal(find(alarms, "lane-silent:macmini"), undefined);
  assert.equal(find(alarms, "lane-silent:lead"), undefined);
});

test("past-eta: warn when eta passed and not done; negatives", () => {
  const state = mkState([
    item("1", { eta: "10-18 ~04:00Z" }),
    item("2", { eta: "10-19 ~13:00Z" }),
    item("3", { eta: "10-10", status: "live" }),
    item("4", { eta: "after census" }),
  ]);
  const alarms = run({ state });
  assert.equal(find(alarms, "past-eta:1").severity, "warn");
  assert.equal(find(alarms, "past-eta:2"), undefined);
  assert.equal(find(alarms, "past-eta:3"), undefined);
  assert.equal(find(alarms, "past-eta:4"), undefined);
});

test("stale-source: severity by source, never-ok, ISO at, and fresh negative", () => {
  const sources = {
    specs: { ok: true, at: NOW - 100 * 1000, intervalSec: 30 },
    github: { ok: false, at: null, error: "gh: not logged in", intervalSec: 45 },
    railway: { ok: true, at: new Date(NOW - 400 * 1000).toISOString(), intervalSec: 120 },
    bugs: { ok: true, at: NOW - 100 * 1000, intervalSec: 120 },
  };
  const alarms = run({ sources });
  assert.equal(find(alarms, "stale-source:specs").severity, "error");
  const g = find(alarms, "stale-source:github");
  assert.equal(g.severity, "error");
  assert.match(g.message, /not logged in/);
  assert.equal(find(alarms, "stale-source:railway").severity, "warn");
  assert.equal(find(alarms, "stale-source:bugs"), undefined);
  // boundary: exactly interval x factor is not stale
  const edge = run({ sources: { specs: { ok: true, at: NOW - 90_000, intervalSec: 30 } } });
  assert.equal(find(edge, "stale-source:specs"), undefined);
});

test("anomaly: one error per anomaly, kind in message, ids disambiguated", () => {
  const state = mkState([], {
    anomalies: [
      { kind: "unknown-item", eventId: "pc-1", item: "999", detail: "no such item" },
      { kind: "invalid-event", eventId: "pc-2", item: null, detail: "bad json" },
      { kind: "claim-conflict", eventId: "pc-3", item: "999", detail: "x" },
    ],
  });
  const alarms = run({ state });
  const a = find(alarms, "anomaly:999");
  assert.equal(a.severity, "error");
  assert.match(a.message, /unknown-item/);
  assert.ok(find(alarms, "anomaly:pc-2"));
  assert.ok(find(alarms, "anomaly:999#2"));
  assert.equal(alarms.filter((x) => x.kind === "anomaly").length, 3);
});

test("sorted error, warn, info then id", () => {
  const state = mkState([item("2", { eta: "10-01" }), item("1", { eta: "10-01" })], {
    anomalies: [{ kind: "invalid-event", eventId: "pc-9", item: null, detail: "x" }],
  });
  const b = { branch: "feat/z", sha: "abc1234", date: new Date(NOW - HOUR).toISOString() };
  const ids = run({ state, branches: [b] }).map((a) => a.id);
  assert.deepEqual(ids, ["anomaly:pc-9", "past-eta:1", "past-eta:2", "untracked-branch:feat/z"]);
});

test("linkItemFor maps number, branch, prEvents and branch ids", () => {
  const state = mkState(
    [item("525", { links: { prs: [3467], branches: ["feat/a"], urls: [] } }), item("9")],
    { prEvents: [{ ts: 1, number: 70, action: "create", item: "9" }] },
  );
  assert.equal(linkItemFor({ number: 3467 }, state), "525");
  assert.equal(linkItemFor({ branch: "feat/a" }, state), "525");
  assert.equal(linkItemFor({ number: 70 }, state), "9");
  assert.equal(linkItemFor({ branch: "fix/b12-x" }, state), "B12");
  assert.equal(linkItemFor({ number: 1, branch: "feat/none" }, state), null);
});
