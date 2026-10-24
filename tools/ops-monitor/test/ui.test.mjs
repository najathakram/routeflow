// Unit tests for the pure decision logic in public/app.js. The browser script exposes it on
// globalThis.__opsUi when there is no document (see the seam near the top of the file).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "..", "public", "app.js"), "utf8");
const ctx = {};
vm.runInNewContext(src, ctx);
// Results come from another realm, so compare plain copies (deepEqual checks prototypes).
const raw = ctx.__opsUi;
const UI = Object.fromEntries(
  Object.entries(raw).map(([k, f]) => [
    k,
    (...a) => {
      const r = f(...a);
      return r === undefined ? r : JSON.parse(JSON.stringify(r));
    },
  ]),
);

const nums = (n) => Array.from({ length: n }, (_, i) => i);

test("the script exposes its pure functions without a document", () => {
  assert.ok(raw, "__opsUi is set");
  for (const k of [
    "capEntries",
    "groupAlarms",
    "plainWord",
    "panelCollapsedByDefault",
    "announceText",
  ])
    assert.equal(typeof raw[k], "function", k);
});

test("capEntries: empty, under, exactly 5, 6, many", () => {
  assert.deepEqual(UI.capEntries([]), { shown: [], hidden: [] });
  assert.deepEqual(UI.capEntries(undefined), { shown: [], hidden: [] });
  assert.equal(UI.capEntries(nums(3)).hidden.length, 0);
  const five = UI.capEntries(nums(5));
  assert.equal(five.shown.length, 5);
  assert.equal(five.hidden.length, 0);
  const six = UI.capEntries(nums(6));
  assert.deepEqual(six.shown, [0, 1, 2, 3, 4]);
  assert.deepEqual(six.hidden, [5]);
  const many = UI.capEntries(nums(12));
  assert.equal(many.shown.length + many.hidden.length, 12);
});

test("capEntries: custom cap, order kept", () => {
  const r = UI.capEntries(["a", "b", "c"], 2);
  assert.deepEqual(r, { shown: ["a", "b"], hidden: ["c"] });
  assert.deepEqual(UI.capEntries(["a"], 0), { shown: [], hidden: ["a"] });
});

test("plainWord: uncampaigned is shown as not yet scheduled; others pass through", () => {
  assert.equal(UI.plainWord("uncampaigned"), "not yet scheduled");
  assert.equal(UI.plainWord("Uncampaigned"), "not yet scheduled");
  assert.equal(UI.plainWord("building"), "building");
  assert.equal(UI.plainWord(""), "");
  assert.equal(UI.plainWord(null), "");
  assert.equal(UI.plainWord(undefined), "");
});

test("panelCollapsedByDefault: only the three long panels", () => {
  for (const k of ["alarms", "map", "tree"]) assert.equal(UI.panelCollapsedByDefault(k), true, k);
  for (const k of ["releases", "owner", "prs", "lanes", "ci", "bugs", "nope"])
    assert.equal(UI.panelCollapsedByDefault(k), false, k);
});

test("panelCountLine: counts per folded panel", () => {
  const snap = {
    alarms: [{ severity: "error" }, { severity: "warn" }, { severity: "error" }],
    map: { domains: [{}, {}, {}] },
    items: [{}, {}],
  };
  assert.equal(UI.panelCountLine("alarms", snap), "Drift & problems (3) · 2 errors");
  assert.equal(
    UI.panelCountLine("alarms", { alarms: [{ severity: "error" }] }),
    "Drift & problems (1) · 1 error",
  );
  assert.equal(
    UI.panelCountLine("alarms", { alarms: [{ severity: "warn" }] }),
    "Drift & problems (1)",
  );
  assert.equal(UI.panelCountLine("alarms", {}), "Drift & problems (0)");
  assert.equal(UI.panelCountLine("map", snap), "System map (3 areas)");
  assert.equal(UI.panelCountLine("map", { map: { domains: [{}] } }), "System map (1 area)");
  assert.equal(UI.panelCountLine("tree", snap), "Item tree (2 items)");
  assert.equal(UI.panelCountLine("tree", {}), "Item tree (0 items)");
  assert.equal(UI.panelCountLine("ci", snap), null);
});

const al = (kind, severity, suggest) => ({
  kind,
  severity,
  message: `${kind} ${severity}`,
  suggest,
});

test("groupAlarms: empty input", () => {
  assert.deepEqual(UI.groupAlarms([]), []);
  assert.deepEqual(UI.groupAlarms(undefined), []);
});

test("groupAlarms: severity first, then bigger groups, then kind name", () => {
  const g = UI.groupAlarms([
    al("past-eta", "info"),
    al("past-eta", "info"),
    al("past-eta", "info"),
    al("lane-silent", "warn"),
    al("untracked-pr", "error"),
    al("stale-source", "warn"),
    al("stale-source", "warn"),
    al("bug-unowned", "error"),
    al("bug-unowned", "error"),
    al("building-stale", "warn"),
  ]);
  assert.deepEqual(
    g.map((x) => x.kind),
    ["bug-unowned", "untracked-pr", "stale-source", "building-stale", "lane-silent", "past-eta"],
  );
  assert.deepEqual(
    g.map((x) => x.severity),
    ["error", "error", "warn", "warn", "warn", "info"],
  );
  assert.equal(g[0].alarms.length, 2);
});

test("groupAlarms: a group takes its worst member severity", () => {
  const g = UI.groupAlarms([
    al("past-eta", "info"),
    al("past-eta", "error"),
    al("lane-silent", "warn"),
  ]);
  assert.equal(g[0].kind, "past-eta");
  assert.equal(g[0].severity, "error");
});

test("groupAlarms: commands collected once per group, missing suggest skipped, order kept", () => {
  const g = UI.groupAlarms([
    al("status-behind-merge", "error", "cmd one"),
    al("status-behind-merge", "error"),
    al("status-behind-merge", "error", "cmd two"),
    al("status-behind-merge", "error", "   "),
  ]);
  assert.equal(g.length, 1);
  assert.deepEqual(g[0].commands, ["cmd one", "cmd two"]);
  assert.equal(g[0].alarms.length, 4);
});

test("groupAlarms: a repeated command is listed once, in first-seen order (review MUST)", () => {
  const g = UI.groupAlarms([
    al("bug-unowned", "warn", "rf claim <B-id>"),
    al("bug-unowned", "warn", "rf claim <B-id>"),
    al("bug-unowned", "warn", "rf event link 742 --pr N"),
    al("bug-unowned", "warn", "  rf claim <B-id>  "),
    al("bug-unowned", "warn", "rf event link 742 --pr N"),
  ]);
  assert.deepEqual(g[0].commands, ["rf claim <B-id>", "rf event link 742 --pr N"]);
  assert.equal(g[0].alarms.length, 5);
});

test("groupAlarms: plain labels for known kinds, dash-to-space fallback", () => {
  const known = [
    "status-behind-merge",
    "bug-fixed-still-open",
    "bug-unowned-backlog",
    "bug-unowned",
    "building-stale",
    "incident-stale",
    "lane-silent",
    "past-eta",
    "stale-source",
    "untracked-pr",
    "unknown-status",
    "untracked-branch",
    "unknown-lane",
  ];
  for (const k of known) {
    const label = UI.kindLabel(k);
    assert.notEqual(label, k.replace(/-/g, " "), k);
    assert.ok(label.length > 8, k);
  }
  assert.equal(UI.kindLabel("status-behind-merge"), "PR merged but the item was not moved on");
  assert.equal(UI.groupAlarms([al("some-new-kind", "warn")])[0].label, "some new kind");
});

test("announceText: silent without a baseline or a change", () => {
  const d = { alarms: 4, errors: 1, conn: "live" };
  assert.equal(UI.announceText(null, d), null);
  assert.equal(UI.announceText(d, null), null);
  assert.equal(UI.announceText(d, { ...d }), null);
});

test("announceText: alarm or error count change", () => {
  const prev = { alarms: 4, errors: 1, conn: "live" };
  assert.match(UI.announceText(prev, { ...prev, alarms: 5 }), /5 alarms, 1 error\./);
  assert.match(UI.announceText(prev, { ...prev, errors: 0 }), /4 alarms, 0 errors\./);
});

test("announceText: connection change, but not out of the first connecting state", () => {
  const prev = { alarms: 1, errors: 0, conn: "live" };
  assert.match(UI.announceText(prev, { ...prev, conn: "offline" }), /Connection offline\./);
  assert.equal(UI.announceText({ ...prev, conn: "connecting" }, { ...prev, conn: "live" }), null);
  const both = UI.announceText(prev, { alarms: 2, errors: 1, conn: "reconnecting" });
  assert.match(both, /Connection reconnecting\./);
  assert.match(both, /2 alarms, 1 error\./);
});

test("announceDue: at most once per 60 seconds", () => {
  assert.equal(UI.announceDue(null, 1000), true);
  assert.equal(UI.announceDue(1000, 1000 + 59999), false);
  assert.equal(UI.announceDue(1000, 1000 + 60000), true);
});

test("laneBeat: heartbeat text and the not-in-config mark", () => {
  assert.deepEqual(UI.laneBeat({ lastHeartbeatAt: "2026-10-19T11:30:00.000Z", known: true }), {
    label: "heartbeat",
    at: "2026-10-19T11:30:00.000Z",
    unknown: false,
  });
  assert.deepEqual(UI.laneBeat({ lastHeartbeatAt: null, known: true }), {
    label: "no heartbeat",
    at: null,
    unknown: false,
  });
  // Older snapshots carry neither field: nothing is marked unknown.
  assert.equal(UI.laneBeat({ id: "x" }).unknown, false);
  assert.equal(UI.laneBeat({ id: "x", known: false }).unknown, true);
});

test("gateLabel: every gate state has its own label and tone; not-run is never read as a pass", () => {
  assert.deepEqual(UI.gateLabel("success"), { label: "gate passes", kind: "ok" });
  assert.deepEqual(UI.gateLabel("failure"), { label: "gate fails", kind: "err" });
  assert.deepEqual(UI.gateLabel("pending"), { label: "gate running", kind: "warn" });
  assert.deepEqual(UI.gateLabel("skipped", true), {
    label: "gate skipped (private)",
    kind: "info",
  });
  assert.deepEqual(UI.gateLabel("skipped"), { label: "gate skipped", kind: "info" });
  assert.deepEqual(UI.gateLabel("none"), { label: "no gate runs", kind: "info" });
  assert.deepEqual(UI.gateLabel("not-run"), { label: "gate not run", kind: "warn" });
  assert.equal(UI.gateLabel("something-new"), null);
});

test("phone CSS: 44 px nav targets, a visible 'updated', and the PR table stacks into labelled cards", () => {
  const css = readFileSync(new URL("../public/app.css", import.meta.url), "utf8");
  const phone = css.slice(css.lastIndexOf("@media (max-width: 600px) {"));
  assert.match(phone, /\.navlink\s*\{[^}]*min-height:\s*44px/);
  assert.doesNotMatch(css, /min-height:\s*34px/, "no 34 px nav override left");
  assert.match(phone, /#updated\s*\{[^}]*display:\s*inline/);
  assert.doesNotMatch(phone, /#updated,\s*\.hdr-machine\s*\{\s*display:\s*none/);
  assert.match(css, /table\.wide-table td::before\s*\{[^}]*attr\(data-label\)/);
  const js = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(js, /setAttribute\("data-label", PR_COLS\[i\]\)/);
});
