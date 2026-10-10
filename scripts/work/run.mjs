#!/usr/bin/env node
// run.mjs — the work-board poller entry point.
//
// Run every 5 minutes by a scheduled task (installed separately by
// scripts/work/install-scheduler.ps1, never by this file). Each run:
//
//   1. Takes a stale-after-10-minute lock (local-assets/work/run.lock) so
//      two overlapping runs never fight each other.
//   2. When WORK_RUNNER=1 (this process is running inside the dedicated
//      runner worktree the installer creates), fetches origin and detach-
//      checks-out WORK_RUNNER_REF (default origin/master) IN THAT WORKTREE
//      ONLY — this file never touches any other checkout. It refuses to do
//      even that unless local-assets/work/.runner exists (the marker
//      install-scheduler.ps1 writes for the runner worktree it
//      creates/uses) — proof WORK_RUNNER=1 wasn't set by accident in some
//      other checkout, where a fetch + detach-checkout would be actively
//      destructive. If that checkout changed run.mjs's own on-disk code
//      (already loaded into this live process), it re-execs the fresh
//      version exactly once so the rest of the run uses current logic.
//   3. Runs `node reconcile.mjs --apply --quiet` (a bare run is a dry run since #2284).
//   4. When WORK_TRIAGE=1, may spawn a headless `claude -p ...` auto-triage
//      run over the needs-triage backlog — see the "AUTO-TRIAGE" section
//      below for the full trigger contract. Best-effort: any failure here
//      is caught and logged, never thrown.
//   5. Runs `node plane-release-sync.mjs --apply`, but only if that script
//      exists and WORK_PLANE=1 (it throttles itself; this is just the gate
//      for whether to invoke it at all).
//   6. Appends exactly one line to local-assets/work/run.log for this run.
//
// Every sub-step failure is caught and logged — this script always exits 0
// so a bad run never breaks the scheduled task itself; the run.log and the
// reconciler's own drift digest are where failures surface.
//
// ── AUTO-TRIAGE ────────────────────────────────────────────────────────
// When WORK_TRIAGE=1, after reconcile this counts open `needs-triage`
// issues (`gh issue list --label needs-triage --state open`) and, subject
// to ALL of the gates below, spawns a fully detached, windowless, headless
// `claude -p <prompt> --model sonnet ...` run over docs/work/TRIAGE.md's
// routine. State lives in local-assets/work/run-state.json
// (lastTriageStartedAt, triageRunsToday); in-flight tracking lives in
// local-assets/work/triage.pid ({ pid, startedAt }); each run's
// stdout+stderr goes to local-assets/work/triage-<UTC timestamp>.log,
// pruned to the newest TRIAGE_LOG_RETENTION files.
//
// Trigger gates (see shouldTriggerTriage — all must hold):
//   - fresh work: at least one needs-triage issue created/updated after
//     lastTriageStartedAt (hasNewerTriageIssue), OR the backlog is
//     non-empty and lastTriageStartedAt is >= 3h old (isBacklogStaleEnough)
//   - AND >= 60 minutes since lastTriageStartedAt (hasMinIntervalElapsed)
//   - AND fewer than TRIAGE_MAX_RUNS_PER_DAY runs already started today,
//     UTC calendar date (isUnderDailyCap / countTriageRunsToday)
//   - AND no triage process is still running: triage.pid's recorded pid is
//     either absent, OS-dead, or older than TRIAGE_PID_STALE_MS
//     (isTriageRunning / isTriagePidStale)
//
// The `claude` binary is resolved WORK_CLAUDE_BIN env override > the fixed
// local install (if present on disk) > bare "claude" if it resolves on
// PATH (resolveClaudeBin) — none found logs a skip rather than throwing.
//
// No npm dependencies — plain Node, ESM.
//
// Usage:
//   node scripts/work/run.mjs
//
// Env:
//   WORK_RUNNER=1            run inside the dedicated runner worktree: sync
//                             to WORK_RUNNER_REF before reconciling.
//   WORK_RUNNER_REF=<ref>    ref to detach-checkout to (default origin/master).
//   WORK_PLANE=1              also run plane-release-sync.mjs --apply if present.
//   WORK_TRIAGE=1             also consider spawning a headless auto-triage
//                             run — see "AUTO-TRIAGE" above.
//   WORK_CLAUDE_BIN=<path>    override the `claude` executable auto-triage spawns.
//
// Every exported function above the "── IO" marker is pure and is what
// scripts/work/run.self-test.mjs exercises directly (alongside trigger.mjs's
// debounce decision).
import { execFileSync, spawnSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  unlinkSync,
  readdirSync,
  openSync,
  closeSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const SELF_PATH = fileURLToPath(import.meta.url);
const RECONCILE_PATH = join(ROOT, "scripts", "work", "reconcile.mjs");
const PLANE_SYNC_PATH = join(ROOT, "scripts", "work", "plane-release-sync.mjs");

const WORK_DIR = join(ROOT, "local-assets", "work");
const LOCK_FILE = join(WORK_DIR, "run.lock");
const LOG_FILE = join(WORK_DIR, "run.log");
const RUNNER_MARKER_FILE = join(WORK_DIR, ".runner");
const TRIAGE_STATE_FILE = join(WORK_DIR, "run-state.json");
const TRIAGE_PID_FILE = join(WORK_DIR, "triage.pid");
const TRIAGE_CLAUDE_FIXED_PATH = "C:/Users/nakram/.local/bin/claude";

const TRIAGE_PROMPT =
  "You are RouteFlow's triage agent. Follow docs/work/TRIAGE.md exactly for up to 15 of the " +
  "OLDEST open issues labelled needs-triage in najathakram/routeflow (gh issue list " +
  "--label needs-triage --state open --json number,title,createdAt --limit 100, sort by " +
  "createdAt ascending). For each: read it, check for duplicates, read the code map " +
  "(.claude/code-map/INDEX.md then one area file) to place it, set kind/sev/prio/lane/tier1 " +
  "labels and milestone, rewrite the body into Problem/goal, Acceptance criteria, Where, Test " +
  "plan, Notes, keeping the Original ask, then remove needs-triage — or keep it and comment ONE " +
  "specific question for the owner when unsure. Never assign anyone, never close anything except " +
  "exact duplicates (comment 'Duplicate of #N' first), never write client names, tenant ids, " +
  "credentials or production data. Stop after 15 issues.";

const TRIAGE_ALLOWED_TOOLS = [
  "Bash(gh issue view:*)",
  "Bash(gh issue list:*)",
  "Bash(gh issue edit:*)",
  "Bash(gh issue comment:*)",
  "Bash(gh issue close:*)",
  "Bash(gh search issues:*)",
  "Bash(gh search prs:*)",
  "Bash(gh pr list:*)",
  "Bash(gh pr view:*)",
  "Read",
  "Grep",
  "Glob",
];

// ════════════════════════════════════════════════════════════════════════
// PURE
// ════════════════════════════════════════════════════════════════════════

export const LOCK_STALE_MS = 10 * 60 * 1000; // 10 minutes
export const DEFAULT_RUNNER_REF = "origin/master";

/**
 * lock: { pid, startedAt } or null/undefined. now: Date.
 * true = no lock, or a lock old enough to be considered abandoned (a
 * crashed run never releases it) — safe for a new run to reclaim.
 */
export function isLockStale(lock, now = new Date()) {
  if (!lock || !lock.startedAt) return true;
  const age = now.getTime() - new Date(lock.startedAt).getTime();
  return !(age < LOCK_STALE_MS);
}

/** true when this process is running inside the dedicated runner worktree. */
export function isRunnerMode(env = {}) {
  return env.WORK_RUNNER === "1";
}

/** true when auto-triage is enabled for this run at all (the outer gate;
 * shouldTriggerTriage decides whether it's actually DUE). */
export function isTriageEnabled(env = {}) {
  return env.WORK_TRIAGE === "1";
}

/** Which ref the runner worktree should detach-checkout to. */
export function resolveRunnerRef(env = {}) {
  const ref = env.WORK_RUNNER_REF;
  return typeof ref === "string" && ref.trim() ? ref.trim() : DEFAULT_RUNNER_REF;
}

/** Gate for the optional plane-release-sync step: needs both the flag and the file. */
export function shouldRunPlaneSync(env = {}, planeSyncExists = false) {
  return env.WORK_PLANE === "1" && !!planeSyncExists;
}

/**
 * Runner mode (WORK_RUNNER=1) may only fetch + detach-checkout when this
 * worktree carries the marker install-scheduler.ps1 writes for the
 * dedicated runner worktree it creates/uses — proof this really is that
 * worktree, not some other checkout where the env var got set by accident
 * (a fetch + detach-checkout there would be actively destructive). true =
 * refuse the sync.
 */
export function shouldRefuseRunnerSync(env = {}, markerExists = false) {
  return isRunnerMode(env) && !markerExists;
}

/** true when the checkout swapped run.mjs's own on-disk bytes out from under
 * this already-running process — it should re-exec once before continuing. */
export function hasScriptChanged(beforeHash, afterHash) {
  return (
    typeof beforeHash === "string" && typeof afterHash === "string" && beforeHash !== afterHash
  );
}

// ── auto-triage: trigger gates ──────────────────────────────────────────

export const TRIAGE_PID_STALE_MS = 45 * 60 * 1000; // 45 minutes
export const TRIAGE_MIN_INTERVAL_MS = 60 * 60 * 1000; // 60 minutes since last triage START
export const TRIAGE_BACKLOG_STALE_MS = 3 * 60 * 60 * 1000; // 3 hours
export const TRIAGE_MAX_RUNS_PER_DAY = 8;
export const TRIAGE_LOG_RETENTION = 20;

/**
 * pidRecord: { pid, startedAt } or null/undefined. now: Date.
 * true = no record, or a record old enough (45min) that a crashed/killed
 * triage process should no longer block a new run — mirrors run.mjs's own
 * isLockStale (10min threshold) but for the longer-running triage agent.
 */
export function isTriagePidStale(pidRecord, now = new Date()) {
  if (!pidRecord || !pidRecord.startedAt) return true;
  const age = now.getTime() - new Date(pidRecord.startedAt).getTime();
  return !(age < TRIAGE_PID_STALE_MS);
}

/** true = a previous triage run is still in flight and a new one must not
 * start. `isAlive` is the caller's own OS-level liveness check for
 * pidRecord.pid, injected as a plain boolean (not a syscall) so this stays
 * pure — see isPidAlive below the IO marker. A stale-after-45min record is
 * treated as not-running even if the pid happens to be alive again
 * (recycled by the OS for an unrelated process). */
export function isTriageRunning(pidRecord, isAlive, now = new Date()) {
  if (!pidRecord || !pidRecord.pid) return false;
  if (isTriagePidStale(pidRecord, now)) return false;
  return !!isAlive;
}

/** How many triage runs already started today, by the UTC calendar date of
 * `now` — `startedTimestamps` is the full (possibly multi-day) history kept
 * in run-state.json's triageRunsToday field. */
export function countTriageRunsToday(startedTimestamps = [], now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  return (startedTimestamps ?? []).filter(
    (ts) => typeof ts === "string" && ts.slice(0, 10) === today,
  ).length;
}

/** true when today's (UTC) run count is still under the daily cap. */
export function isUnderDailyCap(runsToday) {
  return runsToday < TRIAGE_MAX_RUNS_PER_DAY;
}

/** true when at least 60 minutes have elapsed since the last triage run
 * started (or none has ever started). */
export function hasMinIntervalElapsed(lastTriageStartedAt, now = new Date()) {
  if (!lastTriageStartedAt) return true;
  const age = now.getTime() - new Date(lastTriageStartedAt).getTime();
  return age >= TRIAGE_MIN_INTERVAL_MS;
}

/** true when any needs-triage issue was created OR updated after the last
 * triage run started — fresh work worth an early trigger even before the
 * backlog-age gate below has elapsed. No prior run at all -> any backlog
 * counts as "newer". */
export function hasNewerTriageIssue(issues = [], lastTriageStartedAt) {
  if (!lastTriageStartedAt) return (issues ?? []).length > 0;
  const cutoff = new Date(lastTriageStartedAt).getTime();
  return (issues ?? []).some((issue) => {
    const created = issue?.createdAt ? new Date(issue.createdAt).getTime() : NaN;
    const updated = issue?.updatedAt ? new Date(issue.updatedAt).getTime() : NaN;
    const newest = Math.max(
      Number.isFinite(created) ? created : -Infinity,
      Number.isFinite(updated) ? updated : -Infinity,
    );
    return Number.isFinite(newest) && newest > cutoff;
  });
}

/** true when the backlog is non-empty and the last triage run started at
 * least TRIAGE_BACKLOG_STALE_MS (3h) ago — a fallback trigger for a
 * backlog that never gets a "newer" issue (nothing new arriving, but never
 * cleared either). No prior run at all with a non-empty backlog counts as
 * stale (nothing to wait on). */
export function isBacklogStaleEnough(backlogCount, lastTriageStartedAt, now = new Date()) {
  if (!(backlogCount > 0)) return false;
  if (!lastTriageStartedAt) return true;
  const age = now.getTime() - new Date(lastTriageStartedAt).getTime();
  return age >= TRIAGE_BACKLOG_STALE_MS;
}

/**
 * The full auto-triage trigger decision — every gate ANDed together. Every
 * input is pre-computed by the (impure) caller so this stays a pure
 * function of plain data:
 *   issues:              needs-triage backlog, { number, createdAt, updatedAt }[]
 *   lastTriageStartedAt: ISO string or null (never triaged before)
 *   runsToday:           count from countTriageRunsToday
 *   pidRecord:           triage.pid contents, or null
 *   pidAlive:            OS-level liveness of pidRecord.pid (injected boolean)
 *   now:                 Date
 */
export function shouldTriggerTriage({
  issues = [],
  lastTriageStartedAt = null,
  runsToday = 0,
  pidRecord = null,
  pidAlive = false,
  now = new Date(),
} = {}) {
  const backlogCount = (issues ?? []).length;
  const hasWork =
    hasNewerTriageIssue(issues, lastTriageStartedAt) ||
    isBacklogStaleEnough(backlogCount, lastTriageStartedAt, now);
  if (!hasWork) return false;
  if (!hasMinIntervalElapsed(lastTriageStartedAt, now)) return false;
  if (!isUnderDailyCap(runsToday)) return false;
  if (isTriageRunning(pidRecord, pidAlive, now)) return false;
  return true;
}

// ── auto-triage: claude binary resolution ───────────────────────────────

/** Which `claude` executable to launch, in order: WORK_CLAUDE_BIN env
 * override, then the fixed local install (if the caller found it on disk),
 * then bare "claude" if the caller confirmed it resolves on PATH. null =
 * none available — the caller logs a skip rather than spawn into ENOENT. */
export function resolveClaudeBin(env = {}, fixedPathIfExists = null, pathResolves = false) {
  const override = typeof env.WORK_CLAUDE_BIN === "string" ? env.WORK_CLAUDE_BIN.trim() : "";
  if (override) return override;
  if (fixedPathIfExists) return fixedPathIfExists;
  if (pathResolves) return "claude";
  return null;
}

// ── auto-triage: log retention ──────────────────────────────────────────

/** Given every triage-*.log filename currently on disk (any order) and how
 * many to retain, returns the ones to delete — the oldest by the UTC
 * timestamp embedded in the filename (triage-<UTC timestamp>.log, colons/
 * dots replaced with "-" so it's a valid Windows filename that still sorts
 * lexicographically in chronological order) — no filesystem stat call
 * needed, so this stays pure. */
export function selectTriageLogsToDelete(filenames = [], retain = TRIAGE_LOG_RETENTION) {
  const sorted = [...(filenames ?? [])].sort();
  if (sorted.length <= retain) return [];
  return sorted.slice(0, sorted.length - retain);
}

// ════════════════════════════════════════════════════════════════════════
// ── IO ─────────────────────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════════

function ensureWorkDir() {
  mkdirSync(WORK_DIR, { recursive: true });
}

function loadLock() {
  if (!existsSync(LOCK_FILE)) return null;
  try {
    return JSON.parse(readFileSync(LOCK_FILE, "utf8"));
  } catch {
    return null; // corrupt lock file -> treated as absent, isLockStale(null) === true
  }
}

function writeLock(lock) {
  ensureWorkDir();
  writeFileSync(LOCK_FILE, JSON.stringify(lock, null, 2) + "\n", "utf8");
}

function releaseLockIfOwned(pid) {
  const lock = loadLock();
  if (lock && lock.pid === pid) {
    try {
      unlinkSync(LOCK_FILE);
    } catch {
      // already gone — fine.
    }
  }
}

function appendLog(line) {
  ensureWorkDir();
  appendFileSync(LOG_FILE, `${JSON.stringify(line)}\n`, "utf8");
}

function hashFile(path) {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return null;
  }
}

function shortErr(e) {
  const msg = `${e?.stdout ?? ""}${e?.stderr ?? ""}`.toString().trim() || String(e?.message ?? e);
  return msg.length > 500 ? `${msg.slice(0, 500)}…` : msg;
}

// ── auto-triage IO ───────────────────────────────────────────────────────

function loadTriageState() {
  if (!existsSync(TRIAGE_STATE_FILE)) return {};
  try {
    return JSON.parse(readFileSync(TRIAGE_STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveTriageState(state) {
  ensureWorkDir();
  writeFileSync(TRIAGE_STATE_FILE, JSON.stringify(state, null, 2) + "\n", "utf8");
}

function loadTriagePid() {
  if (!existsSync(TRIAGE_PID_FILE)) return null;
  try {
    return JSON.parse(readFileSync(TRIAGE_PID_FILE, "utf8"));
  } catch {
    return null;
  }
}

/** OS-level liveness check for a pid — signal 0 tests existence without
 * sending a real signal, supported cross-platform by Node/libuv. */
function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function fetchNeedsTriageIssues() {
  const out = execFileSync(
    "gh",
    [
      "issue",
      "list",
      "-R",
      "najathakram/routeflow",
      "--label",
      "needs-triage",
      "--state",
      "open",
      "--json",
      "number,createdAt,updatedAt",
      "--limit",
      "500",
    ],
    { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  return JSON.parse(out || "[]");
}

/** Resolves the `claude` binary for this machine: checks the fixed local
 * install (both with and without .exe) and whether "claude" resolves on
 * PATH, then defers the actual tier choice to the pure resolveClaudeBin. */
function findClaudeBin() {
  let fixedPathIfExists = null;
  if (existsSync(TRIAGE_CLAUDE_FIXED_PATH)) fixedPathIfExists = TRIAGE_CLAUDE_FIXED_PATH;
  else if (existsSync(`${TRIAGE_CLAUDE_FIXED_PATH}.exe`)) {
    fixedPathIfExists = `${TRIAGE_CLAUDE_FIXED_PATH}.exe`;
  }

  let pathResolves = false;
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", ["claude"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    pathResolves = true;
  } catch {
    pathResolves = false;
  }

  return resolveClaudeBin(process.env, fixedPathIfExists, pathResolves);
}

/** Spawns the headless triage agent fully detached and windowless, with
 * stdout+stderr appended to `logPath`. Runs from ROOT (this file's own
 * checkout — "the runner checkout" when WORK_RUNNER=1). */
function spawnTriage(claudeBin, logPath) {
  ensureWorkDir();
  const logFd = openSync(logPath, "a");
  try {
    const child = spawn(
      claudeBin,
      [
        "-p",
        TRIAGE_PROMPT,
        "--model",
        "sonnet",
        // Default mode: in -p nothing outside --allowedTools can run. Triage only needs gh +
        // reads; a file edit would dirty the runner checkout and break its next detach-sync.
        "--permission-mode",
        "default",
        "--allowedTools",
        ...TRIAGE_ALLOWED_TOOLS,
        "--disallowedTools",
        "Edit",
        "Write",
        "NotebookEdit",
        "--no-session-persistence",
      ],
      {
        cwd: ROOT,
        detached: true,
        stdio: ["ignore", logFd, logFd],
        windowsHide: true,
      },
    );
    child.unref();
    return child;
  } finally {
    closeSync(logFd);
  }
}

/** Deletes every triage-*.log file selectTriageLogsToDelete says is beyond
 * TRIAGE_LOG_RETENTION. Best-effort — a delete failure is swallowed, never
 * thrown, so a locked/already-gone log file can't fail the run. */
function pruneTriageLogs() {
  let names;
  try {
    names = readdirSync(WORK_DIR).filter((f) => /^triage-.*\.log$/.test(f));
  } catch {
    return;
  }
  for (const name of selectTriageLogsToDelete(names, TRIAGE_LOG_RETENTION)) {
    try {
      unlinkSync(join(WORK_DIR, name));
    } catch {
      // best-effort only.
    }
  }
}

/** Runs after reconcile, when WORK_TRIAGE=1: counts the needs-triage
 * backlog, evaluates shouldTriggerTriage, and — if due — spawns the
 * headless triage agent. Always returns a short status string for
 * run.log's steps.triage and never throws (every failure is caught and
 * reported as "failed: ..."), matching this file's existing steps.reconcile
 * / steps.plane convention. */
function runAutoTriageIfDue(now) {
  if (!isTriageEnabled(process.env)) return "disabled";
  try {
    const state = loadTriageState();
    const issues = fetchNeedsTriageIssues();
    const runsToday = countTriageRunsToday(state.triageRunsToday ?? [], now);
    const pidRecord = loadTriagePid();
    const pidAlive = isPidAlive(pidRecord?.pid);

    const trigger = shouldTriggerTriage({
      issues,
      lastTriageStartedAt: state.lastTriageStartedAt ?? null,
      runsToday,
      pidRecord,
      pidAlive,
      now,
    });
    if (!trigger) return "skipped: not due";

    const claudeBin = findClaudeBin();
    if (!claudeBin) return "skipped: claude binary not found";

    const logPath = join(WORK_DIR, `triage-${now.toISOString().replace(/[:.]/g, "-")}.log`);
    const child = spawnTriage(claudeBin, logPath);

    writeFileSync(
      TRIAGE_PID_FILE,
      JSON.stringify({ pid: child.pid, startedAt: now.toISOString() }, null, 2) + "\n",
      "utf8",
    );

    const priorRuns = (state.triageRunsToday ?? []).filter(
      (ts) => typeof ts === "string" && now.getTime() - new Date(ts).getTime() < 2 * 86_400_000,
    );
    saveTriageState({
      ...state,
      lastTriageStartedAt: now.toISOString(),
      triageRunsToday: [...priorRuns, now.toISOString()],
    });

    pruneTriageLogs();

    return `started (pid ${child.pid})`;
  } catch (e) {
    return `failed: ${shortErr(e)}`;
  }
}

/** Fetch + detach-checkout the runner worktree to `ref`. Throws on failure —
 * the caller aborts the rest of this run rather than reconcile against an
 * unknown checkout state. Runs with cwd=ROOT (this file's own repo root),
 * so it can only ever affect the worktree run.mjs is executing from. */
function syncRunnerWorktree(ref) {
  execFileSync("git", ["fetch", "-q", "origin"], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
  execFileSync("git", ["checkout", "-q", "--detach", ref], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Runs the reconcile + optional plane-sync steps and logs exactly one line. */
function runSteps(now, meta) {
  const started = Date.now();
  const steps = {};

  try {
    execFileSync(process.execPath, [RECONCILE_PATH, "--apply", "--quiet"], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    steps.reconcile = "ok";
  } catch (e) {
    steps.reconcile = `failed: ${shortErr(e)}`;
  }

  steps.triage = runAutoTriageIfDue(now);

  const planeSyncExists = existsSync(PLANE_SYNC_PATH);
  if (shouldRunPlaneSync(process.env, planeSyncExists)) {
    try {
      execFileSync(process.execPath, [PLANE_SYNC_PATH, "--apply"], {
        cwd: ROOT,
        stdio: ["ignore", "pipe", "pipe"],
      });
      steps.plane = "ok";
    } catch (e) {
      steps.plane = `failed: ${shortErr(e)}`;
    }
  } else {
    steps.plane = "skipped";
  }

  appendLog({ ts: now.toISOString(), ...meta, steps, durationMs: Date.now() - started });
}

function main() {
  const now = new Date();
  ensureWorkDir();

  // Freshly re-exec'd child: the parent already holds run.lock and already
  // did the checkout (if any) before spawning us — just do the work.
  if (process.env.WORK_RUN_REEXEC === "1") {
    runSteps(now, {
      runnerMode: isRunnerMode(process.env),
      ref: isRunnerMode(process.env) ? resolveRunnerRef(process.env) : null,
      reexeced: true,
    });
    return;
  }

  const lock = loadLock();
  if (lock && !isLockStale(lock, now)) {
    const ageMs = now.getTime() - new Date(lock.startedAt).getTime();
    appendLog({
      ts: now.toISOString(),
      skipped: true,
      reason: "lock-held",
      lockPid: lock.pid,
      lockAgeMs: ageMs,
    });
    return;
  }

  writeLock({ pid: process.pid, startedAt: now.toISOString() });
  try {
    if (isRunnerMode(process.env)) {
      if (shouldRefuseRunnerSync(process.env, existsSync(RUNNER_MARKER_FILE))) {
        appendLog({
          ts: now.toISOString(),
          runnerMode: true,
          skipped: true,
          reason: "runner-marker-missing",
        });
        return;
      }
      const ref = resolveRunnerRef(process.env);
      const beforeHash = hashFile(SELF_PATH);
      try {
        syncRunnerWorktree(ref);
      } catch (e) {
        appendLog({
          ts: now.toISOString(),
          runnerMode: true,
          ref,
          steps: { checkout: `failed: ${shortErr(e)}` },
          durationMs: 0,
        });
        return; // don't reconcile against an unknown checkout state
      }
      const afterHash = hashFile(SELF_PATH);
      if (hasScriptChanged(beforeHash, afterHash)) {
        // run.mjs's own code changed under us — hand off to the fresh
        // on-disk version once instead of continuing with stale in-memory
        // logic. The child logs its own (single) run.log line.
        const result = spawnSync(process.execPath, [SELF_PATH], {
          cwd: ROOT,
          stdio: "inherit",
          env: { ...process.env, WORK_RUN_REEXEC: "1" },
        });
        if (result.error || result.status !== 0) {
          // The child is expected to log its own (single) line on success;
          // this covers the case where it never got that far (spawn itself
          // failed, or it crashed before reaching runSteps' appendLog).
          appendLog({
            ts: now.toISOString(),
            runnerMode: true,
            ref,
            reexeced: true,
            steps: {
              reexec: `failed: ${shortErr(result.error ?? { message: `child exited ${result.status ?? "(signal " + result.signal + ")"}` })}`,
            },
            durationMs: 0,
          });
        }
        return;
      }
      runSteps(now, { runnerMode: true, ref, reexeced: false });
    } else {
      runSteps(now, { runnerMode: false, ref: null, reexeced: false });
    }
  } finally {
    releaseLockIfOwned(process.pid);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
