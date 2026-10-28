// auto-status: statuses written from polled PR + deploy facts. planAutoStatus is pure; runAutoStatus is the IO shell.
import test from "node:test";
import assert from "node:assert/strict";
import { fold } from "../lib/fold.mjs";
import { validateEvent } from "../lib/schema.mjs";
import {
  AUTO_STATUS_ACTOR,
  GRACE_MS,
  MAX_EVENTS_PER_RUN,
  planAutoStatus,
  runAutoStatus,
} from "../lib/auto-status.mjs";

const NOW = Date.parse("2026-10-28T12:00:00Z");
const H = 3600_000;
const iso = (ms) => new Date(ms).toISOString();
let seq = 0;
function ev(kind, item, data, { at, lane = "pc-lane", actor = "t" } = {}) {
  const ms = at ?? NOW - 48 * H + seq * 1000;
  return {
    v: 1,
    id: `box-${String(ms).padStart(13, "0")}-${(seq++).toString(36).padStart(4, "0")}`,
    ts: iso(ms),
    machine: "box",
    actor,
    lane,
    kind,
    item,
    data,
  };
}
/** An item at `status` with explicit PR links, all of it older than the grace window by default. */
function item(id, { status = "building", prs = [], at = NOW - 48 * H, extra = [] } = {}) {
  return [
    ev("item.new", id, { title: `Item ${id}`, type: "feature" }, { at }),
    ...(prs.length ? [ev("link", id, { prs }, { at: at + 1000 })] : []),
    ...(status !== "planned" ? [ev("status", id, { status }, { at: at + 2000 })] : []),
    ...extra,
  ];
}
const merged = (number, mergedAt, o = {}) => ({
  number,
  title: `PR ${number}`,
  branch: `feat/p${number}`,
  base: "master",
  mergedAt: iso(mergedAt),
  mergeSha: `m${number}`.padEnd(40, "0"),
  ...o,
});
const open = (number, o = {}) => ({
  number,
  title: `PR ${number}`,
  branch: `feat/p${number}`,
  draft: false,
  ...o,
});
const deploy = (service, createdAt, status = "SUCCESS") => ({
  service,
  status,
  sha: null,
  createdAt: iso(createdAt),
});
const plan = (events, { open: o = [], merged: m = [], deploys = [], extra = {} } = {}) =>
  planAutoStatus({
    state: fold(events),
    events,
    prs: { open: o, merged: m },
    deploys,
    master: null,
    now: NOW,
    machine: "box",
    ...extra,
  });
const statusesOf = (r) => r.events.map((e) => `${e.item}:${e.data.status}`);

test("the events are valid status events from the auto-status actor, naming the PRs in the note", () => {
  const events = item("5", { prs: [11] });
  const r = plan(events, { merged: [merged(11, NOW - 10 * H)] });
  assert.equal(r.events.length, 1);
  const e = r.events[0];
  assert.deepEqual(validateEvent(e).errors, []);
  assert.equal(e.actor, AUTO_STATUS_ACTOR);
  assert.equal(e.kind, "status");
  assert.equal(e.lane, null);
  assert.equal(e.data.status, "shipping");
  assert.match(e.data.note, /^auto-status: PR #11 /);
});

test("all linked PRs merged -> shipping (red on master: nothing wrote it)", () => {
  const events = [...item("5", { prs: [11, 12] })];
  const both = plan(events, { merged: [merged(11, NOW - 10 * H), merged(12, NOW - 9 * H)] });
  assert.deepEqual(statusesOf(both), ["5:shipping"]);
  // one still open: the item is not shipped; the open PR is what shows (review)
  const one = plan(events, { merged: [merged(11, NOW - 10 * H)], open: [open(12)] });
  assert.deepEqual(statusesOf(one), ["5:review"]);
  const shipping = plan(item("6", { status: "shipping", prs: [13, 14] }), {
    merged: [merged(13, NOW - 10 * H)],
    open: [open(14)],
  });
  assert.deepEqual(statusesOf(shipping), []);
});

test("a linked PR the monitor cannot see is not read as merged", () => {
  const r = plan(item("5", { prs: [11, 99] }), { merged: [merged(11, NOW - 10 * H)] });
  assert.deepEqual(statusesOf(r), []);
});

test("merged at or before the latest SUCCESS api+web deploy -> live; after it -> shipping", () => {
  const ev1 = item("5", { status: "shipping", prs: [11] });
  const deploys = [deploy("api", NOW - 5 * H), deploy("web", NOW - 5 * H)];
  assert.deepEqual(statusesOf(plan(ev1, { merged: [merged(11, NOW - 6 * H)], deploys })), [
    "5:live",
  ]);
  assert.deepEqual(statusesOf(plan(ev1, { merged: [merged(11, NOW - 4 * H)], deploys })), []);
  // from an earlier status the first step is shipping when the deploy has not covered it
  const early = item("6", { status: "review", prs: [12] });
  assert.deepEqual(statusesOf(plan(early, { merged: [merged(12, NOW - 4 * H)], deploys })), [
    "6:shipping",
  ]);
  // a failed deploy is no deploy
  const failed = [deploy("api", NOW - 5 * H, "FAILED"), deploy("web", NOW - 5 * H, "FAILED")];
  assert.deepEqual(
    statusesOf(plan(ev1, { merged: [merged(11, NOW - 6 * H)], deploys: failed })),
    [],
  );
});

test("an open linked PR -> review; a draft is not review", () => {
  const events = item("5", { status: "building", prs: [11] });
  assert.deepEqual(statusesOf(plan(events, { open: [open(11)] })), ["5:review"]);
  assert.deepEqual(statusesOf(plan(events, { open: [open(11, { draft: true })] })), []);
  const planned = item("6", { status: "planned", prs: [12] });
  assert.deepEqual(statusesOf(plan(planned, { open: [open(12)] })), ["6:review"]);
});

test("forward-only: ready, shipping, live, verified never go back to a lower rule", () => {
  for (const status of ["ready", "shipping", "live", "verified"]) {
    const r = plan(item("5", { status, prs: [11] }), { open: [open(11)] });
    assert.deepEqual(statusesOf(r), [], `open PR must not move ${status}`);
  }
  const live = plan(item("6", { status: "live", prs: [12] }), {
    merged: [merged(12, NOW - 9 * H)],
  });
  assert.deepEqual(statusesOf(live), []);
  const ver = plan(item("7", { status: "verified", prs: [13] }), {
    merged: [merged(13, NOW - 9 * H)],
    deploys: [deploy("api", NOW - 1 * H), deploy("web", NOW - 1 * H)],
  });
  assert.deepEqual(statusesOf(ver), []);
});

test("parked, dropped and blocked items are skipped", () => {
  for (const status of ["parked", "dropped"]) {
    const r = plan(item("5", { status, prs: [11] }), { merged: [merged(11, NOW - 9 * H)] });
    assert.deepEqual(statusesOf(r), [], status);
  }
  const blocked = [
    ...item("6", { status: "building", prs: [12] }),
    ev("blocked", "6", { by: "waiting on the owner" }, { at: NOW - 40 * H }),
  ];
  assert.deepEqual(statusesOf(plan(blocked, { merged: [merged(12, NOW - 9 * H)] })), []);
});

test("2 h grace: an item a lane touched inside the window waits; after it, it moves", () => {
  const touched = [
    ...item("5", { status: "building", prs: [11] }),
    ev("note", "5", { text: "still going" }, { at: NOW - 1 * H }),
  ];
  const facts = { merged: [merged(11, NOW - 3 * H)] };
  assert.equal(GRACE_MS, 2 * H);
  assert.deepEqual(statusesOf(plan(touched, facts)), []);
  const quiet = [
    ...item("6", { status: "building", prs: [12] }),
    ev("note", "6", { text: "done" }, { at: NOW - 3 * H }),
  ];
  assert.deepEqual(statusesOf(plan(quiet, { merged: [merged(12, NOW - 4 * H)] })), ["6:shipping"]);
});

test("never overrides a later explicit lane status (work reopened after the merge)", () => {
  const events = [
    ...item("5", { status: "shipping", prs: [11] }),
    ev("status", "5", { status: "building", note: "reopened" }, { at: NOW - 6 * H }),
  ];
  const r = plan(events, { merged: [merged(11, NOW - 8 * H)] });
  assert.deepEqual(statusesOf(r), []);
});

test("dedupe by item + status + PR: the same step is not written twice", () => {
  const events = item("5", { status: "building", prs: [11] });
  const facts = { merged: [merged(11, NOW - 10 * H)] };
  const first = plan(events, facts);
  assert.equal(first.events.length, 1);
  // the lane sets it back; the same fact must not re-fire
  const again = [
    ...events,
    { ...first.events[0], ts: iso(NOW - 5 * H) },
    ev("status", "5", { status: "building" }, { at: NOW - 3 * H }),
  ];
  assert.deepEqual(statusesOf(plan(again, facts)), []);
  // the same for review (no merge time to guard on): written once, then the lane lowers it
  const open1 = item("6", { status: "planned", prs: [12] });
  const review = plan(open1, { open: [open(12)] });
  assert.deepEqual(statusesOf(review), ["6:review"]);
  const lowered = [
    ...open1,
    { ...review.events[0], ts: iso(NOW - 6 * H) },
    ev("status", "6", { status: "building" }, { at: NOW - 3 * H }),
  ];
  assert.deepEqual(statusesOf(plan(lowered, { open: [open(12)] })), []);
});

test("explicit links only: a PR that merely names the item by branch or title is ignored", () => {
  const events = item("5", { status: "building", prs: [] });
  const r = plan(events, {
    merged: [merged(20, NOW - 10 * H, { branch: "feat/row-5", title: "fix row 5" })],
    open: [open(21, { branch: "feat/5-thing", title: "item 5" })],
  });
  assert.deepEqual(statusesOf(r), []);
});

test("a PR merged into a train branch lands when the train PR merges into master", () => {
  const events = item("5", { status: "building", prs: [11] });
  const member = merged(11, NOW - 12 * H, { base: "train/r1" });
  const notYet = plan(events, { merged: [member] });
  assert.deepEqual(statusesOf(notYet), []);
  const train = merged(30, NOW - 9 * H, { branch: "train/r1" });
  assert.deepEqual(statusesOf(plan(events, { merged: [member, train] })), ["5:shipping"]);
});

test("at most MAX_EVENTS_PER_RUN per run; the rest is reported as capped", () => {
  const events = [];
  const mergedPrs = [];
  for (let i = 1; i <= MAX_EVENTS_PER_RUN + 5; i++) {
    events.push(...item(String(i), { status: "building", prs: [100 + i] }));
    mergedPrs.push(merged(100 + i, NOW - 10 * H));
  }
  const r = plan(events, { merged: mergedPrs });
  assert.equal(r.events.length, MAX_EVENTS_PER_RUN);
  assert.equal(r.capped, 5);
});

test("runAutoStatus appends the planned events once, under the held lock, and not on a failed pull", async () => {
  const events = item("5", { status: "building", prs: [11] });
  const appended = [];
  const store = {
    readAllEvents: () => events,
    syncSpecs: async () => ({ ok: true }),
    appendEvents: async (evs, o) => {
      appended.push({ evs, o });
      return { events: evs, pushed: true, warnings: [] };
    },
  };
  const sources = {
    github: { data: { open: [], merged: [merged(11, NOW - 10 * H)], master: null } },
    railway: { data: { deploys: [] } },
  };
  const res = await runAutoStatus({
    dir: "/d",
    home: "/h",
    machine: "box",
    now: NOW,
    sources,
    store,
    lockHeld: true,
  });
  assert.equal(res.appended, 1);
  assert.equal(appended[0].evs[0].data.status, "shipping");
  assert.equal(appended[0].o.lockHeld, true);
  // no github data yet -> nothing, no append
  const none = await runAutoStatus({
    dir: "/d",
    home: "/h",
    machine: "box",
    now: NOW,
    sources: {},
    store,
    lockHeld: true,
  });
  assert.equal(none.appended, 0);
  assert.equal(appended.length, 1);
});
