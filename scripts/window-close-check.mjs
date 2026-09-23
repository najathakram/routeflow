#!/usr/bin/env node
// Window-close gate — proves a public CI window is safe to close BEFORE the
// private flip (docs/runbooks/deploy-visibility-flip.md).
//
// WHY THIS EXISTS
// On the night of 2026-09-22, PR #1262 (f894d974) landed on master, its
// Railway deployment FAILED, and the API kept serving the previous commit
// (cb88378f) — but nothing checked that before the repo flipped back private,
// so the failed deploy sat unnoticed for about 90 minutes. A second hole let a
// PR merge without containing master's tip (see
// scripts/pre-merge-ancestry-check.mjs, the sibling gate for that). This
// script closes the first hole: it re-derives, from GitHub's own record, that
// EVERY commit pushed to master during the window actually deployed
// successfully (or legitimately didn't need to), that the prod API is
// currently serving the newest commit that DID need to deploy, and that CI's
// own verdict on master's tip is a real result rather than a skip or the
// known ~2s "billing-block" artifact (see scripts/ci-freshness-guard.mjs and
// docs/runbooks/deploy-visibility-flip.md's retirement checklist: "a 0-step
// green is still the billing block, not proof it's fixed").
//
// UNLIKE ci-freshness-guard.mjs, THIS IS A CLOSE GATE, NOT AN OPEN GATE: a
// `gh api` failure, a timeout, an unreachable prod URL, or a commit whose
// deploy status cannot be read is a REFUSAL to close the window (exit
// non-zero), never a silent pass. Reuses ci-freshness-guard.mjs's
// `spawnGhJson`/`truncate` for the mechanical "spawn gh, parse JSON safely"
// step rather than re-implementing it — only the open/closed VERDICT differs.
//
// ALGORITHM (see CLAUDE.md "Canonical deploy flow" for the routine this gate
// slots into, and docs/runbooks/deploy-visibility-flip.md step 3)
//   (a) `git fetch origin master`, then list the first-parent commits on
//       origin/master in (--since, HEAD].
//   (b) Classify each commit "deploying" or "docs-only" against the UNION of
//       apps/api/railway.toml's and apps/web/railway.toml's `watchPatterns` —
//       read from those files at runtime, never hardcoded (Railway skips a
//       push that touches neither service's watched paths, so no GitHub
//       deployment is ever created for it — see KNOWN TRAPS below).
//   (c) For each deploying sha, require a `success` somewhere in its
//       deployment's status history (read the whole history — Railway's
//       `success -> inactive` transition a few seconds later is not a
//       failure, see the runbook). Missing deployment or no `success` in the
//       history fails the gate.
//   (d) The prod `/api/v1/health` response's `commit` must equal the NEWEST
//       deploying sha in the window — not necessarily master's HEAD, since
//       the window can close on a docs-only commit that deployed nothing new.
//   (e) The latest CI ("CI" workflow) run whose `head_sha` is master's FINAL
//       sha must be a real `success`: `status: completed`, `conclusion:
//       success`, AND at least one job with a non-empty `steps` array (the
//       billing-block artifact reports a conclusion with zero recorded
//       steps — see the module comment above).
//   (f) Print a markdown table (sha, subject, deploying?, deploy status, CI)
//       plus the raw served commit / master head / newest-deploying-sha next
//       to the verdict, then exit 0 only if every check above passed.
//
// KNOWN TRAPS (verified against this repo's real history — see the PROVE
// section of the tooling task this script shipped for)
//   - `gh api repos/<r>/deployments?sha=<sha>` needs the FULL 40-char sha to
//     filter server-side and silently returns nothing useful otherwise; this
//     script instead lists the latest deployments UNFILTERED and matches the
//     full sha client-side.
//   - Railway posts ONE GitHub deployment per push, to the single
//     "routeflow / production" environment, regardless of how many services
//     (api/web) it touches — never assume one deployment per service.
//   - A deployment's status history goes in_progress -> success -> inactive
//     ~3s later; `inactive` is not a failure, only the terminal echo of a
//     deploy this script already saw succeed. Read the WHOLE history.
//
// USAGE
//   node scripts/window-close-check.mjs --since <sha> [--base-url <url>]
//     [--repo <owner/name>]
//   --since     required. The master sha the public window opened FROM
//               (exclusive) — usually the sha the previous close-check (or
//               the last private flip) last verified.
//   --base-url  default https://routeflowapi-production.up.railway.app
//   --repo      default najathakram/routeflow
//
// TEST-ONLY OVERRIDES (never set these for a real run — see
// apps/api/src/common/window-close-check-script.spec.ts)
//   WINDOW_CLOSE_GH_CMD          JSON array of argv, e.g.
//                                '["node","/tmp/fake-gh.mjs"]', replacing
//                                every `gh api ...` invocation this script
//                                makes with a fake driver — no network, no
//                                real token.
//   WINDOW_CLOSE_GH_TIMEOUT_MS   Bounds each `gh` call (default 30000ms).

import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { pathToFileURL } from "node:url";
import {
  spawnGhJson,
  truncate,
  MAX_BODY_CHARS,
  DEFAULT_TIMEOUT_MS,
} from "./ci-freshness-guard.mjs";

const DEFAULT_REPO = "najathakram/routeflow";
const DEFAULT_BASE_URL = "https://routeflowapi-production.up.railway.app";
const HTTP_TIMEOUT_MS = Number(process.env.WINDOW_CLOSE_HTTP_TIMEOUT_MS || 20_000);
const GIT_TIMEOUT_MS = 30_000;

// ── argv ───────────────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const args = { since: null, baseUrl: DEFAULT_BASE_URL, repo: DEFAULT_REPO };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--since") args.since = argv[++i];
    else if (a.startsWith("--since=")) args.since = a.slice("--since=".length);
    else if (a === "--base-url") args.baseUrl = argv[++i];
    else if (a.startsWith("--base-url=")) args.baseUrl = a.slice("--base-url=".length);
    else if (a === "--repo") args.repo = argv[++i];
    else if (a.startsWith("--repo=")) args.repo = a.slice("--repo=".length);
  }
  return args;
}

// ── glob-vs-path matching (railway.toml watchPatterns) ──────────────────────

// Railway's own patterns are simple `dir/**` globs — no need for a full glob
// engine, just `**` -> "anything" and `*` -> "anything but a path separator".
export function globToRegExp(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const withDoubleStar = escaped.replace(/\*\*/g, "\u0000");
  const withSingleStar = withDoubleStar.replace(/\*/g, "[^/]*");
  const restored = withSingleStar.replace(/\u0000/g, ".*");
  return new RegExp(`^${restored}$`);
}

/** Reads `watchPatterns = [...]` out of a railway.toml — regex, not a TOML
 *  parser, because every pattern here is a flat array of quoted strings and
 *  this repo has no TOML dependency to reach for instead. */
export function readWatchPatterns(tomlPath) {
  if (!existsSync(tomlPath)) return [];
  const text = readFileSync(tomlPath, "utf8");
  const match = text.match(/watchPatterns\s*=\s*\[([^\]]*)\]/);
  if (!match) return [];
  return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/** The union of every service's watchPatterns, derived at runtime — never
 *  hardcoded, per CLAUDE.md's "Prisma schema is a FOLDER" spirit of reading
 *  the source of truth instead of restating it. */
export function loadDeployPatterns(repoRoot) {
  const api = readWatchPatterns(`${repoRoot}/apps/api/railway.toml`);
  const web = readWatchPatterns(`${repoRoot}/apps/web/railway.toml`);
  return [...new Set([...api, ...web])];
}

export function isDeployingCommit(changedFiles, patterns) {
  const regexes = patterns.map(globToRegExp);
  return changedFiles.some((f) => regexes.some((re) => re.test(f)));
}

// ── git plumbing ─────────────────────────────────────────────────────────────

function git(repoRoot, args) {
  const res = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
    env: process.env,
  });
  if (res.error || res.status !== 0) {
    return { ok: false, reason: (res.stderr || res.error?.message || "unknown git error").trim() };
  }
  return { ok: true, stdout: res.stdout };
}

/** First-parent commits in (since, head], oldest first, each with its
 *  changed-file list (diffed against its first parent, so a merge commit is
 *  handled the same as a plain one). */
export function commitsInWindow(repoRoot, since, head) {
  const log = git(repoRoot, [
    "log",
    "--first-parent",
    "--format=%H%x1f%s",
    "--reverse",
    `${since}..${head}`,
  ]);
  if (!log.ok) return { ok: false, reason: `git log failed: ${log.reason}` };
  const lines = log.stdout.split("\n").filter(Boolean);
  const commits = [];
  for (const line of lines) {
    const [sha, subject] = line.split("\x1f");
    const diff = git(repoRoot, ["diff", "--name-only", `${sha}^`, sha]);
    if (!diff.ok) return { ok: false, reason: `git diff failed for ${sha}: ${diff.reason}` };
    const files = diff.stdout.split("\n").filter(Boolean);
    commits.push({ sha, subject, files });
  }
  return { ok: true, commits };
}

// ── gh api calls (fail CLOSED — this is a close gate, unlike ci-freshness-guard.mjs) ──

function ghArgv() {
  const overrideRaw = process.env.WINDOW_CLOSE_GH_CMD;
  if (overrideRaw) {
    const argv = JSON.parse(overrideRaw);
    return { cmd: argv[0], args: argv.slice(1) };
  }
  return { cmd: "gh", args: [] };
}

function timeoutMs() {
  return Number(process.env.WINDOW_CLOSE_GH_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
}

function ghApi(path) {
  const { cmd, args } = ghArgv();
  return spawnGhJson(cmd, [...args, "api", path], timeoutMs());
}

/** Latest deployments, UNFILTERED (never `?sha=` — see KNOWN TRAPS), matched
 *  client-side against a full 40-char sha. */
export function findDeployment(deployments, sha) {
  return deployments.find((d) => d && d.sha === sha) || null;
}

export function hasSuccessInHistory(statuses) {
  return Array.isArray(statuses) && statuses.some((s) => s && s.state === "success");
}

/** The billing-block artifact: a run with SOME conclusion (often "success" —
 *  see the runbook's retirement checklist: "a 0-step green is still the
 *  billing block") whose job(s) recorded zero actual steps. A real run always
 *  has at least one job with at least one step. */
export function isBillingBlockJobs(jobsPayload) {
  const jobs = Array.isArray(jobsPayload?.jobs) ? jobsPayload.jobs : null;
  if (!jobs || jobs.length === 0) return true;
  return jobs.every((j) => !Array.isArray(j.steps) || j.steps.length === 0);
}

// ── http (prod /health) — node's http/https, not fetch: fetch's default
// undici keep-alive socket is a known hang/crash risk on this Windows dev box
// (see scripts/release-health.mjs's sentryGet for the same fix). agent:false
// opens one non-pooled socket per request and closes it as soon as the
// response ends. ──────────────────────────────────────────────────────────

export function httpGetJson(url) {
  return new Promise((resolve) => {
    let target;
    try {
      target = new URL(url);
    } catch (e) {
      resolve({ ok: false, reason: `invalid URL: ${e.message}` });
      return;
    }
    const client = target.protocol === "https:" ? https : http;
    const req = client.get(target, { agent: false, timeout: HTTP_TIMEOUT_MS }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        const status = res.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          resolve({ ok: false, reason: `HTTP ${status}: ${truncate(body, MAX_BODY_CHARS)}` });
          return;
        }
        try {
          resolve({ ok: true, json: JSON.parse(body) });
        } catch {
          resolve({ ok: false, reason: `unparseable response: ${truncate(body, MAX_BODY_CHARS)}` });
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error(`request timed out after ${HTTP_TIMEOUT_MS}ms`)));
    req.on("error", (error) => resolve({ ok: false, reason: error.message }));
  });
}

// ── the verdict — pure, given everything already fetched ───────────────────

/**
 * Combines every fetched fact into the final table + failure list. Takes
 * plain data (no network, no git) so it is directly unit-testable against
 * fixture payloads — mirrors scripts/release-health.mjs's `buildComparison`.
 *
 * `commits`: [{ sha, subject, deploying, deployStatus }] — deployStatus is
 *   one of "success" | "failure" | "missing" | null (null for docs-only).
 * `served`: { ok, commit?, reason? } — the /health read.
 * `newestDeploying`: sha string | null.
 * `ci`: { ok, run?, reason? } — the CI-run verdict for master's final sha.
 */
export function buildVerdict({ commits, served, newestDeploying, masterHead, ci }) {
  const failures = [];

  for (const c of commits) {
    if (!c.deploying) continue;
    if (c.deployStatus === "missing") {
      failures.push(`${c.sha.slice(0, 8)} (${c.subject}) — no GitHub deployment record found`);
    } else if (c.deployStatus === "failure") {
      failures.push(
        `${c.sha.slice(0, 8)} (${c.subject}) — deploy FAILED (no success in status history)`,
      );
    } else if (c.deployStatus !== "success") {
      failures.push(
        `${c.sha.slice(0, 8)} (${c.subject}) — could not read deploy status: ${c.deployStatus}`,
      );
    }
  }

  if (newestDeploying) {
    if (!served.ok) {
      failures.push(`prod /health unreadable: ${served.reason}`);
    } else if (served.commit !== newestDeploying) {
      failures.push(
        `served commit ${served.commit?.slice(0, 8) ?? "(none)"} does not match the newest deploying sha ${newestDeploying.slice(0, 8)}`,
      );
    }
  }

  if (!ci.ok) {
    failures.push(`CI on master HEAD ${masterHead.slice(0, 8)}: ${ci.reason}`);
  }

  return { failures, pass: failures.length === 0 };
}

export function formatTable(commits) {
  const header = "| sha | subject | deploying? | deploy status | CI |";
  const sep = "|---|---|---|---|---|";
  const rows = commits.map((c) => {
    const deployStatus = c.deploying ? (c.deployStatus ?? "unknown") : "n/a (docs-only)";
    return `| ${c.sha.slice(0, 8)} | ${c.subject.replace(/\|/g, "\\|")} | ${c.deploying ? "yes" : "no"} | ${deployStatus} | ${c.ci ?? ""} |`;
  });
  return [header, sep, ...rows].join("\n");
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.since) {
    console.error(
      "usage: window-close-check.mjs --since <sha> [--base-url <url>] [--repo <owner/name>]",
    );
    return 1;
  }

  const repoRoot = process.cwd();

  const fetchRes = spawnSync("git", ["fetch", "origin", "master"], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
    env: process.env,
  });
  if (fetchRes.error || fetchRes.status !== 0) {
    console.error(
      `FAIL: git fetch origin master failed: ${(fetchRes.stderr || fetchRes.error?.message || "unknown error").trim()}`,
    );
    return 1;
  }

  const headRes = git(repoRoot, ["rev-parse", "origin/master"]);
  if (!headRes.ok) {
    console.error(`FAIL: could not resolve origin/master: ${headRes.reason}`);
    return 1;
  }
  const masterHead = headRes.stdout.trim();

  const windowRes = commitsInWindow(repoRoot, args.since, "origin/master");
  if (!windowRes.ok) {
    console.error(`FAIL: ${windowRes.reason}`);
    return 1;
  }

  const patterns = loadDeployPatterns(repoRoot);
  const commits = windowRes.commits.map((c) => ({
    ...c,
    deploying: isDeployingCommit(c.files, patterns),
  }));

  console.log(
    `Window: (${args.since}, ${masterHead}] — ${commits.length} commit(s), repo ${args.repo}`,
  );
  console.log(`watchPatterns (union of api+web): ${JSON.stringify(patterns)}`);

  if (commits.length === 0) {
    console.log("No commits in window — nothing to verify.");
    console.log(formatTable([]));
    return 0;
  }

  // (c) deployment status per deploying commit — fetch the deployment list ONCE, unfiltered.
  const deploymentsRes = ghApi(`repos/${args.repo}/deployments?per_page=100`);
  let deployments = [];
  let deploymentsError = null;
  if (!deploymentsRes.ok) {
    deploymentsError = deploymentsRes.reason;
  } else if (!Array.isArray(deploymentsRes.json)) {
    deploymentsError = `deployments response was not a JSON array: ${truncate(JSON.stringify(deploymentsRes.json), MAX_BODY_CHARS)}`;
  } else {
    deployments = deploymentsRes.json;
  }

  for (const c of commits) {
    if (!c.deploying) {
      c.deployStatus = null;
      continue;
    }
    if (deploymentsError) {
      c.deployStatus = `unreadable (${deploymentsError})`;
      continue;
    }
    const deployment = findDeployment(deployments, c.sha);
    if (!deployment) {
      c.deployStatus = "missing";
      continue;
    }
    const statusesRes = ghApi(
      `repos/${args.repo}/deployments/${deployment.id}/statuses?per_page=20`,
    );
    if (!statusesRes.ok || !Array.isArray(statusesRes.json)) {
      c.deployStatus = `unreadable (${statusesRes.ok ? "not an array" : statusesRes.reason})`;
      continue;
    }
    c.deployStatus = hasSuccessInHistory(statusesRes.json) ? "success" : "failure";
  }

  // (d) served commit vs the newest deploying sha in the window.
  const deployingCommits = commits.filter((c) => c.deploying);
  const newestDeploying = deployingCommits.length
    ? deployingCommits[deployingCommits.length - 1].sha
    : null;
  let served = { ok: true, commit: null };
  if (newestDeploying) {
    served = await httpGetJson(`${args.baseUrl.replace(/\/+$/, "")}/api/v1/health`);
    if (served.ok) served = { ok: true, commit: served.json?.commit ?? null };
  }

  // (e) CI on master's final sha — real success, not a skip or a billing-block artifact.
  let ci = { ok: false, reason: "not checked" };
  const runsRes = ghApi(`repos/${args.repo}/actions/runs?head_sha=${masterHead}&per_page=20`);
  if (!runsRes.ok) {
    ci = { ok: false, reason: `could not list workflow runs: ${runsRes.reason}` };
  } else {
    const runs = Array.isArray(runsRes.json?.workflow_runs) ? runsRes.json.workflow_runs : null;
    if (!runs) {
      ci = {
        ok: false,
        reason: `runs response missing workflow_runs array: ${truncate(JSON.stringify(runsRes.json), MAX_BODY_CHARS)}`,
      };
    } else {
      const ciRuns = runs
        .filter((r) => r && r.name === "CI")
        .sort((a, b) => new Date(b.created_at ?? 0) - new Date(a.created_at ?? 0));
      if (ciRuns.length === 0) {
        ci = { ok: false, reason: `no "CI" workflow run found for head_sha ${masterHead}` };
      } else {
        const run = ciRuns[0];
        if (run.status !== "completed" || run.conclusion !== "success") {
          ci = {
            ok: false,
            reason: `run ${run.id} is not a real success (status=${run.status}, conclusion=${run.conclusion})`,
          };
        } else {
          const jobsRes = ghApi(`repos/${args.repo}/actions/runs/${run.id}/jobs`);
          if (!jobsRes.ok) {
            ci = { ok: false, reason: `could not read jobs for run ${run.id}: ${jobsRes.reason}` };
          } else if (isBillingBlockJobs(jobsRes.json)) {
            ci = {
              ok: false,
              reason: `run ${run.id} looks like the billing-block artifact (0 steps recorded)`,
            };
          } else {
            ci = { ok: true, run };
          }
        }
      }
    }
  }

  for (const c of commits) {
    c.ci = c.sha === masterHead ? (ci.ok ? "success" : "FAIL") : "";
  }

  const verdict = buildVerdict({ commits, served, newestDeploying, masterHead, ci });

  console.log("");
  console.log(formatTable(commits));
  console.log("");
  console.log(`master head:            ${masterHead}`);
  console.log(`newest deploying sha:   ${newestDeploying ?? "(none in window)"}`);
  console.log(
    `served commit (/health): ${served.ok ? (served.commit ?? "(none)") : `unreadable: ${served.reason}`}`,
  );
  console.log("");

  if (verdict.pass) {
    console.log("PASS: window-close-check — safe to flip private.");
    return 0;
  }

  console.log("FAIL: window-close-check — DO NOT flip private yet:");
  for (const f of verdict.failures) console.log(`  - ${f}`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => {
    process.exitCode = code;
  });
}
