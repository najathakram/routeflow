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
// EXIT CODE
//   0 — the flip ran and was verified PRIVATE.
//   1 — the flip command failed, or the repo could not be confirmed PRIVATE
//       within the retry budget. Either way, check the log — a human may need
//       to flip it by hand.
//
// LOG
// One line per event, appended to `local-assets/visibility-watchdog.log`
// (created if missing; gitignored — see .gitignore's "local-assets/" section)
// and also printed to stdout:
//   <ISO timestamp> start|flip|verified|error <detail>
//
// TEST-ONLY OVERRIDES (never set these outside a Jest worker — see
// apps/api/src/common/visibility-watchdog-script.spec.ts)
//   VISIBILITY_WATCHDOG_GH_CMD             JSON array of argv, e.g.
//                                           '["node","/tmp/fake-gh.mjs"]', replacing the
//                                           real `gh` invocation entirely so specs can
//                                           drive a fake with no network and no real
//                                           repo access.
//   VISIBILITY_WATCHDOG_LOG_FILE           Absolute path overriding the default
//                                           `local-assets/visibility-watchdog.log`, so
//                                           specs never touch the real operational log.
//   VISIBILITY_WATCHDOG_VERIFY_INTERVAL_MS Overrides the 10s read-back poll interval so
//                                           specs don't sleep for real.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const DEFAULT_LOG_FILE = path.join(REPO_ROOT, "local-assets", "visibility-watchdog.log");

const DEFAULT_REPO = "najathakram/routeflow";
const DEFAULT_MINUTES = 45;
const VERIFY_MAX_TRIES = 5;
const DEFAULT_VERIFY_INTERVAL_MS = 10_000;

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
  return process.env.VISIBILITY_WATCHDOG_LOG_FILE || DEFAULT_LOG_FILE;
}

function verifyIntervalMs() {
  const raw = process.env.VISIBILITY_WATCHDOG_VERIFY_INTERVAL_MS;
  if (!raw) return DEFAULT_VERIFY_INTERVAL_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_VERIFY_INTERVAL_MS;
}

function ghBase() {
  const overrideRaw = process.env.VISIBILITY_WATCHDOG_GH_CMD;
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
  });
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

async function main() {
  const { minutes, repo } = parseArgs(process.argv.slice(2));
  const waitMs = Math.round(minutes * 60_000);
  const deadline = new Date(Date.now() + waitMs).toISOString();
  log("start", `minutes=${minutes} repo=${repo} pid=${process.pid} deadline=${deadline}`);

  await sleep(waitMs);

  const editResult = runGh([
    "repo",
    "edit",
    repo,
    "--visibility",
    "private",
    "--accept-visibility-change-consequences",
  ]);
  if (editResult.error || editResult.status !== 0) {
    const detail = editResult.error
      ? editResult.error.message
      : `exit=${editResult.status} stderr=${(editResult.stderr || "").trim().slice(0, 500)}`;
    log("error", `gh repo edit --visibility private failed: ${detail}`);
    return 1;
  }
  log("flip", "gh repo edit --visibility private exit=0");

  const interval = verifyIntervalMs();
  for (let attempt = 1; attempt <= VERIFY_MAX_TRIES; attempt++) {
    const viewResult = runGh(["repo", "view", repo, "--json", "visibility"]);
    let visibility = null;
    if (!viewResult.error && viewResult.status === 0) {
      try {
        visibility = JSON.parse(viewResult.stdout).visibility;
      } catch {
        visibility = null;
      }
    }
    if (visibility === "PRIVATE") {
      log("verified", `visibility=PRIVATE attempt=${attempt}/${VERIFY_MAX_TRIES}`);
      return 0;
    }
    if (attempt < VERIFY_MAX_TRIES) {
      await sleep(interval);
    } else {
      log(
        "error",
        `visibility not confirmed PRIVATE after ${VERIFY_MAX_TRIES} attempts (last read: ${
          visibility ?? "unreadable"
        }) — check manually`,
      );
      return 1;
    }
  }
  // Unreachable — the loop always returns — but keep a safe fallback.
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    log("error", `unhandled: ${err && err.message ? err.message : String(err)}`);
    process.exit(1);
  });
