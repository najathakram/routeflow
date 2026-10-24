#!/usr/bin/env node
// CI freshness guard for the e2e job's `deployment_status` runs.
//
// WHY THIS EXISTS (REG-E2EGUARD-403)
// The e2e job's old inline bash guard did `latest=$(gh api ... --jq '.[0].sha'
// 2>/dev/null || true)` then tested `[ -z "$latest" ]`. On a 4xx/5xx, `gh api`
// writes the ERROR BODY to stdout and exits non-zero; `--jq` is skipped, and
// `2>/dev/null || true` swallows the message and the exit code. The captured
// "sha" was therefore an error JSON blob, non-empty, so the emptiness check
// never fired — the guard silently compared garbage to DEPLOY_SHA, found it
// unequal, and emitted `run=false`. A run token missing `deployments:read`
// made EVERY deployment_status E2E run skip itself, reported green, with
// zero E2E coverage.
//
// This script decides the SAME question (is DEPLOY_SHA still the newest
// deployment?) but only ever skips (`run=false`) when a real, structurally
// valid answer says so. Anything else — a non-zero exit, an error object, an
// unparseable body, a timeout, a missing required env var — fails OPEN
// (`run=true`, `::warning::`) so a GitHub API/permissions blip can never
// silently cancel E2E coverage. It ALWAYS exits 0 — with one deliberate
// exception: a missing GITHUB_OUTPUT exits 2, because with no output written
// the suite would skip anyway and a loud red is safer than a silent green.
// Otherwise a red guard step would hide the suite exactly like a wrongful
// skip does.
//
// DECISION TABLE
//   (A) exit 0, stdout is a JSON array, [0].sha is a string
//         -> compare to DEPLOY_SHA: match => run=true (::notice::), else
//            run=false (::notice::Skipping — a genuinely superseded deploy).
//   (B) exit 0, stdout is an empty JSON array
//         -> run=true (::notice::no deployments recorded — proceeding).
//   (C) exit != 0, OR stdout isn't a JSON array (error object, invalid JSON,
//       a spawn error/timeout), OR a required env var is missing
//         -> run=true (::warning::), quoting the exit code and at most 200
//            chars of the response body/stderr. Never prints the token.
//   (D) EVENT_NAME is set to anything other than "deployment_status" (a
//       workflow_dispatch / repository_dispatch run)
//         -> run=true (::notice::): the guard only applies to
//            deployment_status, so an absent DEPLOY_SHA is normal there and
//            must not be reported as an API failure.
//
// SUPERSEDED IS NOT A FREE PASS (B621)
//   `run=false` used to be published the moment a newer deployment existed. Every later step
//   then skipped and the job still concluded `success`: across 40 deployment runs Playwright
//   completed ZERO times, and each was read as a pass. The guard now only publishes `run=false`
//   once a LATER E2E run is CONFIRMED to exist for the newest deployment (queued, in progress,
//   passed or failed: a run that was cancelled or skipped does not count, or the chain of
//   "someone later covers it" ends in nothing). It re-reads the newest deployment on every poll,
//   so a still-newer deploy simply retargets the check. Outcomes, on the `reason` output:
//     confirmed         -> run=false, notice cites the successor's run URL
//     newest            -> the polled-for deploy turned out to be this one: run=true
//     successor-failed  -> the newest deployment failed/errored and will never have a run:
//                          run=true (this sha's E2E runs against whatever is live)
//     unconfirmed       -> no later run within the window, or the API kept failing: run=false
//                          AND exit 3 (the job goes red; a green that ran no tests is worse).
//   The confirmation polls up to CI_E2E_SUCCESSOR_TIMEOUT_MS (default 10 min) every
//   CI_E2E_SUCCESSOR_INTERVAL_MS (default 15 s). An API error, empty or malformed body while
//   confirming counts as "not confirmed yet" (fail CLOSED); only the first newest-deployment read
//   above still fails open, because that path runs the suite instead of skipping it.
//
// USAGE (invoked by .github/workflows/ci.yml's `freshness` step)
//   GITHUB_OUTPUT=... DEPLOY_SHA=... GITHUB_REPOSITORY=... GH_TOKEN=... \
//     EVENT_NAME=... node scripts/ci-freshness-guard.mjs
//
// TEST-ONLY OVERRIDES (never set these in a real CI run — see
// apps/api/src/common/ci-freshness-guard-script.spec.ts)
//   CI_FRESHNESS_GH_CMD          JSON array of argv, e.g.
//                                '["node","/tmp/fake-gh.mjs"]', replacing the
//                                real `gh api ...` invocation entirely so
//                                specs can drive a fake with no network.
//   CI_FRESHNESS_GH_TIMEOUT_MS   Bounds the `gh api` call (default 30000ms).
//   CI_FRESHNESS_VIRTUAL_CLOCK   "1" = the successor-confirmation window runs on a virtual clock
//                                that advances only by the polling sleeps (no real waiting).

import { spawnSync } from "node:child_process";
import fs from "node:fs";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BODY_CHARS = 200;
const MAX_BUFFER = 10 * 1024 * 1024; // 10 MiB

function appendOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) {
    // The one case where failing LOUDLY is safer than exiting 0: with no
    // output written every steps.freshness.outputs.run consumer skips and the
    // job reports green with zero E2E coverage.
    console.error(
      "::error::GITHUB_OUTPUT is not set — the guard cannot publish `run`, and a missing output makes every consumer skip the suite (silent green); refusing to exit 0",
    );
    process.exit(2);
  }
  fs.appendFileSync(file, `${name}=${value}\n`);
}

// Collapses whitespace and caps length — used only on response bodies/error
// text, never on the token, so quoting it in a log line is safe.
function truncate(text, max) {
  if (!text) return "(empty)";
  const oneLine = String(text).replace(/\s+/g, " ").trim();
  if (!oneLine) return "(empty)";
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

function ghCommand(endpoint) {
  const overrideRaw = process.env.CI_FRESHNESS_GH_CMD;
  if (overrideRaw) {
    // Test-only — see the header comment. The endpoint is appended so a fake can answer per URL.
    const argv = JSON.parse(overrideRaw);
    return { cmd: argv[0], args: [...argv.slice(1), endpoint] };
  }
  return { cmd: "gh", args: ["api", endpoint] };
}

// One `gh api` read. Returns { ok: true, json } or { ok: false, why } — never throws.
function ghApi(endpoint) {
  const timeoutMs = Number(process.env.CI_FRESHNESS_GH_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  const { cmd, args } = ghCommand(endpoint);
  const r = spawnSync(cmd, args, {
    shell: false,
    timeout: timeoutMs,
    maxBuffer: MAX_BUFFER,
    env: process.env,
    encoding: "utf8",
  });
  if (r.error) return { ok: false, why: truncate(r.error.message, MAX_BODY_CHARS) };
  if (r.status !== 0) {
    return {
      ok: false,
      why: `exit ${r.status}: ${truncate(r.stdout || r.stderr, MAX_BODY_CHARS)}`,
    };
  }
  try {
    return { ok: true, json: JSON.parse(r.stdout) };
  } catch {
    return { ok: false, why: `unparseable response: ${truncate(r.stdout, MAX_BODY_CHARS)}` };
  }
}

// Clock seam (test-only, off by default). With CI_FRESHNESS_VIRTUAL_CLOCK=1 the confirmation window is
// measured in VIRTUAL time that only advances by the sleeps the loop asks for, so how many polls fit
// in CI_E2E_SUCCESSOR_TIMEOUT_MS depends on the intervals, never on how fast the machine spawns `gh`.
// Unset (every real CI run) it is the real Date.now() and a real sleep, exactly as before.
const VIRTUAL_CLOCK = process.env.CI_FRESHNESS_VIRTUAL_CLOCK === "1";
let virtualNow = 0;
const now = () => (VIRTUAL_CLOCK ? virtualNow : Date.now());

function sleep(ms) {
  if (VIRTUAL_CLOCK) {
    virtualNow += ms;
    return;
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// A run that IS (or did) actually exercise the suite. cancelled/skipped/neutral do NOT count, and
// (#1134 Opus item 1) neither does `queued`/`waiting`/`requested`/`pending`: the e2e job's per-SHA
// concurrency group has cancel-in-progress, so a run that has not started can still be cancelled by a
// later echo of the same deployment and never exercise anything.
const LIVE_CONCLUSIONS = new Set(["success", "failure", "timed_out"]);
const isLiveRun = (r) =>
  !!r &&
  (r.status === "in_progress" || (r.status === "completed" && LIVE_CONCLUSIONS.has(r.conclusion)));

// #1134 Opus item 4: "the newest deployment" means the newest one of THIS deployment's environment,
// so a deployment to another environment can never supersede it. DEPLOY_ENV comes from
// `github.event.deployment.environment`; when it is absent (not a deployment event) no filter is
// invented.
function deploymentsEndpoint(repo) {
  const env = process.env.DEPLOY_ENV;
  return `repos/${repo}/deployments?per_page=1${env ? `&environment=${encodeURIComponent(env)}` : ""}`;
}

// One look at the world. Returns { kind: "newest" | "confirmed" | "failed" | "wait", ... }.
function pollSuccessor(repo, deploySha) {
  const dep = ghApi(deploymentsEndpoint(repo));
  if (!dep.ok) return { kind: "wait", why: `deployments read failed: ${dep.why}` };
  const top = Array.isArray(dep.json) ? dep.json[0] : null;
  if (!top || typeof top.sha !== "string")
    return { kind: "wait", why: "deployments read was empty or malformed" };
  if (top.sha === deploySha) return { kind: "newest", sha: top.sha };

  const runs = ghApi(
    `repos/${repo}/actions/workflows/ci.yml/runs?event=deployment_status&head_sha=${top.sha}&per_page=20`,
  );
  if (!runs.ok) return { kind: "wait", sha: top.sha, why: `runs read failed: ${runs.why}` };
  if (!runs.json || !Array.isArray(runs.json.workflow_runs)) {
    return { kind: "wait", sha: top.sha, why: "runs read was malformed" };
  }
  const live = runs.json.workflow_runs.find(isLiveRun);
  if (live) return { kind: "confirmed", sha: top.sha, url: String(live.html_url ?? live.id) };

  // The status HISTORY (newest first). Opus 7ec75f57: "is the successor live?" is ANY `success` in it,
  // not the newest status alone: a redeploy of the same sha goes in_progress again while the earlier
  // success still serves, and a live deployment can be flipped to `inactive`.
  const st = ghApi(`repos/${repo}/deployments/${top.id}/statuses?per_page=100`);
  const history = st.ok && Array.isArray(st.json) ? st.json : null;
  const state = history && history[0] ? String(history[0].state) : null;
  const everLive = history ? history.some((h) => h && h.state === "success") : null;
  // A failed REDEPLOY over an earlier success leaves that first build serving: not "never gets a run".
  if ((state === "failure" || state === "error") && everLive === false)
    return { kind: "failed", sha: top.sha, state };
  // Opus fad6aa19 finding 2: every deployed sha carries one completed/`skipped` run (the
  // deployment_status `in_progress` echo, all jobs gated off). It is not an E2E attempt, so it never
  // counts as "the successor has runs"; only a real attempt (queued, cancelled, ...) does.
  const attempts = runs.json.workflow_runs.filter(
    (r) => !(r && r.status === "completed" && r.conclusion === "skipped"),
  );
  const rerun = attempts.find((r) => r && r.status === "completed" && r.html_url);
  return {
    kind: "wait",
    sha: top.sha,
    seen: attempts.length,
    state,
    everLive,
    rerunUrl: rerun ? String(rerun.html_url) : null,
    why: `no live E2E run for ${top.sha} yet (${attempts.length} E2E attempt(s), none live; deployment state ${state ?? "unknown"})`,
  };
}

function confirmSuccessor(repo, deploySha) {
  const timeoutMs = Number(process.env.CI_E2E_SUCCESSOR_TIMEOUT_MS) || 10 * 60_000;
  const intervalMs = Number(process.env.CI_E2E_SUCCESSOR_INTERVAL_MS) || 15_000;
  const deadline = now() + timeoutMs;
  let last = { kind: "wait", why: "never polled" };
  for (;;) {
    last = pollSuccessor(repo, deploySha);
    if (last.kind !== "wait" || now() >= deadline) return last;
    console.log(`::notice::superseded, waiting for a later E2E run: ${last.why}`);
    sleep(intervalMs);
  }
}

function failOpen(reason) {
  console.log(
    `::warning::Could not read the newest deployment (${reason}) — proceeding rather than skipping`,
  );
  appendOutput("run", "true");
  return 0;
}

function main() {
  const deploySha = process.env.DEPLOY_SHA;
  const repo = process.env.GITHUB_REPOSITORY;
  const eventName = process.env.EVENT_NAME;

  // A dispatch run carries no deployment, so an empty DEPLOY_SHA is expected
  // there — ::warning:: stays reserved for a genuine API/permission failure.
  if (eventName && eventName !== "deployment_status") {
    console.log(
      `::notice::${eventName} run — the freshness guard only applies to deployment_status; proceeding`,
    );
    appendOutput("run", "true");
    return 0;
  }

  if (!deploySha) {
    return failOpen("DEPLOY_SHA is not set");
  }
  if (!repo) {
    return failOpen("GITHUB_REPOSITORY is not set");
  }

  const first = ghApi(deploymentsEndpoint(repo));
  if (!first.ok) return failOpen(first.why);
  const parsed = first.json;
  if (!Array.isArray(parsed)) {
    return failOpen(
      `response was not a JSON array: ${truncate(JSON.stringify(parsed), MAX_BODY_CHARS)}`,
    );
  }

  if (parsed.length === 0) {
    console.log("::notice::no deployments recorded — proceeding");
    appendOutput("run", "true");
    return 0;
  }

  const latest = parsed[0] && typeof parsed[0].sha === "string" ? parsed[0].sha : null;
  if (!latest) {
    return failOpen(
      `newest deployment entry has no sha: ${truncate(JSON.stringify(parsed[0]), MAX_BODY_CHARS)}`,
    );
  }

  if (latest === deploySha) {
    console.log(`::notice::newest deployment ${latest} matches`);
    appendOutput("run", "true");
    return 0;
  }

  console.log(
    `::notice::deployment ${deploySha} is superseded by ${latest}; confirming a later E2E run exists`,
  );
  const v = confirmSuccessor(repo, deploySha);
  if (v.kind === "confirmed") {
    console.log(`::notice::Skipping (confirmed): E2E for ${v.sha} exists at ${v.url}`);
    appendOutput("reason", "confirmed");
    appendOutput("run", "false");
    return 0;
  }
  if (v.kind === "newest") {
    console.log(`::notice::${deploySha} is the newest deployment after all; running`);
    appendOutput("reason", "newest");
    appendOutput("run", "true");
    return 0;
  }
  if (v.kind === "failed") {
    console.log(
      `::notice::The newer deployment ${v.sha} ended in state "${v.state}" and will never have an E2E run; running E2E for ${deploySha} against whatever is live instead of skipping`,
    );
    appendOutput("reason", "successor-failed");
    appendOutput("run", "true");
    return 0;
  }
  // `everLive === false` only: `true` = the successor is (or was) live; `null` = the statuses read
  // failed, which fails CLOSED to the red below like every other API error while confirming.
  if (v.kind === "wait" && v.seen > 0 && v.everLive === false) {
    // #1134 Opus item 2: the successor HAS real E2E attempts, but none is exercising the suite by the
    // deadline (cancelled, or still only queued), AND its deployment is not live yet, so this sha may
    // well be what production still serves. Failing would leave a permanent red; skipping would be
    // the silent green B621 exists to stop. So run E2E here and say so. (Once the successor IS live,
    // this sha's suite would only wait out the readiness gate against the newer commit and go red
    // late (Opus fad6aa19 finding 1), so that case stays the red below, naming the run to re-run.)
    console.log(
      `::notice::The newer deployment ${v.sha} has ${v.seen} E2E run(s) but none is exercising the suite (${v.why}); running E2E for ${deploySha} against whatever is live instead of failing or skipping`,
    );
    appendOutput("reason", "successor-unconfirmed");
    appendOutput("run", "true");
    return 0;
  }
  const rerunHint =
    v.kind === "wait" && v.rerunUrl
      ? ` Re-run the newest deployment's E2E: ${v.rerunUrl}`
      : " Re-run E2E for the newest deployment.";
  console.log(
    `::error::Superseded by ${latest} but NO E2E run was confirmed for the newest deployment (${v.why}). Failing instead of reporting a green that ran no tests.${rerunHint}`,
  );
  appendOutput("reason", "unconfirmed");
  appendOutput("run", "false");
  return 3; // deliberate: not 1, which is what an uncaught crash exits with
}

process.exit(main());
