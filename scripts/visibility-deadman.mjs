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
//   Recommended (launchd, every ~2 min): `node scripts/visibility-deadman.mjs --once`
//     see scripts/launchd/com.routeflow.visibility-deadman.plist and the runbook section
//     "Dead-man switch (second machine)" in docs/runbooks/deploy-visibility-flip.md.
//   Optional: `node scripts/visibility-deadman.mjs` (no --once) loops forever, one poll every
//     --interval-seconds. `--once` under launchd is preferred: launchd restarts it after a crash
//     or reboot, a long-lived loop does not.
//
// USAGE
//   node scripts/visibility-deadman.mjs [--once] [--status] [--repo <owner/name>]
//     [--max-public-minutes <n>] [--interval-seconds <n>] [--state-dir <dir>] [--help]
//     --once                one poll, then exit (the launchd mode)
//     --status              print state and the age of the last heartbeat; no gh call; exit 0
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
// EACH POLL (`gh repo view <repo> --json visibility`)
//   PRIVATE                              -> clear firstSeenPublicAt
//   PUBLIC, no firstSeenPublicAt         -> set it to now
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
//   { firstSeenPublicAt, lastCheckAt, lastVisibility, lastAttemptAt }
//   lastCheckAt = last poll that got a real answer; lastAttemptAt = last poll of any kind.
//   If the flip is not confirmed, firstSeenPublicAt is KEPT, so the next poll tries again.
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
//   4 — gh could not report the visibility (state kept, nothing guessed)
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
const EXIT_GH_FAILED = 4;

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

/** The saved state, or an empty one when absent. An unreadable file is reported, not trusted. */
function readState(p) {
  let raw;
  try {
    raw = fs.readFileSync(p.state, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return { ...EMPTY_STATE };
    log(p, "error", { detail: `state unreadable: ${err.message}; starting from empty state` });
    return { ...EMPTY_STATE };
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return { ...EMPTY_STATE, ...parsed };
  } catch {
    // fall through
  }
  log(p, "error", { detail: "state is not valid JSON; starting from empty state" });
  return { ...EMPTY_STATE };
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

/** {visibility} on a real answer (upper-cased), {error} otherwise. Never guesses. */
function readVisibility(repo) {
  const res = runGh(["repo", "view", repo, "--json", "visibility"]);
  if (res.error || res.status !== 0) {
    const exit = res.error ? "spawn-error" : String(res.status);
    return { error: `gh repo view exit=${exit} ${firstErrorLine(res)}`.trim() };
  }
  try {
    const v = JSON.parse(res.stdout).visibility;
    if (typeof v === "string" && v) return { visibility: v.toUpperCase() };
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
async function pollOnce({ repo, maxPublicMinutes, stateDir }) {
  const p = paths(stateDir);
  const state = readState(p);
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  state.lastAttemptAt = nowIso;

  const read = readVisibility(repo);
  if (read.error) {
    // Keep firstSeenPublicAt and lastCheckAt exactly as they were: an unreadable poll is not an
    // answer. Only lastAttemptAt moves, so --status can tell "script runs, gh is broken" apart
    // from "script is not running at all".
    writeState(p, state);
    log(p, "heartbeat", { ok: false, repo, error: read.error });
    log(p, "error", { detail: `visibility unreadable; state kept: ${read.error}` });
    return EXIT_GH_FAILED;
  }

  const visibility = read.visibility;
  state.lastCheckAt = nowIso;
  state.lastVisibility = visibility;

  if (visibility !== "PUBLIC") {
    if (state.firstSeenPublicAt)
      log(p, "state", { change: "cleared firstSeenPublicAt", visibility });
    state.firstSeenPublicAt = null;
    writeState(p, state);
    log(p, "heartbeat", { ok: true, repo, visibility, publicMinutes: 0 });
    return 0;
  }

  let sinceMs = Date.parse(state.firstSeenPublicAt ?? "");
  if (!Number.isFinite(sinceMs)) {
    sinceMs = nowMs;
    state.firstSeenPublicAt = nowIso;
    log(p, "state", { change: "set firstSeenPublicAt", firstSeenPublicAt: nowIso });
  }
  const publicMinutes = Math.max(0, (nowMs - sinceMs) / 60_000);
  const rounded = Math.round(publicMinutes * 10) / 10;
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
  // State is kept (firstSeenPublicAt untouched) so the next poll flips again.
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
  if (!state) console.log("no state yet: the dead-man switch has not completed a poll here.");
  else if (out.lastHeartbeatAgeSeconds !== null && out.lastHeartbeatAgeSeconds > 600) {
    console.log(
      `WARNING: last heartbeat is ${out.lastHeartbeatAgeSeconds}s old — is launchd running it?`,
    );
  }
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
  printStatus(cli);
  process.exit(0);
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
