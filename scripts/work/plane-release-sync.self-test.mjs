#!/usr/bin/env node
// Coverage for scripts/work/plane-release-sync.mjs — PURE parts only (change
// detection, throttle incl. the major-release override, plan building from
// fixtures), same standalone convention as the campaign/plane-*.self-test.mjs
// suite: `node scripts/work/plane-release-sync.self-test.mjs`, PASS/FAIL
// lines, `process.exit(failures ? 1 : 0)`. No network, no fs, no fake
// server — every function under test here takes plain data in and returns
// plain data out. The live GitHub+Plane dry-run proof (runReleaseSync end to
// end) is run separately, by hand, per the task's own instructions.
import {
  autoMatchReleaseRef,
  buildReleaseOps,
  computeAtRisk,
  computeReleaseSnapshot,
  countRealSyncsToday,
  decideThrottle,
  DEFAULT_PREVIOUS_RELEASE,
  diffRelease,
  escapeHtml,
  extractFeatureKey,
  formatDate,
  formatDescriptionLine,
  loadMapping,
  resolveReleaseRef,
  upsertReleaseLine,
} from "./plane-release-sync.mjs";

let failures = 0;
function check(name, got, want) {
  const gotJson = JSON.stringify(got);
  const wantJson = JSON.stringify(want);
  if (gotJson === wantJson) {
    console.log(`PASS ${name}`);
  } else {
    failures++;
    console.log(`FAIL ${name}\n  got:  ${gotJson}\n  want: ${wantJson}`);
  }
}
function checkTrue(name, got) {
  check(name, Boolean(got), true);
}

const NOW = new Date("2026-09-24T12:00:00Z");

// ── extractFeatureKey ───────────────────────────────────────────────────
check(
  "extractFeatureKey: standard title",
  extractFeatureKey("F-01 · Sell and edit orders by unit"),
  "F-01",
);
check("extractFeatureKey: two-digit", extractFeatureKey("F-22 · Tracking engine"), "F-22");
check("extractFeatureKey: no match", extractFeatureKey("Bug-register burn-down"), null);
check(
  "extractFeatureKey: legacy F01 (no hyphen) does not match",
  extractFeatureKey("F01 · Schema foundation"),
  null,
);

// ── escapeHtml / formatDate ─────────────────────────────────────────────
check(
  "escapeHtml: escapes ampersand and brackets",
  escapeHtml('<a href="x">A & B</a>'),
  "&lt;a href=&quot;x&quot;&gt;A &amp; B&lt;/a&gt;",
);
check("formatDate: ISO datetime -> date", formatDate("2026-09-22T00:00:00Z"), "2026-09-22");
check("formatDate: null -> null", formatDate(null), null);
check("formatDate: garbage -> null", formatDate("not-a-date"), null);

// ── computeAtRisk ────────────────────────────────────────────────────────
checkTrue(
  "computeAtRisk: past due with open items -> at risk",
  computeAtRisk({ state: "open", dueOn: "2026-09-22T00:00:00Z", open: 8, total: 8, now: NOW }),
);
check(
  "computeAtRisk: past due with zero open items -> not at risk",
  computeAtRisk({ state: "open", dueOn: "2026-09-22T00:00:00Z", open: 0, total: 8, now: NOW }),
  false,
);
checkTrue(
  "computeAtRisk: due in 1 day, 100% open -> at risk",
  computeAtRisk({ state: "open", dueOn: "2026-09-25T00:00:00Z", open: 4, total: 4, now: NOW }),
);
check(
  "computeAtRisk: due in 1 day, 20% open (<=25%) -> not at risk",
  computeAtRisk({ state: "open", dueOn: "2026-09-25T00:00:00Z", open: 1, total: 5, now: NOW }),
  false,
);
check(
  "computeAtRisk: due in 8 days -> not at risk regardless of open%",
  computeAtRisk({ state: "open", dueOn: "2026-10-02T00:00:00Z", open: 3, total: 3, now: NOW }),
  false,
);
check(
  "computeAtRisk: closed milestone is never at risk, even past due",
  computeAtRisk({ state: "closed", dueOn: "2026-09-01T00:00:00Z", open: 2, total: 8, now: NOW }),
  false,
);
check(
  "computeAtRisk: no due date -> not at risk",
  computeAtRisk({ state: "open", dueOn: null, open: 5, total: 5, now: NOW }),
  false,
);

// ── computeReleaseSnapshot ───────────────────────────────────────────────
{
  const milestone = {
    number: 1,
    title: "R1",
    state: "open",
    due_on: "2026-09-22T00:00:00Z",
    html_url: "https://github.com/x/y/milestone/1",
  };
  const features = [
    { number: 1367, title: "F-01 · Sell and edit orders by unit", state: "OPEN", closedAt: null },
    {
      number: 1368,
      title: "F-02 · Purchase orders",
      state: "CLOSED",
      closedAt: "2026-09-23T00:00:00Z",
    },
  ];
  const snap = computeReleaseSnapshot({ milestone, features, now: NOW });
  check(
    "computeReleaseSnapshot: totals",
    { total: snap.total, closed: snap.closed, open: snap.open, percentDone: snap.percentDone },
    {
      total: 2,
      closed: 1,
      open: 1,
      percentDone: 50,
    },
  );
  checkTrue("computeReleaseSnapshot: past-due + open item -> atRisk", snap.atRisk);
  check("computeReleaseSnapshot: feature keyed by F-code", Object.keys(snap.features).sort(), [
    "F-01",
    "F-02",
  ]);
  check(
    "computeReleaseSnapshot: zero features -> 0%, not at risk",
    computeReleaseSnapshot({
      milestone: { ...milestone, due_on: "2026-10-02T00:00:00Z" },
      features: [],
      now: NOW,
    }).percentDone,
    0,
  );
}

// ── diffRelease ──────────────────────────────────────────────────────────
{
  const base = {
    state: "open",
    percentDone: 40,
    atRisk: false,
    features: { "F-01": { number: 1, state: "OPEN" } },
  };
  check(
    "diffRelease: identical current/previous -> unchanged",
    diffRelease({ ...base }, base).changed,
    false,
  );
  check(
    "diffRelease: state flip open->closed sets changed+majorRelease",
    diffRelease({ ...base, state: "closed" }, base),
    { changed: true, majorRelease: true, reasons: ["state open -> closed"], closedOrReopened: [] },
  );
  check(
    "diffRelease: closed->open is NOT a major release",
    diffRelease({ ...base, state: "open" }, { ...base, state: "closed" }).majorRelease,
    false,
  );
  checkTrue(
    "diffRelease: percentDone moved by exactly 10 points -> changed",
    diffRelease({ ...base, percentDone: 50 }, base).changed,
  );
  check(
    "diffRelease: percentDone moved by 9 points -> unchanged",
    diffRelease({ ...base, percentDone: 49 }, base).changed,
    false,
  );
  checkTrue(
    "diffRelease: atRisk flip -> changed",
    diffRelease({ ...base, atRisk: true }, base).changed,
  );
  {
    const current = { ...base, features: { "F-01": { number: 1, state: "CLOSED" } } };
    const d = diffRelease(current, base);
    checkTrue("diffRelease: feature closed -> changed", d.changed);
    check("diffRelease: closedOrReopened records the transition", d.closedOrReopened, [
      { key: "F-01", number: 1, from: "OPEN", to: "CLOSED" },
    ]);
  }
  {
    // No previous snapshot at all for this release: DEFAULT_PREVIOUS_RELEASE
    // is the baseline. A release that is ALREADY at-risk the first time this
    // tool ever looks at it must show as changed, not be silently skipped.
    const current = { state: "open", percentDone: 0, atRisk: true, features: {} };
    checkTrue(
      "diffRelease: cold-start already-at-risk release -> changed",
      diffRelease(current).changed,
    );
    const healthy = { state: "open", percentDone: 0, atRisk: false, features: {} };
    check(
      "diffRelease: cold-start healthy release -> unchanged",
      diffRelease(healthy).changed,
      false,
    );
  }
  check("diffRelease: default previous export shape", DEFAULT_PREVIOUS_RELEASE, {
    state: "open",
    percentDone: 0,
    atRisk: false,
    features: {},
  });
}

// ── decideThrottle (incl. the major-release override) ───────────────────
check(
  "decideThrottle: nothing changed -> no-change",
  decideThrottle({ changed: false, majorRelease: false }),
  { proceed: false, reason: "no-change" },
);
check(
  "decideThrottle: changed, under cap -> proceeds",
  decideThrottle({ changed: true, majorRelease: false, realSyncsToday: 1 }),
  { proceed: true, reason: "under-cap" },
);
check(
  "decideThrottle: changed, at cap, no force -> throttled",
  decideThrottle({ changed: true, majorRelease: false, realSyncsToday: 3 }),
  { proceed: false, reason: "throttled" },
);
check(
  "decideThrottle: changed, at cap, majorRelease -> bypasses cap",
  decideThrottle({ changed: true, majorRelease: true, realSyncsToday: 5 }),
  { proceed: true, reason: "major-release" },
);
check(
  "decideThrottle: changed, at cap, --force -> bypasses cap",
  decideThrottle({ changed: true, majorRelease: false, force: true, realSyncsToday: 9 }),
  { proceed: true, reason: "force" },
);
check(
  "decideThrottle: --force alone does NOT bypass the change requirement",
  decideThrottle({ changed: false, majorRelease: false, force: true, realSyncsToday: 0 }),
  { proceed: false, reason: "no-change" },
);
check(
  "decideThrottle: --force-all bypasses both the cap and the change requirement",
  decideThrottle({ changed: false, majorRelease: false, forceAll: true, realSyncsToday: 99 }),
  { proceed: true, reason: "force-all" },
);

// ── countRealSyncsToday ──────────────────────────────────────────────────
{
  const lines = [
    { ts: "2026-09-24T01:00:00Z", mode: "apply", attempted: true },
    { ts: "2026-09-24T02:00:00Z", mode: "dry-run", attempted: true }, // dry-run never counts
    { ts: "2026-09-24T03:00:00Z", mode: "apply", attempted: false }, // throttled/no-op: not attempted
    { ts: "2026-09-24T04:00:00Z", mode: "apply", attempted: true },
    { ts: "2026-09-23T23:00:00Z", mode: "apply", attempted: true }, // yesterday
  ];
  check(
    "countRealSyncsToday: counts only real, attempted, today's syncs",
    countRealSyncsToday(lines, "2026-09-24"),
    2,
  );
  check("countRealSyncsToday: empty log -> 0", countRealSyncsToday([], "2026-09-24"), 0);
}

// ── autoMatchReleaseRef / resolveReleaseRef ──────────────────────────────
{
  const topLevel = [
    { sequence_id: 96, name: "Release 1 — compressed (ships Tue 22 Sep 14:00Z)" },
    { sequence_id: 52, name: "Backorder / oversell switch" },
  ];
  check(
    "autoMatchReleaseRef: bare 'R1' matches 'Release 1 ...'",
    autoMatchReleaseRef("R1", topLevel),
    "ROAD-96",
  );
  check(
    "autoMatchReleaseRef: 'R1.1 — follow-ups' does not auto-match (has a suffix)",
    autoMatchReleaseRef("R1.1 — follow-ups", topLevel),
    null,
  );
  check(
    "autoMatchReleaseRef: 'R2 — Lite' does not auto-match (no Release 2 item yet)",
    autoMatchReleaseRef("R2 — Lite", topLevel),
    null,
  );
  check(
    "autoMatchReleaseRef: unrelated title -> null",
    autoMatchReleaseRef("Some other thing", topLevel),
    null,
  );
  check(
    "resolveReleaseRef: releaseOverrides takes precedence over auto-match",
    resolveReleaseRef({
      milestoneTitle: "R1",
      topLevelItems: topLevel,
      releaseOverrides: { R1: "ROAD-999" },
    }),
    "ROAD-999",
  );
  check(
    "resolveReleaseRef: falls back to auto-match when no override",
    resolveReleaseRef({ milestoneTitle: "R1", topLevelItems: topLevel, releaseOverrides: {} }),
    "ROAD-96",
  );
  check(
    "resolveReleaseRef: override can supply what auto-match can't (R2)",
    resolveReleaseRef({
      milestoneTitle: "R2 — Lite",
      topLevelItems: topLevel,
      releaseOverrides: { "R2 — Lite": "ROAD-200" },
    }),
    "ROAD-200",
  );
}

// ── formatDescriptionLine / upsertReleaseLine ────────────────────────────
{
  const line = formatDescriptionLine({
    htmlUrl: "https://github.com/najathakram/routeflow/milestone/1",
    closed: 3,
    total: 8,
    dueOn: "2026-09-22T00:00:00Z",
  });
  checkTrue(
    "formatDescriptionLine: carries the marker attribute",
    line.includes('data-plane-release-sync="1"'),
  );
  checkTrue("formatDescriptionLine: carries the fraction", line.includes("3/8 features done"));
  checkTrue("formatDescriptionLine: carries the due date", line.includes("due 2026-09-22"));

  check(
    "upsertReleaseLine: appends to existing human content",
    upsertReleaseLine("<p>Human notes.</p>", line),
    `<p>Human notes.</p>\n${line}`,
  );
  check("upsertReleaseLine: empty description -> just the line", upsertReleaseLine("", line), line);
  {
    const line2 = formatDescriptionLine({
      htmlUrl: "https://github.com/najathakram/routeflow/milestone/1",
      closed: 5,
      total: 8,
      dueOn: "2026-09-22T00:00:00Z",
    });
    const firstPass = upsertReleaseLine("<p>Human notes.</p>", line);
    const secondPass = upsertReleaseLine(firstPass, line2);
    check(
      "upsertReleaseLine: replaces its own prior line in place (idempotent)",
      secondPass,
      `<p>Human notes.</p>\n${line2}`,
    );
    checkTrue(
      "upsertReleaseLine: human content survives the second sync untouched",
      secondPass.startsWith("<p>Human notes.</p>"),
    );
  }
}

// ── buildReleaseOps (plan building from fixtures) ────────────────────────
{
  const current = {
    number: 1,
    title: "R1",
    htmlUrl: "https://github.com/najathakram/routeflow/milestone/1",
    state: "open",
    dueOn: "2026-09-22T00:00:00Z",
    total: 8,
    closed: 1,
    open: 7,
    percentDone: 13,
    atRisk: true,
    features: {
      "F-02": {
        number: 1368,
        title: "F-02 · Purchase orders",
        state: "CLOSED",
        closedAt: "2026-09-23T00:00:00Z",
      },
    },
  };
  const diff = {
    changed: true,
    majorRelease: false,
    reasons: ["atRisk false -> true"],
    closedOrReopened: [{ key: "F-02", number: 1368, from: "OPEN", to: "CLOSED" }],
  };
  const mappingFeatures = { 1368: { road: "ROAD-99" } };

  const { ops, unmappedFeatures } = buildReleaseOps({
    releaseRef: "ROAD-96",
    current,
    diff,
    currentDescriptionHtml: "<p>Existing human notes.</p>",
    mappingFeatures,
  });

  check("buildReleaseOps: op count (release update + comment + 1 mapped feature)", ops.length, 3);
  check(
    "buildReleaseOps: first op updates the release item",
    { op: ops[0].op, ref: ops[0].ref },
    { op: "update", ref: "ROAD-96" },
  );
  checkTrue(
    "buildReleaseOps: release update preserves prior human description",
    ops[0].set.description_html.startsWith("<p>Existing human notes.</p>"),
  );
  check(
    "buildReleaseOps: release update sets target_date from the due date",
    ops[0].set.target_date,
    "2026-09-22",
  );
  check(
    "buildReleaseOps: open release does NOT set state (never fights a human's manual move)",
    ops[0].set.state,
    undefined,
  );
  check(
    "buildReleaseOps: second op is the summary comment on the release",
    { op: ops[1].op, ref: ops[1].ref },
    { op: "comment", ref: "ROAD-96" },
  );
  checkTrue("buildReleaseOps: comment mentions AT RISK", ops[1].html.includes("AT RISK"));
  check("buildReleaseOps: third op moves the mapped closed feature to Done", ops[2], {
    op: "update",
    ref: "ROAD-99",
    set: { state: "Done" },
  });
  check(
    "buildReleaseOps: no unmapped features when the mapping covers everything closed",
    unmappedFeatures,
    [],
  );

  const noMapping = buildReleaseOps({
    releaseRef: "ROAD-96",
    current,
    diff,
    currentDescriptionHtml: "",
    mappingFeatures: {},
  });
  check(
    "buildReleaseOps: unmapped closed feature reported, not guessed",
    noMapping.unmappedFeatures,
    [{ key: "F-02", number: 1368, reason: "no Plane item mapped" }],
  );
  check("buildReleaseOps: unmapped feature never becomes a 3rd op", noMapping.ops.length, 2);

  const closedMilestone = { ...current, state: "closed" };
  const closedOps = buildReleaseOps({
    releaseRef: "ROAD-96",
    current: closedMilestone,
    diff,
    currentDescriptionHtml: "",
    mappingFeatures,
  });
  check(
    "buildReleaseOps: a CLOSED milestone's release update DOES set state:Done",
    closedOps.ops[0].set.state,
    "Done",
  );

  const reopened = {
    ...current,
    features: { "F-02": { number: 1368, title: "x", state: "OPEN", closedAt: null } },
  };
  const reopenedDiff = {
    changed: true,
    majorRelease: false,
    reasons: ["features: F-02 CLOSED->OPEN"],
    closedOrReopened: [{ key: "F-02", number: 1368, from: "CLOSED", to: "OPEN" }],
  };
  const reopenedOps = buildReleaseOps({
    releaseRef: "ROAD-96",
    current: reopened,
    diff: reopenedDiff,
    currentDescriptionHtml: "",
    mappingFeatures,
  });
  check(
    "buildReleaseOps: a reopened (CLOSED->OPEN) feature is never auto-moved",
    reopenedOps.ops.length,
    2,
  );
  check(
    "buildReleaseOps: a reopened feature is not reported as 'unmapped' either (only closes are actionable)",
    reopenedOps.unmappedFeatures,
    [],
  );
}

// ── loadMapping ───────────────────────────────────────────────────────────
check(
  "loadMapping: normal shape passes through",
  loadMapping({ releaseOverrides: { R1: "ROAD-1" }, features: { 1: { road: "ROAD-2" } } }),
  {
    releaseOverrides: { R1: "ROAD-1" },
    features: { 1: { road: "ROAD-2" } },
  },
);
check("loadMapping: null input -> both empty", loadMapping(null), {
  releaseOverrides: {},
  features: {},
});
check(
  "loadMapping: malformed input -> both empty",
  loadMapping({ releaseOverrides: "not an object" }),
  { releaseOverrides: {}, features: {} },
);

console.log(failures ? `\n${failures} failure(s)` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
