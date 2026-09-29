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
  buildReleaseCreateOp,
  buildReleaseOps,
  buildReleasePlanForMilestone,
  computeAtRisk,
  computeReleaseSnapshot,
  countRealSyncsToday,
  decideThrottle,
  DEFAULT_PREVIOUS_RELEASE,
  diffRelease,
  escapeHtml,
  extractFeatureKey,
  findByExactReleaseName,
  formatDate,
  formatDescriptionLine,
  generateReleaseName,
  loadMapping,
  parseReleaseMilestoneTitle,
  resolveReleaseRef,
  upsertReleaseLine,
} from "./plane-release-sync.mjs";
import { readFileSync as readPkgFile } from "node:fs";

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
  check(
    "resolveReleaseRef: a snapshot-recorded ref wins over auto-match/exact-name",
    resolveReleaseRef({
      milestoneTitle: "R1",
      topLevelItems: topLevel,
      releaseOverrides: {},
      snapshotReleaseRef: "ROAD-500",
    }),
    "ROAD-500",
  );
  check(
    "resolveReleaseRef: a snapshot ref survives even if the item's name later changed (no exact/auto match)",
    resolveReleaseRef({
      milestoneTitle: "R2 — Lite",
      topLevelItems: [{ sequence_id: 7, name: "Renamed by a human" }],
      releaseOverrides: {},
      snapshotReleaseRef: "ROAD-7",
    }),
    "ROAD-7",
  );
}

// ── parseReleaseMilestoneTitle / generateReleaseName / findByExactReleaseName
{
  check("parseReleaseMilestoneTitle: bare 'R1'", parseReleaseMilestoneTitle("R1"), {
    id: "1",
    rest: "",
  });
  check(
    "parseReleaseMilestoneTitle: 'R1.1 — follow-ups'",
    parseReleaseMilestoneTitle("R1.1 — follow-ups"),
    {
      id: "1.1",
      rest: "follow-ups",
    },
  );
  check("parseReleaseMilestoneTitle: 'R2 — Lite'", parseReleaseMilestoneTitle("R2 — Lite"), {
    id: "2",
    rest: "Lite",
  });
  check(
    "parseReleaseMilestoneTitle: 'R3 — CRM + K-hub'",
    parseReleaseMilestoneTitle("R3 — CRM + K-hub"),
    {
      id: "3",
      rest: "CRM + K-hub",
    },
  );
  check(
    "parseReleaseMilestoneTitle: plain hyphen also accepted",
    parseReleaseMilestoneTitle("R2 - Lite"),
    {
      id: "2",
      rest: "Lite",
    },
  );
  check(
    "parseReleaseMilestoneTitle: not a release title -> null",
    parseReleaseMilestoneTitle("F-01 · Sell and edit orders by unit"),
    null,
  );

  check("generateReleaseName: bare 'R1' -> 'Release 1'", generateReleaseName("R1"), "Release 1");
  check(
    "generateReleaseName: matches the lead's own example exactly",
    generateReleaseName("R1.1 — follow-ups"),
    "Release 1.1 — follow-ups",
  );
  check("generateReleaseName: 'R2 — Lite'", generateReleaseName("R2 — Lite"), "Release 2 — Lite");
  check(
    "generateReleaseName: 'R3 — CRM + K-hub'",
    generateReleaseName("R3 — CRM + K-hub"),
    "Release 3 — CRM + K-hub",
  );
  check(
    "generateReleaseName: non-release title -> null",
    generateReleaseName("Bug-register burn-down"),
    null,
  );

  const topLevel = [
    { sequence_id: 96, name: "Release 1 — compressed (ships Tue 22 Sep 14:00Z)" },
    { sequence_id: 200, name: "Release 1.1 — follow-ups" },
  ];
  check(
    "findByExactReleaseName: finds an item this tool created (exact name)",
    findByExactReleaseName("R1.1 — follow-ups", topLevel),
    "ROAD-200",
  );
  check(
    "findByExactReleaseName: a PREFIX match (ROAD-96) is not an exact match for a different milestone",
    findByExactReleaseName("R2 — Lite", topLevel),
    null,
  );
  check(
    "findByExactReleaseName: no match at all -> null",
    findByExactReleaseName("R3 — CRM + K-hub", topLevel),
    null,
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

// ── buildReleaseCreateOp / buildReleasePlanForMilestone (the create-when-
// missing path, and the create-then-reuse scenario the lead specifically
// asked to be self-tested: no duplicate create on a second run) ───────────
{
  const openNoProgress = {
    number: 2,
    title: "R1.1 — follow-ups",
    htmlUrl: "https://github.com/najathakram/routeflow/milestone/2",
    state: "open",
    dueOn: "2026-09-25T00:00:00Z",
    total: 4,
    closed: 0,
    open: 4,
    percentDone: 0,
    atRisk: true,
    features: {},
  };

  const createOp = buildReleaseCreateOp({
    milestoneTitle: "R1.1 — follow-ups",
    current: openNoProgress,
  });
  check(
    "buildReleaseCreateOp: op/project/name",
    { op: createOp.op, project: createOp.project, name: createOp.name },
    {
      op: "create",
      project: "ROAD",
      name: "Release 1.1 — follow-ups",
    },
  );
  check("buildReleaseCreateOp: NO type field (paid-tier)", "type" in createOp, false);
  check("buildReleaseCreateOp: target_date from the due date", createOp.target_date, "2026-09-25");
  check("buildReleaseCreateOp: open, no progress yet -> Backlog", createOp.state, "Backlog");
  checkTrue(
    "buildReleaseCreateOp: description carries the marker line",
    createOp.description_html.includes('data-plane-release-sync="1"'),
  );

  check(
    "buildReleaseCreateOp: open WITH progress -> In progress (best-effort 'started')",
    buildReleaseCreateOp({
      milestoneTitle: "R1.1 — follow-ups",
      current: { ...openNoProgress, percentDone: 25 },
    }).state,
    "In progress",
  );
  check(
    "buildReleaseCreateOp: closed milestone -> Done",
    buildReleaseCreateOp({
      milestoneTitle: "R1.1 — follow-ups",
      current: { ...openNoProgress, state: "closed" },
    }).state,
    "Done",
  );
  check(
    "buildReleaseCreateOp: a title that isn't 'R<N>' at all -> null (nothing sensible to create)",
    buildReleaseCreateOp({ milestoneTitle: "Some other thing", current: openNoProgress }),
    null,
  );

  const noChangeDiff = {
    changed: true,
    majorRelease: false,
    reasons: ["atRisk false -> true"],
    closedOrReopened: [],
  };

  // FIRST RUN: no Plane item found anywhere (override/snapshot/auto-match/
  // exact-name all miss) -> the dispatcher queues exactly one `create`.
  const firstRun = buildReleasePlanForMilestone({
    milestoneTitle: "R1.1 — follow-ups",
    current: openNoProgress,
    diff: noChangeDiff,
    releaseRef: null,
    currentDescriptionHtml: "",
    mappingFeatures: {},
  });
  check("buildReleasePlanForMilestone (1st run): exactly one op", firstRun.ops.length, 1);
  check("buildReleasePlanForMilestone (1st run): it's a create", firstRun.ops[0].op, "create");
  check("buildReleasePlanForMilestone (1st run): created=true", firstRun.created, true);

  // SECOND RUN: the item now exists (as if the first run's create succeeded
  // and either the snapshot recorded its ref, or findByExactReleaseName()
  // re-discovers it live) -> resolveReleaseRef finds it, so the dispatcher
  // takes the UPDATE path instead — never a second create.
  const nowExists = [{ sequence_id: 201, name: "Release 1.1 — follow-ups", description_html: "" }];
  const rediscoveredRef = resolveReleaseRef({
    milestoneTitle: "R1.1 — follow-ups",
    topLevelItems: nowExists,
    releaseOverrides: {},
    snapshotReleaseRef: null,
  });
  check(
    "create-then-reuse: second run re-discovers the SAME item by exact name",
    rediscoveredRef,
    "ROAD-201",
  );
  const secondRun = buildReleasePlanForMilestone({
    milestoneTitle: "R1.1 — follow-ups",
    current: openNoProgress,
    diff: noChangeDiff,
    releaseRef: rediscoveredRef,
    currentDescriptionHtml: "",
    mappingFeatures: {},
  });
  check("create-then-reuse: second run produces NO create op", secondRun.created, false);
  checkTrue(
    "create-then-reuse: second run's ops are all update/comment, never create",
    secondRun.ops.every((op) => op.op !== "create"),
  );
  check(
    "create-then-reuse: second run targets the discovered ref, not a new one",
    secondRun.ops[0].ref,
    "ROAD-201",
  );

  // Same idea, but via a snapshot-recorded ref instead of a live exact-name
  // scan (the OTHER re-discovery path the lead asked for).
  const viaSnapshot = resolveReleaseRef({
    milestoneTitle: "R1.1 — follow-ups",
    topLevelItems: [],
    releaseOverrides: {},
    snapshotReleaseRef: "ROAD-201",
  });
  check(
    "create-then-reuse: a snapshot-recorded ref also prevents a second create",
    viaSnapshot,
    "ROAD-201",
  );
  const thirdRun = buildReleasePlanForMilestone({
    milestoneTitle: "R1.1 — follow-ups",
    current: openNoProgress,
    diff: noChangeDiff,
    releaseRef: viaSnapshot,
    currentDescriptionHtml: "",
    mappingFeatures: {},
  });
  check("create-then-reuse (via snapshot ref): still no create op", thirdRun.created, false);
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

// ── VERIFY-PIN (#2285): `npm run verify` runs this self-test ──────────────────
// Unwired, this file protects nothing (found orphaned in the #2273 sweep), so it pins its own
// place in the root verify chain, the same pattern as the F-22 self-tests' T10v/T17v (#2283).
{
  const pkg = JSON.parse(readPkgFile(new URL("../../package.json", import.meta.url), "utf8"));
  const verify = typeof pkg.scripts?.verify === "string" ? pkg.scripts.verify : "";
  check(
    "VERIFY-PIN: verify chain runs scripts/work/plane-release-sync.self-test.mjs",
    verify
      .split("&&")
      .some((step) => step.trim() === "node scripts/work/plane-release-sync.self-test.mjs"),
    true,
  );
}

console.log(failures ? `\n${failures} failure(s)` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
