import test from "node:test";
import assert from "node:assert/strict";
import { newEventId, nextItemId, utcDate, itemIdFromBranch, parseEta } from "../lib/ids.mjs";
import { EVENT_ID_RE } from "../lib/schema.mjs";

test("newEventId shape and determinism", () => {
  const id = newEventId("pc", 1760000000000, () => 0);
  assert.equal(id, "pc-1760000000000-aaaa");
  assert.ok(EVENT_ID_RE.test(id));
  assert.ok(EVENT_ID_RE.test(newEventId("mac-mini", 5)));
  assert.equal(newEventId("pc", 5, () => 0.999999).length, "pc-0000000000005-".length + 4);
  assert.match(newEventId("pc", 5), /^pc-0000000000005-[a-z0-9]{4}$/);
});

test("nextItemId", () => {
  assert.equal(nextItemId({ items: new Map() }), "1");
  const items = new Map([
    ["B12", {}],
    ["R1", {}],
    ["K11-16", {}],
  ]);
  assert.equal(nextItemId({ items }), "1");
  items.set("7", {});
  items.set("525", {});
  items.set("90", {});
  assert.equal(nextItemId({ items }), "526");
});

test("utcDate", () => {
  assert.equal(utcDate(Date.UTC(2026, 9, 19, 23, 59, 59)), "2026-10-19");
  assert.equal(utcDate(Date.UTC(2026, 0, 1, 0, 0, 0)), "2026-01-01");
});

test("itemIdFromBranch", () => {
  const known = new Set(["525", "3467"]);
  assert.equal(itemIdFromBranch("feat/b123-thing", known), "B123");
  assert.equal(itemIdFromBranch("fix/B9_x", known), "B9");
  assert.equal(itemIdFromBranch("feat/525-order-screen", known), "525");
  assert.equal(itemIdFromBranch("feat/526-order-screen", known), null);
  assert.equal(itemIdFromBranch("feat/k11-16", known), null);
  assert.equal(itemIdFromBranch("feat/12-x", new Set(["12"])), null); // < 3 digits
  assert.equal(itemIdFromBranch("master", known), null);
  assert.equal(itemIdFromBranch(null, known), null);
  assert.equal(itemIdFromBranch("feat/b123456", known), null);
});

test("parseEta", () => {
  const now = Date.UTC(2026, 9, 18, 12, 0, 0);
  assert.equal(parseEta("10-19 ~04:00Z", now), Date.UTC(2026, 9, 19, 4, 0, 0));
  assert.equal(parseEta("10-19 to 10-21", now), Date.UTC(2026, 9, 21, 23, 59, 59));
  assert.equal(parseEta("2026-10-20 ~18:00Z", now), Date.UTC(2026, 9, 20, 18, 0, 0));
  assert.equal(parseEta("2027-01-05", now), Date.UTC(2027, 0, 5, 23, 59, 59));
  assert.equal(parseEta("after census", now), null);
  assert.equal(parseEta(null, now), null);
  assert.equal(parseEta("02-31", now), null);
  assert.equal(parseEta("13-01", now), null);
  assert.equal(parseEta("10-19 ~25:00Z", now), null);
});
