import test from "node:test";
import assert from "node:assert/strict";
import { fold } from "../lib/fold.mjs";
import { rankCandidates, pickNext, laneNow } from "../lib/next.mjs";
import { DEFAULT_CONFIG } from "../lib/config.mjs";

const NOW = Date.UTC(2026, 9, 19, 6, 0, 0);
let seq = 0;
function ev(kind, item, data, lane = "pc-lane") {
  const ms = Date.UTC(2026, 9, 19, 4, 0, 0) + seq * 1000;
  return {
    v: 1,
    id: `testbox-${ms}-${(seq++).toString(36).padStart(4, "0")}`,
    ts: new Date(ms).toISOString(),
    machine: "testbox",
    actor: "t",
    lane,
    kind,
    item,
    data,
  };
}
const mk = (id, f = {}) => ev("item.new", id, { title: `Item ${id}`, type: "feature", ...f });
const config = DEFAULT_CONFIG;
const ids = (r) => r.map((c) => c.item.id);

test("assigned items rank by priority, train, eta, id", () => {
  const s = fold([
    mk("10", { lane: "pc-lane", priority: "P2" }),
    mk("11", { lane: "pc-lane", priority: "P1", train: "R3" }),
    mk("12", { lane: "pc-lane", priority: "P1", train: "R2", eta: "10-25" }),
    mk("13", { lane: "pc-lane", priority: "P1", train: "R2", eta: "10-20" }),
    mk("14", { lane: "pc-lane", priority: "P0" }),
    mk("9", { lane: "pc-lane", priority: "P2" }),
    mk("15", { lane: "macmini", priority: "P0" }),
  ]);
  const r = rankCandidates(s, "pc-lane", config, { now: NOW });
  assert.deepEqual(ids(r), ["14", "13", "12", "11", "9", "10"]);
  assert.equal(r[1].reason, "P1 · R2 · assigned to pc-lane");
  assert.equal(r[0].reason, "P0 · assigned to pc-lane");
  assert.equal(pickNext(s, "pc-lane", config, { now: NOW }).item.id, "14");
});

test("filters: status, type, blocked, claimed, open children", () => {
  const s = fold([
    mk("1", { lane: "pc-lane", status: "building" }),
    mk("2", { lane: "pc-lane", type: "release" }),
    mk("3", { lane: "pc-lane", type: "epic" }),
    mk("4", { lane: "pc-lane" }),
    ev("blocked", "4", { by: "x" }),
    mk("5", { lane: "pc-lane" }),
    ev("claim", "5", {}, "someone"),
    mk("6", { lane: "pc-lane" }),
    mk("7", { lane: "pc-lane", parent: "6" }),
    mk("8", { lane: "pc-lane", status: "spec" }),
    mk("20", { lane: "pc-lane", parent: "21", status: "live" }),
    mk("21", { lane: "pc-lane" }),
  ]);
  assert.deepEqual(ids(rankCandidates(s, "pc-lane", config, { now: NOW })).sort(), [
    "21",
    "7",
    "8",
  ]);
});

test("unassigned items match by lane areas (*, domain, exact area)", () => {
  const s = fold([
    mk("1", { area: "api:invoices" }),
    mk("2", { area: "domain:catalog" }),
    mk("3", { area: "api:products" }),
    mk("4"),
    mk("5", { area: "api:invoices", lane: "macbook" }),
  ]);
  assert.deepEqual(ids(rankCandidates(s, "pc-lane", config, { now: NOW })).sort(), [
    "1",
    "2",
    "3",
    "4",
  ]);
  const cfg = {
    ...config,
    lanes: [
      { id: "mm", areas: ["domain:catalog"] },
      { id: "ex", areas: ["api:invoices"] },
      { id: "none", areas: [] },
    ],
  };
  assert.deepEqual(ids(rankCandidates(s, "mm", cfg, { now: NOW })).sort(), ["2", "3"]);
  assert.deepEqual(ids(rankCandidates(s, "ex", cfg, { now: NOW })), ["1"]);
  assert.deepEqual(rankCandidates(s, "none", cfg, { now: NOW }), []);
  assert.equal(pickNext(s, "none", cfg, { now: NOW }), null);
  assert.equal(rankCandidates(s, "ex", cfg, { now: NOW })[0].reason, "P2 · area match");
});

test("numeric ids sort numerically before string ids", () => {
  const s = fold([
    mk("100", { lane: "a" }),
    mk("9", { lane: "a" }),
    mk("K1-2", { lane: "a" }),
    mk("B5", { lane: "a" }),
  ]);
  const cfg = { ...config, lanes: [{ id: "a", areas: [] }] };
  assert.deepEqual(ids(rankCandidates(s, "a", cfg, { now: NOW })), ["9", "100", "B5", "K1-2"]);
});

test("laneNow", () => {
  const s = fold([
    mk("1", { lane: "a", status: "building" }),
    mk("2", { lane: "a", status: "planned" }),
    mk("3", { lane: "b", status: "building" }),
    mk("4", { lane: "a", status: "review" }),
    ev("claim", "4", {}, "a"),
    mk("5", { lane: "b" }),
    ev("claim", "5", {}, "a"),
  ]);
  assert.deepEqual(laneNow(s, "a").sort(), ["1", "4", "5"]);
});
