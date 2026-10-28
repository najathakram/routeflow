#!/usr/bin/env node
// Reports how many lines a PR changes, by the one counting rule in scripts/lib/pr-size.mjs
// (lockfiles, fixtures, snapshots, generated code and bookkeeping ledgers are excluded).
//
//   node scripts/pr-size.mjs [--repo <dir>] [--base <ref>] [--json] [--github]
//   node scripts/pr-size.mjs --pr <n> [--json] [--github]
//   node scripts/pr-size.mjs --since <YYYY-MM-DD> [--json]
//
// default   numstat of merge-base(<ref>, HEAD)..HEAD (<ref> default origin/master) plus the risk class of
//           the touched paths (a diff of only docs/e2e, class green, is ok at any size).
// --pr      the same rule over gh's `files` for PR <n>; no checkout needed.
// --since   blast-radius report for the enforcing flip: counted-line distribution over every PR merged
//           since the date (7-day gh slices; a slice at the gh limit fails loudly), would-warn and
//           would-block counts, and the would-block PRs listed.
// --github  also print a `::warning::` annotation for warn / block / warn-override (CI).
// Override: a `PR-Size-Override: <reason>` trailer on the HEAD commit turns block into warn-override.
//
// Mode: PR_SIZE_MODE in lib/pr-size.mjs. Dark (today) exits 0 whatever the size; enforced exits 1 on
// `block` without an override. Exit 2 = bad usage or a git/gh failure, in either mode.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scrubbedGitEnv } from "./lib/check-git-hooks.mjs";
import * as riskLib from "./lib/risk-paths.mjs";
import {
  PR_SIZE_MODE,
  WARN_AT,
  countLines,
  parseNumstatZ,
  parseOverride,
  rowsFromGhFiles,
  sizeVerdict,
} from "./lib/pr-size.mjs";
import { classifyMax, diffSince, loadBaseLib } from "./risk-class.mjs";

const GH_REPO = "najathakram/routeflow";
const GIT_TIMEOUT_MS = 15000; // pre-push runs this: it must never hang
const GH_TIMEOUT_MS = 120000;
const SLICE_LIMIT = 100; // `files` makes each row heavy, so slices are small
const DAY_MS = 86_400_000;

const USAGE =
  "usage: pr-size.mjs [--repo <dir>] [--base <ref>] [--json] [--github] | --pr <n> [--json] [--github] | --since <YYYY-MM-DD> [--json]";

/** Strict parse; returns { error } for any unknown flag or missing value. */
export function parseArgs(argv) {
  const o = { repo: null, base: null, pr: null, since: null, json: false, github: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") o.json = true;
    else if (a === "--github") o.github = true;
    else if (["--base", "--repo", "--pr", "--since"].includes(a)) {
      const v = argv[++i];
      if (!v || v.startsWith("--")) return { error: `${a} needs a value` };
      o[a.slice(2)] = v;
    } else return { error: `unknown argument ${a}` };
  }
  if (o.pr !== null && !/^\d+$/.test(o.pr)) return { error: "--pr must be a PR number" };
  if (
    o.since !== null &&
    !(/^\d{4}-\d{2}-\d{2}$/.test(o.since) && Number.isFinite(Date.parse(o.since)))
  )
    return { error: "--since must be YYYY-MM-DD" };
  if (o.pr !== null && o.since !== null)
    return { error: "--pr and --since are mutually exclusive" };
  if ((o.pr !== null || o.since !== null) && o.base) return { error: "--base needs the git mode" };
  if (o.since !== null && o.github) return { error: "--github needs the git or --pr mode" };
  return o;
}

const gitIn = (repo) => (args) =>
  execFileSync("git", repo ? ["-C", repo, ...args] : args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: scrubbedGitEnv(),
    stdio: ["ignore", "pipe", "pipe"],
    timeout: GIT_TIMEOUT_MS,
  });

const ghRun = (args) =>
  execFileSync("gh", args, {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: GH_TIMEOUT_MS,
  });

/** The numbers for one change set, from numstat-style rows. */
function measure(rows, message) {
  const c = countLines(rows);
  const greenOnly =
    rows.length > 0 && riskLib.classifyDiff(rows.map((r) => r.path)).cls === "green";
  const override = parseOverride(message);
  return { ...c, greenOnly, override, verdict: sizeVerdict(c, { greenOnly, override }) };
}

function report(m, o, log) {
  if (o.json) log.log(JSON.stringify({ ...m, mode: PR_SIZE_MODE }));
  else {
    let line = `pr-size: ${m.counted} counted lines (${m.excluded} excluded) — ${m.verdict}`;
    if (m.override) line += ` (override: ${m.override})`;
    log.log(line);
    if (m.binary.length) log.log(`  binary, counted 0: ${m.binary.join(", ")}`);
  }
  if (o.github && m.verdict !== "ok")
    log.log(
      `::warning::pr-size: ${m.counted} counted lines (warn above ${WARN_AT}), ${m.verdict}${m.override ? `, override: ${m.override}` : ""}. Split the PR or add a PR-Size-Override trailer.`,
    );
}

async function gitMode(o, git) {
  const ref = o.base ?? "origin/master";
  const d = diffSince(git, ref);
  const rows = parseNumstatZ(git(["diff", "--numstat", "-z", "-M", `${d.base}..HEAD`]));
  const m = measure(rows, git(["log", "-1", "--format=%B"]));
  // The green exemption is judged with the rules at the base, so a diff cannot loosen them.
  let libs = [riskLib];
  try {
    const base = [await loadBaseLib(git, d.base), await loadBaseLib(git, ref)].filter(Boolean);
    if (base.length) libs = base;
  } catch {
    // keep the judge checkout's rules
  }
  m.greenOnly = d.files.length > 0 && classifyMax(libs, d.files).cls === "green";
  m.verdict = sizeVerdict(m, { greenOnly: m.greenOnly, override: m.override });
  return m;
}

function prMode(o, gh) {
  const j = JSON.parse(
    gh(["pr", "view", o.pr, "--repo", GH_REPO, "--json", "files,headRefOid,commits"]),
  );
  const last = (j.commits ?? []).at(-1) ?? {};
  return measure(
    rowsFromGhFiles(j.files),
    `${last.messageHeadline ?? ""}\n\n${last.messageBody ?? ""}`,
  );
}

const pct = (sorted, p) => (sorted.length ? sorted[Math.ceil(p * sorted.length) - 1] : 0);

function sinceMode(o, gh, now, limit) {
  const day = (ms) => new Date(ms).toISOString().slice(0, 10);
  const lastDay = Math.floor(now / DAY_MS) * DAY_MS;
  const byNumber = new Map();
  for (let from = Date.parse(o.since); from <= lastDay; from += 7 * DAY_MS) {
    const range = `${day(from)}..${day(Math.min(from + 6 * DAY_MS, lastDay))}`;
    const rows = JSON.parse(
      gh([
        "pr",
        "list",
        "--repo",
        GH_REPO,
        "--state",
        "merged",
        "--search",
        `merged:${range}`,
        "--json",
        "number,title,mergedAt,files",
        "--limit",
        String(limit),
      ]),
    );
    if (rows.length >= limit)
      throw new Error(`gh returned ${rows.length} PRs for merged:${range} (the limit): truncated`);
    for (const p of rows) byNumber.set(p.number, p);
  }
  const prs = [...byNumber.values()].map((p) => {
    const m = measure(rowsFromGhFiles(p.files), "");
    return { number: p.number, title: p.title, counted: m.counted, verdict: m.verdict };
  });
  const sizes = prs.map((p) => p.counted).sort((a, b) => a - b);
  const mid = sizes.length >> 1;
  const median = !sizes.length
    ? 0
    : sizes.length % 2
      ? sizes[mid]
      : (sizes[mid - 1] + sizes[mid]) / 2;
  const blockPrs = prs
    .filter((p) => p.verdict === "block")
    .map(({ number, title, counted }) => ({ number, title, counted }));
  const wouldWarn = prs.filter((p) => p.verdict === "warn").length;
  return {
    since: o.since,
    count: prs.length,
    median,
    p90: pct(sizes, 0.9),
    overWarn: wouldWarn + blockPrs.length,
    overBlock: blockPrs.length,
    wouldWarn,
    wouldBlock: blockPrs.length,
    blockPrs,
  };
}

function reportSince(r, o, log) {
  if (o.json) return log.log(JSON.stringify({ ...r, mode: PR_SIZE_MODE }));
  log.log(`pr-size --since ${r.since}: ${r.count} merged PRs`);
  log.log(`  counted lines: median ${r.median}, p90 ${r.p90}`);
  log.log(`  over 400: ${r.overWarn} (would warn ${r.wouldWarn}, would block ${r.wouldBlock})`);
  log.log(`  over 600: ${r.overBlock}`);
  for (const p of r.blockPrs) log.log(`  would block: #${p.number} ${p.counted} lines  ${p.title}`);
}

export async function main(
  argv = process.argv.slice(2),
  { git, gh, log = console, mode = PR_SIZE_MODE, now = Date.now(), limit = SLICE_LIMIT } = {},
) {
  const o = parseArgs(argv);
  if (o.error) {
    log.error(`pr-size: ${o.error}\n${USAGE}`);
    return 2;
  }
  try {
    if (o.since !== null) {
      if (Date.parse(o.since) > now) throw new Error("--since is in the future");
      reportSince(sinceMode(o, gh ?? ghRun, now, limit), o, log);
      return 0;
    }
    const m =
      o.pr !== null
        ? prMode(o, gh ?? ghRun)
        : await gitMode(o, git ?? gitIn(o.repo ? path.resolve(o.repo) : null));
    report(m, o, log);
    return mode === "enforced" && m.verdict === "block" ? 1 : 0;
  } catch (e) {
    log.error(`pr-size: cannot measure: ${String(e.stderr || e.message).trim()}`);
    return 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
