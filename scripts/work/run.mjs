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
//      ONLY — this file never touches any other checkout. If that checkout
//      changed run.mjs's own on-disk code (already loaded into this live
//      process), it re-execs the fresh version exactly once so the rest of
//      the run uses current logic.
//   3. Runs `node reconcile.mjs --quiet`.
//   4. Runs `node plane-release-sync.mjs --apply`, but only if that script
//      exists and WORK_PLANE=1 (it throttles itself; this is just the gate
//      for whether to invoke it at all).
//   5. Appends exactly one line to local-assets/work/run.log for this run.
//
// Every sub-step failure is caught and logged — this script always exits 0
// so a bad run never breaks the scheduled task itself; the run.log and the
// reconciler's own drift digest are where failures surface.
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
//
// Every exported function above the "── IO" marker is pure and is what
// scripts/work/run.self-test.mjs exercises directly (alongside trigger.mjs's
// debounce decision).
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  unlinkSync,
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

/** Which ref the runner worktree should detach-checkout to. */
export function resolveRunnerRef(env = {}) {
  const ref = env.WORK_RUNNER_REF;
  return typeof ref === "string" && ref.trim() ? ref.trim() : DEFAULT_RUNNER_REF;
}

/** Gate for the optional plane-release-sync step: needs both the flag and the file. */
export function shouldRunPlaneSync(env = {}, planeSyncExists = false) {
  return env.WORK_PLANE === "1" && !!planeSyncExists;
}

/** true when the checkout swapped run.mjs's own on-disk bytes out from under
 * this already-running process — it should re-exec once before continuing. */
export function hasScriptChanged(beforeHash, afterHash) {
  return (
    typeof beforeHash === "string" && typeof afterHash === "string" && beforeHash !== afterHash
  );
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
    execFileSync(process.execPath, [RECONCILE_PATH, "--quiet"], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    steps.reconcile = "ok";
  } catch (e) {
    steps.reconcile = `failed: ${shortErr(e)}`;
  }

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
