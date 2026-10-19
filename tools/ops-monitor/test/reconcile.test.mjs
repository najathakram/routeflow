import test from "node:test";
import assert from "node:assert/strict";
import { reconcile, linkItemFor } from "../lib/reconcile.mjs";
import * as REC from "../lib/reconcile.mjs";
import { fold } from "../lib/fold.mjs";
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

test("status-behind-merge: warn within 24h, error after, exact id and suggestion", () => {
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
  assert.equal(a.severity, "warn");
  assert.equal(a.suggest, "rf status 525 shipping");
  assert.match(a.message, /PR #3467 merged 3h ago but item is building/);
  const old = { open: [], merged: [{ ...prs.merged[0], mergedAt: ago(30 * HOUR) }] };
  assert.equal(find(run({ state, prs: old }), "status-behind-merge:525").severity, "error");
});

const ago = (ms) => new Date(NOW - ms).toISOString();
const mergedPr = (number, ms) => ({ number, branch: "b", mergedAt: ago(ms), base: "master" });

test("status-behind-merge: 2h grace, ready/shipping never fire, open sibling PR silences", () => {
  const link = (prs) => ({ prs, branches: [], urls: [] });
  const at = (ms, over = {}, linked = [9]) =>
    find(
      run({
        state: mkState([item("7", { links: link(linked), ...over })]),
        prs: { open: [{ number: 10, branch: "x" }], merged: [mergedPr(9, ms)] },
      }),
      "status-behind-merge:7",
    );
  assert.equal(at(HOUR), undefined); // merged 1h ago: lane still has time to record it
  assert.equal(at(3 * HOUR).severity, "warn");
  assert.equal(at(30 * HOUR).severity, "error");
  for (const status of ["ready", "shipping"]) assert.equal(at(30 * HOUR, { status }), undefined);
  assert.equal(at(30 * HOUR, {}, [9, 10]), undefined); // a linked PR is still open
});

test("status-behind-merge: via prEvents; negatives (done, non-master base)", () => {
  const prs = {
    open: [],
    merged: [
      { number: 9, branch: "b", mergedAt: new Date(NOW - 3 * HOUR).toISOString(), base: "master" },
    ],
  };
  const viaEvent = mkState([item("7")], {
    prEvents: [{ ts: 1, number: 9, action: "create", item: "7" }],
  });
  assert.ok(find(run({ state: viaEvent, prs }), "status-behind-merge:7"));
  for (const status of ["live", "verified"]) {
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
      { kind: "unknown-item", eventId: "pc-3", item: "999", detail: "x" },
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

test("anomaly: claim-conflict anomalies are not re-reported; old ones are info", () => {
  const state = mkState([], {
    anomalies: [
      { kind: "claim-conflict", eventId: "pc-1", item: "5", detail: "x", ts: NOW - HOUR },
      { kind: "invalid-event", eventId: "pc-2", item: null, detail: "bad", ts: NOW - 30 * HOUR },
      { kind: "invalid-event", eventId: "pc-3", item: null, detail: "bad", ts: NOW - HOUR },
    ],
  });
  const alarms = run({ state });
  assert.equal(find(alarms, "anomaly:5"), undefined);
  assert.equal(find(alarms, "anomaly:pc-2").severity, "info");
  assert.match(find(alarms, "anomaly:pc-2").message, /^historical: /);
  assert.equal(find(alarms, "anomaly:pc-3").severity, "error");
});

test("sorted error, warn, info then id", () => {
  const fresh = { updatedAt: NOW - HOUR };
  const state = mkState(
    [item("2", { eta: "10-01", ...fresh }), item("1", { eta: "10-01", ...fresh })],
    { anomalies: [{ kind: "invalid-event", eventId: "pc-9", item: null, detail: "x" }] },
  );
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

// ---- accuracy round: fix links, not citations ----
const fixLinksFor = (...a) => REC.fixLinksFor(...a);
const KNOWN = new Set(["525", "555", "556", "557", "7"]);

test("fixLinksFor: only text that names the item makes a fix link", () => {
  const f = (o) => fixLinksFor({ branch: null, title: "", body: "", ...o }, KNOWN);
  assert.deepEqual(f({ body: "Closes row 525" }), ["525"]);
  assert.deepEqual(f({ body: "Resolves rows 555/556" }), ["555", "556"]);
  assert.deepEqual(f({ body: "rows 555/556" }), []); // body counts only after a closing verb
  assert.deepEqual(f({ title: "rows 555/556" }), ["555", "556"]);
  assert.deepEqual(f({ title: "feat: totals (rows 555, 556 and 557)" }), ["555", "556", "557"]);
  assert.deepEqual(f({ body: "Fixes B1234" }), ["B1234"]);
  assert.deepEqual(f({ title: "fix(b230): dispatch" }), ["B230"]);
  assert.deepEqual(f({ branch: "fix/b12-and-525-thing" }), ["B12", "525"]);
  assert.deepEqual(f({ title: "Resolves row 7", body: "Fixes B9" }), ["7", "B9"]);
});

test("fixLinksFor: real background sentences in a body are not fix links", () => {
  const f = (body) =>
    fixLinksFor({ branch: null, title: "", body }, new Set(["402", "527", "1232"]));
  assert.deepEqual(f("Supersedes parked row 402"), []);
  assert.deepEqual(f("B1 (row 527, HIGH)..."), []);
  assert.deepEqual(f("The W0 reds (B1232/B1233, B1234) are not in this PR"), []);
});

test("fixLinksFor: citations, bare numbers and unknown rows are not fix links", () => {
  const f = (o) => fixLinksFor({ branch: null, title: "", body: "", ...o }, KNOWN);
  assert.deepEqual(f({ body: "follow-ups of #3202" }), []);
  assert.deepEqual(f({ body: "Closes #3202" }), []);
  assert.deepEqual(f({ body: "Fixes 525" }), []); // numeric only after "row"
  assert.deepEqual(f({ body: "525 is the order screen" }), []);
  assert.deepEqual(f({ body: "see row 9999 of the table" }), []); // not a known item
  assert.deepEqual(f({ title: "b2b invoices and ab12 hashes b1234567" }), []);
  assert.deepEqual(f({ branch: "feat/2026-10-19-x" }), []);
  assert.deepEqual(f({}), []);
  assert.deepEqual(fixLinksFor({ title: null, body: null }, KNOWN), []);
});

test("linkItemFor: a PR title or body that names the item links it", () => {
  const state = mkState([item("525"), item("555")]);
  assert.equal(linkItemFor({ number: 1, branch: "feat/x", body: "Closes row 525" }, state), "525");
  assert.equal(linkItemFor({ number: 1, branch: "feat/x", title: "rows 555/556" }, state), "555");
  const cite = { number: 1, branch: "feat/x", body: "follow-ups of #3202" };
  assert.equal(linkItemFor(cite, state), null);
  assert.equal(linkItemFor({ number: 1, title: "Fixes B77" }, state), "B77");
});

test("status-behind-merge: a register-cited PR (refPrs) never fires", () => {
  const state = mkState([item("525", { refPrs: [3466] })]);
  const prs = { open: [], merged: [mergedPr(3466, 30 * HOUR)] };
  assert.equal(find(run({ state, prs }), "status-behind-merge:525"), undefined);
});

test("status-behind-merge: a merged PR whose body or title names the item fires", () => {
  const state = mkState([item("525"), item("556"), item("7")]);
  const prs = {
    open: [],
    merged: [
      { ...mergedPr(3500, 3 * HOUR), body: "Closes row 525" },
      { ...mergedPr(3501, 3 * HOUR), title: "feat: rows 555/556" },
      { ...mergedPr(3502, 3 * HOUR), body: "follow-ups of #3202; related to row 7" },
    ],
  };
  const alarms = run({ state, prs });
  assert.match(find(alarms, "status-behind-merge:525").message, /PR #3500/);
  assert.match(find(alarms, "status-behind-merge:556").message, /PR #3501/);
  assert.equal(find(alarms, "status-behind-merge:7"), undefined); // a plain body mention is background
});

test("status-behind-merge: an open PR that names the item silences it", () => {
  const state = mkState([item("525", { links: { prs: [9], branches: [], urls: [] } })]);
  const prs = {
    open: [{ number: 10, branch: "feat/y", title: "more work", body: "Closes row 525" }],
    merged: [mergedPr(9, 30 * HOUR)],
  };
  assert.equal(find(run({ state, prs }), "status-behind-merge:525"), undefined);
});

test("register rows citing a merged PR as background raise no status-behind-merge alarm", () => {
  const registerNew = {
    v: 1,
    id: "pc-1790000000000-aaaa",
    ts: "2026-10-01T00:00:00.000Z",
    machine: "pc",
    actor: "backfill",
    lane: null,
    kind: "item.new",
    item: "525",
    data: {
      title: "Order screen",
      type: "feature",
      status: "building",
      source: "register",
      gate: "B1 live (#3466); verify the rest",
      links: { prs: [3466], branches: [], urls: [] },
    },
  };
  const state = fold([registerNew]);
  const prs = { open: [], merged: [mergedPr(3466, 30 * HOUR)] };
  assert.equal(find(run({ state, prs }), "status-behind-merge:525"), undefined);
  assert.deepEqual(state.items.get("525").refPrs, [3466]);
});

// ---- building-stale ----
test("building-stale: building/review with no activity for 48h warns; any activity silences", () => {
  const stale = (over, extra = {}) =>
    find(
      run({ state: mkState([item("5", { updatedAt: NOW - 50 * HOUR, ...over })]), ...extra }),
      "building-stale:5",
    );
  const a = stale({});
  assert.equal(a.severity, "warn");
  assert.match(a.message, /Item 5 is building but nothing has moved for 2d/);
  assert.ok(stale({ status: "review" }));
  assert.equal(stale({ updatedAt: NOW - 47 * HOUR }), undefined);
  for (const status of ["planned", "spec", "ready", "shipping", "live", "parked"])
    assert.equal(stale({ status }), undefined, status);
  // a recent commit on a linked branch counts as activity (by link, by branch item, by name)
  const recent = new Date(NOW - 5 * HOUR).toISOString();
  const old = new Date(NOW - 100 * HOUR).toISOString();
  const linked = { links: { prs: [], branches: ["feat/x"], urls: [] } };
  assert.equal(stale(linked, { branches: [{ branch: "feat/x", date: recent }] }), undefined);
  assert.equal(stale({}, { branches: [{ branch: "feat/y", item: "5", date: recent }] }), undefined);
  assert.ok(stale(linked, { branches: [{ branch: "feat/x", date: old }] }));
  assert.ok(stale({}, { branches: [{ branch: "feat/other", date: recent }] }));
  const byName = run({
    state: mkState([item("B5", { updatedAt: NOW - 50 * HOUR })]),
    branches: [{ branch: "fix/b5-x", date: recent }],
  });
  assert.equal(find(byName, "building-stale:B5"), undefined);
});

test("building-stale: a blocked item is idle on purpose", () => {
  const blocked = { by: "waiting on acme", unblocker: null, at: NOW - 60 * HOUR };
  const state = mkState([item("5", { updatedAt: NOW - 60 * HOUR, blocked })]);
  assert.equal(find(run({ state }), "building-stale:5"), undefined);
});

// ---- bug alarms ----
const bug = (id, over = {}) => ({
  id,
  title: `Bug ${id}`,
  severity: "high",
  state: "queued",
  ledgerState: "queued",
  fix: "none",
  filedAt: NOW - 100 * HOUR,
  pending: false,
  items: [],
  ...over,
});

test("bug-fixed-still-open: a merged PR names an open bug; warn, error after 24h", () => {
  const bugs = [bug("B12"), bug("B13")];
  const mk = (ms, over = {}) => ({
    open: [],
    merged: [{ ...mergedPr(3600, ms), title: "fix(b12): dispatch", ...over }],
  });
  const a = find(run({ bugs, prs: mk(3 * HOUR) }), "bug-fixed-still-open:B12");
  assert.equal(a.severity, "warn");
  assert.equal(a.item, "B12");
  assert.equal(a.pr, 3600);
  assert.match(a.message, /PR #3600 merged 3h ago names B12 but the registry still says queued/);
  const old = find(run({ bugs, prs: mk(30 * HOUR) }), "bug-fixed-still-open:B12");
  assert.equal(old.severity, "error");
  assert.equal(find(run({ bugs, prs: mk(3 * HOUR) }), "bug-fixed-still-open:B13"), undefined);
  // body naming works too; a train-bound merge, a closed bug and a pending bug do not
  const body = { open: [], merged: [{ ...mergedPr(3601, HOUR), body: "Fixes B13" }] };
  assert.ok(find(run({ bugs, prs: body }), "bug-fixed-still-open:B13"));
  const train = mk(3 * HOUR, { base: "train/r1" });
  assert.equal(find(run({ bugs, prs: train }), "bug-fixed-still-open:B12"), undefined);
  const closed = [bug("B12", { ledgerState: "done", state: "queued" })];
  const fixedOf = (b) => find(run({ bugs: b, prs: mk(3 * HOUR) }), "bug-fixed-still-open:B12");
  assert.equal(fixedOf(closed), undefined);
  const pending = [bug("B12", { pending: true })];
  assert.equal(fixedOf(pending), undefined);
});

test("bug-fixed-still-open: the PR that filed the bug is not its fix", () => {
  const bugs = [bug("B12", { filedAt: NOW - 3 * HOUR })];
  const filing = { open: [], merged: [{ ...mergedPr(3600, 3 * HOUR), title: "chore: file B12" }] };
  assert.equal(find(run({ bugs, prs: filing }), "bug-fixed-still-open:B12"), undefined);
  const later = { open: [], merged: [{ ...mergedPr(3601, HOUR), title: "fix B12" }] };
  assert.ok(find(run({ bugs, prs: later }), "bug-fixed-still-open:B12"));
});

test("bug-unowned: critical/high, no claim, no branch, no PR, filed over 4h ago", () => {
  const un = (b, extra = {}) => find(run({ bugs: [b], ...extra }), `bug-unowned:${b.id}`);
  const a = un(bug("B20", { severity: "critical" }));
  assert.equal(a.severity, "warn");
  assert.equal(a.item, "B20");
  assert.match(a.message, /B20 \(critical\) has no owner, branch or PR/);
  // older than 7 days (or undated): no per-bug alarm, aggregated instead
  assert.equal(un(bug("B20", { filedAt: null })), undefined);
  assert.equal(un(bug("B20", { filedAt: NOW - 8 * 24 * HOUR })), undefined);
  assert.ok(un(bug("B20", { filedAt: NOW - 6 * 24 * HOUR })));
  assert.ok(un(bug("B20", { filedAt: NOW - 30 * 24 * HOUR, ledgerState: "reopened" })));
  assert.equal(un(bug("B20", { filedAt: NOW - 3 * HOUR })), undefined);
  assert.equal(un(bug("B20", { severity: "medium" })), undefined);
  assert.equal(un(bug("B20", { severity: "low" })), undefined);
  assert.equal(un(bug("B20", { fix: "pr-open" })), undefined);
  assert.equal(un(bug("B20", { fix: { state: "branch", branch: "fix/b20" } })), undefined);
  assert.equal(un(bug("B20", { pending: true })), undefined);
  assert.equal(un(bug("B20", { ledgerState: "in-flight" })), undefined);
  assert.equal(un(bug("B20", { ledgerState: "done" })), undefined);
  // claimed (by the bug's own item or a register item naming it)
  const claimed = mkState([item("B20", { claimedBy: "pc-lane" })]);
  assert.equal(un(bug("B20"), { state: claimed }), undefined);
  const viaItem = mkState([item("525", { claimedBy: "pc-lane" })]);
  assert.equal(un(bug("B20", { items: ["525"] }), { state: viaItem }), undefined);
  // a branch or open PR that names it counts even when the bug carries no fix state
  const b = { branch: "fix/b20-thing", date: new Date(NOW - HOUR).toISOString() };
  assert.equal(un(bug("B20", { fix: undefined }), { branches: [b] }), undefined);
  const pr = { open: [{ number: 5, branch: "x", title: "fix B20" }], merged: [] };
  assert.equal(un(bug("B20", { fix: undefined }), { prs: pr }), undefined);
  assert.ok(un(bug("B20", { fix: undefined })));
});

test("bug-no-registry: a B-id in an open PR or recent branch with no registry file", () => {
  const ids = ["B1", "B2"];
  const prs = {
    open: [
      { number: 5, branch: "feat/x", title: "fix B999 dispatch", body: "" },
      { number: 6, branch: "fix/b2-thing", title: "ok", body: "" },
    ],
    merged: [],
  };
  const branches = [
    { branch: "fix/b888-y", date: new Date(NOW - 2 * HOUR).toISOString() },
    { branch: "fix/b777-old", date: new Date(NOW - 20 * 24 * HOUR).toISOString() },
  ];
  const alarms = run({ prs, branches, bugIds: ids });
  const a = find(alarms, "bug-no-registry:B999");
  assert.equal(a.severity, "warn");
  assert.equal(a.pr, 5);
  assert.match(a.message, /B999/);
  assert.ok(find(alarms, "bug-no-registry:B888"));
  assert.equal(find(alarms, "bug-no-registry:B2"), undefined);
  assert.equal(find(alarms, "bug-no-registry:B777"), undefined);
  // a pending bug (filed on a branch) is known; with no registry list loaded nothing fires
  const pend = run({ prs, branches, bugIds: ids, bugs: [bug("B999", { pending: true })] });
  assert.equal(find(pend, "bug-no-registry:B999"), undefined);
  assert.equal(find(run({ prs, branches }), "bug-no-registry:B999"), undefined);
});

test("bug-unowned-backlog: one warn per severity x domain with the B-ids; claims and branches drop out", () => {
  const old = NOW - 20 * 24 * HOUR;
  const bugs = [
    bug("B30", { severity: "high", domain: "orders", filedAt: old }),
    bug("B31", { severity: "high", domain: "orders", filedAt: null }),
    bug("B32", { severity: "critical", domain: "orders", filedAt: old }),
    bug("B33", { severity: "high", domain: "nope", filedAt: old }),
    bug("B34", { severity: "medium", domain: "orders", filedAt: old }),
    bug("B35", { severity: "high", domain: "orders", filedAt: NOW - 5 * 24 * HOUR }),
  ];
  const alarms = run({ bugs });
  const a = find(alarms, "bug-unowned-backlog:high:orders");
  assert.equal(a.severity, "warn");
  assert.deepEqual(a.items, ["B30", "B31"]);
  assert.match(
    a.message,
    /^2 high Orders & sales bugs have no owner, branch or PR for more than 7 days/,
  );
  assert.deepEqual(find(alarms, "bug-unowned-backlog:critical:orders").items, ["B32"]);
  assert.deepEqual(find(alarms, "bug-unowned-backlog:high:other").items, ["B33"]);
  assert.equal(find(alarms, "bug-unowned:B30"), undefined);
  assert.ok(find(alarms, "bug-unowned:B35")); // within 7 days -> per-bug
  // drop-out: a claim and a branch remove bugs from the count
  const claimed = mkState([item("B30", { claimedBy: "pc-lane" })]);
  const br = [{ branch: "fix/b31-x", date: new Date(NOW - HOUR).toISOString() }];
  assert.equal(
    find(run({ bugs, state: claimed, branches: br }), "bug-unowned-backlog:high:orders"),
    undefined,
  );
  assert.deepEqual(find(run({ bugs, state: claimed }), "bug-unowned-backlog:high:orders").items, [
    "B31",
  ]);
});

test("bug-unowned-backlog groups masked security bugs on their own, not under Other", () => {
  const old = NOW - 30 * 24 * HOUR;
  const bugs = [
    bug("B901", { severity: "high", sensitive: true, area: null, domain: null, filedAt: old }),
    bug("B902", { severity: "high", sensitive: true, area: null, domain: null, filedAt: old }),
    bug("B903", { severity: "high", area: null, domain: null, filedAt: old }),
  ];
  const alarms = run({ bugs });
  const sec = find(alarms, "bug-unowned-backlog:high:security");
  assert.deepEqual(sec.items, ["B901", "B902"]);
  assert.match(sec.message, /security hardening \(details private\)/);
  assert.deepEqual(find(alarms, "bug-unowned-backlog:high:other").items, ["B903"]);
});
