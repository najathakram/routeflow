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

test("push and pr events touch the lane that claims the linked item", () => {
  const s = fold([
    newItem("5", {}, { min: 0 }),
    ev("claim", "5", { branch: "feat/5-x" }, { min: 1, lane: "a" }),
    ev(
      "push",
      "5",
      { branch: "feat/5-x", sha: "abc1234", repo: "routeflow" },
      { min: 30, lane: "b" },
    ),
    ev("pr", "5", { number: 7, action: "create" }, { min: 45, lane: "c" }),
  ]);
  assert.equal(s.lanes.get("a").lastEventAt, T0 + 45 * 60000);
});

test("claim conflict clears when the holder or the loser releases", () => {
  const base = [
    newItem("5", {}, { min: 0 }),
    ev("claim", "5", {}, { min: 1, lane: "a" }),
    ev("claim", "5", {}, { min: 2, lane: "b" }),
  ];
  assert.deepEqual(fold(base).items.get("5").claimConflict, ["a", "b"]);
  const byLoser = fold([...base, ev("release", "5", {}, { min: 3, lane: "b" })]);
  assert.equal(byLoser.items.get("5").claimConflict, null);
  assert.equal(byLoser.items.get("5").claimedBy, "a");
  const byHolder = fold([...base, ev("release", "5", {}, { min: 3, lane: "a" })]);
  assert.equal(byHolder.items.get("5").claimConflict, null);
});

test("anomalies carry the event time", () => {
  const s = fold([ev("status", "999", { status: "live" }, { min: 5 })]);
  assert.equal(s.anomalies[0].ts, T0 + 5 * 60000);
});

test("register-sourced PR numbers are refs, never fix links", () => {
  const s = fold([
    newItem(
      "525",
      {
        source: "register",
        gate: "B1 live (#3466); verify the rest",
        links: { prs: [3466], branches: ["feat/525-x"], urls: [] },
      },
      { min: 0 },
    ),
    ev("item.edit", "525", { fields: { source: "register", links: { prs: [3202] } } }, { min: 1 }),
  ]);
  const it = s.items.get("525");
  assert.deepEqual(it.links.prs, []);
  assert.deepEqual(it.links.branches, ["feat/525-x"]);
  assert.deepEqual(it.refPrs.sort(), [3202, 3466]);
});

test("a PR linked by a non-register event is a fix link, not a ref", () => {
  const s = fold([
    newItem("525", { source: "register", links: { prs: [3466], branches: [], urls: [] } }),
    ev("link", "525", { prs: [3500] }),
    ev("item.edit", "525", { fields: { links: { prs: [3501] } } }),
    ev("pr", "525", { number: 3502, action: "create" }),
  ]);
  const it = s.items.get("525");
  assert.deepEqual(it.links.prs.sort(), [3500, 3501, 3502]);
  assert.deepEqual(it.refPrs, [3466]);
  assert.deepEqual(fold([newItem("6")]).items.get("6").refPrs, []);
});

test("registerFields keeps the last register-sourced values for the sync diff", () => {
  const s = fold([
    newItem(
      "7",
      { source: "register", priority: "P1", status: "planned", eta: "10-25" },
      { min: 0 },
    ),
    ev("item.edit", "7", { fields: { source: "register", status: "building" } }, { min: 1 }),
    ev("item.edit", "7", { fields: { priority: "P0" } }, { min: 2 }), // a human edit: not register
  ]);
  const it = s.items.get("7");
  assert.equal(it.registerFields.status, "building");
  assert.equal(it.registerFields.eta, "10-25");
  assert.equal(it.registerFields.priority, "P1");
  assert.equal(it.registerFields.source, undefined);
  assert.equal(it.priority, "P0");
  assert.deepEqual(fold([newItem("8")]).items.get("8").registerFields, {});
});

test("owner-decision on an item records answeredAt; a decision item becomes verified", () => {
  const s = fold([
    newItem("OQ-N1", { type: "decision", status: "planned" }, { min: 0 }),
    newItem("9", { type: "feature", status: "planned" }, { min: 0 }),
    ev("owner-decision", "OQ-N1", { question: "q?", answer: "yes" }, { min: 5 }),
    ev("owner-decision", "9", { question: "q?", answer: "yes" }, { min: 6 }),
  ]);
  const d = s.items.get("OQ-N1");
  assert.equal(d.answeredAt, T0 + 5 * 60000);
  assert.equal(d.status, "verified");
  const f = s.items.get("9");
  assert.equal(f.answeredAt, T0 + 6 * 60000);
  assert.equal(f.status, "planned");
  assert.equal(fold([newItem("10")]).items.get("10").answeredAt, null);
});

test("a human story edit clears summaryDraft; the draft import and an explicit value do not", () => {
  const draft = { problem: "p", impact: "i", summaryDraft: true };
  const s = fold([
    newItem("11", draft, { min: 0 }),
    newItem("12", draft, { min: 0 }),
    newItem("13", draft, { min: 0 }),
    newItem("14", draft, { min: 0 }),
    ev("item.edit", "11", { fields: { solution: "fix it" } }, { min: 1 }),
    ev("item.edit", "12", { fields: { solution: "x", source: "summary-draft" } }, { min: 1 }),
    ev("item.edit", "13", { fields: { solution: "x" } }, { min: 1, actor: "summary-draft" }),
    ev("item.edit", "14", { fields: { solution: "x", summaryDraft: true } }, { min: 1 }),
  ]);
  assert.equal(s.items.get("11").summaryDraft, false);
  assert.equal(s.items.get("11").solution, "fix it");
  assert.equal(s.items.get("12").summaryDraft, true);
  assert.equal(s.items.get("13").summaryDraft, true);
  assert.equal(s.items.get("14").summaryDraft, true);
  const plain = fold([
    newItem("15", {}, { min: 0 }),
    ev("item.edit", "15", { fields: { title: "renamed" } }, { min: 1 }),
  ]);
  assert.equal(plain.items.get("15").summaryDraft, false); // non-story edits leave it alone
});
