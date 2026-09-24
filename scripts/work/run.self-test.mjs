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
  resolveRunnerRef,
  shouldRunPlaneSync,
  hasScriptChanged,
  LOCK_STALE_MS,
  DEFAULT_RUNNER_REF,
} from "./run.mjs";
import { shouldSkipTrigger, DEBOUNCE_WINDOW_MS } from "./trigger.mjs";

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

// ── result ────────────────────────────────────────────────────────────────
console.log(
  failures === 0 ? `\nrun.self-test: ALL GREEN` : `\nrun.self-test: ${failures} FAILURE(S)`,
);
process.exitCode = failures === 0 ? 0 : 1;
