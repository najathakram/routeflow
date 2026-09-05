#!/usr/bin/env node
// Visibility watchdog — arms the private flip BEFORE any public CI window,
// so a killed agent session can never leave the repo public.
//
// WHY THIS EXISTS
// RouteFlow's canonical deploy flow (CLAUDE.md "Canonical deploy flow") makes the
// repo public for the ~1-2 minutes CI needs, then flips it back private as a
// `finally` inside the agent's own control flow. On 2026-09-04 the agent
// running that flow was killed by a process restart mid-window — the private
// flip lived only in that agent's own logic, so nothing else was ever going to
// run it, and the repo stayed public for ~6.5 hours (07:38Z -> 14:18Z) before
// anyone noticed.
//
// This script is the fix: launch it DETACHED, before `gh repo edit ... public`,
// with a fixed deadline. It sleeps, flips the repo private, and verifies the
// flip landed — independent of whatever happens to the agent session that
// started it. If the session dies, is killed, or simply forgets, the repo
// still goes private on schedule.
//
// A flip-to-private by THIS watchdog while CI (or a merge, or a deploy) is
// still running is the CORRECT outcome, not a bug: a GitHub Actions run on a
// private repo simply fails on billing (see docs/runbooks/deploy-visibility-flip.md)
// — it does not corrupt anything. Just rerun the job once the window reopens.
// A late, unwanted flip is always safer than no flip at all.
//
// HOW TO LAUNCH (detached, so it outlives the current process/session)
//
//   Windows PowerShell:
//     Start-Process -WindowStyle Hidden -FilePath node -ArgumentList "scripts/visibility-watchdog.mjs","--minutes","45"
//
//   POSIX (bash/sh):
//     nohup node scripts/visibility-watchdog.mjs --minutes 45 >/dev/null 2>&1 &
//
// Both must be run from the repo root (or pass an absolute path to this file)
// so the relative `local-assets/` log path below resolves correctly regardless
// of launch method — the script also resolves it from its own location, not
// from `process.cwd()`, so this is a convenience, not a requirement.
//
// USAGE
//   node scripts/visibility-watchdog.mjs [--minutes <n>] [--repo <owner/name>]
//     --minutes  minutes to wait before flipping private (default 45)
//     --repo     "owner/name" to flip (default najathakram/routeflow)
//
// FLIP RETRY (2026-09-05)
// The private flip used to be attempted once, with only the read-back
// retried — a single `gh repo edit` failure (a transient 5xx, a rate limit)
// left the repo public with nothing left to try. The flip itself is now
// retried: up to 6 attempts, sleeping between them. Only FIVE delays are
// reachable between 6 attempts (the last attempt is never followed by a
// sleep), so the list is five long: 5s, 15s, 30s, 60s, 120s — a worst case of
// ≈ 3.8 min of sleeps plus up to 6 × 2 × 60 s of gh timeouts (two bounded `gh`
// calls per attempt, see runGh). Each attempt runs `gh repo edit ...
// --visibility private ...` followed immediately by a `gh repo view`
// read-back; the loop stops as soon as a read-back reports PRIVATE. Every
// attempt is logged with its edit exit status and the first line of stderr —
// or, for a call that never returned, `spawn-error` plus the spawn error's
// own `code` (`ETIMEDOUT` for a call the 60 s timeout killed) — win or lose.
//
// EXIT CODE
//   0 — a read-back confirmed PRIVATE within the attempt budget. Any stale
//       `local-assets/visibility-watchdog.FAILED` marker is removed.
//   1 — no read-back confirmed PRIVATE after 6 attempts. A marker file is
//       written to `local-assets/visibility-watchdog.FAILED` (ISO time,
//       repo, last error) so a later check doesn't need the log — a human
//       needs to flip it by hand.
//
// LOG
// One line per event, appended to `local-assets/visibility-watchdog.log`
// (created if missing; gitignored — see .gitignore's "local-assets/" section)
// and also printed to stdout:
//   <ISO timestamp> start|attempt|verified|error <detail>
// The `start` line reports the visibility read at launch, before the wait
// even begins (`visibility=<X>`) — if it is already PRIVATE the watchdog
// keeps running anyway, since the public window it guards against may still
// open later in the deploy flow. It also reports `root=<path>` (the directory
// the log and the FAILED marker are written under, see MARKER/LOG ROOT below)
// and `delays=<json>` (the backoff list actually in force).
//
// MARKER/LOG ROOT
// `local-assets/` is resolved against the MAIN checkout, never the worktree
// the watchdog happened to be launched from: `git rev-parse
// --path-format=absolute --git-common-dir` names the main repository's `.git`
// directory even from inside a linked worktree, and its parent is that main
// checkout. A reader following the runbook looks in ONE place, so a watchdog
// armed from `.claude/worktrees/rf-xyz` must not hide its FAILED marker there.
// If git cannot be run (not installed, not a repository), this falls back to
// the `__dirname`-derived repo root — the previous behaviour.
//
// TEST-ONLY OVERRIDES (four; honoured ONLY inside a Jest worker — see
// apps/api/src/common/visibility-watchdog-script.spec.ts)
// Each is read through `testOverride()`, which mirrors
// `SCHEMA_DRIFT_PRISMA_CLI` in apps/api/scripts/schema-drift.mjs: the value is
// used only when `process.env.JEST_WORKER_ID` is set, and then exactly one
// `WARNING: test override <NAME> active` line goes to stderr. Anywhere else the
// variable is IGNORED — loudly, with one stderr line naming it — so a stray
// export in an operator's shell can never point the real watchdog at a fake
// `gh`, silence its marker, or collapse its backoff. `NODE_ENV` is deliberately
// not part of the guard, for the same reason schema-drift.mjs leaves it out.
//   VISIBILITY_WATCHDOG_GH_CMD             JSON array of argv, e.g.
//                                           '["node","/tmp/fake-gh.mjs"]', replacing the
//                                           real `gh` invocation entirely so specs can
//                                           drive a fake with no network and no real
//                                           repo access.
//   VISIBILITY_WATCHDOG_LOG_FILE           Absolute path overriding the default
//                                           `local-assets/visibility-watchdog.log`, so
//                                           specs never touch the real operational log.
//   VISIBILITY_WATCHDOG_MARKER_FILE        Absolute path overriding the default
//                                           `local-assets/visibility-watchdog.FAILED`, so
//                                           specs never touch the real marker file.
//   VISIBILITY_WATCHDOG_ATTEMPT_DELAYS_MS  JSON array overriding the default backoff
//                                           `[5000,15000,30000,60000,120000]` between flip
//                                           attempts, so specs don't sleep for real
//                                           minutes. A malformed or non-numeric value
//                                           falls back to that default list.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const DEFAULT_REPO = "najathakram/routeflow";
const DEFAULT_MINUTES = 45;
const MAX_ATTEMPTS = 6;
// FIVE delays for SIX attempts: attempt 6 is never followed by a sleep, so a sixth entry
// would be dead weight that also inflated the documented budget. Sum = 230 s ≈ 3.8 min.
const DEFAULT_ATTEMPT_DELAYS_MS = [5_000, 15_000, 30_000, 60_000, 120_000];
// Every `gh` call is bounded: an unattended watchdog whose retry loop is "bounded" by attempt
// count alone is not bounded at all if one call can hang forever (no TTY to notice, no session
// left to kill it). SIGKILL because a hung `gh` may not honour SIGTERM.
const GH_TIMEOUT_MS = 60_000;
const GIT_TIMEOUT_MS = 10_000;

// ─── test-only overrides ──────────────────────────────────────────────────────────────────────
// Mirrors SCHEMA_DRIFT_PRISMA_CLI in apps/api/scripts/schema-drift.mjs: honoured ONLY inside a
// jest worker that also sets the variable, announced once when honoured, and ignored LOUDLY
// anywhere else — a stray export must never be able to disarm the real watchdog. Memoised so a
// helper called on every log line still prints exactly one line per variable.
const UNDER_TEST = Boolean(process.env.JEST_WORKER_ID);
const announcedOverrides = new Set();

function testOverride(name) {
  const raw = process.env[name];
  if (!raw) return undefined;
  if (!announcedOverrides.has(name)) {
    announcedOverrides.add(name);
    console.error(
      UNDER_TEST
        ? `visibility-watchdog: WARNING: test override ${name} active — this is NOT a real flip guard`
        : `visibility-watchdog: ${name} is ignored outside test (JEST_WORKER_ID unset); using the real value`,
    );
  }
  return UNDER_TEST ? raw : undefined;
}

// ─── where the log and the FAILED marker live ─────────────────────────────────────────────────
// The MAIN checkout, not whatever worktree armed the watchdog: `--git-common-dir` points at the
// main repository's `.git` even from a linked worktree, so its parent is the one directory the
// runbook tells a human to check. Falls back to this file's own repo root when git fails.
let cachedRoot = null;

function markerRoot() {
  if (cachedRoot) return cachedRoot;
  const res = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd: REPO_ROOT,
    shell: false,
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  const out = !res.error && res.status === 0 ? (res.stdout || "").trim() : "";
  cachedRoot = out ? path.dirname(path.resolve(out)) : REPO_ROOT;
  return cachedRoot;
}

function parseArgs(argv) {
  let minutes = DEFAULT_MINUTES;
  let repo = DEFAULT_REPO;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--minutes") {
      minutes = Number(argv[++i]);
    } else if (arg.startsWith("--minutes=")) {
      minutes = Number(arg.slice("--minutes=".length));
    } else if (arg === "--repo") {
      repo = argv[++i];
    } else if (arg.startsWith("--repo=")) {
      repo = arg.slice("--repo=".length);
    }
  }
  if (!Number.isFinite(minutes) || minutes < 0) {
    throw new Error(`invalid --minutes: ${JSON.stringify(minutes)}`);
  }
  if (!repo || typeof repo !== "string") {
    throw new Error(`invalid --repo: ${JSON.stringify(repo)}`);
  }
  return { minutes, repo };
}

function logFile() {
  return (
    testOverride("VISIBILITY_WATCHDOG_LOG_FILE") ||
    path.join(markerRoot(), "local-assets", "visibility-watchdog.log")
  );
}

function markerFile() {
  return (
    testOverride("VISIBILITY_WATCHDOG_MARKER_FILE") ||
    path.join(markerRoot(), "local-assets", "visibility-watchdog.FAILED")
  );
}

/** The backoff actually in force. Exported so the delay budget can be asserted directly; it is
 *  also reported as `delays=` on the `start` log line, which is how the spec reads it without
 *  importing this module (importing it would run `main()`). */
export function attemptDelaysMs() {
  const raw = testOverride("VISIBILITY_WATCHDOG_ATTEMPT_DELAYS_MS");
  if (!raw) return DEFAULT_ATTEMPT_DELAYS_MS;
  try {
    const arr = JSON.parse(raw);
    if (Array.isArray(arr) && arr.length > 0 && arr.every((n) => Number.isFinite(n) && n >= 0)) {
      return arr;
    }
  } catch {
    // fall through to default
  }
  return DEFAULT_ATTEMPT_DELAYS_MS;
}

function ghBase() {
  const overrideRaw = testOverride("VISIBILITY_WATCHDOG_GH_CMD");
  if (overrideRaw) {
    // Test-only — see header comment.
    const argv = JSON.parse(overrideRaw);
    return { cmd: argv[0], args: argv.slice(1) };
  }
  return { cmd: "gh", args: [] };
}

function runGh(subArgs) {
  const { cmd, args } = ghBase();
  return spawnSync(cmd, [...args, ...subArgs], {
    shell: false,
    encoding: "utf8",
    env: process.env,
    // A hung `gh` in an unattended watchdog is a public repo that never goes private: the
    // timeout turns it into a normal failed attempt (result.error.code === "ETIMEDOUT") that
    // the retry loop can move past, and SIGKILL guarantees the child actually dies.
    timeout: GH_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
}

/** One-line diagnosis for a spawnSync result: the spawn error's own `code` (ETIMEDOUT for a
 *  call the timeout killed) plus its message, or else the first line of stderr. */
function firstErrorLine(result) {
  if (result.error) {
    const code = result.error.code ? `${result.error.code}: ` : "";
    return `${code}${result.error.message}`;
  }
  return (result.stderr || "").trim().split("\n")[0] || "";
}

function log(event, detail) {
  const line = `${new Date().toISOString()} ${event}${detail ? ` ${detail}` : ""}`;
  const file = logFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, line + "\n");
  console.log(line);
  return line;
}

// Plain setTimeout-based sleep — never a busy-wait (Atomics.wait or similar).
// This keeps the event loop free the whole time this script waits, so process
// signals (SIGINT/SIGTERM) are handled normally rather than starved until the
// sleep completes.
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readVisibility(repo) {
  const viewResult = runGh(["repo", "view", repo, "--json", "visibility"]);
  if (!viewResult.error && viewResult.status === 0) {
    try {
      return JSON.parse(viewResult.stdout).visibility ?? null;
    } catch {
      return null;
    }
  }
  return null;
}

function writeFailedMarker(repo, errorDetail) {
  const file = markerFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({ time: new Date().toISOString(), repo, error: errorDetail }, null, 2) + "\n",
  );
}

function clearFailedMarker() {
  const file = markerFile();
  if (fs.existsSync(file)) {
    fs.rmSync(file, { force: true });
  }
}

async function main() {
  const { minutes, repo } = parseArgs(process.argv.slice(2));
  const waitMs = Math.round(minutes * 60_000);
  const deadline = new Date(Date.now() + waitMs).toISOString();

  const startVisibility = readVisibility(repo) ?? "unknown";
  // Read BEFORE the wait so the launch line already carries both the resolved root a human
  // would go looking in and the backoff actually in force (a malformed override falls back to
  // the default list, and `delays=` is where that is visible).
  const delays = attemptDelaysMs();
  log(
    "start",
    `visibility=${startVisibility} minutes=${minutes} repo=${repo} pid=${process.pid} ` +
      `root=${markerRoot()} delays=${JSON.stringify(delays)} deadline=${deadline}`,
  );
  // Keep running even if already PRIVATE — the public window this watchdog
  // guards against may still open later in the deploy flow.

  await sleep(waitMs);

  let lastErrorDetail = "no successful read-back";

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const editResult = runGh([
      "repo",
      "edit",
      repo,
      "--visibility",
      "private",
      "--accept-visibility-change-consequences",
    ]);
    const editExit = editResult.error ? "spawn-error" : String(editResult.status);
    const editStderrFirstLine = firstErrorLine(editResult);

    const visibility = readVisibility(repo);

    log(
      "attempt",
      `n=${attempt}/${MAX_ATTEMPTS} edit_exit=${editExit} edit_stderr=${JSON.stringify(
        editStderrFirstLine,
      )} visibility=${visibility ?? "unreadable"}`,
    );

    if (visibility === "PRIVATE") {
      log("verified", `visibility=PRIVATE attempt=${attempt}/${MAX_ATTEMPTS}`);
      clearFailedMarker();
      return 0;
    }

    lastErrorDetail = `edit_exit=${editExit} edit_stderr=${editStderrFirstLine} visibility=${
      visibility ?? "unreadable"
    }`;

    if (attempt < MAX_ATTEMPTS) {
      await sleep(delays[attempt - 1] ?? delays[delays.length - 1]);
    }
  }

  log(
    "error",
    `visibility not confirmed PRIVATE after ${MAX_ATTEMPTS} attempts (last: ${lastErrorDetail}) — check manually`,
  );
  writeFailedMarker(repo, lastErrorDetail);
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    log("error", `unhandled: ${err && err.message ? err.message : String(err)}`);
    process.exit(1);
  });
