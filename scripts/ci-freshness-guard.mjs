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

function ghCommand(repo) {
  const overrideRaw = process.env.CI_FRESHNESS_GH_CMD;
  if (overrideRaw) {
    // Test-only — see the header comment.
    const argv = JSON.parse(overrideRaw);
    return { cmd: argv[0], args: argv.slice(1) };
  }
  return { cmd: "gh", args: ["api", `repos/${repo}/deployments?per_page=1`] };
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

  const timeoutMs = Number(process.env.CI_FRESHNESS_GH_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  const { cmd, args } = ghCommand(repo);

  const result = spawnSync(cmd, args, {
    shell: false,
    timeout: timeoutMs,
    maxBuffer: MAX_BUFFER,
    env: process.env,
    encoding: "utf8",
  });

  if (result.error) {
    return failOpen(
      `exit ${result.status ?? "n/a"}: ${truncate(result.error.message, MAX_BODY_CHARS)}`,
    );
  }

  if (result.status !== 0) {
    return failOpen(
      `exit ${result.status}: ${truncate(result.stdout || result.stderr, MAX_BODY_CHARS)}`,
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return failOpen(
      `exit ${result.status}: unparseable response: ${truncate(result.stdout, MAX_BODY_CHARS)}`,
    );
  }

  if (!Array.isArray(parsed)) {
    return failOpen(
      `exit ${result.status}: response was not a JSON array: ${truncate(result.stdout, MAX_BODY_CHARS)}`,
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
      `exit ${result.status}: newest deployment entry has no sha: ${truncate(result.stdout, MAX_BODY_CHARS)}`,
    );
  }

  if (latest === deploySha) {
    console.log(`::notice::newest deployment ${latest} matches`);
    appendOutput("run", "true");
    return 0;
  }

  console.log(`::notice::Skipping — deployment ${deploySha} is superseded by ${latest}`);
  appendOutput("run", "false");
  return 0;
}

process.exit(main());
