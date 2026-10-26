#!/usr/bin/env node
// Visibility dead-man switch — a SECOND-MACHINE backstop for scripts/visibility-watchdog.mjs.
//
// WHY THIS EXISTS
// The watchdog arms the private flip on the SAME machine that opens the public CI window. On
// 2026-10-25 a PC reboot killed that watchdog (and the agent session that started it) mid-window,
// and the repo stayed public for ~8 hours. Anything that lives on the machine that can die cannot
// be the only guard. This script runs on a DIFFERENT machine (the Mac mini, under launchd) and
// knows nothing about any window: it just watches the repo and, if it has been continuously PUBLIC
// for longer than any legitimate window (watchdog default 45 min + a deploy), flips it private.
//
// A flip by this script while a window is legitimately still open is the CORRECT outcome, not a
// bug (same reasoning as the watchdog: CI on a private repo just fails on billing, nothing is
// corrupted; rerun it). A late, unwanted flip is always safer than no flip at all.
//
// HOW TO RUN
//   Recommended (launchd, every ~2 min): `node scripts/visibility-deadman.mjs --once`, installed as
//     a LaunchDaemon (runs at boot, no login needed; scripts/launchd/*.daemon.plist plus
//     visibility-deadman-run.sh, which reads GH_TOKEN from a root-only file). The LaunchAgent plist
//     is a FALLBACK: an agent dies with logout/reboot unless the Mac auto-logs-in. See the runbook section
//     "Dead-man switch (second machine)" in docs/runbooks/deploy-visibility-flip.md.
//   Optional: `node scripts/visibility-deadman.mjs` (no --once) loops forever, one poll every
//     --interval-seconds. `--once` under launchd is preferred: launchd restarts it after a crash
//     or reboot, a long-lived loop does not.
//
// USAGE
//   node scripts/visibility-deadman.mjs [--once] [--status] [--repo <owner/name>]
//     [--max-public-minutes <n>] [--interval-seconds <n>] [--state-dir <dir>] [--help]
//     --once                one poll, then exit (the launchd mode)
//     --status              print state + heartbeat age, no gh call; exit 3 + WARNING if unhealthy
//     --repo                "owner/name" to watch and flip (default najathakram/routeflow)
//     --max-public-minutes  flip private once continuously PUBLIC for longer than this (default 60)
//     --interval-seconds    loop mode only: seconds between polls (default 120)
//     --state-dir           directory for state + log (default <main checkout>/local-assets)
//     --help                print usage and exit 0
//
// ARGUMENTS ARE VALIDATED FIRST (#2076)
// An unknown flag or a bad value prints a usage message and exits 2 BEFORE any side effect: no
// state file, no log line, no `gh` call. `--help` exits 0 the same way.
//
// EACH POLL (`gh repo view <repo> --json visibility,viewerPermission`)
//   viewerPermission != ADMIN            -> log an `incident` (reason "not-admin"), never try to flip,
//                                           exit 5, EVERY poll (even while PRIVATE): a wrong account
//                                           or a token without admin rights would otherwise be a dead
//                                           switch that looks alive
//   PRIVATE                              -> clear firstSeenPublicAt
//   PUBLIC, no firstSeenPublicAt         -> set it to now, BUT backdate it to the previous answered
//                                           poll (lastCheckAt) when that is older than 2x the
//                                           interval (gh errors, sleep): the repo may have been
//                                           public the whole gap
//   PUBLIC for <= --max-public-minutes   -> nothing (heartbeat only)
//   PUBLIC for >  --max-public-minutes   -> FLIP: `gh repo edit <repo> --visibility private
//                                           --accept-visibility-change-consequences`, then read
//                                           back until PRIVATE is confirmed (same retry budget as
//                                           the watchdog: 6 attempts, 5s/15s/30s/60s/120s between),
//                                           and log an `incident` JSON line.
//   gh fails (network/auth/timeout/junk) -> log it, KEEP state, exit 4. The visibility is never
//                                           guessed: an unreadable poll neither starts nor clears
//                                           the timer.
//
// STATE (<state-dir>/visibility-deadman.state.json)
//   { firstSeenPublicAt, lastCheckAt, lastVisibility, lastAttemptAt, lastPollOk, lastPollError,
//     lastFlipAt, lastFlipConfirmed }
//   lastCheckAt = last poll that got a real answer; lastAttemptAt = last poll of any kind.
//   If the flip is not confirmed, firstSeenPublicAt is KEPT, so the next poll tries again.
//   A CORRUPT state file (or an unparseable firstSeenPublicAt) is logged, never silently reset: the
//   timer starts at the lastCheckAt that can still be read from it, or, if none, the window is
//   treated as already spent and a PUBLIC repo is flipped on that very poll.
//
// LOG (<state-dir>/visibility-deadman.log) — JSON lines, also printed to stdout:
//   {"time":"<ISO>","event":"heartbeat|state|flip-attempt|incident|error|status",...}
//   Every poll writes exactly one `heartbeat` line.
//
// STATE/LOG ROOT
// `local-assets/` is resolved against the MAIN checkout (via `git rev-parse --git-common-dir`),
// falling back to this file's repo root, exactly like the watchdog. `--state-dir` overrides it.
//
// EXIT CODE
//   0 — poll completed (including "flipped and confirmed PRIVATE"), or --status / --help
//   1 — flipped but PRIVATE was not confirmed after all attempts (human must flip by hand)
//   2 — usage error
//   3 — --status only: unhealthy (stale poll > 600 s, unconfirmed flip, last poll failed, no state)
//   4 — gh could not report the visibility (state kept, nothing guessed)
//   5 — the gh account is not an admin of the repo (incident logged; it cannot flip)
//
// TEST-ONLY HOOKS (never set these in a launchd plist or an operator shell)
//   VISIBILITY_DEADMAN_GH_BIN             path of the executable used INSTEAD of `gh`. A WARNING
//                                         line goes to stderr whenever it is set: it means this is
//                                         NOT a real flip guard. Used by the self-test.
//   VISIBILITY_DEADMAN_RETRY_DELAYS_MS    JSON array overriding the 5s..120s read-back backoff so
//                                         the self-test does not sleep for minutes. Same WARNING.
//                                         A malformed value falls back to the default list.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const DEFAULT_REPO = "najathakram/routeflow";
// Longer than the watchdog's 45-minute default window plus a deploy.
const DEFAULT_MAX_PUBLIC_MINUTES = 60;
const DEFAULT_INTERVAL_SECONDS = 120;
const MAX_ATTEMPTS = 6;
// Five delays for six attempts (the last attempt is never followed by a sleep) — mirrors the watchdog.
const DEFAULT_ATTEMPT_DELAYS_MS = [5_000, 15_000, 30_000, 60_000, 120_000];
// Every `gh` call is bounded: an unattended switch that can hang forever is not a switch.
const GH_TIMEOUT_MS = 60_000;
const GIT_TIMEOUT_MS = 10_000;

const EXIT_FLIP_UNCONFIRMED = 1;
const EXIT_USAGE = 2;
const EXIT_STATUS_WARN = 3;
const EXIT_GH_FAILED = 4;
const EXIT_NOT_ADMIN = 5;
// `--status` calls a poll stale after this long (launchd polls every ~120 s).
const STATUS_STALE_SECONDS = 600;

const USAGE = `usage: node scripts/visibility-deadman.mjs [--once] [--status] [--repo <owner/name>]
         [--max-public-minutes <n>] [--interval-seconds <n>] [--state-dir <dir>] [--help]
  --once                     one poll, then exit (the launchd mode)
  --status                   print state + last heartbeat age and exit 0 (no gh call)
  --repo <owner/name>        repository to watch and flip (default ${DEFAULT_REPO})
  --max-public-minutes <n>   flip private after this long continuously PUBLIC (default ${DEFAULT_MAX_PUBLIC_MINUTES})
  --interval-seconds <n>     loop mode: seconds between polls (default ${DEFAULT_INTERVAL_SECONDS})
  --state-dir <dir>          directory for state + log (default <main checkout>/local-assets)
  --help                     print this message and exit 0`;

class UsageError extends Error {}

function parseArgs(argv) {
  const opts = {
    once: false,
    status: false,
    repo: DEFAULT_REPO,
    maxPublicMinutes: DEFAULT_MAX_PUBLIC_MINUTES,
    intervalSeconds: DEFAULT_INTERVAL_SECONDS,
    stateDir: null,
  };
  let help = false;
  // A flag value must be a real value: `--repo --once` would otherwise swallow the next flag.
  const valueOf = (flag, next) => {
    if (next === undefined || next.startsWith("--")) {
      throw new UsageError(`${flag} needs a value`);
    }
    return next;
  };
  // Accepts both `--flag value` and `--flag=value`.
  const takeValue = (flag, arg, i) =>
    arg.startsWith(`${flag}=`)
      ? { value: arg.slice(flag.length + 1), skip: 0 }
      : { value: valueOf(flag, argv[i + 1]), skip: 1 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const flag = arg.split("=")[0];
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--once") {
      opts.once = true;
    } else if (arg === "--status") {
      opts.status = true;
    } else if (flag === "--repo") {
      const { value, skip } = takeValue(flag, arg, i);
      opts.repo = value;
      i += skip;
    } else if (flag === "--max-public-minutes") {
      const { value, skip } = takeValue(flag, arg, i);
      opts.maxPublicMinutes = Number(value);
      i += skip;
    } else if (flag === "--interval-seconds") {
      const { value, skip } = takeValue(flag, arg, i);
      opts.intervalSeconds = Number(value);
      i += skip;
    } else if (flag === "--state-dir") {
      const { value, skip } = takeValue(flag, arg, i);
      opts.stateDir = value;
      i += skip;
    } else {
      throw new UsageError(`unknown argument: ${arg}`);
    }
  }
  if (help) return { help: true };
  if (!Number.isFinite(opts.maxPublicMinutes) || opts.maxPublicMinutes <= 0) {
    throw new UsageError(`invalid --max-public-minutes: ${JSON.stringify(opts.maxPublicMinutes)}`);
  }
  if (!Number.isFinite(opts.intervalSeconds) || opts.intervalSeconds < 1) {
    throw new UsageError(`invalid --interval-seconds: ${JSON.stringify(opts.intervalSeconds)}`);
  }
  if (!opts.repo || !/^[^/\s]+\/[^/\s]+$/.test(opts.repo)) {
    throw new UsageError(`invalid --repo (want owner/name): ${JSON.stringify(opts.repo)}`);
  }
  if (opts.stateDir !== null && !opts.stateDir.trim()) {
    throw new UsageError(`invalid --state-dir: ${JSON.stringify(opts.stateDir)}`);
  }
  return { ...opts, help: false };
}

// ─── test-only hooks ──────────────────────────────────────────────────────────────────────────
// Announced once each, on stderr, whenever set: a stray export must never be silent.
const announced = new Set();

function testHook(name) {
  const raw = process.env[name];
  if (!raw) return undefined;
  if (!announced.has(name)) {
    announced.add(name);
    console.error(
      `visibility-deadman: WARNING: test hook ${name} is set — this is NOT a real flip guard`,
    );
  }
  return raw;
}

function attemptDelaysMs() {
  const raw = testHook("VISIBILITY_DEADMAN_RETRY_DELAYS_MS");
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

// ─── where state and log live ─────────────────────────────────────────────────────────────────
// The MAIN checkout, not whatever worktree the script runs from — same rule as the watchdog.
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

function paths(stateDir) {
  const dir = stateDir ? path.resolve(stateDir) : path.join(markerRoot(), "local-assets");
  return {
    dir,
    state: path.join(dir, "visibility-deadman.state.json"),
    log: path.join(dir, "visibility-deadman.log"),
  };
}

// ─── logging + state ──────────────────────────────────────────────────────────────────────────
function log(p, event, fields = {}) {
  const line = JSON.stringify({ time: new Date().toISOString(), event, ...fields });
  fs.mkdirSync(p.dir, { recursive: true });
  fs.appendFileSync(p.log, line + "\n");
  console.log(line);
}

const EMPTY_STATE = { firstSeenPublicAt: null, lastCheckAt: null, lastVisibility: null };

const isoOrNull = (s) => {
  const ms = Date.parse(typeof s === "string" ? s : "");
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};

/**
 * {state, corrupt}. `corrupt` is null for a healthy or simply absent state; otherwise
 * {lastCheckAt} holds the last poll time that could still be read (ISO) or null. A corrupt state
 * must NEVER silently hand a possibly-public repo a fresh timer, so pollOnce starts the timer at
 * that lastCheckAt, or flips immediately when there is none. The corruption is always logged.
 */
function readState(p) {
  let raw;
  try {
    raw = fs.readFileSync(p.state, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return { state: { ...EMPTY_STATE }, corrupt: null };
    log(p, "error", { detail: `state corrupt (unreadable: ${err.message})` });
    return { state: { ...EMPTY_STATE }, corrupt: { lastCheckAt: null } };
  }
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // fall through to salvage
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const state = { ...EMPTY_STATE, ...parsed };
    // A timer that is present but unreadable is corruption too, not "no timer".
    if (state.firstSeenPublicAt && isoOrNull(state.firstSeenPublicAt) === null) {
      const salvaged = isoOrNull(state.lastCheckAt);
      log(p, "error", {
        detail: `state corrupt (firstSeenPublicAt unparseable: ${JSON.stringify(state.firstSeenPublicAt)}); lastCheckAt=${salvaged}`,
      });
      state.firstSeenPublicAt = null;
      return { state, corrupt: { lastCheckAt: salvaged } };
    }
    return { state, corrupt: null };
  }
  // Truncated / garbage file: pull lastCheckAt out of the raw text if it is still there.
  const m = /"lastCheckAt"\s*:\s*"([^"]+)"/.exec(raw);
  const salvaged = m ? isoOrNull(m[1]) : null;
  log(p, "error", {
    detail: `state corrupt (not valid JSON); salvaged lastCheckAt=${salvaged}`,
  });
  return { state: { ...EMPTY_STATE, lastCheckAt: salvaged }, corrupt: { lastCheckAt: salvaged } };
}

/** Atomic write (temp + rename) so a kill mid-write can never leave a half-written state. */
function writeState(p, state) {
  fs.mkdirSync(p.dir, { recursive: true });
  const tmp = `${p.state}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  fs.renameSync(tmp, p.state);
}

// ─── gh ───────────────────────────────────────────────────────────────────────────────────────
function runGh(subArgs) {
  const bin = testHook("VISIBILITY_DEADMAN_GH_BIN") || "gh";
  return spawnSync(bin, subArgs, {
    // Node refuses to spawn a .cmd/.bat without a shell on Windows; real `gh` is an .exe.
    shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(bin),
    encoding: "utf8",
    env: process.env,
    timeout: GH_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
}

/** One-line diagnosis for a spawnSync result: the spawn error's code + message, or stderr line 1. */
function firstErrorLine(result) {
  if (result.error) {
    const code = result.error.code ? `${result.error.code}: ` : "";
    return `${code}${result.error.message}`;
  }
  return (result.stderr || "").trim().split("\n")[0] || "";
}

/** {visibility, viewerPermission} on a real answer (both upper-cased; permission null if absent),
 *  {error} otherwise. Never guesses. */
function readVisibility(repo) {
  const res = runGh(["repo", "view", repo, "--json", "visibility,viewerPermission"]);
  if (res.error || res.status !== 0) {
    const exit = res.error ? "spawn-error" : String(res.status);
    return { error: `gh repo view exit=${exit} ${firstErrorLine(res)}`.trim() };
  }
  try {
    const j = JSON.parse(res.stdout);
    const v = j.visibility;
    const perm = typeof j.viewerPermission === "string" ? j.viewerPermission.toUpperCase() : null;
    if (typeof v === "string" && v) return { visibility: v.toUpperCase(), viewerPermission: perm };
  } catch {
    // fall through
  }
  return { error: "gh repo view returned no parseable visibility" };
}

// Plain setTimeout sleep — never a busy-wait, so signals are handled during the wait.
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── the flip ─────────────────────────────────────────────────────────────────────────────────
/** Flip private and read back until PRIVATE is confirmed. Returns {confirmed, attempts, last}. */
async function flipPrivate(p, repo) {
  const delays = attemptDelaysMs();
  let last = "no successful read-back";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const edit = runGh([
      "repo",
      "edit",
      repo,
      "--visibility",
      "private",
      "--accept-visibility-change-consequences",
    ]);
    const editExit = edit.error ? "spawn-error" : String(edit.status);
    const editStderr = firstErrorLine(edit);
    const back = readVisibility(repo);
    log(p, "flip-attempt", {
      n: attempt,
      of: MAX_ATTEMPTS,
      editExit,
      editStderr,
      visibility: back.visibility ?? "unreadable",
    });
    if (back.visibility === "PRIVATE") return { confirmed: true, attempts: attempt, last };
    last = `edit_exit=${editExit} edit_stderr=${editStderr} visibility=${back.visibility ?? "unreadable"}`;
    if (attempt < MAX_ATTEMPTS) await sleep(delays[attempt - 1] ?? delays[delays.length - 1]);
  }
  return { confirmed: false, attempts: MAX_ATTEMPTS, last };
}

// ─── one poll ─────────────────────────────────────────────────────────────────────────────────
async function pollOnce({ repo, maxPublicMinutes, intervalSeconds, stateDir }) {
  const p = paths(stateDir);
  const { state, corrupt } = readState(p);
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  // The previous answered poll, captured BEFORE this poll overwrites it: the gap rule needs it.
  const prevCheckMs = Date.parse(state.lastCheckAt ?? "");
  state.lastAttemptAt = nowIso;

  const read = readVisibility(repo);
  if (read.error) {
    // Keep firstSeenPublicAt and lastCheckAt exactly as they were: an unreadable poll is not an
    // answer. Only lastAttemptAt moves, so --status can tell "script runs, gh is broken" apart
    // from "script is not running at all".
    state.lastPollOk = false;
    state.lastPollError = read.error;
    writeState(p, state);
    log(p, "heartbeat", { ok: false, repo, error: read.error });
    log(p, "error", { detail: `visibility unreadable; state kept: ${read.error}` });
    return EXIT_GH_FAILED;
  }

  const visibility = read.visibility;
  const notAdmin = read.viewerPermission !== "ADMIN";
  state.lastCheckAt = nowIso;
  state.lastVisibility = visibility;
  state.lastPollOk = !notAdmin;
  state.lastPollError = notAdmin
    ? `not-admin: viewerPermission=${read.viewerPermission ?? "missing"}`
    : null;

  // A non-admin `gh` (wrong account, expired token, fine-grained token without admin) can read the
  // repo but can never flip it: that is a dead switch that looks alive. Say so, every poll, loudly.
  const reportNotAdmin = (publicMinutes) => {
    writeState(p, state);
    log(p, "heartbeat", { ok: false, repo, visibility, error: state.lastPollError });
    log(p, "incident", {
      repo,
      reason: "not-admin",
      viewerPermission: read.viewerPermission,
      visibility,
      publicMinutes,
      detail: "the gh account has no admin rights on the repo; it CANNOT flip it private",
    });
    return EXIT_NOT_ADMIN;
  };

  if (visibility !== "PUBLIC") {
    if (state.firstSeenPublicAt)
      log(p, "state", { change: "cleared firstSeenPublicAt", visibility });
    state.firstSeenPublicAt = null;
    if (notAdmin) return reportNotAdmin(0);
    writeState(p, state);
    log(p, "heartbeat", { ok: true, repo, visibility, publicMinutes: 0 });
    return 0;
  }

  let sinceMs = Date.parse(state.firstSeenPublicAt ?? "");
  if (!Number.isFinite(sinceMs)) {
    // First PUBLIC sighting. "Now" is the OPTIMISTIC guess and the wrong one whenever polls were
    // missed (gh errors, a sleeping machine, a corrupt state file): the repo may have been public
    // since the last poll that DID answer. Never hand a public repo a fresh full window.
    let reason = "first-sighting";
    sinceMs = nowMs;
    const corruptLast = corrupt ? Date.parse(corrupt.lastCheckAt ?? "") : NaN;
    if (corrupt) {
      reason = Number.isFinite(corruptLast)
        ? "corrupt-state-lastCheckAt"
        : "corrupt-state-flip-now";
      // Unknown history: treat the window as already spent so this very poll flips.
      sinceMs = Number.isFinite(corruptLast) ? corruptLast : nowMs - maxPublicMinutes * 60_000 - 1;
    } else if (Number.isFinite(prevCheckMs) && nowMs - prevCheckMs > 2 * intervalSeconds * 1000) {
      reason = "gap-backdate";
      sinceMs = prevCheckMs;
    }
    state.firstSeenPublicAt = new Date(sinceMs).toISOString();
    log(p, "state", {
      change: "set firstSeenPublicAt",
      reason,
      firstSeenPublicAt: state.firstSeenPublicAt,
    });
  }
  const publicMinutes = Math.max(0, (nowMs - sinceMs) / 60_000);
  const rounded = Math.round(publicMinutes * 10) / 10;
  if (notAdmin) return reportNotAdmin(rounded);
  writeState(p, state);
  log(p, "heartbeat", {
    ok: true,
    repo,
    visibility,
    publicMinutes: rounded,
    maxPublicMinutes,
    firstSeenPublicAt: state.firstSeenPublicAt,
  });

  if (publicMinutes <= maxPublicMinutes) return 0;

  const result = await flipPrivate(p, repo);
  state.lastFlipAt = new Date().toISOString();
  state.lastFlipConfirmed = result.confirmed;
  if (result.confirmed) {
    state.firstSeenPublicAt = null;
    state.lastVisibility = "PRIVATE";
    writeState(p, state);
    log(p, "incident", {
      repo,
      action: "flipped-private",
      confirmed: true,
      publicMinutes: rounded,
      maxPublicMinutes,
      firstSeenPublicAt: new Date(sinceMs).toISOString(),
      attempts: result.attempts,
    });
    return 0;
  }
  // firstSeenPublicAt stays untouched so the next poll flips again.
  writeState(p, state);
  log(p, "incident", {
    repo,
    action: "flip-unconfirmed",
    confirmed: false,
    publicMinutes: rounded,
    maxPublicMinutes,
    firstSeenPublicAt: new Date(sinceMs).toISOString(),
    attempts: result.attempts,
    last: result.last,
  });
  return EXIT_FLIP_UNCONFIRMED;
}

// ─── --status ─────────────────────────────────────────────────────────────────────────────────
/** Prints the state and returns the exit code: 0 healthy, EXIT_STATUS_WARN if anything is off. */
function printStatus({ stateDir, maxPublicMinutes }) {
  const p = paths(stateDir);
  let state = null;
  try {
    state = JSON.parse(fs.readFileSync(p.state, "utf8"));
  } catch {
    // absent or unreadable: reported below
  }
  const ageOf = (iso) => {
    const ms = Date.parse(iso ?? "");
    return Number.isFinite(ms) ? Math.round((Date.now() - ms) / 1000) : null;
  };
  const out = {
    stateFile: p.state,
    logFile: p.log,
    stateFound: state !== null,
    state,
    lastCheckAgeSeconds: ageOf(state?.lastCheckAt),
    lastHeartbeatAgeSeconds: ageOf(state?.lastAttemptAt ?? state?.lastCheckAt),
    publicMinutes:
      state && Number.isFinite(Date.parse(state.firstSeenPublicAt ?? ""))
        ? Math.round(((Date.now() - Date.parse(state.firstSeenPublicAt)) / 60_000) * 10) / 10
        : 0,
    maxPublicMinutes,
  };
  // Status is read-only: it prints, it does not write the log or the state.
  console.log(JSON.stringify(out, null, 2));
  const warnings = [];
  if (!state) {
    warnings.push("no state yet: the dead-man switch has not completed a poll here");
  } else {
    if (out.lastCheckAgeSeconds === null || out.lastCheckAgeSeconds > STATUS_STALE_SECONDS) {
      warnings.push(
        `last answered poll (lastCheckAt) is ${out.lastCheckAgeSeconds ?? "never"}s old, limit ${STATUS_STALE_SECONDS}s: is launchd running it, or is gh failing?`,
      );
    }
    if (
      out.lastHeartbeatAgeSeconds !== null &&
      out.lastHeartbeatAgeSeconds > STATUS_STALE_SECONDS
    ) {
      warnings.push(
        `last heartbeat is ${out.lastHeartbeatAgeSeconds}s old: launchd is not running it`,
      );
    }
    if (state.lastFlipConfirmed === false) {
      warnings.push(
        "the last flip was NOT confirmed PRIVATE: the repo may still be public, flip it by hand",
      );
    }
    if (state.lastPollOk === false) {
      warnings.push(`the last poll failed: ${state.lastPollError ?? "unknown error"}`);
    }
  }
  for (const w of warnings) console.log(`WARNING: ${w}`);
  return warnings.length > 0 ? EXIT_STATUS_WARN : 0;
}

// ─── entry point ──────────────────────────────────────────────────────────────────────────────
// Validate the arguments before anything else runs: a bad flag or --help never reaches the state
// file, `gh` or the log (#2076).
let cli;
try {
  cli = parseArgs(process.argv.slice(2));
} catch (err) {
  if (!(err instanceof UsageError)) throw err;
  console.error(`visibility-deadman: ${err.message}\n${USAGE}`);
  process.exit(EXIT_USAGE);
}
if (cli.help) {
  console.log(USAGE);
  process.exit(0);
}
if (cli.status) {
  process.exit(printStatus(cli));
}

function logUnhandled(err) {
  try {
    log(paths(cli.stateDir), "error", {
      detail: `unhandled: ${err && err.message ? err.message : String(err)}`,
    });
  } catch {
    console.error(`visibility-deadman: unhandled: ${err && err.message ? err.message : err}`);
  }
}

if (cli.once) {
  pollOnce(cli)
    .then((code) => process.exit(code))
    .catch((err) => {
      logUnhandled(err);
      process.exit(1);
    });
} else {
  process.on("SIGINT", () => process.exit(130));
  process.on("SIGTERM", () => process.exit(143));
  // Loop mode never exits on a failed poll: it logs and tries again next interval.
  for (;;) {
    try {
      await pollOnce(cli);
    } catch (err) {
      logUnhandled(err);
    }
    await sleep(cli.intervalSeconds * 1000);
  }
}
