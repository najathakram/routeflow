import test from "node:test";
import assert from "node:assert/strict";
import {
  validateEvent,
  validateItemFields,
  STATUSES,
  DONE_STATUSES,
  PICKABLE_STATUSES,
  ITEM_ID_RE,
  BUG_ID_RE,
} from "../lib/schema.mjs";

let n = 0;
const ev = (kind, item, data, over = {}) => ({
  v: 1,
  id: `testbox-${String(1760000000000 + n++)}-ab12`,
  ts: "2026-10-19T04:00:00.000Z",
  machine: "testbox",
  actor: "tester",
  lane: "pc-lane",
  kind,
  item,
  data,
  ...over,
});

const VALID = [
  ev("item.new", "525", { title: "Acme thing", type: "feature", priority: "P1", tags: ["a"] }),
  ev("item.edit", "525", { fields: { title: "Renamed", links: { prs: [3467] } } }),
  ev("claim", "525", { branch: "feat/525-x", steal: true }),
  ev("release", "525", {}),
  ev("status", "525", { status: "building", note: "go" }),
  ev("blocked", "525", { by: "waiting on acme", unblocker: "owner" }),
  ev("unblocked", "525", {}),
  ev("ruling", null, { ref: "R-1", summary: "do it" }),
  ev("owner-decision", "525", { question: "q?", answer: "a", recommended: "a" }),
  ev("note", null, { text: "hello" }),
  ev("link", "525", { prs: [1], branches: ["feat/x"], urls: ["https://example.com"] }),
  ev("push", null, { branch: "feat/x", sha: "abcdef1234", repo: "acme/widgets" }),
  ev("pr", "525", { number: 12, action: "merge", branch: "feat/x" }),
];

test("valid events of every kind pass", () => {
  for (const e of VALID) {
    const r = validateEvent(e);
    assert.deepEqual(r.errors, [], e.kind);
    assert.equal(r.ok, true, e.kind);
  }
});

test("unknown top-level and data keys are rejected (strict)", () => {
  assert.equal(validateEvent({ ...VALID[2], extra: 1 }).ok, false);
  assert.equal(validateEvent(ev("claim", "525", { branch: "b", bogus: 1 })).ok, false);
  assert.equal(
    validateEvent(ev("item.new", "525", { title: "t", type: "bug", nope: 1 })).ok,
    false,
  );
  assert.equal(
    validateEvent(ev("item.edit", "525", { fields: { title: "t" }, extra: 1 })).ok,
    false,
  );
});

test("invalid events are rejected with errors", () => {
  const bad = [
    null,
    [],
    ev("nope", null, {}),
    ev("item.new", "525", { title: "t" }), // no type
    ev("item.new", "525", { type: "bug" }), // no title
    ev("item.new", null, { title: "t", type: "bug" }), // item required
    ev("item.edit", "525", { fields: {} }),
    ev("claim", "525", {}, { lane: null }), // lane required
    ev("status", "525", { status: "bogus" }),
    ev("status", "525", {}),
    ev("blocked", "525", {}),
    ev("link", "525", {}),
    ev("push", null, { branch: "b", sha: "zz", repo: "acme/x" }),
    ev("pr", null, { number: 0, action: "merge" }),
    ev("pr", null, { number: 3, action: "explode" }),
    ev("note", null, { text: "" }),
    ev("note", null, {}, { ts: "2026-10-19 04:00" }),
    ev("note", null, { text: "x" }, { id: "bad id" }),
    ev("note", "not an id!", { text: "x" }),
    ev("note", null, { text: "x" }, { v: 2 }),
    ev("note", null, { text: "x" }, { machine: "Bad Machine" }),
    ev("note", null, { text: "x" }, { actor: "" }),
    ev("note", null, "string"),
  ];
  for (const b of bad) {
    const r = validateEvent(b);
    assert.equal(r.ok, false, JSON.stringify(b));
    assert.ok(r.errors.length > 0);
  }
});

test("validateItemFields", () => {
  assert.deepEqual(validateItemFields({ title: "t", type: "bug" }, { full: true }), []);
  assert.ok(validateItemFields({ title: "t" }, { full: true }).length > 0);
  assert.ok(validateItemFields({}, { full: false }).length > 0);
  assert.ok(validateItemFields({ train: "X1" }, { full: false }).length > 0);
  assert.ok(validateItemFields({ wat: 1 }, { full: false }).length > 0);
  assert.deepEqual(validateItemFields({ lane: null, parent: "12" }, { full: false }), []);
});

test("constants and id patterns", () => {
  assert.ok(STATUSES.includes("building"));
  assert.ok(DONE_STATUSES.every((s) => STATUSES.includes(s)));
  assert.ok(PICKABLE_STATUSES.every((s) => STATUSES.includes(s)));
  for (const id of ["525", "B1234", "R1", "K11-16", "OQ-N1"]) assert.ok(ITEM_ID_RE.test(id), id);
  for (const id of ["", "b12", "123456", "x y", "-1"]) assert.ok(!ITEM_ID_RE.test(id), id);
  assert.ok(BUG_ID_RE.test("B1"));
  assert.ok(!BUG_ID_RE.test("R1"));
});

test("refPrs: a register-cited PR number list is a valid item field", () => {
  const ok = ev("item.edit", "525", { fields: { refPrs: [3202, 3466], source: "register" } });
  assert.deepEqual(validateEvent(ok).errors, []);
  assert.deepEqual(validateItemFields({ title: "t", type: "bug", refPrs: [] }, { full: true }), []);
  for (const bad of [[0], [-1], [1.5], ["3202"], "3202", null, new Array(51).fill(5)])
    assert.deepEqual(
      validateItemFields({ refPrs: bad }, { full: false }),
      ['invalid item field "refPrs"'],
      JSON.stringify(bad).slice(0, 30),
    );
});

test("item.rename: needs an item and a valid data.to, nothing else", () => {
  assert.equal(validateEvent(ev("item.rename", "614", { to: "OQ-N1" })).ok, true);
  assert.equal(validateEvent(ev("item.rename", "614", { to: "W-12" })).ok, true);
  assert.equal(validateEvent(ev("item.rename", null, { to: "W-12" })).ok, false);
  assert.equal(validateEvent(ev("item.rename", "614", {})).ok, false);
  assert.equal(validateEvent(ev("item.rename", "614", { to: "not an id" })).ok, false);
  assert.equal(validateEvent(ev("item.rename", "614", { to: "" })).ok, false);
  assert.equal(validateEvent(ev("item.rename", "614", { to: "W-1", extra: 1 })).ok, false);
});
