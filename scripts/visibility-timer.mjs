#!/usr/bin/env node
// Visibility timer — the OFF-MACHINE safety net behind scripts/visibility-watchdog.mjs.
//
// WHY THIS EXISTS
// The watchdog flips the repo private at a deadline, but it runs on the machine that opens the
// public window. That machine died twice mid-window and the repo stayed public for hours. With
// `--window-marker` the watchdog publishes a small marker (scripts/lib/visibility-window.mjs) to a
// private repo; this script runs on a DIFFERENT machine (a Mac launchd job, every 5 minutes, see
// tools/visibility-timer/README.md), reads that marker and flips the repo private once the deadline
// plus a 2 minute grace has passed and the repo is still PUBLIC.
//
// ONE-SHOT: each run reads the marker, decides, acts at most once, and exits.
//   marker missing (404 while the marker repo is readable) / malformed / for another repo / stale
//   (> 6 h past deadline)                                                             -> no action
//   deadline + 2 min not reached                                                      -> no action
//   marker repo itself unreadable (a 404 from a token that cannot see it)    -> marker-unreadable, exit 1
//   past deadline + grace: read visibility; PRIVATE -> no action; PUBLIC -> flip (up to 3 attempts
//   of `gh repo edit` + read-back, sleeping 10 s then 30 s between) and verify.
// A late flip is always safer than no flip; a flip while CI still runs just fails that run on billing.
//
// USAGE
//   node scripts/visibility-timer.mjs [--repo <owner/name>] [--marker-repo <owner/name>] [--help]
//     --repo         repository to guard (default najathakram/routeflow)
//     --marker-repo  repository holding the marker (default najathakram/routeflow-specs)
//     --help         print usage and exit 0
// Arguments are validated first: an unknown flag or missing value prints usage and exits 2 with no
// `gh` call and no log line (the same rule as the watchdog, #2076).
//
// EXIT CODE  0 = no action needed, or the repo is verified PRIVATE.
//            1 = marker (incl. a 404 while the marker repo is itself unreadable, e.g. a bad token)
//                or visibility unreadable, or the flip was not confirmed. Nothing was flipped
//                blindly; the next launchd run tries again.
//
// LOG  ~/.routeflow/ops/visibility-timer.log (mkdir -p), also printed to stdout. Exactly ONE line per
// decision, plus one per failed flip attempt: `<ISO> <event> <detail>`. Events: none, wait,
// already-private, flipped, attempt, error, marker-unreadable, visibility-unreadable. The detail
// names the repo, deadline and opener whenever a marker parsed.
//
// TEST-ONLY OVERRIDES (honoured ONLY inside a Jest worker; same pattern as testOverride() in
// visibility-watchdog.mjs: one `WARNING: test override <NAME> active` stderr line when honoured, one
// "ignored" line otherwise, so a stray export can never disarm the real timer)
//   VISIBILITY_TIMER_GH_CMD               JSON argv replacing `gh`
//   VISIBILITY_TIMER_LOG_FILE             absolute log path
//   VISIBILITY_TIMER_NOW_MS               epoch ms used as "now"
//   VISIBILITY_TIMER_ATTEMPT_DELAYS_MS    JSON array replacing the default [10000,30000]

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MARKER_PATH, MARKER_REPO, decide, parseMarker } from "./lib/visibility-window.mjs";

const DEFAULT_REPO = "najathakram/routeflow";
const MAX_ATTEMPTS = 3;
const DEFAULT_ATTEMPT_DELAYS_MS = [10_000, 30_000];
// Every `gh` call is bounded; SIGKILL because a hung `gh` may not honour SIGTERM.
const GH_TIMEOUT_MS = 60_000;

const UNDER_TEST = Boolean(process.env.JEST_WORKER_ID);
const announcedOverrides = new Set();

function testOverride(name) {
  const raw = process.env[name];
  if (!raw) return undefined;
  if (!announcedOverrides.has(name)) {
    announcedOverrides.add(name);
    console.error(
      UNDER_TEST
        ? `visibility-timer: WARNING: test override ${name} active — this is NOT a real flip guard`
        : `visibility-timer: ${name} is ignored outside test (JEST_WORKER_ID unset); using the real value`,
    );
  }
  return UNDER_TEST ? raw : undefined;
}

const USAGE = `usage: node scripts/visibility-timer.mjs [--repo <owner/name>] [--marker-repo <owner/name>] [--help]
  --repo <owner/name>         repository to guard (default ${DEFAULT_REPO})
  --marker-repo <owner/name>  repository holding the window marker (default ${MARKER_REPO})
  --help                      print this message and exit 0`;

class UsageError extends Error {}

function parseArgs(argv) {
  let repo = DEFAULT_REPO;
  let markerRepo = MARKER_REPO;
  let help = false;
  const valueOf = (flag, next) => {
    if (next === undefined || next.startsWith("--")) throw new UsageError(`${flag} needs a value`);
    return next;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") help = true;
    else if (arg === "--repo") repo = valueOf(arg, argv[++i]);
    else if (arg.startsWith("--repo=")) repo = arg.slice("--repo=".length);
    else if (arg === "--marker-repo") markerRepo = valueOf(arg, argv[++i]);
    else if (arg.startsWith("--marker-repo=")) markerRepo = arg.slice("--marker-repo=".length);
    else throw new UsageError(`unknown argument: ${arg}`);
  }
  if (help) return { help: true };
  for (const [flag, v] of [
    ["--repo", repo],
    ["--marker-repo", markerRepo],
  ]) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(v))
      throw new UsageError(`invalid ${flag}: ${JSON.stringify(v)}`);
  }
  return { repo, markerRepo, help: false };
}

function logFile() {
  return (
    testOverride("VISIBILITY_TIMER_LOG_FILE") ||
    path.join(os.homedir(), ".routeflow", "ops", "visibility-timer.log")
  );
}

function log(event, detail) {
  const line = `${new Date().toISOString()} ${event}${detail ? ` ${detail}` : ""}`;
  const file = logFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, line + "\n");
  console.log(line);
}

function nowMs() {
  const raw = testOverride("VISIBILITY_TIMER_NOW_MS");
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) ? n : Date.now();
}

function attemptDelaysMs() {
  const raw = testOverride("VISIBILITY_TIMER_ATTEMPT_DELAYS_MS");
  if (!raw) return DEFAULT_ATTEMPT_DELAYS_MS;
  try {
    const arr = JSON.parse(raw);
    if (Array.isArray(arr) && arr.length > 0 && arr.every((n) => Number.isFinite(n) && n >= 0)) {
      return arr;
    }
  } catch {
    // fall through to the default
  }
  return DEFAULT_ATTEMPT_DELAYS_MS;
}

function runGh(subArgs) {
  const raw = testOverride("VISIBILITY_TIMER_GH_CMD");
  let cmd = "gh";
  let args = [];
  if (raw) {
    const argv = JSON.parse(raw);
    cmd = argv[0];
    args = argv.slice(1);
  }
  return spawnSync(cmd, [...args, ...subArgs], {
    shell: false,
    encoding: "utf8",
    env: process.env,
    timeout: GH_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
}

function firstErrorLine(result) {
  if (result.error) {
    const code = result.error.code ? `${result.error.code}: ` : "";
    return `${code}${result.error.message}`;
  }
  return (result.stderr || "").trim().split("\n")[0] || "";
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * {text} | {missing:true} | {error}. A 404 counts as "no marker" only when the marker repo itself
 * is readable (one extra bounded `gh api repos/<marker-repo>` call, made only after a 404).
 */
function readMarker(markerRepo) {
  const res = runGh([
    "api",
    `repos/${markerRepo}/contents/${MARKER_PATH}`,
    "-H",
    "Accept: application/vnd.github.raw",
  ]);
  if (!res.error && res.status === 0) return { text: res.stdout };
  const out = `${res.stderr || ""}\n${res.stdout || ""}`;
  if (!res.error && /404|Not Found/i.test(out)) {
    // GitHub answers 404 for a private repo the token cannot see, so a broken or missing token
    // looks exactly like "no marker". Prove the marker repo itself is readable first; if it is
    // not, the 404 means nothing and the timer is blind, which must be loud.
    const probe = runGh(["api", `repos/${markerRepo}`, "--jq", ".full_name"]);
    if (probe.error || probe.status !== 0) {
      return {
        error: `marker repo ${markerRepo} unreadable (${firstErrorLine(probe) || `exit ${probe.status}`})`,
      };
    }
    return { missing: true };
  }
  return { error: firstErrorLine(res) || `exit ${res.status}` };
}

/** "PUBLIC" | "PRIVATE" | "INTERNAL" | null (unreadable). */
function readVisibility(repo) {
  const res = runGh(["repo", "view", repo, "--json", "visibility", "--jq", ".visibility"]);
  if (res.error || res.status !== 0) return null;
  return (res.stdout || "").trim() || null;
}

async function main({ repo, markerRepo }) {
  const read = readMarker(markerRepo);
  if (read.error) {
    log("marker-unreadable", `marker_repo=${markerRepo} error=${JSON.stringify(read.error)}`);
    return 1;
  }
  const markerText = read.missing ? null : read.text;
  const now = nowMs();
  const decision = decide({ markerText, repo, nowMs: now });

  let ctx = `repo=${repo}`;
  if (markerText !== null) {
    const parsed = parseMarker(markerText);
    if (parsed.ok) {
      ctx = `repo=${parsed.marker.repo} deadline=${parsed.marker.deadline} opener=${JSON.stringify(
        parsed.marker.opener,
      )}`;
    }
  }

  if (decision.action === "none" || decision.action === "wait") {
    log(decision.action, `${decision.reason} ${ctx}`);
    return 0;
  }

  // action === "check": the deadline and grace have passed and the marker is live.
  const before = readVisibility(repo);
  if (before === null) {
    log("visibility-unreadable", ctx);
    return 1;
  }
  if (before === "PRIVATE") {
    log("already-private", ctx);
    return 0;
  }

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
    const after = readVisibility(repo);
    if (after === "PRIVATE") {
      log("flipped", `attempt=${attempt}/${MAX_ATTEMPTS} ${ctx}`);
      return 0;
    }
    last = `edit_exit=${edit.error ? "spawn-error" : edit.status} edit_stderr=${JSON.stringify(
      firstErrorLine(edit),
    )} visibility=${after ?? "unreadable"}`;
    log("attempt", `n=${attempt}/${MAX_ATTEMPTS} ${last}`);
    if (attempt < MAX_ATTEMPTS) await sleep(delays[attempt - 1] ?? delays[delays.length - 1]);
  }
  log(
    "error",
    `visibility not confirmed PRIVATE after ${MAX_ATTEMPTS} attempts (last: ${last}) ${ctx} — flip by hand`,
  );
  return 1;
}

// Validate the arguments before anything else runs: a bad flag or --help never reaches `gh` or the log.
let cli;
try {
  cli = parseArgs(process.argv.slice(2));
} catch (err) {
  if (!(err instanceof UsageError)) throw err;
  console.error(`visibility-timer: ${err.message}\n${USAGE}`);
  process.exit(2);
}
if (cli.help) {
  console.log(USAGE);
  process.exit(0);
}

main(cli)
  .then((code) => process.exit(code))
  .catch((err) => {
    try {
      log("error", `unhandled: ${err && err.message ? err.message : String(err)}`);
    } catch {
      // nothing left to log to
    }
    process.exit(1);
  });
