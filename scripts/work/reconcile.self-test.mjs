#!/usr/bin/env node
// Coverage for scripts/work/reconcile.mjs's pure derivation layer — everything
// above the "── IO" marker in that file. No fake gh/GraphQL server: every
// export here is a pure function of its inputs (no gh/fs/Date.now calls), so
// this file imports them directly and asserts against hand-built fixtures,
// the same convention scripts/campaign/*.self-test.mjs uses for their unit
// halves (deriveDesired, mapPriority, registryDigest in plane-sync.self-test.mjs).
//
// Run: node scripts/work/reconcile.self-test.mjs
import {
  classifyAddResults,
  parseLabels,
  extractClosesRefs,
  extractBranchIssueNumber,
  resolveLinkedIssueNumbers,
  buildIssuePRIndex,
  deriveIssueStatus,
  derivePRStatus,
  deriveWorkerForIssue,
  deriveWorkerForPR,
  lastActivityInstant,
  lastActivityInstantForPR,
  toDateValue,
  staleClaimAction,
  shouldAutoCloseIssue,
  isExcludedFromBoard,
  shouldSkipClose,
  shouldSkipUnassign,
  attemptGhAction,
  isReconcileLockStale,
  RECONCILE_LOCK_STALE_MS,
  findLaneConflicts,
  milestoneStats,
  overallProjectStatus,
  diffFieldValues,
  deriveIssueFields,
  derivePRFields,
  digestBodyChanged,
  renderDigestBody,
  renderStatusUpdateBody,
  postStatusUpdateIfDue,
  decideWorkStatusIssue,
  shouldHaltWrites,
  buildFieldUpdateMutation,
  buildAddItemsMutation,
  buildDeleteItemsMutation,
  chunk,
  planWrites,
  ISSUE_FIELDS,
  parseArgs,
  RECONCILE_USAGE,
} from "./reconcile.mjs";
import { readFileSync as readPkgFile, existsSync, statSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { fileURLToPath } from "node:url";

let failures = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(
    `${ok ? "  ok  " : "  FAIL"} ${name}${ok ? "" : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`,
  );
}

// ── fixtures ─────────────────────────────────────────────────────────────
const label = (name) => ({ name });
const issue = (overrides = {}) => ({
  number: 100,
  title: "Fix invoice rounding",
  state: "OPEN",
  labels: [],
  assignees: [],
  milestone: null,
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-01T00:00:00Z",
  closedAt: null,
  comments: [],
  ...overrides,
});
const pr = (overrides = {}) => ({
  number: 200,
  title: "fix(api): invoice rounding",
  state: "OPEN",
  isDraft: false,
  merged: false,
  mergedAt: null,
  headRefName: "fix/100-invoice-rounding",
  body: "",
  updatedAt: "2026-09-02T00:00:00Z",
  commits: {
    nodes: [{ commit: { committedDate: "2026-09-02T00:00:00Z", statusCheckRollup: null } }],
  },
  mergeable: "MERGEABLE",
  closingIssuesReferences: [],
  ...overrides,
});

// ── parseLabels ──────────────────────────────────────────────────────────
{
  const p = parseLabels([
    label("prio:P1"),
    label("lane:invoices"),
    label("kind:bug"),
    label("tier1"),
  ]);
  check(
    "parseLabels: priority/lane/kind extracted, other labels kept as flags",
    {
      priority: p.priority,
      lane: p.lane,
      kind: p.kind,
      flags: [...p.flags],
    },
    { priority: "P1", lane: "invoices", kind: "bug", flags: ["tier1"] },
  );

  const empty = parseLabels([]);
  check(
    "parseLabels: no labels -> all unset",
    { priority: empty.priority, lane: empty.lane, kind: empty.kind },
    { priority: null, lane: null, kind: null },
  );
}

// ── PR linking: all three methods ───────────────────────────────────────
{
  check("extractClosesRefs: Closes #12", extractClosesRefs("Closes #12"), [12]);
  check(
    "extractClosesRefs: Fixes #12 and #13, case-insensitive verb",
    extractClosesRefs("fixed #12\nresolves #13"),
    [12, 13],
  );
  check("extractClosesRefs: no reference", extractClosesRefs("just a description"), []);
  check("extractClosesRefs: dedups", extractClosesRefs("Closes #12. Also closes #12 again."), [12]);

  check("extractBranchIssueNumber: kind/N-slug", extractBranchIssueNumber("bug/44-fix-thing"), 44);
  check("extractBranchIssueNumber: no match", extractBranchIssueNumber("random-branch-name"), null);
  check(
    "extractBranchIssueNumber: master is never mistaken for a link",
    extractBranchIssueNumber("master"),
    null,
  );

  const viaClosingRefs = pr({
    closingIssuesReferences: [55],
    body: "",
    headRefName: "chore/9-misc",
  });
  check(
    "resolveLinkedIssueNumbers: method 1 (closingIssuesReferences) combines with method 3 (branch name)",
    resolveLinkedIssueNumbers(viaClosingRefs).sort((a, b) => a - b),
    [9, 55],
  );

  const viaBody = pr({
    closingIssuesReferences: [],
    body: "Closes #77",
    headRefName: "feature/x-no-number",
  });
  check(
    "resolveLinkedIssueNumbers: method 2 (body text)",
    resolveLinkedIssueNumbers(viaBody),
    [77],
  );

  const viaBranch = pr({
    closingIssuesReferences: [],
    body: "no ref here",
    headRefName: "feature/88-thing",
  });
  check(
    "resolveLinkedIssueNumbers: method 3 (branch name)",
    resolveLinkedIssueNumbers(viaBranch),
    [88],
  );

  const viaAllThree = pr({
    closingIssuesReferences: [1],
    body: "Fixes #2",
    headRefName: "bug/3-x",
  });
  check(
    "resolveLinkedIssueNumbers: all three combine and dedup",
    resolveLinkedIssueNumbers(viaAllThree).sort((a, b) => a - b),
    [1, 2, 3],
  );

  const idx = buildIssuePRIndex([
    pr({ number: 201, headRefName: "bug/5-x" }),
    pr({ number: 202, body: "Closes #5" }),
  ]);
  check(
    "buildIssuePRIndex: both PRs indexed under issue 5",
    idx
      .get(5)
      .map((p) => p.number)
      .sort(),
    [201, 202],
  );
}

// ── issue status derivation (exact precedence) ──────────────────────────
{
  check(
    "deriveIssueStatus: closed -> Done",
    deriveIssueStatus(issue({ state: "CLOSED" }), []),
    "Done",
  );
  check(
    "deriveIssueStatus: closed wins even with blocked label (Done takes precedence)",
    deriveIssueStatus(issue({ state: "CLOSED", labels: [label("blocked")] }), []),
    "Done",
  );
  check(
    "deriveIssueStatus: blocked label -> Blocked",
    deriveIssueStatus(issue({ labels: [label("blocked")] }), []),
    "Blocked",
  );
  check(
    "deriveIssueStatus: blocked:owner label -> Blocked",
    deriveIssueStatus(issue({ labels: [label("blocked:owner")] }), []),
    "Blocked",
  );
  check(
    "deriveIssueStatus: blocked wins over needs-triage",
    deriveIssueStatus(issue({ labels: [label("blocked"), label("needs-triage")] }), []),
    "Blocked",
  );
  check(
    "deriveIssueStatus: needs-triage -> Inbox",
    deriveIssueStatus(issue({ labels: [label("needs-triage")] }), []),
    "Inbox",
  );
  check(
    "deriveIssueStatus: linked OPEN non-draft PR -> In review",
    deriveIssueStatus(issue(), [pr({ state: "OPEN", isDraft: false })]),
    "In review",
  );
  check(
    "deriveIssueStatus: needs-triage wins over an open PR",
    deriveIssueStatus(issue({ labels: [label("needs-triage")] }), [
      pr({ state: "OPEN", isDraft: false }),
    ]),
    "Inbox",
  );
  check(
    "deriveIssueStatus: linked draft PR -> In progress",
    deriveIssueStatus(issue(), [pr({ state: "OPEN", isDraft: true })]),
    "In progress",
  );
  check(
    "deriveIssueStatus: assignee with no PR -> In progress",
    deriveIssueStatus(issue({ assignees: [{ login: "alice" }] }), []),
    "In progress",
  );
  check(
    "deriveIssueStatus: a MERGED/closed linked PR does not count as 'linked open PR'",
    deriveIssueStatus(issue(), [pr({ state: "CLOSED", merged: true })]),
    "Ready",
  );
  check("deriveIssueStatus: nothing -> Ready", deriveIssueStatus(issue(), []), "Ready");
}

// ── PR status derivation ────────────────────────────────────────────────
{
  check(
    "derivePRStatus: merged -> Done",
    derivePRStatus(pr({ merged: true, state: "CLOSED" })),
    "Done",
  );
  check(
    "derivePRStatus: closed unmerged -> Done",
    derivePRStatus(pr({ merged: false, state: "CLOSED" })),
    "Done",
  );
  check(
    "derivePRStatus: draft -> In progress",
    derivePRStatus(pr({ isDraft: true })),
    "In progress",
  );
  check(
    "derivePRStatus: open non-draft -> In review",
    derivePRStatus(pr({ isDraft: false, state: "OPEN" })),
    "In review",
  );
}

// ── worker derivation ────────────────────────────────────────────────────
{
  const withComments = issue({
    comments: [
      { body: "Claimed by alice · box1 · session A", createdAt: "2026-09-01T00:00:00Z" },
      { body: "Claimed by bob · box2 · session B", createdAt: "2026-09-03T00:00:00Z" },
      { body: "just a note", createdAt: "2026-09-04T00:00:00Z" },
    ],
  });
  check(
    "deriveWorkerForIssue: newest 'Claimed by' comment wins",
    deriveWorkerForIssue(withComments, []),
    "bob · box2 · session B",
  );

  const noComments = issue({ comments: [] });
  const linkedWithWorker = [pr({ body: "Closes #100\n\nWorker: carol · box3 · session C" })];
  check(
    "deriveWorkerForIssue: falls back to a linked PR's Worker: line",
    deriveWorkerForIssue(noComments, linkedWithWorker),
    "carol · box3 · session C",
  );
  check(
    "deriveWorkerForIssue: no comment, no PR worker line -> null",
    deriveWorkerForIssue(noComments, [pr({ body: "no worker line" })]),
    null,
  );

  check(
    "deriveWorkerForPR: extracts Worker: line",
    deriveWorkerForPR(pr({ body: "Closes #1\n\nWorker: dana · m1 · s1" })),
    "dana · m1 · s1",
  );
  check(
    "deriveWorkerForPR: no line -> null",
    deriveWorkerForPR(pr({ body: "nothing here" })),
    null,
  );
}

// ── last activity ────────────────────────────────────────────────────────
{
  const i = issue({ updatedAt: "2026-09-01T00:00:00Z" });
  const newerPR = pr({
    commits: { nodes: [{ commit: { committedDate: "2026-09-05T12:00:00Z" } }] },
  });
  check(
    "lastActivityInstant: max of issue updatedAt and linked PR's last commit",
    lastActivityInstant(i, [newerPR]),
    "2026-09-05T12:00:00Z",
  );
  check(
    "lastActivityInstant: issue updatedAt wins when it is newer",
    lastActivityInstant(issue({ updatedAt: "2026-09-10T00:00:00Z" }), [newerPR]),
    "2026-09-10T00:00:00Z",
  );
  check(
    "lastActivityInstant: no linked PRs -> issue updatedAt",
    lastActivityInstant(i, []),
    "2026-09-01T00:00:00Z",
  );
  check("toDateValue: truncates to date", toDateValue("2026-09-05T12:34:56Z"), "2026-09-05");
  check("toDateValue: null passthrough", toDateValue(null), null);
  check(
    "lastActivityInstantForPR: last commit date",
    lastActivityInstantForPR(newerPR),
    "2026-09-05T12:00:00Z",
  );
}

// ── deriveIssueFields / derivePRFields composition ──────────────────────
{
  const fields = deriveIssueFields(
    issue({
      labels: [label("prio:P2"), label("lane:pricing"), label("kind:feature")],
      updatedAt: "2026-09-01T00:00:00Z",
    }),
    [],
  );
  check("deriveIssueFields: composes status+labels+worker+last-activity", fields, {
    Status: "Ready",
    Priority: "P2",
    Lane: "pricing",
    Kind: "feature",
    Worker: null,
    "Last activity": "2026-09-01",
  });

  const linkedIssue = issue({
    labels: [label("prio:P0"), label("lane:billing"), label("kind:bug")],
  });
  const prFields = derivePRFields(
    pr({ isDraft: true, body: "Worker: erin · m1 · s1" }),
    linkedIssue,
  );
  check("derivePRFields: Priority/Lane/Kind copied from linked issue", prFields, {
    Status: "In progress",
    Priority: "P0",
    Lane: "billing",
    Kind: "bug",
    Worker: "erin · m1 · s1",
    "Last activity": "2026-09-02",
  });

  const orphanPrFields = derivePRFields(pr(), undefined);
  check(
    "derivePRFields: no linked issue -> Priority/Lane/Kind unset",
    { Priority: orphanPrFields.Priority, Lane: orphanPrFields.Lane, Kind: orphanPrFields.Kind },
    { Priority: null, Lane: null, Kind: null },
  );
}

// ── stale thresholds (section 6) ────────────────────────────────────────
{
  const now = new Date("2026-09-24T00:00:00Z");
  const assigned = (hoursAgo) =>
    issue({
      assignees: [{ login: "alice" }],
      updatedAt: new Date(now.getTime() - hoursAgo * 3_600_000).toISOString(),
    });

  check(
    "staleClaimAction: unassigned issue -> null (nothing to do)",
    staleClaimAction(issue(), [], now),
    null,
  );
  check("staleClaimAction: <24h -> null", staleClaimAction(assigned(10), [], now), null);
  const at30h = staleClaimAction(assigned(30), [], now);
  check(
    "staleClaimAction: 24-72h -> flag",
    { action: at30h.action, reason: at30h.reason },
    { action: "flag", reason: "stale-24h" },
  );
  const at80hNoPR = staleClaimAction(assigned(80), [], now);
  check(
    "staleClaimAction: >72h, no open PR -> unassign",
    { action: at80hNoPR.action, reason: at80hNoPR.reason },
    { action: "unassign", reason: "stale-72h" },
  );
  const at80hWithPR = staleClaimAction(assigned(80), [pr({ state: "OPEN" })], now);
  check(
    "staleClaimAction: >72h WITH an open linked PR -> flag only, never unassign",
    { action: at80hWithPR.action, reason: at80hWithPR.reason },
    { action: "flag", reason: "stale-72h-open-pr" },
  );
  check(
    "staleClaimAction: closed issue -> null",
    staleClaimAction(issue({ state: "CLOSED", assignees: [{ login: "a" }] }), [], now),
    null,
  );
}

// ── auto-close (section 5) ──────────────────────────────────────────────
{
  const openIssue = issue({ state: "OPEN", number: 300 });
  const mergedViaClosingRef = pr({ number: 400, merged: true, closingIssuesReferences: [300] });
  check(
    "shouldAutoCloseIssue: GitHub already auto-closed via closingIssuesReferences -> no action needed",
    shouldAutoCloseIssue(openIssue, [mergedViaClosingRef]),
    null,
  );

  const mergedViaBranchOnly = pr({
    number: 401,
    merged: true,
    closingIssuesReferences: [],
    headRefName: "bug/300-x",
    body: "",
  });
  const toClose = shouldAutoCloseIssue(openIssue, [mergedViaBranchOnly]);
  check(
    "shouldAutoCloseIssue: merged, linked only by branch name, GH didn't auto-close -> we close it, citing the PR",
    toClose?.number,
    401,
  );

  check(
    "shouldAutoCloseIssue: issue already closed -> null",
    shouldAutoCloseIssue(issue({ state: "CLOSED" }), [mergedViaBranchOnly]),
    null,
  );
  check(
    "shouldAutoCloseIssue: linked PR still open (not merged) -> null",
    shouldAutoCloseIssue(openIssue, [pr({ merged: false, state: "OPEN" })]),
    null,
  );
}

// ── worker attribution comment window (fix 3) ────────────────────────────
{
  check(
    "ISSUE_FIELDS: fetches the last 100 comments, not 30, so deriveWorkerForIssue's scan for the newest 'Claimed by' reaches far enough back",
    ISSUE_FIELDS.includes("comments(last: 100)"),
    true,
  );
}

// ── #938 / work-status exclusion (fix 1) ─────────────────────────────────
{
  check(
    "isExcludedFromBoard: issue #938 (FLEET_LOG_ISSUE) -> excluded",
    isExcludedFromBoard(issue({ number: 938 })),
    true,
  );
  check(
    "isExcludedFromBoard: issue carrying the work-status label -> excluded",
    isExcludedFromBoard(issue({ number: 555, labels: [label("work-status")] })),
    true,
  );
  check(
    "isExcludedFromBoard: an ordinary issue -> not excluded",
    isExcludedFromBoard(issue({ number: 100 })),
    false,
  );
  check(
    "isExcludedFromBoard: #938 with unrelated labels is still excluded (number check alone is enough)",
    isExcludedFromBoard(issue({ number: 938, labels: [label("prio:P0")] })),
    true,
  );
}

// ── idempotent close/unassign (fix 2b) ───────────────────────────────────
{
  check(
    "shouldSkipClose: live state already CLOSED -> skip",
    shouldSkipClose({ state: "CLOSED", assignees: [] }),
    true,
  );
  check(
    "shouldSkipClose: live state still OPEN -> do not skip",
    shouldSkipClose({ state: "OPEN", assignees: [] }),
    false,
  );
  check(
    "shouldSkipClose: live read failed (null) -> never skip (go ahead)",
    shouldSkipClose(null),
    false,
  );

  check(
    "shouldSkipUnassign: live assignees already empty -> skip",
    shouldSkipUnassign({ state: "OPEN", assignees: [] }),
    true,
  );
  check(
    "shouldSkipUnassign: live assignees still present -> do not skip",
    shouldSkipUnassign({ state: "OPEN", assignees: [{ login: "alice" }] }),
    false,
  );
  check(
    "shouldSkipUnassign: live read failed (null) -> never skip (go ahead)",
    shouldSkipUnassign(null),
    false,
  );

  const okResult = attemptGhAction(() => {});
  check("attemptGhAction: mutation succeeds -> acted: true", okResult, { acted: true });

  const failResult = attemptGhAction(() => {
    throw new Error("gh: rate limited");
  });
  check(
    "attemptGhAction: mutation throws -> acted: false with the reason, never propagates",
    { acted: failResult.acted, reasonHasMessage: failResult.reason?.includes("gh: rate limited") },
    { acted: false, reasonHasMessage: true },
  );
}

// ── reconcile's own overlap lock (fix 2a) ────────────────────────────────
{
  const NOW = new Date("2026-09-24T12:00:00Z");
  const isoMinutesAgo = (m) => new Date(NOW.getTime() - m * 60_000).toISOString();

  check("isReconcileLockStale: no lock -> stale", isReconcileLockStale(null, NOW), true);
  check(
    "isReconcileLockStale: undefined lock -> stale",
    isReconcileLockStale(undefined, NOW),
    true,
  );
  check(
    "isReconcileLockStale: lock missing startedAt -> stale (corrupt)",
    isReconcileLockStale({ pid: 1 }, NOW),
    true,
  );
  check(
    "isReconcileLockStale: fresh lock (started now) -> not stale",
    isReconcileLockStale({ pid: 1, startedAt: NOW.toISOString() }, NOW),
    false,
  );
  check(
    "isReconcileLockStale: 9 minutes old -> not stale",
    isReconcileLockStale({ pid: 1, startedAt: isoMinutesAgo(9) }, NOW),
    false,
  );
  check(
    "isReconcileLockStale: exactly 10 minutes -> stale (boundary inclusive)",
    isReconcileLockStale(
      { pid: 1, startedAt: new Date(NOW.getTime() - RECONCILE_LOCK_STALE_MS).toISOString() },
      NOW,
    ),
    true,
  );
  check(
    "isReconcileLockStale: 30 minutes old -> stale (an abandoned/crashed run)",
    isReconcileLockStale({ pid: 1, startedAt: isoMinutesAgo(30) }, NOW),
    true,
  );
  check("RECONCILE_LOCK_STALE_MS is 10 minutes", RECONCILE_LOCK_STALE_MS, 10 * 60 * 1000);
}

// ── lane-conflict detection (section 7) ─────────────────────────────────
{
  const rows = [
    { number: 1, lane: "orders", status: "In progress" },
    { number: 2, lane: "orders", status: "In progress" },
    { number: 3, lane: "pricing", status: "In progress" },
    { number: 4, lane: "pricing", status: "Ready" },
    { number: 5, lane: null, status: "In progress" },
  ];
  check(
    "findLaneConflicts: two In-progress issues in one lane -> flagged",
    findLaneConflicts(rows),
    [{ lane: "orders", issues: [1, 2] }],
  );
  check(
    "findLaneConflicts: single In-progress issue in a lane -> not flagged",
    findLaneConflicts([{ number: 9, lane: "billing", status: "In progress" }]),
    [],
  );
  check(
    "findLaneConflicts: no lane label -> ignored, never crashes",
    findLaneConflicts([rows[4]]),
    [],
  );
}

// ── milestone risk (sections 7 + 9) ─────────────────────────────────────
{
  const now = new Date("2026-09-24T00:00:00Z");
  const past = milestoneStats("R1", "2026-09-01", [{ state: "OPEN" }, { state: "CLOSED" }], now);
  check("milestoneStats: past due with an open item -> atRisk", past.atRisk, true);
  check("milestoneStats: past due, 50% open (>25%) -> offTrack too", past.offTrack, true);

  const pastAllDone = milestoneStats(
    "R1.1",
    "2026-09-01",
    [{ state: "CLOSED" }, { state: "CLOSED" }],
    now,
  );
  check("milestoneStats: past due but everything closed -> not atRisk", pastAllDone.atRisk, false);

  const dueSoonHighOpen = milestoneStats(
    "R2",
    "2026-09-25",
    [{ state: "OPEN" }, { state: "OPEN" }, { state: "CLOSED" }],
    now,
  );
  check(
    "milestoneStats: due within 3 days, >25% open -> atRisk, not yet offTrack (not past due)",
    { atRisk: dueSoonHighOpen.atRisk, offTrack: dueSoonHighOpen.offTrack },
    { atRisk: true, offTrack: false },
  );

  const dueSoonLowOpen = milestoneStats(
    "R3",
    "2026-09-25",
    [{ state: "OPEN" }, { state: "CLOSED" }, { state: "CLOSED" }, { state: "CLOSED" }],
    now,
  );
  check(
    "milestoneStats: due within 3 days, <=25% open -> not atRisk",
    dueSoonLowOpen.atRisk,
    false,
  );

  const farOut = milestoneStats("R4", "2026-12-01", [{ state: "OPEN" }], now);
  check("milestoneStats: due far in the future -> never atRisk", farOut.atRisk, false);

  const noItems = milestoneStats("R5", null, [], now);
  check(
    "milestoneStats: no items, no due date -> zeroed out, not atRisk",
    { total: noItems.total, atRisk: noItems.atRisk, percentDone: noItems.percentDone },
    { total: 0, atRisk: false, percentDone: 0 },
  );

  check(
    "overallProjectStatus: an offTrack milestone -> OFF_TRACK (worse than AT_RISK)",
    overallProjectStatus([past, dueSoonHighOpen], 0),
    "OFF_TRACK",
  );
  check(
    "overallProjectStatus: an atRisk milestone alone -> AT_RISK",
    overallProjectStatus([dueSoonHighOpen], 0),
    "AT_RISK",
  );
  check(
    "overallProjectStatus: any open P0 -> AT_RISK even with healthy milestones",
    overallProjectStatus([farOut], 1),
    "AT_RISK",
  );
  check(
    "overallProjectStatus: nothing at risk, no P0 -> ON_TRACK",
    overallProjectStatus([farOut, pastAllDone], 0),
    "ON_TRACK",
  );
}

// ── change detection: unchanged fields produce no writes ────────────────
{
  const current = {
    Status: "Ready",
    Priority: "P2",
    Lane: "orders",
    Kind: "bug",
    Worker: null,
    "Last activity": "2026-09-01",
  };
  const identicalDesired = { ...current };
  const { changed, cleared } = diffFieldValues(current, identicalDesired);
  check(
    "diffFieldValues: fully identical -> zero changed, zero cleared",
    { changed, cleared },
    { changed: {}, cleared: [] },
  );

  const oneFieldChanged = { ...current, Status: "In progress" };
  const diff2 = diffFieldValues(current, oneFieldChanged);
  check("diffFieldValues: exactly one differing field -> exactly one write", diff2, {
    changed: { Status: "In progress" },
    cleared: [],
  });

  const clearWorker = { ...current, Worker: null };
  const currentWithWorker = { ...current, Worker: "alice" };
  const diff3 = diffFieldValues(currentWithWorker, clearWorker);
  check(
    "diffFieldValues: desired null where current has a value -> goes to cleared, not changed",
    diff3,
    { changed: {}, cleared: ["Worker"] },
  );

  const bothNull = diffFieldValues({ Worker: null }, { Worker: null });
  check("diffFieldValues: both unset -> no clear emitted (would be a no-op write)", bothNull, {
    changed: {},
    cleared: [],
  });

  // planWrites: end-to-end including field/option id resolution and the
  // unknown-option skip guard.
  const fieldsByName = {
    Status: {
      id: "F_status",
      options: [
        { id: "opt-ready", name: "Ready" },
        { id: "opt-inprog", name: "In progress" },
      ],
    },
    Worker: { id: "F_worker", options: null },
  };
  const noopPlan = planWrites({
    projectId: "P1",
    itemId: "I1",
    current: { Status: "Ready" },
    desired: { Status: "Ready" },
    fieldsByName,
  });
  check("planWrites: unchanged single-select field -> zero writes", noopPlan.writes, []);

  const realPlan = planWrites({
    projectId: "P1",
    itemId: "I1",
    current: { Status: "Ready" },
    desired: { Status: "In progress" },
    fieldsByName,
  });
  check("planWrites: changed single-select resolves to its option id", realPlan.writes, [
    {
      projectId: "P1",
      itemId: "I1",
      fieldId: "F_status",
      kind: "singleSelect",
      value: "opt-inprog",
    },
  ]);

  const unknownOptionPlan = planWrites({
    projectId: "P1",
    itemId: "I1",
    current: {},
    desired: { Status: "Blocked" },
    fieldsByName,
  });
  check(
    "planWrites: desired option not live on the board -> skipped, not written",
    { writes: unknownOptionPlan.writes, skippedField: unknownOptionPlan.skipped[0]?.field },
    { writes: [], skippedField: "Status" },
  );

  const clearPlan = planWrites({
    projectId: "P1",
    itemId: "I1",
    current: { Worker: "bob" },
    desired: { Worker: null },
    fieldsByName,
  });
  check(
    "planWrites: clearing a text field emits a clear write, no option lookup",
    clearPlan.writes,
    [{ projectId: "P1", itemId: "I1", fieldId: "F_worker", clear: true }],
  );
}

// ── digest rendering ─────────────────────────────────────────────────────
{
  const empty = renderDigestBody({
    generatedAtLabel: "2026-09-24 12:00 UTC",
    releases: [],
    staleClaims: [],
    laneConflicts: [],
    orphanPRs: [],
    reviewStalePRs: [],
    inboxStale: [],
    inFlight: [],
    inboxCount: 0,
    recentlyDone: [],
  });
  check(
    "renderDigestBody: top line names the updater and the UTC time",
    empty.startsWith("Updated 2026-09-24 12:00 UTC by the reconciler"),
    true,
  );
  check(
    "renderDigestBody: quiet run says 'Nothing outstanding.'",
    empty.includes("Nothing outstanding."),
    true,
  );
  check(
    "renderDigestBody: every required section header is present",
    ["## Releases", "## Needs attention", "## In flight", "## Inbox: 0", "## Recently done"].every(
      (h) => empty.includes(h),
    ),
    true,
  );
  // Mobile-friendly: tables stay at or under 4 columns.
  const tableHeaderLines = empty.split("\n").filter((l) => l.startsWith("| ") && l.includes(" | "));
  const maxCols = Math.max(...tableHeaderLines.map((l) => l.split("|").length - 2));
  check("renderDigestBody: no table exceeds 4 columns", maxCols <= 4, true);

  const withDrift = renderDigestBody({
    generatedAtLabel: "2026-09-24 12:00 UTC",
    releases: [
      {
        title: "R1",
        dueOn: "2026-10-01",
        total: 4,
        open: 1,
        closed: 3,
        percentDone: 75,
        atRisk: false,
        offTrack: false,
      },
    ],
    staleClaims: [{ number: 12, worker: "alice · box1 · s1", hours: 30, reason: "stale-24h" }],
    laneConflicts: [{ lane: "orders", issues: [1, 2] }],
    orphanPRs: [55],
    reviewStalePRs: [{ number: 66, reason: "no commit in 60h" }],
    inboxStale: [77],
    inFlight: [{ number: 12, status: "In progress", worker: "alice · box1 · s1", title: "x" }],
    inboxCount: 3,
    recentlyDone: [{ number: 88, title: "Shipped thing" }],
  });
  check("renderDigestBody: stale claim referenced as #N", withDrift.includes("#12"), true);
  check(
    "renderDigestBody: lane conflict lists both issues",
    withDrift.includes("orders: #1, #2"),
    true,
  );
  check("renderDigestBody: orphan PR referenced as #N", withDrift.includes("#55"), true);
  check(
    "renderDigestBody: recently done lists the closed issue",
    withDrift.includes("#88 Shipped thing"),
    true,
  );

  check(
    "digestBodyChanged: identical content, different timestamp line -> unchanged",
    digestBodyChanged(
      "Updated 2026-09-24 00:00 UTC by the reconciler\n\nsame body",
      "Updated 2026-09-24 06:00 UTC by the reconciler\n\nsame body",
    ),
    false,
  );
  check(
    "digestBodyChanged: real content difference -> changed",
    digestBodyChanged("Updated X\n\nbody A", "Updated Y\n\nbody B"),
    true,
  );

  const statusBody = renderStatusUpdateBody("AT_RISK", {
    releases: [
      { title: "R1", dueOn: "2026-10-01", percentDone: 50, atRisk: true, offTrack: false },
    ],
    staleClaims: [],
    laneConflicts: [],
    orphanPRs: [],
    reviewStalePRs: [],
    inboxCount: 2,
    inFlight: [],
    digestIssueUrl: "https://github.com/najathakram/routeflow/issues/999",
  });
  const statusLines = statusBody.split("\n").filter(Boolean);
  check(
    "renderStatusUpdateBody: 5-8 lines",
    statusLines.length >= 5 && statusLines.length <= 8,
    true,
  );
  check(
    "renderStatusUpdateBody: names the overall status and links the digest issue",
    statusBody.includes("AT_RISK") && statusBody.includes("issues/999"),
    true,
  );
}

// ── status-update persistence ordering (fix 5) ───────────────────────────
{
  const NOW = new Date("2026-09-24T12:00:00Z");
  const baseState = { lastDigestUpdatedAt: "2026-09-23T00:00:00Z" };

  {
    const calls = [];
    const result = postStatusUpdateIfDue({
      shouldPostStatus: true,
      halted: false,
      dryRun: false,
      now: NOW,
      state: baseState,
      overallStatus: "AT_RISK",
      statusBody: "body",
      post: (body) => calls.push(`post:${body}`),
      save: (s) => calls.push(`save:${s.lastStatusValue}`),
    });
    check(
      "postStatusUpdateIfDue: due -> posts, THEN immediately saves (before any other step)",
      calls,
      ["post:body", "save:AT_RISK"],
    );
    check(
      "postStatusUpdateIfDue: returned state carries the new lastStatusPostedAt/lastStatusValue",
      { posted: result.posted, lastStatusValue: result.state.lastStatusValue },
      { posted: true, lastStatusValue: "AT_RISK" },
    );
  }

  {
    const calls = [];
    postStatusUpdateIfDue({
      shouldPostStatus: false,
      halted: false,
      dryRun: false,
      now: NOW,
      state: baseState,
      overallStatus: "ON_TRACK",
      statusBody: "body",
      post: (body) => calls.push(`post:${body}`),
      save: (s) => calls.push(`save:${s.lastStatusValue}`),
    });
    check("postStatusUpdateIfDue: not due -> neither posts nor saves", calls, []);
  }

  {
    const calls = [];
    postStatusUpdateIfDue({
      shouldPostStatus: true,
      halted: true,
      dryRun: false,
      now: NOW,
      state: baseState,
      overallStatus: "OFF_TRACK",
      statusBody: "body",
      post: (body) => calls.push(`post:${body}`),
      save: (s) => calls.push(`save:${s.lastStatusValue}`),
    });
    check("postStatusUpdateIfDue: rate-limit halted -> neither posts nor saves", calls, []);
  }

  {
    const calls = [];
    postStatusUpdateIfDue({
      shouldPostStatus: true,
      halted: false,
      dryRun: true,
      now: NOW,
      state: baseState,
      overallStatus: "AT_RISK",
      statusBody: "body",
      post: (body) => calls.push(`post:${body}`),
      save: (s) => calls.push(`save:${s.lastStatusValue}`),
    });
    check("postStatusUpdateIfDue: dry-run -> posts (dry-run-aware) but never saves", calls, [
      "post:body",
    ]);
  }
}

// ── decideWorkStatusIssue (fix: #2043 duplicate-of-#1507) ──────────────────
{
  const row = (number, title = "Work board status (auto-updated)") => ({
    number,
    title,
    body: "digest",
  });

  check(
    "persisted issue is open and still carries the label -> use it, no gh issue list needed",
    decideWorkStatusIssue({
      persisted: { number: 1507, state: "OPEN", labels: [{ name: "work-status" }] },
    }),
    { action: "use", number: 1507, closeDuplicates: [] },
  );

  check(
    "persisted issue was closed -> falls through to the label lookup (not used as-is)",
    decideWorkStatusIssue({
      persisted: { number: 1507, state: "CLOSED", labels: [{ name: "work-status" }] },
      labelRows: [row(1507)],
      labelAttemptsCount: 1,
    }),
    { action: "use", number: 1507, closeDuplicates: [] },
  );

  check(
    "persisted issue lost the label -> falls through to the label lookup",
    decideWorkStatusIssue({
      persisted: { number: 1507, state: "OPEN", labels: [] },
      labelRows: [row(1507)],
      labelAttemptsCount: 1,
    }),
    { action: "use", number: 1507, closeDuplicates: [] },
  );

  check(
    "no persisted number, first label attempt finds exactly #1507 -> use it",
    decideWorkStatusIssue({ persisted: null, labelRows: [row(1507)], labelAttemptsCount: 1 }),
    { action: "use", number: 1507, closeDuplicates: [] },
  );

  check(
    "first label attempt comes back empty (the #2043 flake) and no title search yet -> " +
      "NOT enough evidence to create — caller must retry, never creates on one empty read",
    decideWorkStatusIssue({ persisted: null, labelRows: [], labelAttemptsCount: 1 }),
    { action: "insufficient-evidence", number: null, closeDuplicates: [] },
  );

  check(
    "first attempt empty, retry (2nd attempt) finds #1507 -> use it, still never created a dup",
    decideWorkStatusIssue({ persisted: null, labelRows: [row(1507)], labelAttemptsCount: 2 }),
    { action: "use", number: 1507, closeDuplicates: [] },
  );

  check(
    "both label attempts empty, title search finds #1507 -> use it",
    decideWorkStatusIssue({
      persisted: null,
      labelRows: [],
      labelAttemptsCount: 2,
      titleRows: [row(1507)],
    }),
    { action: "use", number: 1507, closeDuplicates: [] },
  );

  check(
    "both label attempts empty, title search also empty -> only now create",
    decideWorkStatusIssue({ persisted: null, labelRows: [], labelAttemptsCount: 2, titleRows: [] }),
    { action: "create", number: null, closeDuplicates: [] },
  );

  check(
    "both label attempts empty, title search not run yet (null) -> still not enough evidence",
    decideWorkStatusIssue({
      persisted: null,
      labelRows: [],
      labelAttemptsCount: 2,
      titleRows: null,
    }),
    { action: "insufficient-evidence", number: null, closeDuplicates: [] },
  );

  check(
    "label lookup finds two open work-status issues (#1507 and dup #2043) -> use the lowest, close the other",
    decideWorkStatusIssue({
      persisted: null,
      labelRows: [row(2043), row(1507)],
      labelAttemptsCount: 1,
    }),
    { action: "use", number: 1507, closeDuplicates: [2043] },
  );

  check(
    "title search finds three matches -> use the lowest, close the rest as duplicates",
    decideWorkStatusIssue({
      persisted: null,
      labelRows: [],
      labelAttemptsCount: 2,
      titleRows: [row(2043), row(1507), row(3001)],
    }),
    { action: "use", number: 1507, closeDuplicates: [2043, 3001] },
  );
}

// ── rate limit circuit breaker ───────────────────────────────────────────
{
  check("shouldHaltWrites: below floor -> halt", shouldHaltWrites(199), true);
  check(
    "shouldHaltWrites: at floor -> does not halt (floor is exclusive)",
    shouldHaltWrites(200),
    false,
  );
  check("shouldHaltWrites: comfortably above -> does not halt", shouldHaltWrites(5000), false);
  check(
    "shouldHaltWrites: unknown remaining -> does not halt (never blocks on a missing read)",
    shouldHaltWrites(undefined),
    false,
  );
}

// ── GraphQL mutation builders (string shape only, no network) ───────────
{
  const m = buildFieldUpdateMutation([
    { projectId: "P1", itemId: "I1", fieldId: "F1", kind: "singleSelect", value: "OPT1" },
    { projectId: "P1", itemId: "I2", fieldId: "F2", clear: true },
  ]);
  check(
    "buildFieldUpdateMutation: aliases m0, m1 in order",
    m.includes("m0: updateProjectV2ItemFieldValue") &&
      m.includes("m1: clearProjectV2ItemFieldValue"),
    true,
  );
  check(
    "buildFieldUpdateMutation: single-select value carries singleSelectOptionId",
    m.includes("singleSelectOptionId"),
    true,
  );

  const addM = buildAddItemsMutation("P1", ["C1", "C2"]);
  check(
    "buildAddItemsMutation: aliases a0, a1",
    addM.includes("a0: addProjectV2ItemById") && addM.includes("a1: addProjectV2ItemById"),
    true,
  );

  const delM = buildDeleteItemsMutation("P1", ["I1", "I2"]);
  check(
    "buildDeleteItemsMutation: aliases d0, d1",
    delM.includes("d0: deleteProjectV2Item") && delM.includes("d1: deleteProjectV2Item"),
    true,
  );
  check(
    "buildDeleteItemsMutation: carries the project + item ids",
    delM.includes('projectId: "P1"') &&
      delM.includes('itemId: "I1"') &&
      delM.includes('itemId: "I2"'),
    true,
  );

  check("chunk: splits into groups of the given size", chunk([1, 2, 3, 4, 5], 2), [
    [1, 2],
    [3, 4],
    [5],
  ]);
  check(
    "chunk: batches of exactly 20 for the 20-per-request rule",
    chunk(new Array(45).fill(0), 20).map((c) => c.length),
    [20, 20, 5],
  );
}

// ── add-items: "already exists" is success, not failure ─────────────────
{
  const r = classifyAddResults(
    ["C1", "C2", "C3"],
    { a0: { item: { id: "I1" } }, a1: null, a2: null },
    [
      { path: ["a1"], message: "Content already exists in this project" },
      { path: ["a2"], message: "Could not resolve to a node" },
    ],
  );
  check("classifyAddResults: added item keeps its id", [...r.added], [["C1", "I1"]]);
  check("classifyAddResults: already-on-board content is not an error", r.existing, ["C2"]);
  check("classifyAddResults: any other error is fatal", r.fatal, ["Could not resolve to a node"]);
}

// ── a PR inherits its worker from the claimed linked issue ───────────────
{
  const issue = {
    number: 7,
    labels: [],
    comments: [{ body: "Claimed by Ana · PC · Lane F", createdAt: "2026-09-24T10:00:00Z" }],
  };
  const pr = {
    number: 70,
    state: "OPEN",
    isDraft: false,
    body: "Closes #7",
    commits: { nodes: [] },
  };
  check(
    "derivePRFields: worker falls back to the linked issue claim",
    derivePRFields(pr, issue).Worker,
    "Ana · PC · Lane F",
  );
  check(
    "derivePRFields: the PR's own Worker: line wins",
    derivePRFields({ ...pr, body: "Closes #7\n\nWorker: Bo · Mac · Lane B" }, issue).Worker,
    "Bo · Mac · Lane B",
  );
}

// ── CLI arguments (#2284): `--help` once ran a LIVE apply ─────────────────────
{
  const ok = (argv) => {
    const r = parseArgs(argv);
    return r.ok
      ? { apply: r.apply, dryRun: r.dryRun, help: r.help, json: r.json, quiet: r.quiet }
      : r;
  };
  check("#2284 parseArgs: a bare run is a DRY RUN", ok([]).dryRun, true);
  check("#2284 parseArgs: --dry-run is a dry run", ok(["--dry-run"]).dryRun, true);
  check("#2284 parseArgs: only --apply writes", ok(["--apply", "--quiet"]), {
    apply: true,
    dryRun: false,
    help: false,
    json: false,
    quiet: true,
  });
  check(
    "#2284 parseArgs: --help is help (and not an apply)",
    ok(["--help"]).help && !ok(["--help"]).apply,
    true,
  );
  check("#2284 parseArgs: -h is help", ok(["-h"]).help, true);
  for (const bad of [["--dryrun"], ["--dry_run"], ["--Apply"], ["apply"], ["--quiet", "--typo"]])
    check(`#2284 parseArgs: ${JSON.stringify(bad)} is refused`, parseArgs(bad).ok, false);
  check(
    "#2284 parseArgs: --apply with --dry-run is refused",
    parseArgs(["--apply", "--dry-run"]).ok,
    false,
  );

  // The CLI end to end: a refused or help run exits BEFORE the lock, the log, the state file or
  // any gh call. PATH is an empty directory, so a gh call could not even start (it would fail
  // loudly, exit 1); the three local files are compared byte-for-byte-by-stat before and after.
  const SCRIPT = fileURLToPath(new URL("./reconcile.mjs", import.meta.url));
  // B973: the CLI runs against a TEMP work dir (RECONCILE_WORK_DIR), never the real local-assets/work, so a real reconcile
  // (or `work:reconcile:apply`) running during verify can no longer flip a before/after stat.
  const WORK = mkdtempSync(joinPath(tmpdir(), "rf-973-work-"));
  const REAL_WORK = fileURLToPath(new URL("../../local-assets/work/", import.meta.url));
  const realFiles = ["reconcile-state.json", "reconcile.log", "reconcile.lock"].map((f) =>
    joinPath(REAL_WORK, f),
  );
  const statOf = (fs) =>
    fs.map((f) => (existsSync(f) ? `${statSync(f).size}:${statSync(f).mtimeMs}` : "absent"));
  const realBefore = statOf(realFiles);
  const files = ["reconcile-state.json", "reconcile.log", "reconcile.lock"].map((f) =>
    joinPath(WORK, f),
  );
  const snap = () => statOf(files);
  const emptyPath = mkdtempSync(joinPath(tmpdir(), "rf-2284-"));
  const cli = (args, extraEnv = { RECONCILE_WORK_DIR: WORK }) => {
    const env = { ...process.env, PATH: emptyPath, Path: emptyPath, ...extraEnv };
    if (extraEnv.RECONCILE_WORK_DIR === undefined) delete env.RECONCILE_WORK_DIR;
    const r = spawnSync(process.execPath, [SCRIPT, ...args], {
      encoding: "utf8",
      env,
      timeout: 30_000,
    });
    return { status: r.status, out: `${r.stdout}`, err: `${r.stderr}` };
  };
  try {
    for (const bad of [["--dryrun"], ["--help-me"], ["--apply", "--dry-run"]]) {
      const before = snap();
      const r = cli(bad);
      check(`#2284 CLI ${JSON.stringify(bad)}: exit 2`, r.status, 2);
      check(
        `#2284 CLI ${JSON.stringify(bad)}: usage on stderr`,
        r.err.includes(RECONCILE_USAGE),
        true,
      );
      check(
        `#2284 CLI ${JSON.stringify(bad)}: never ran (no FAILED, no output)`,
        [r.out, /FAILED/.test(r.err)],
        ["", false],
      );
      check(`#2284 CLI ${JSON.stringify(bad)}: lock/log/state untouched`, snap(), before);
    }
    for (const help of [["--help"], ["-h"]]) {
      const before = snap();
      const r = cli(help);
      check(
        `#2284 CLI ${JSON.stringify(help)}: exit 0 with the usage`,
        [r.status, r.out.trim()],
        [0, RECONCILE_USAGE],
      );
      check(`#2284 CLI ${JSON.stringify(help)}: lock/log/state untouched`, snap(), before);
    }

    // B973: `--help --apply` is HELP (exit 0, usage, nothing written, no gh call), never an apply.
    {
      const before = snap();
      const r = cli(["--help", "--apply"]);
      check(
        `B973 CLI ["--help","--apply"]: exit 0 with the usage (help wins, never an apply)`,
        [r.status, r.out.trim()],
        [0, RECONCILE_USAGE],
      );
      check(`B973 CLI ["--help","--apply"]: lock/log/state untouched`, snap(), before);
      const p = parseArgs(["--help", "--apply"]);
      check("B973 parseArgs --help --apply: help is set", p.ok && p.help, true);
    }
    // B973: `--apply=1` (a value form) is not a flag: refused like any unknown argument, nothing written.
    {
      const before = snap();
      check("B973 parseArgs --apply=1 is refused", parseArgs(["--apply=1"]).ok, false);
      const r = cli(["--apply=1"]);
      check(
        `B973 CLI ["--apply=1"]: exit 2 with the usage`,
        [r.status, r.err.includes(RECONCILE_USAGE)],
        [2, true],
      );
      check(`B973 CLI ["--apply=1"]: lock/log/state untouched`, snap(), before);
    }
    // B973: the relocation hook is documented in the usage text and VISIBLE when it is in effect (a stray export shows up).
    check(
      "B973 usage documents RECONCILE_WORK_DIR",
      RECONCILE_USAGE.includes("RECONCILE_WORK_DIR"),
      true,
    );
    check(
      "B973 usage says the dir must be ABSOLUTE",
      /RECONCILE_WORK_DIR=<absolute dir>/.test(RECONCILE_USAGE),
      true,
    );
    {
      const r = cli(["--help"]);
      check(
        "B973 a run with RECONCILE_WORK_DIR set prints the resolved dir on stderr",
        r.err.includes(`RECONCILE_WORK_DIR in effect: ${WORK}`),
        true,
      );
      const d = cli(["--help"], { RECONCILE_WORK_DIR: undefined });
      check(
        "B973 a run WITHOUT it prints no relocation notice",
        d.err.includes("RECONCILE_WORK_DIR in effect"),
        false,
      );
    }
    // B973 (lead Opus): `--apply` with a RELOCATED work dir is REFUSED (exit 2, nothing written, no gh call). A stray export would
    // otherwise move the real scheduler's lock/state/log (run.mjs swallows stderr; trigger.mjs is stdio:ignore) and risk a double apply.
    {
      const before = snap();
      const r = cli(["--apply"]);
      check("B973 CLI --apply with RECONCILE_WORK_DIR set: exit 2", r.status, 2);
      check(
        "B973 CLI --apply with RECONCILE_WORK_DIR set: says why on stderr",
        /refus/i.test(r.err) && r.err.includes("RECONCILE_WORK_DIR"),
        true,
      );
      check(
        "B973 CLI --apply with RECONCILE_WORK_DIR set: lock/log/state untouched",
        snap(),
        before,
      );
      const q = cli(["--apply", "--quiet"]);
      check("B973 CLI --apply --quiet with RECONCILE_WORK_DIR set: still refused", q.status, 2);
      // a dry run (bare) and --help stay allowed with the override: the refusal is for the write only
      const h = cli(["--help"]);
      check("B973 CLI --help with RECONCILE_WORK_DIR set: still help (exit 0)", h.status, 0);
    }
    // B973 (lead Opus): mutation-proof isolation: the lock, state and log (and the scratch body file) are ALL built from WORK_DIR,
    // and the real path appears ONCE in the code (the default), in any form. A path built another way would fail one of these.
    {
      const code = readPkgFile(new URL("./reconcile.mjs", import.meta.url), "utf8")
        .split("\n")
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join("\n");
      for (const name of ["STATE_FILE", "LOG_FILE", "RECONCILE_LOCK_FILE"]) {
        check(
          `B973 reconcile.mjs builds ${name} from WORK_DIR`,
          new RegExp(`const ${name} = join\\(WORK_DIR, "`).test(code),
          true,
        );
      }
      check(
        "B973 reconcile.mjs builds the scratch body file from WORK_DIR",
        /join\(WORK_DIR, "\.work-status-body\.md"\)/.test(code),
        true,
      );
      check(
        "B973 reconcile.mjs mentions local-assets once in code (the default dir), in any form",
        code.split("local-assets").length - 1,
        1,
      );
    }
    // B973: isolation proof: none of the CLI runs above touched the REAL local-assets/work files (read-only stat).
    check(
      "B973 the real local-assets/work files are untouched by the self-test",
      statOf(realFiles),
      realBefore,
    );
    // B973: a real-root guard: this self-test must not build a path to the real work dir again (the strings are assembled so the
    // pin does not match itself).
    {
      const me = readPkgFile(new URL(import.meta.url), "utf8")
        .split("\n")
        .filter((l) => !/^\s*\/\//.test(l))
        .join("\n");
      // a PATH built to the real dir (a URL or join), as opposed to a word in a message: exactly the one read-only stat above
      const real = ["..", "..", "local-assets", "work"].join("/");
      const occurrences = me.split(`new URL("${real}`).length - 1;
      check(
        "B973 the self-test builds exactly ONE path to the real work dir (the read-only stat above)",
        occurrences,
        1,
      );
    }
  } finally {
    rmSync(emptyPath, { recursive: true, force: true });
    rmSync(WORK, { recursive: true, force: true });
  }

  // The two automated callers must ask for the write explicitly, or the board silently stops
  // updating (a bare run is now a dry run).
  const src = (f) => readPkgFile(new URL(f, import.meta.url), "utf8");
  check(
    "#2284 run.mjs runs reconcile with --apply --quiet",
    /\[RECONCILE_PATH, "--apply", "--quiet"\]/.test(src("./run.mjs")),
    true,
  );
  check(
    "#2284 trigger.mjs spawns reconcile with --apply --quiet",
    /\[RECONCILE_PATH, "--apply", "--quiet"\]/.test(src("./trigger.mjs")),
    true,
  );
  check(
    "#2284 no caller runs reconcile without --apply",
    /\[RECONCILE_PATH, "--quiet"\]/.test(src("./run.mjs") + src("./trigger.mjs")),
    false,
  );
}

// ── result ────────────────────────────────────────────────────────────────
// ── VERIFY-PIN (#2285): `npm run verify` runs this self-test ──────────────────
// Unwired, this file protects nothing (found orphaned in the #2273 sweep), so it pins its own
// place in the root verify chain, the same pattern as the F-22 self-tests' T10v/T17v (#2283).
{
  const pkg = JSON.parse(readPkgFile(new URL("../../package.json", import.meta.url), "utf8"));
  const verify = typeof pkg.scripts?.verify === "string" ? pkg.scripts.verify : "";
  check(
    "VERIFY-PIN: verify chain runs scripts/work/reconcile.self-test.mjs",
    verify.split("&&").some((step) => step.trim() === "node scripts/work/reconcile.self-test.mjs"),
    true,
  );
}

console.log(
  failures === 0
    ? `\nreconcile.self-test: ALL GREEN`
    : `\nreconcile.self-test: ${failures} FAILURE(S)`,
);
process.exitCode = failures === 0 ? 0 : 1;
