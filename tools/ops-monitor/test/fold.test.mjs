import test from "node:test";
import assert from "node:assert/strict";
import { fold } from "../lib/fold.mjs";
import { validateEvent } from "../lib/schema.mjs";

let seq = 0;
const T0 = Date.UTC(2026, 9, 19, 4, 0, 0);
/** Builds a valid event; `min` = minutes after T0. */
function ev(
  kind,
  item,
  data,
  { min = seq, lane = "pc-lane", machine = "testbox", actor = "t" } = {},
) {
  const ms = T0 + min * 60000;
  return {
    v: 1,
    id: `${machine}-${String(ms)}-${(seq++).toString(36).padStart(4, "0")}`,
    ts: new Date(ms).toISOString(),
    machine,
    actor,
    lane,
    kind,
    item,
    data,
  };
}
const newItem = (id, fields = {}, o) =>
  ev("item.new", id, { title: `Item ${id}`, type: "feature", ...fields }, o);

test("helper builds schema-valid events", () => {
  assert.deepEqual(validateEvent(newItem("5")).errors, []);
});

test("item.new defaults and fields", () => {
  const s = fold([
    newItem("5", { priority: "P1", train: "R2", area: "api:orders", tags: ["x"] }, { min: 0 }),
  ]);
  const it = s.items.get("5");
  assert.equal(it.title, "Item 5");
  assert.equal(it.priority, "P1");
  assert.equal(it.status, "planned");
  assert.equal(it.lane, null);
  assert.equal(it.train, "R2");
  assert.deepEqual(it.tags, ["x"]);
  assert.deepEqual(it.links, { prs: [], branches: [], urls: [] });
  assert.equal(it.claimedBy, null);
  assert.equal(it.overlay, false);
  assert.equal(it.createdAt, T0);
  assert.equal(s.eventCount, 1);
  const d = fold([newItem("6")]).items.get("6");
  assert.equal(d.priority, "P2");
});

test("sorting by (ts, id) makes input order irrelevant", () => {
  const a = newItem("1", {}, { min: 0 });
  const b = ev("status", "1", { status: "building" }, { min: 1 });
  const c = ev("status", "1", { status: "review" }, { min: 2 });
  assert.equal(fold([c, a, b]).items.get("1").status, "review");
  assert.equal(fold([a, b, c]).items.get("1").status, "review");
});

test("duplicate item.new: first wins, anomaly", () => {
  const s = fold([
    newItem("5", { title: "first" }, { min: 0 }),
    newItem("5", { title: "second" }, { min: 1 }),
  ]);
  assert.equal(s.items.get("5").title, "first");
  assert.equal(s.anomalies.length, 1);
  assert.equal(s.anomalies[0].kind, "duplicate-item");
  assert.equal(s.anomalies[0].item, "5");
});

test("invalid events and __invalid lines become anomalies", () => {
  const bad = { v: 1, id: "nope" };
  const s = fold([
    newItem("5"),
    bad,
    { __invalid: true, raw: "{oops", file: "events/x/a.jsonl", line: 3 },
  ]);
  assert.equal(s.items.size, 1);
  const inv = s.anomalies.filter((a) => a.kind === "invalid-event");
  assert.equal(inv.length, 2);
  assert.ok(inv.some((a) => /a\.jsonl/.test(a.detail) && /3/.test(a.detail)));
  assert.equal(s.eventCount, 1);
});

test("unknown item is skipped; bug id creates an overlay", () => {
  const bugs = new Map([["B12", { title: "Totals wrong", state: "open", severity: "high" }]]);
  const s = fold(
    [
      ev("status", "99", { status: "live" }, { min: 0 }),
      ev("claim", "B12", {}, { min: 1 }),
      ev("note", "B77", { text: "hi" }, { min: 2 }),
    ],
    { bugs },
  );
  assert.equal(s.items.has("99"), false);
  assert.deepEqual(
    s.anomalies.map((a) => [a.kind, a.item]),
    [["unknown-item", "99"]],
  );
  const b = s.items.get("B12");
  assert.equal(b.overlay, true);
  assert.equal(b.type, "bug");
  assert.equal(b.title, "Totals wrong");
  assert.equal(b.status, "planned");
  assert.equal(b.source, "registry");
  assert.equal(b.claimedBy, "pc-lane");
  assert.equal(s.items.get("B77").title, "B77");
});

test("item.edit merges fields; links merged and deduped", () => {
  const s = fold([
    newItem("5", { links: { prs: [1], branches: ["a"] } }, { min: 0 }),
    ev(
      "item.edit",
      "5",
      { fields: { title: "New", priority: "P0", links: { prs: [1, 2], urls: ["u"] } } },
      { min: 1 },
    ),
  ]);
  const it = s.items.get("5");
  assert.equal(it.title, "New");
  assert.equal(it.priority, "P0");
  assert.deepEqual(it.links, { prs: [1, 2], branches: ["a"], urls: ["u"] });
});

test("claim, release, steal, conflict", () => {
  const s = fold([
    newItem("5", {}, { min: 0 }),
    ev("claim", "5", { branch: "feat/5-x" }, { min: 1, lane: "a" }),
    ev("claim", "5", {}, { min: 2, lane: "b" }),
  ]);
  const it = s.items.get("5");
  assert.equal(it.claimedBy, "a");
  assert.deepEqual(it.claimConflict, ["a", "b"]);
  assert.deepEqual(it.links.branches, ["feat/5-x"]);
  assert.equal(s.anomalies[0].kind, "claim-conflict");
  assert.deepEqual(s.lanes.get("a").claims, ["5"]);
  assert.deepEqual(s.lanes.get("b").claims, []);

  const s2 = fold([
    newItem("5", {}, { min: 0 }),
    ev("claim", "5", {}, { min: 1, lane: "a" }),
    ev("claim", "5", { steal: true }, { min: 2, lane: "b" }),
  ]);
  assert.equal(s2.items.get("5").claimedBy, "b");
  assert.equal(s2.anomalies.length, 0);

  const s3 = fold([
    newItem("5", {}, { min: 0 }),
    ev("claim", "5", {}, { min: 1, lane: "a" }),
    ev("release", "5", {}, { min: 2, lane: "b" }), // not the holder: ignored
  ]);
  assert.equal(s3.items.get("5").claimedBy, "a");
  const s4 = fold([
    newItem("5", {}, { min: 0 }),
    ev("claim", "5", {}, { min: 1, lane: "a" }),
    ev("release", "5", {}, { min: 2, lane: "a" }),
  ]);
  assert.equal(s4.items.get("5").claimedBy, null);
});

test("done status auto-releases the claim", () => {
  const s = fold([
    newItem("5", {}, { min: 0 }),
    ev("claim", "5", {}, { min: 1, lane: "a" }),
    ev("status", "5", { status: "building" }, { min: 2, lane: "a" }),
    ev("status", "5", { status: "live" }, { min: 3, lane: "a" }),
  ]);
  assert.equal(s.items.get("5").status, "live");
  assert.equal(s.items.get("5").claimedBy, null);
  assert.deepEqual(s.lanes.get("a").claims, []);
});

test("blocked / unblocked", () => {
  const s = fold([
    newItem("5", {}, { min: 0 }),
    ev("blocked", "5", { by: "acme", unblocker: "owner" }, { min: 1 }),
  ]);
  assert.deepEqual(s.items.get("5").blocked, { by: "acme", unblocker: "owner", at: T0 + 60000 });
  const s2 = fold([
    newItem("5", {}, { min: 0 }),
    ev("blocked", "5", { by: "acme" }, { min: 1 }),
    ev("unblocked", "5", {}, { min: 2 }),
  ]);
  assert.equal(s2.items.get("5").blocked, null);
});

test("link merges", () => {
  const s = fold([
    newItem("5", {}, { min: 0 }),
    ev("link", "5", { prs: [3], branches: ["b1"] }, { min: 1 }),
    ev("link", "5", { prs: [3, 4], urls: ["http://x"] }, { min: 2 }),
  ]);
  assert.deepEqual(s.items.get("5").links, { prs: [3, 4], branches: ["b1"], urls: ["http://x"] });
});

test("push resolves item by branch link, claim holder lane, or branch name", () => {
  const sha = "abcdef1234";
  const s = fold([
    newItem("525", {}, { min: 0 }),
    newItem("600", {}, { min: 0 }),
    ev("claim", "525", { branch: "feat/mine" }, { min: 1, lane: "a" }),
    ev("push", null, { branch: "feat/mine", sha, repo: "acme/w" }, { min: 2, lane: null }),
    ev("push", null, { branch: "feat/600-thing", sha, repo: "acme/w" }, { min: 3, lane: "c" }),
    ev("push", null, { branch: "feat/b44-bug", sha, repo: "acme/w" }, { min: 4, lane: "c" }),
    ev("push", null, { branch: "random", sha, repo: "acme/w" }, { min: 5, lane: "c" }),
  ]);
  assert.equal(s.pushes.length, 4);
  assert.equal(s.pushes[0].item, "525");
  assert.equal(s.pushes[0].lane, "a");
  assert.equal(s.pushes[1].item, "600");
  assert.ok(s.items.get("600").links.branches.includes("feat/600-thing"));
  assert.equal(s.pushes[2].item, "B44");
  assert.equal(s.pushes[3].item, null);
  assert.equal(s.pushes[3].branch, "random");
});

test("pr events resolve item and link the number", () => {
  const s = fold([
    newItem("525", {}, { min: 0 }),
    newItem("526", { links: { prs: [90] } }, { min: 0 }),
    ev("claim", "525", { branch: "feat/mine" }, { min: 1 }),
    ev("pr", null, { number: 12, action: "create", branch: "feat/mine" }, { min: 2 }),
    ev("pr", null, { number: 90, action: "merge" }, { min: 3 }),
    ev("pr", "526", { number: 91, action: "create" }, { min: 4 }),
    ev("pr", null, { number: 5, action: "close" }, { min: 5 }),
  ]);
  assert.equal(s.prEvents[0].item, "525");
  assert.deepEqual(s.items.get("525").links.prs, [12]);
  assert.equal(s.prEvents[1].item, "526");
  assert.deepEqual(s.items.get("526").links.prs, [90, 91]);
  assert.equal(s.prEvents[3].item, null);
});

test("decisions, rulings, notes", () => {
  const s = fold([
    newItem("5", {}, { min: 0 }),
    ev(
      "owner-decision",
      "5",
      { question: "q", answer: "a", recommended: "a" },
      { min: 1, actor: "owner" },
    ),
    ev("ruling", null, { ref: "R-1", summary: "s" }, { min: 2 }),
    ev("note", "5", { text: "hello" }, { min: 3 }),
  ]);
  assert.equal(s.decisions[0].question, "q");
  assert.equal(s.decisions[0].actor, "owner");
  assert.equal(s.decisions[0].item, "5");
  assert.equal(s.rulings[0].ref, "R-1");
  assert.equal(s.rulings[0].item, null);
  assert.equal(s.notes[0].text, "hello");
});

test("children, parent unknown, lanes, machines, history cap", () => {
  const evs = [
    newItem("R1", { type: "release" }, { min: 0 }),
    newItem("1", { parent: "R1" }, { min: 1 }),
    newItem("2", { parent: "R1" }, { min: 2 }),
    newItem("3", { parent: "999" }, { min: 3, machine: "mac" }),
  ];
  for (let i = 0; i < 60; i++) evs.push(ev("note", "1", { text: `n${i}` }, { min: 10 + i }));
  const s = fold(evs);
  assert.deepEqual(s.items.get("R1").children, ["1", "2"]);
  assert.equal(s.items.get("3").parent, "999");
  assert.equal(s.anomalies.length, 0);
  assert.equal(s.items.get("1").history.length, 50);
  assert.equal(s.lanes.get("pc-lane").lastEventKind, "note");
  assert.equal(s.lastEventAt, T0 + 69 * 60000);
  assert.equal(s.machines.mac, T0 + 3 * 60000);
  assert.equal(s.machines.testbox, T0 + 69 * 60000);
  assert.equal(s.eventCount, evs.length);
  assert.equal(s.items.get("1").updatedAt, T0 + 69 * 60000);
});
