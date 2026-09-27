#!/usr/bin/env node
// Coverage for the pure parts of scripts/work/run.mjs (the 5-minute poller)
// and scripts/work/trigger.mjs (the debounced refresh-now) — everything
// above each file's "── IO" marker. Same convention as
// scripts/work/reconcile.self-test.mjs: no fake gh/fs/process, every export
// here is a pure function of its inputs.
//
// Run: node scripts/work/run.self-test.mjs
import {
  isLockStale,
  isRunnerMode,
  isTriageEnabled,
  resolveRunnerRef,
  shouldRunPlaneSync,
  shouldRefuseRunnerSync,
  hasScriptChanged,
  LOCK_STALE_MS,
  DEFAULT_RUNNER_REF,
  isTriagePidStale,
  isTriageRunning,
  countTriageRunsToday,
  isUnderDailyCap,
  hasMinIntervalElapsed,
  hasNewerTriageIssue,
  isBacklogStaleEnough,
  shouldTriggerTriage,
  resolveClaudeBin,
  selectTriageLogsToDelete,
  TRIAGE_PID_STALE_MS,
  TRIAGE_MIN_INTERVAL_MS,
  TRIAGE_BACKLOG_STALE_MS,
  TRIAGE_MAX_RUNS_PER_DAY,
  TRIAGE_LOG_RETENTION,
} from "./run.mjs";
import { shouldSkipTrigger, DEBOUNCE_WINDOW_MS } from "./trigger.mjs";
import { readFileSync as readPkgFile } from "node:fs";

let failures = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(
    `${ok ? "  ok  " : "  FAIL"} ${name}${ok ? "" : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`,
  );
}

const NOW = new Date("2026-09-24T12:00:00Z");
const isoMinutesAgo = (m) => new Date(NOW.getTime() - m * 60_000).toISOString();

// ── lock staleness ──────────────────────────────────────────────────────
{
  check(
    "isLockStale: no lock at all -> stale (nothing to reclaim from)",
    isLockStale(null, NOW),
    true,
  );
  check("isLockStale: undefined lock -> stale", isLockStale(undefined, NOW), true);
  check(
    "isLockStale: lock missing startedAt -> stale (treat as corrupt)",
    isLockStale({ pid: 1 }, NOW),
    true,
  );
  check(
    "isLockStale: fresh lock (started now) -> not stale",
    isLockStale({ pid: 1, startedAt: NOW.toISOString() }, NOW),
    false,
  );
  check(
    "isLockStale: 9 minutes old -> not stale",
    isLockStale({ pid: 1, startedAt: isoMinutesAgo(9) }, NOW),
    false,
  );
  check(
    "isLockStale: just under 10 minutes -> not stale",
    isLockStale(
      { pid: 1, startedAt: new Date(NOW.getTime() - (LOCK_STALE_MS - 1)).toISOString() },
      NOW,
    ),
    false,
  );
  check(
    "isLockStale: exactly 10 minutes -> stale (boundary is inclusive)",
    isLockStale({ pid: 1, startedAt: new Date(NOW.getTime() - LOCK_STALE_MS).toISOString() }, NOW),
    true,
  );
  check(
    "isLockStale: 30 minutes old -> stale (an abandoned/crashed run)",
    isLockStale({ pid: 1, startedAt: isoMinutesAgo(30) }, NOW),
    true,
  );
}

// ── runner-mode / ref resolution ────────────────────────────────────────
{
  check("isRunnerMode: WORK_RUNNER=1 -> true", isRunnerMode({ WORK_RUNNER: "1" }), true);
  check("isRunnerMode: WORK_RUNNER unset -> false", isRunnerMode({}), false);
  check(
    'isRunnerMode: WORK_RUNNER=0 -> false (only the string "1" counts)',
    isRunnerMode({ WORK_RUNNER: "0" }),
    false,
  );

  check(
    "resolveRunnerRef: no override -> DEFAULT_RUNNER_REF",
    resolveRunnerRef({}),
    DEFAULT_RUNNER_REF,
  );
  check(
    "resolveRunnerRef: DEFAULT_RUNNER_REF is origin/master",
    DEFAULT_RUNNER_REF,
    "origin/master",
  );
  check(
    "resolveRunnerRef: explicit ref wins",
    resolveRunnerRef({ WORK_RUNNER_REF: "origin/feat/x" }),
    "origin/feat/x",
  );
  check(
    "resolveRunnerRef: blank/whitespace override falls back to default",
    resolveRunnerRef({ WORK_RUNNER_REF: "   " }),
    DEFAULT_RUNNER_REF,
  );
  check(
    "resolveRunnerRef: override is trimmed",
    resolveRunnerRef({ WORK_RUNNER_REF: "  origin/master  " }),
    "origin/master",
  );
}

// ── runner-marker guard (fix 4) ──────────────────────────────────────────
{
  check(
    "shouldRefuseRunnerSync: runner mode, marker missing -> refuse",
    shouldRefuseRunnerSync({ WORK_RUNNER: "1" }, false),
    true,
  );
  check(
    "shouldRefuseRunnerSync: runner mode, marker present -> allow",
    shouldRefuseRunnerSync({ WORK_RUNNER: "1" }, true),
    false,
  );
  check(
    "shouldRefuseRunnerSync: not runner mode, marker missing -> allow (nothing to refuse)",
    shouldRefuseRunnerSync({}, false),
    false,
  );
  check(
    "shouldRefuseRunnerSync: not runner mode, marker present -> allow",
    shouldRefuseRunnerSync({}, true),
    false,
  );
}

// ── optional plane-sync gate ────────────────────────────────────────────
{
  check(
    "shouldRunPlaneSync: flag set, file exists -> run",
    shouldRunPlaneSync({ WORK_PLANE: "1" }, true),
    true,
  );
  check(
    "shouldRunPlaneSync: flag set, file missing -> skip",
    shouldRunPlaneSync({ WORK_PLANE: "1" }, false),
    false,
  );
  check("shouldRunPlaneSync: file exists, flag unset -> skip", shouldRunPlaneSync({}, true), false);
  check("shouldRunPlaneSync: neither -> skip", shouldRunPlaneSync({}, false), false);
}

// ── re-exec detection ────────────────────────────────────────────────────
{
  check("hasScriptChanged: identical hashes -> false", hasScriptChanged("abc", "abc"), false);
  check("hasScriptChanged: different hashes -> true", hasScriptChanged("abc", "def"), true);
  check(
    "hasScriptChanged: either hash unreadable (null) -> false (never re-exec on a read failure)",
    hasScriptChanged(null, "def"),
    false,
  );
  check("hasScriptChanged: both unreadable -> false", hasScriptChanged(null, null), false);
}

// ── debounce decision (trigger.mjs) ─────────────────────────────────────
{
  check("shouldSkipTrigger: no prior trigger -> never skip", shouldSkipTrigger(null, NOW), false);
  check(
    "shouldSkipTrigger: undefined prior trigger -> never skip",
    shouldSkipTrigger(undefined, NOW),
    false,
  );
  check(
    "shouldSkipTrigger: triggered just now -> skip",
    shouldSkipTrigger(NOW.toISOString(), NOW),
    true,
  );
  check(
    "shouldSkipTrigger: 59.999s ago -> still inside the window, skip",
    shouldSkipTrigger(new Date(NOW.getTime() - (DEBOUNCE_WINDOW_MS - 1)).toISOString(), NOW),
    true,
  );
  check(
    "shouldSkipTrigger: exactly 60s ago -> boundary is exclusive, do not skip",
    shouldSkipTrigger(new Date(NOW.getTime() - DEBOUNCE_WINDOW_MS).toISOString(), NOW),
    false,
  );
  check(
    "shouldSkipTrigger: 5 minutes ago -> do not skip",
    shouldSkipTrigger(isoMinutesAgo(5), NOW),
    false,
  );
  check(
    "shouldSkipTrigger: a future timestamp (clock skew / corrupt state) -> do not skip",
    shouldSkipTrigger(new Date(NOW.getTime() + 60_000).toISOString(), NOW),
    false,
  );
  check("DEBOUNCE_WINDOW_MS is 60 seconds", DEBOUNCE_WINDOW_MS, 60_000);
}

// ── auto-triage: enabled flag ───────────────────────────────────────────
{
  check("isTriageEnabled: WORK_TRIAGE=1 -> true", isTriageEnabled({ WORK_TRIAGE: "1" }), true);
  check("isTriageEnabled: unset -> false", isTriageEnabled({}), false);
  check(
    'isTriageEnabled: WORK_TRIAGE=0 -> false (only the string "1" counts)',
    isTriageEnabled({ WORK_TRIAGE: "0" }),
    false,
  );
}

// ── auto-triage: pid staleness (red-first: no impl existed before this) ──
{
  check("TRIAGE_PID_STALE_MS is 45 minutes", TRIAGE_PID_STALE_MS, 45 * 60 * 1000);
  check("isTriagePidStale: no record -> stale", isTriagePidStale(null, NOW), true);
  check("isTriagePidStale: undefined record -> stale", isTriagePidStale(undefined, NOW), true);
  check(
    "isTriagePidStale: record missing startedAt -> stale (corrupt)",
    isTriagePidStale({ pid: 1 }, NOW),
    true,
  );
  check(
    "isTriagePidStale: fresh record (started now) -> not stale",
    isTriagePidStale({ pid: 1, startedAt: NOW.toISOString() }, NOW),
    false,
  );
  check(
    "isTriagePidStale: 44 minutes old -> not stale",
    isTriagePidStale({ pid: 1, startedAt: isoMinutesAgo(44) }, NOW),
    false,
  );
  check(
    "isTriagePidStale: just under 45 minutes -> not stale",
    isTriagePidStale(
      { pid: 1, startedAt: new Date(NOW.getTime() - (TRIAGE_PID_STALE_MS - 1)).toISOString() },
      NOW,
    ),
    false,
  );
  check(
    "isTriagePidStale: exactly 45 minutes -> stale (boundary is inclusive)",
    isTriagePidStale(
      { pid: 1, startedAt: new Date(NOW.getTime() - TRIAGE_PID_STALE_MS).toISOString() },
      NOW,
    ),
    true,
  );
  check(
    "isTriagePidStale: 2 hours old -> stale (an abandoned/crashed triage run)",
    isTriagePidStale({ pid: 1, startedAt: isoMinutesAgo(120) }, NOW),
    true,
  );
}

// ── auto-triage: isTriageRunning (combines pid staleness + injected liveness) ─
{
  check("isTriageRunning: no record -> not running", isTriageRunning(null, true, NOW), false);
  check(
    "isTriageRunning: record has no pid -> not running",
    isTriageRunning({ startedAt: NOW.toISOString() }, true, NOW),
    false,
  );
  check(
    "isTriageRunning: fresh record, OS says alive -> running",
    isTriageRunning({ pid: 123, startedAt: NOW.toISOString() }, true, NOW),
    true,
  );
  check(
    "isTriageRunning: fresh record, OS says dead -> not running (already exited)",
    isTriageRunning({ pid: 123, startedAt: NOW.toISOString() }, false, NOW),
    false,
  );
  check(
    "isTriageRunning: stale record (>45min), even if OS says alive -> not running",
    isTriageRunning({ pid: 123, startedAt: isoMinutesAgo(120) }, true, NOW),
    false,
  );
}

// ── auto-triage: daily run cap ──────────────────────────────────────────
{
  check("TRIAGE_MAX_RUNS_PER_DAY is 8", TRIAGE_MAX_RUNS_PER_DAY, 8);
  check("countTriageRunsToday: empty history -> 0", countTriageRunsToday([], NOW), 0);
  check(
    "countTriageRunsToday: counts only today's UTC date",
    countTriageRunsToday(
      [
        isoMinutesAgo(10),
        isoMinutesAgo(200),
        new Date(NOW.getTime() - 25 * 60 * 60 * 1000).toISOString(), // yesterday
      ],
      NOW,
    ),
    2,
  );
  check("isUnderDailyCap: 0 of 8 -> true", isUnderDailyCap(0), true);
  check("isUnderDailyCap: 7 of 8 -> true", isUnderDailyCap(7), true);
  check("isUnderDailyCap: 8 of 8 -> false (at the cap)", isUnderDailyCap(8), false);
  check("isUnderDailyCap: 9 of 8 -> false (over the cap)", isUnderDailyCap(9), false);
}

// ── auto-triage: minimum interval since last run start ──────────────────
{
  check("TRIAGE_MIN_INTERVAL_MS is 60 minutes", TRIAGE_MIN_INTERVAL_MS, 60 * 60 * 1000);
  check("hasMinIntervalElapsed: never run before -> true", hasMinIntervalElapsed(null, NOW), true);
  check(
    "hasMinIntervalElapsed: 30 minutes ago -> false",
    hasMinIntervalElapsed(isoMinutesAgo(30), NOW),
    false,
  );
  check(
    "hasMinIntervalElapsed: exactly 60 minutes ago -> true (boundary inclusive)",
    hasMinIntervalElapsed(new Date(NOW.getTime() - TRIAGE_MIN_INTERVAL_MS).toISOString(), NOW),
    true,
  );
  check(
    "hasMinIntervalElapsed: 2 hours ago -> true",
    hasMinIntervalElapsed(isoMinutesAgo(120), NOW),
    true,
  );
}

// ── auto-triage: fresh-work / stale-backlog gates ───────────────────────
{
  check(
    "hasNewerTriageIssue: never triaged, non-empty backlog -> true",
    hasNewerTriageIssue([{ number: 1, createdAt: isoMinutesAgo(500) }], null),
    true,
  );
  check(
    "hasNewerTriageIssue: never triaged, empty backlog -> false",
    hasNewerTriageIssue([], null),
    false,
  );
  check(
    "hasNewerTriageIssue: issue created after last triage -> true",
    hasNewerTriageIssue([{ number: 1, createdAt: isoMinutesAgo(5) }], isoMinutesAgo(30)),
    true,
  );
  check(
    "hasNewerTriageIssue: issue updated (not created) after last triage -> true",
    hasNewerTriageIssue(
      [{ number: 1, createdAt: isoMinutesAgo(200), updatedAt: isoMinutesAgo(5) }],
      isoMinutesAgo(30),
    ),
    true,
  );
  check(
    "hasNewerTriageIssue: every issue older than last triage -> false",
    hasNewerTriageIssue(
      [{ number: 1, createdAt: isoMinutesAgo(200), updatedAt: isoMinutesAgo(100) }],
      isoMinutesAgo(30),
    ),
    false,
  );

  check("TRIAGE_BACKLOG_STALE_MS is 3 hours", TRIAGE_BACKLOG_STALE_MS, 3 * 60 * 60 * 1000);
  check(
    "isBacklogStaleEnough: empty backlog -> false regardless of age",
    isBacklogStaleEnough(0, isoMinutesAgo(500), NOW),
    false,
  );
  check(
    "isBacklogStaleEnough: non-empty backlog, never triaged -> true",
    isBacklogStaleEnough(3, null, NOW),
    true,
  );
  check(
    "isBacklogStaleEnough: non-empty backlog, last triage 1h ago -> false",
    isBacklogStaleEnough(3, isoMinutesAgo(60), NOW),
    false,
  );
  check(
    "isBacklogStaleEnough: non-empty backlog, last triage exactly 3h ago -> true",
    isBacklogStaleEnough(3, new Date(NOW.getTime() - TRIAGE_BACKLOG_STALE_MS).toISOString(), NOW),
    true,
  );
}

// ── auto-triage: the composed trigger decision (red-first: no impl before) ─
{
  const freshIssue = [{ number: 1, createdAt: isoMinutesAgo(5) }];
  const staleIssue = [{ number: 1, createdAt: isoMinutesAgo(500), updatedAt: isoMinutesAgo(400) }];

  check(
    "shouldTriggerTriage: never run, non-empty backlog, nothing else blocking -> true",
    shouldTriggerTriage({ issues: freshIssue, lastTriageStartedAt: null, now: NOW }),
    true,
  );
  check(
    "shouldTriggerTriage: empty backlog -> false (no work)",
    shouldTriggerTriage({ issues: [], lastTriageStartedAt: null, now: NOW }),
    false,
  );
  check(
    "shouldTriggerTriage: fresh issue, but < 60min since last triage -> false",
    shouldTriggerTriage({
      issues: freshIssue,
      lastTriageStartedAt: isoMinutesAgo(10),
      now: NOW,
    }),
    false,
  );
  check(
    "shouldTriggerTriage: stale-only backlog (no newer issue), last run 1h ago (<3h) -> false",
    shouldTriggerTriage({
      issues: staleIssue,
      lastTriageStartedAt: isoMinutesAgo(70),
      now: NOW,
    }),
    false,
  );
  check(
    "shouldTriggerTriage: stale-only backlog, last run 3h+ ago and >=60min -> true",
    shouldTriggerTriage({
      issues: staleIssue,
      lastTriageStartedAt: isoMinutesAgo(200),
      now: NOW,
    }),
    true,
  );
  check(
    "shouldTriggerTriage: work is due, but at the daily cap -> false",
    shouldTriggerTriage({
      issues: freshIssue,
      lastTriageStartedAt: isoMinutesAgo(200),
      runsToday: TRIAGE_MAX_RUNS_PER_DAY,
      now: NOW,
    }),
    false,
  );
  check(
    "shouldTriggerTriage: work is due, under cap, but a triage is still running -> false",
    shouldTriggerTriage({
      issues: freshIssue,
      lastTriageStartedAt: isoMinutesAgo(200),
      runsToday: 1,
      pidRecord: { pid: 999, startedAt: isoMinutesAgo(5) },
      pidAlive: true,
      now: NOW,
    }),
    false,
  );
  check(
    "shouldTriggerTriage: work is due, prior pid record is stale (>45min) -> true",
    shouldTriggerTriage({
      issues: freshIssue,
      lastTriageStartedAt: isoMinutesAgo(200),
      runsToday: 1,
      pidRecord: { pid: 999, startedAt: isoMinutesAgo(120) },
      pidAlive: true,
      now: NOW,
    }),
    true,
  );
  check(
    "shouldTriggerTriage: every gate satisfied -> true",
    shouldTriggerTriage({
      issues: freshIssue,
      lastTriageStartedAt: isoMinutesAgo(200),
      runsToday: 2,
      pidRecord: null,
      pidAlive: false,
      now: NOW,
    }),
    true,
  );
}

// ── auto-triage: claude binary resolution ───────────────────────────────
{
  check(
    "resolveClaudeBin: WORK_CLAUDE_BIN override wins over everything",
    resolveClaudeBin({ WORK_CLAUDE_BIN: "C:/tools/claude.exe" }, "C:/fixed/claude", true),
    "C:/tools/claude.exe",
  );
  check(
    "resolveClaudeBin: blank override falls through to the fixed path",
    resolveClaudeBin({ WORK_CLAUDE_BIN: "   " }, "C:/fixed/claude", true),
    "C:/fixed/claude",
  );
  check(
    "resolveClaudeBin: no override, fixed path exists -> fixed path",
    resolveClaudeBin({}, "C:/fixed/claude", true),
    "C:/fixed/claude",
  );
  check(
    "resolveClaudeBin: no override, no fixed path, PATH resolves -> bare 'claude'",
    resolveClaudeBin({}, null, true),
    "claude",
  );
  check(
    "resolveClaudeBin: nothing available -> null (caller logs and skips)",
    resolveClaudeBin({}, null, false),
    null,
  );
}

// ── auto-triage: log retention selection (red-first: no impl before) ─────
{
  check("TRIAGE_LOG_RETENTION is 20", TRIAGE_LOG_RETENTION, 20);
  check(
    "selectTriageLogsToDelete: fewer files than the retention count -> delete nothing",
    selectTriageLogsToDelete(
      ["triage-2026-09-24T10-00-00-000Z.log", "triage-2026-09-24T11-00-00-000Z.log"],
      20,
    ),
    [],
  );
  check(
    "selectTriageLogsToDelete: exactly at the retention count -> delete nothing",
    selectTriageLogsToDelete(
      Array.from(
        { length: 20 },
        (_, i) => `triage-2026-09-24T${String(i).padStart(2, "0")}-00-00-000Z.log`,
      ),
      20,
    ),
    [],
  );
  {
    // 22 files, oldest-first by name; retain 20 -> the 2 oldest are deleted.
    const names = Array.from(
      { length: 22 },
      (_, i) => `triage-2026-09-${String(10 + i).padStart(2, "0")}T00-00-00-000Z.log`,
    );
    const shuffled = [...names].reverse();
    check(
      "selectTriageLogsToDelete: over the cap -> deletes exactly the oldest N by filename order",
      selectTriageLogsToDelete(shuffled, 20),
      names.slice(0, 2),
    );
  }
  check(
    "selectTriageLogsToDelete: no files -> delete nothing",
    selectTriageLogsToDelete([], 20),
    [],
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
    "VERIFY-PIN: verify chain runs scripts/work/run.self-test.mjs",
    verify.split("&&").some((step) => step.trim() === "node scripts/work/run.self-test.mjs"),
    true,
  );
}

console.log(
  failures === 0 ? `\nrun.self-test: ALL GREEN` : `\nrun.self-test: ${failures} FAILURE(S)`,
);
process.exitCode = failures === 0 ? 0 : 1;
