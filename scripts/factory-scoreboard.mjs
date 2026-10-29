#!/usr/bin/env node
// Factory scoreboard: six outcome numbers for the weekly fleet review (read-only; never writes to GitHub, git refs or the bug register).
// 1 Verified merges: PRs merged in the window split feat/fix/other (train/* bundles counted apart); failed = reverted or named by a revert/hotfix title, verified = 14+ days old and not failed.
// 2 Escapes by risk class: bug-register rows carrying `causedByPr`, filed in the window, classed by the causing PR's touched paths (not instrumented until the field exists).
// 3 Allowance per verified merge: --usage-pct divided by the verified count of the cohort old enough to verify (the window that ended 14 days ago).
// 4 Owner-blocked hours and 5 Release ETA hit rate: not instrumented yet, printed as such rather than invented.
// 6 Exposure: public windows, the longest one and dead-man incidents, parsed from local-assets/visibility-{watchdog,deadman}.log.
//
// USAGE
//   node scripts/factory-scoreboard.mjs [--since <date>] [--usage-pct <n>] [--json] [--write]
//     --since      window start, any ISO date (default: 7 days ago); the window ends now
//     --usage-pct  weekly usage % the lead reads from the app (number 0-100)
//     --json       print JSON instead of the markdown table
//     --write      also save the markdown table to local-assets/scoreboard/<YYYY-MM-DD>.md
//     --fixture    <dir> read gh/git/log/bug inputs from fixture files (self-test only)
//     --help       print usage and exit 0
//
// ARGUMENTS ARE VALIDATED FIRST, as in visibility-watchdog.mjs: an unknown flag or a bad value prints
// usage and exits 2 before any command runs, any file is read or anything is written.
//
// NOTES
// - It reads `origin/master` as it is locally; it never runs `git fetch` (that would write refs).
// - `local-assets/` resolves against the MAIN checkout (like the watchdog), so a worktree finds the logs.
// - The watchdog logs when it was armed (`start`) and when it confirmed PRIVATE (`verified`), not when
//   the repo went public, so a window is an UPPER bound (armed -> confirmed private).
// - A watchdog window with no `verified` line has an unknown length: it is bounded only by the next
//   watchdog start or a dead-man `flipped-private` incident, and unbounded ones stay out of "longest".
// - A revert whose subject names neither the PR number nor its exact title is not detected.
// - PRs are queried in 7-day date slices; a slice that returns exactly the limit fails the run loudly.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LANDINGS_FILE, latestByPr } from "./landing-telemetry.mjs";
import { registryRoot } from "./lib/registry-root.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const GH_REPO = "najathakram/routeflow";
const RISK_PATHS_MODULE = path.join("scripts", "lib", "risk-paths.mjs");
const WATCHDOG_LOG = path.join("local-assets", "visibility-watchdog.log");
const DEADMAN_LOG = path.join("local-assets", "visibility-deadman.log");
const SCOREBOARD_DIR = path.join("local-assets", "scoreboard");

const DAY_MS = 86_400_000;
const VERIFY_AFTER_DAYS = 14;
const DEFAULT_WINDOW_DAYS = 7;
const PR_LIMIT = 500;
const CMD_TIMEOUT_MS = 120_000;

const USAGE = `usage: node scripts/factory-scoreboard.mjs [--since <date>] [--usage-pct <n>] [--json] [--write]
  --since <date>     window start, ISO date (default: ${DEFAULT_WINDOW_DAYS} days ago)
  --usage-pct <n>    weekly usage percent, 0-100 (omit: allowance is "not supplied")
  --json             print JSON instead of the markdown table
  --write            also save the table to local-assets/scoreboard/<YYYY-MM-DD>.md
  --fixture <dir>    read inputs from fixture files instead of running commands (tests)
  --help             print this message and exit 0`;

class UsageError extends Error {}

function parseArgs(argv) {
  const opts = { since: null, usagePct: null, json: false, write: false, fixture: null };
  // A flag value must be a real value: `--since --json` would otherwise swallow the next flag.
  const valueOf = (flag, next) => {
    if (next === undefined || next.startsWith("--")) throw new UsageError(`${flag} needs a value`);
    return next;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);
    const val = () => (inline !== undefined ? inline : valueOf(flag, argv[++i]));
    if (flag === "--help" || flag === "-h") return { help: true };
    else if (flag === "--json") opts.json = true;
    else if (flag === "--write") opts.write = true;
    else if (flag === "--since") opts.since = val();
    else if (flag === "--usage-pct") opts.usagePct = val();
    else if (flag === "--fixture") opts.fixture = val();
    else throw new UsageError(`unknown argument: ${arg}`);
  }
  if (opts.since !== null && !Number.isFinite(Date.parse(opts.since))) {
    throw new UsageError(`invalid --since: ${JSON.stringify(opts.since)}`);
  }
  if (opts.usagePct !== null) {
    const n = opts.usagePct.trim() === "" ? NaN : Number(opts.usagePct);
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      throw new UsageError(`invalid --usage-pct: ${JSON.stringify(opts.usagePct)} (want 0-100)`);
    }
    opts.usagePct = n;
  }
  if (opts.fixture !== null && !fs.existsSync(opts.fixture)) {
    throw new UsageError(`--fixture directory not found: ${opts.fixture}`);
  }
  return { ...opts, help: false };
}

// ─── inputs: every command and file read goes through these two functions ─────────────────────
// With --fixture <dir>, `fixtureName` is read from that directory and no command runs.

/** Run a command and return its stdout, or throw. The ONLY place a subprocess is started. */
function run(fixture, fixtureName, cmd, args) {
  if (fixture) return fs.readFileSync(path.join(fixture, fixtureName), "utf8");
  const res = spawnSync(cmd, args, {
    cwd: REPO_ROOT,
    shell: false,
    encoding: "utf8",
    timeout: CMD_TIMEOUT_MS,
    killSignal: "SIGKILL",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error || res.status !== 0) {
    const why = res.error ? res.error.message : (res.stderr || "").trim().split("\n")[0];
    throw new Error(`${cmd} ${args[0] ?? ""} failed: ${why}`);
  }
  return res.stdout;
}

/** Text of an optional input file, or null when it is missing. */
function readOptional(fixture, fixtureName, realPath) {
  const file = fixture ? path.join(fixture, fixtureName) : realPath;
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** The MAIN checkout (parent of `git --git-common-dir`), where `local-assets/` lives. */
function mainCheckoutRoot() {
  const res = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd: REPO_ROOT,
    shell: false,
    encoding: "utf8",
    timeout: 10_000,
    killSignal: "SIGKILL",
  });
  const out = !res.error && res.status === 0 ? (res.stdout || "").trim() : "";
  return out ? path.dirname(path.resolve(out)) : REPO_ROOT;
}

// ─── 1. verified merges ───────────────────────────────────────────────────────────────────────
const stripPrSuffix = (s) => s.replace(/\s*\(#\d+\)\s*$/, "").trim();

function kindOf(title) {
  const m = /^(feat|fix)(\([^)]*\))?!?:/i.exec(title.trim());
  return m ? m[1].toLowerCase() : "other";
}

/** PR numbers a title/subject refers to, minus its own number (a PR is never evidence against itself). */
function otherRefs(text) {
  const rest = text
    .replace(/^Merge pull request #\d+/i, "")
    .replace(/^Merge #\d+/i, "")
    .replace(/\s*\(#\d+\)\s*$/, "");
  return [...rest.matchAll(/#(\d+)/g)].map((m) => Number(m[1]));
}

/** Map of PR number -> reason, for every PR a later commit or PR title marks as failed. */
function findFailures(prs, commits) {
  const failed = new Map();
  const byTitle = new Map(prs.map((p) => [stripPrSuffix(p.title), p]));
  const evidence = [
    ...prs.map((p) => ({ text: p.title, at: Date.parse(p.mergedAt), self: p.number })),
    ...commits.map((c) => ({ text: c.subject, at: c.at, self: null })),
  ];
  for (const e of evidence) {
    // Only a title that STARTS with Revert / hotfix (or `fix(hotfix)`): a mid-sentence mention is not one.
    if (/^(revert|hotfix\b|fix\(hotfix\))/i.test(e.text.trim())) {
      for (const n of otherRefs(e.text)) {
        const target = prs.find((p) => p.number === n);
        if (target && n !== e.self && e.at > Date.parse(target.mergedAt)) {
          failed.set(n, /^revert/i.test(e.text.trim()) ? "reverted" : "hotfix");
        }
      }
    }
    // `Revert "<exact PR title>"` names no number when the repo merges with merge commits.
    const rv = /^Revert "(.*)"\s*(\(#\d+\))?\s*$/i.exec(e.text.trim());
    if (rv) {
      const target = byTitle.get(stripPrSuffix(rv[1]));
      if (target && target.number !== e.self && e.at > Date.parse(target.mergedAt)) {
        failed.set(target.number, "reverted");
      }
    }
  }
  return failed;
}

// A train/* PR bundles member PRs that are already counted on their own, so it is reported apart.
const isTrain = (p) => String(p.headRefName ?? "").startsWith("train/");

function summarize(prs, failed, nowMs) {
  const out = { total: 0, feat: 0, fix: 0, other: 0, verified: 0, pending: 0, failed: 0 };
  const failedNumbers = [];
  out.trains = prs.filter(isTrain).length;
  for (const p of prs.filter((x) => !isTrain(x))) {
    out.total++;
    out[kindOf(p.title)]++;
    if (failed.has(p.number)) {
      out.failed++;
      failedNumbers.push(p.number);
    } else if (nowMs - Date.parse(p.mergedAt) >= VERIFY_AFTER_DAYS * DAY_MS) out.verified++;
    else out.pending++;
  }
  return { ...out, failedNumbers: failedNumbers.sort((a, b) => a - b) };
}

function parseCommits(text) {
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha, iso, ...rest] = line.split("\t");
      return { sha, at: Date.parse(iso), subject: rest.join("\t") };
    })
    .filter((c) => Number.isFinite(c.at));
}

/**
 * Every PR merged from `floor` to now, fetched in 7-day date slices. A slice that returns exactly the
 * limit may have been cut off, so it fails the run instead of silently under-counting.
 * (A fixture may carry `limit.txt` to exercise that failure without 500 rows.)
 */
function fetchMergedPrs(fixture, floorMs, nowMs) {
  const limitText = fixture ? readOptional(fixture, "limit.txt", "") : null;
  const limit = limitText && Number(limitText.trim()) > 0 ? Number(limitText.trim()) : PR_LIMIT;
  const day = (ms) => new Date(ms).toISOString().slice(0, 10);
  const lastDay = Math.floor(nowMs / DAY_MS) * DAY_MS;
  const byNumber = new Map();
  for (let from = Math.floor(floorMs / DAY_MS) * DAY_MS; from <= lastDay; from += 7 * DAY_MS) {
    const range = `${day(from)}..${day(Math.min(from + 6 * DAY_MS, lastDay))}`;
    const rows = JSON.parse(
      run(fixture, "gh-prs.json", "gh", [
        "pr",
        "list",
        "--repo",
        GH_REPO,
        "--state",
        "merged",
        "--search",
        `merged:${range}`,
        "--json",
        "number,title,mergedAt,headRefName",
        "--limit",
        String(limit),
      ]),
    );
    if (rows.length >= limit) {
      throw new Error(`gh returned ${rows.length} PRs for merged:${range} (the limit): truncated`);
    }
    for (const p of rows) {
      if (p.mergedAt && Number.isFinite(Date.parse(p.mergedAt))) byNumber.set(p.number, p);
    }
  }
  return [...byNumber.values()];
}

function verifiedMerges({ fixture, sinceMs, nowMs }) {
  const floor = new Date(sinceMs - VERIFY_AFTER_DAYS * DAY_MS);
  const all = fetchMergedPrs(fixture, floor.getTime(), nowMs);
  const commits = parseCommits(
    run(fixture, "git-log.txt", "git", [
      "log",
      "origin/master",
      `--since=${floor.toISOString()}`,
      "--format=%H%x09%cI%x09%s",
    ]),
  );
  const failed = findFailures(all, commits);
  const inRange = (from, to) =>
    all.filter((p) => Date.parse(p.mergedAt) >= from && Date.parse(p.mergedAt) <= to);
  const priorFrom = sinceMs - VERIFY_AFTER_DAYS * DAY_MS;
  const priorTo = nowMs - VERIFY_AFTER_DAYS * DAY_MS;
  return {
    window: summarize(inRange(sinceMs, nowMs), failed, nowMs),
    priorWindow: {
      from: new Date(priorFrom).toISOString(),
      to: new Date(priorTo).toISOString(),
      ...summarize(inRange(priorFrom, priorTo), failed, nowMs),
    },
  };
}

// ─── 2. escapes by risk class ─────────────────────────────────────────────────────────────────
async function loadClassifier(fixture) {
  const file = fixture
    ? path.join(fixture, "risk-paths.mjs")
    : path.join(REPO_ROOT, RISK_PATHS_MODULE);
  if (!fs.existsSync(file)) return null;
  const mod = await import(pathToFileURL(file).href);
  if (typeof mod.classifyPath !== "function") return null;
  // classifyPath(path) returns { cls }; CLASSES lists the classes low to high.
  return { classify: mod.classifyPath, order: mod.CLASSES ?? ["green", "amber", "red", "black"] };
}

/**
 * The risk class of the PR that caused an escape: the HIGHEST class among the files that PR touched
 * (`gh pr diff <n> --name-only`). The register's `location` is display text, not a path. "unclassified"
 * when the diff cannot be read, so a missing diff never reads as a low class.
 */
function classOfPr(fixture, n, { classify, order }) {
  let files;
  try {
    files = run(fixture, `pr-diff-${n}.txt`, "gh", [
      "pr",
      "diff",
      String(n),
      "--repo",
      GH_REPO,
      "--name-only",
    ])
      .split("\n")
      .map((f) => f.trim())
      .filter(Boolean);
  } catch {
    return "unclassified";
  }
  if (files.length === 0) return "unclassified";
  let top = -1;
  for (const f of files) top = Math.max(top, order.indexOf(classify(f)?.cls));
  return top < 0 ? "unclassified" : order[top];
}

async function escapes({ fixture, sinceMs, nowMs }) {
  const text = readOptional(
    fixture,
    "bugs.jsonl",
    path.join(registryRoot({ allowMissing: true }), "bugs.jsonl"),
  );
  if (text === null) return { instrumented: false, reason: "bug register not found" };
  const rows = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // a torn line is not worth failing the scoreboard over
    }
  }
  const caused = rows.filter((r) => r.causedByPr !== undefined && r.causedByPr !== null);
  if (caused.length === 0) {
    return { instrumented: false, reason: "no causedByPr field yet" };
  }
  const inWindow = caused.filter((r) => {
    const at = Date.parse(r.filedAt ?? "");
    return Number.isFinite(at) && at >= sinceMs && at <= nowMs;
  });
  const classifier = await loadClassifier(fixture);
  const groups = {};
  const prClass = new Map(); // one diff read per causing PR
  for (const r of inWindow) {
    let key = String(r.severity ?? "unknown");
    if (classifier) {
      // causedByPr may be 123, "123" or "#123": keep the digits.
      const n = Number(String(r.causedByPr).replace(/\D/g, ""));
      if (!prClass.has(n)) {
        prClass.set(n, n > 0 ? classOfPr(fixture, n, classifier) : "unclassified");
      }
      key = prClass.get(n);
    }
    (groups[key] ??= []).push(r.id);
  }
  return {
    instrumented: true,
    groupedBy: classifier ? "risk class of the causing PR's paths" : "severity",
    total: inWindow.length,
    groups: Object.fromEntries(Object.entries(groups).sort(([a], [b]) => a.localeCompare(b))),
  };
}

// ─── 6. exposure ──────────────────────────────────────────────────────────────────────────────
/** Watchdog lines are `<ISO> start|attempt|verified|error|refused <detail>`; see visibility-watchdog.mjs. */
function parseWatchdog(text, sinceMs, nowMs, flipTimes) {
  const closed = [];
  const unclosedStarts = [];
  const allStarts = [];
  let open = null;
  for (const line of text.split("\n")) {
    const m = /^(\S+)\s+(\w+)/.exec(line);
    const at = m ? Date.parse(m[1]) : NaN;
    if (!m || !Number.isFinite(at)) continue;
    const event = m[2];
    if (event === "start") {
      allStarts.push(at);
      if (open !== null) unclosedStarts.push(open); // the previous watchdog never confirmed PRIVATE
      open = at;
    } else if (event === "verified" && open !== null) {
      closed.push({ start: open, minutes: (at - open) / 60_000 });
      open = null;
    } else if (event === "error" && open !== null) {
      unclosedStarts.push(open);
      open = null;
    }
  }
  if (open !== null) unclosedStarts.push(open); // still armed (or killed) at the end of the log
  allStarts.sort((a, b) => a - b);
  // Only windows armed inside the reporting window count, closed or not.
  const inWin = (t) => t >= sinceMs && t <= nowMs;
  const mine = closed.filter((w) => inWin(w.start));
  // An unclosed window has NO known length: a manual flip or the dead-man may have closed it within
  // the hour. It is bounded only by the next watchdog start (the lock allows one watchdog at a time) or
  // a dead-man flipped-private incident, whichever came first; with neither, the duration is unknown
  // and it stays out of "longest".
  const unclosed = unclosedStarts.filter(inWin).map((start) => {
    const ends = [
      { at: allStarts.find((t) => t > start), by: "next watchdog start" },
      { at: flipTimes.find((t) => t > start), by: "dead-man flip" },
    ].filter((e) => e.at !== undefined);
    const first = ends.sort((a, b) => a.at - b.at)[0];
    return {
      armedAt: new Date(start).toISOString().slice(0, 16) + "Z",
      boundMinutes: first ? Math.round(((first.at - start) / 60_000) * 10) / 10 : null,
      boundedBy: first ? first.by : null,
    };
  });
  const lengths = [
    ...mine.map((w) => w.minutes),
    ...unclosed.map((u) => u.boundMinutes).filter((n) => n !== null),
  ];
  return {
    windows: mine.length,
    longestMinutes: lengths.length ? Math.round(Math.max(...lengths) * 10) / 10 : 0,
    unclosed,
  };
}

/**
 * Dead-man lines are JSON objects (`{"time","event","action"|"reason",...}`, see visibility-deadman.mjs)
 * or plain text. An `incident` with action `flipped-private` or `flip-unconfirmed` is a real exposure
 * event, counted apart. `reason: "not-admin"` is logged on EVERY poll the token cannot flip (about 720 a
 * day), so it is a health warning, not an incident. Also returns every flipped-private time (any date),
 * which bounds an unclosed watchdog window.
 */
function parseDeadman(text, sinceMs, nowMs) {
  const out = { flippedPrivate: 0, flipUnconfirmed: 0, otherIncidents: 0, notAdminPolls: 0 };
  let undated = 0;
  const flipTimes = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let at = NaN;
    let isIncident = false;
    let action = "";
    let reason = "";
    try {
      const o = JSON.parse(line);
      if (o && typeof o === "object") {
        at = Date.parse(o.time ?? o.ts ?? o.timestamp ?? o.at ?? "");
        isIncident = ["event", "type", "kind", "level", "status"].some(
          (k) => String(o[k] ?? "").toLowerCase() === "incident",
        );
        action = String(o.action ?? "");
        reason = String(o.reason ?? "");
      }
    } catch {
      const m = /^(\S+)\s+(.*)$/.exec(line);
      at = m ? Date.parse(m[1]) : NaN;
      isIncident = /\bincident\b/i.test(line);
    }
    if (!isIncident) continue;
    if (action === "flipped-private" && Number.isFinite(at)) flipTimes.push(at);
    if (!Number.isFinite(at)) undated++;
    else if (at >= sinceMs && at <= nowMs) {
      if (action === "flipped-private") out.flippedPrivate++;
      else if (action === "flip-unconfirmed") out.flipUnconfirmed++;
      else if (reason === "not-admin") out.notAdminPolls++;
      else out.otherIncidents++;
    }
  }
  return { summary: { ...out, undated }, flipTimes: flipTimes.sort((a, b) => a - b) };
}

function exposure({ fixture, sinceMs, nowMs, root }) {
  const wd = readOptional(fixture, "visibility-watchdog.log", path.join(root, WATCHDOG_LOG));
  const dm = readOptional(fixture, "visibility-deadman.log", path.join(root, DEADMAN_LOG));
  const deadman = dm === null ? null : parseDeadman(dm, sinceMs, nowMs);
  return {
    watchdog:
      wd === null ? null : parseWatchdog(wd, sinceMs, nowMs, deadman ? deadman.flipTimes : []),
    deadman: deadman ? deadman.summary : null,
  };
}

// ─── report ───────────────────────────────────────────────────────────────────────────────────
const split = (s) => `feat ${s.feat} / fix ${s.fix} / other ${s.other}`;
const failedNote = (s) =>
  s.failedNumbers.length ? `, failed ${s.failedNumbers.map((n) => `#${n}`).join(" ")}` : "";
const round1 = (n) => Math.round(n * 10) / 10;

// The usage % is this week's spend, so it is divided by the cohort old enough to be verified (merged
// in the window that ended 14 days ago); the current window's merges are all still pending.
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Metric 7 (R1-b): what the landing rows say about merges in the window. Read-only: the rows are written at landing by
 * landing-telemetry.mjs (ops-post-push spawns it), never here. Coverage compares rows with the window's merged PRs,
 * so a gap in the ledger shows as a number instead of a silently smaller sample.
 */
function landings({ fixture, sinceMs, nowMs, root }, mergedInWindow) {
  const text = readOptional(fixture, "landings.jsonl", path.join(root, LANDINGS_FILE));
  if (text === null) return null;
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      /* a torn line is skipped; coverage shows the gap */
    }
  }
  const inWindow = latestByPr(rows).filter((r) => {
    const t = Date.parse(r.mergedAt);
    return Number.isFinite(t) && t >= sinceMs && t <= nowMs;
  });
  const routes = {};
  for (const r of inWindow) routes[r.route ?? "unknown"] = (routes[r.route ?? "unknown"] ?? 0) + 1;
  const reviewed = inWindow.filter((r) => r.reviewRounds != null);
  const lines = inWindow.map((r) => r.lines).filter(Number.isFinite);
  const costs = inWindow.map((r) => r.costUsd).filter(Number.isFinite);
  return {
    rows: inWindow.length,
    mergedInWindow,
    routes,
    reviewed: reviewed.length,
    medianReviewRounds: median(reviewed.map((r) => r.reviewRounds)),
    firstPass: reviewed.filter((r) => r.firstPass === true).length,
    medianLines: median(lines),
    over400: lines.filter((n) => n > 400).length,
    over600: lines.filter((n) => n > 600).length,
    rework: inWindow.filter((r) => r.reworkOf != null).length,
    costed: costs.length,
    medianCostUsd: costs.length ? Math.round(median(costs) * 100) / 100 : null,
  };
}

function allowance(usagePct, cohort) {
  if (usagePct === null) return { supplied: false };
  return {
    supplied: true,
    usagePct,
    cohortFrom: cohort.from,
    cohortTo: cohort.to,
    verified: cohort.verified,
    perVerifiedMerge: cohort.verified > 0 ? round1(usagePct / cohort.verified) : null,
  };
}

function buildReport({ sinceMs, nowMs, usagePct, merges, esc, expo, land }) {
  const w = merges.window;
  return {
    window: { since: new Date(sinceMs).toISOString(), until: new Date(nowMs).toISOString() },
    verifiedMerges: { window: w, priorWindow: merges.priorWindow },
    escapes: esc,
    allowance: allowance(usagePct, merges.priorWindow),
    ownerBlockedHours: "not instrumented",
    releaseEtaHitRate: "not instrumented",
    exposure: expo,
    landings: land,
  };
}

function toMarkdown(r) {
  const w = r.verifiedMerges.window;
  const p = r.verifiedMerges.priorWindow;
  const rows = [];
  rows.push([
    "1",
    "Verified merges (window)",
    `${w.verified} verified, ${w.pending} pending, ${w.failed} failed of ${w.total}; ${split(w)}${failedNote(w)}; ${w.trains} train merges not counted`,
  ]);
  rows.push([
    "1b",
    `Verified merges (window ended 14 days ago, ${p.from.slice(0, 10)} to ${p.to.slice(0, 10)})`,
    `${p.verified} verified, ${p.failed} failed of ${p.total}; ${split(p)}${failedNote(p)}; ${p.trains} train merges not counted`,
  ]);
  const e = r.escapes;
  let escText;
  if (!e.instrumented) escText = `not instrumented (${e.reason})`;
  else {
    const g = Object.entries(e.groups).map(([k, ids]) => `${k} ${ids.length} (${ids.join(" ")})`);
    escText = `${e.total} by ${e.groupedBy}${g.length ? `: ${g.join("; ")}` : ""}`;
  }
  rows.push(["2", "Escapes by risk class", escText]);
  const a = r.allowance;
  let allowText = "not supplied";
  if (a.supplied) {
    const cohort = `${a.verified} verified in the 14-day-old cohort, ${a.cohortFrom.slice(0, 10)} to ${a.cohortTo.slice(0, 10)}`;
    allowText =
      a.perVerifiedMerge === null
        ? `n/a (${a.usagePct}% used, ${cohort})`
        : `${a.perVerifiedMerge}% per verified merge (${a.usagePct}% used / ${cohort})`;
  }
  rows.push(["3", "Allowance per verified merge (usage % over the 14-day-old cohort)", allowText]);
  rows.push(["4", "Owner-blocked hours", r.ownerBlockedHours]);
  rows.push(["5", "Release ETA hit rate", r.releaseEtaHitRate]);
  const x = r.exposure;
  const parts = [];
  parts.push(
    x.watchdog === null
      ? `watchdog log missing (${WATCHDOG_LOG})`
      : `${x.watchdog.windows} public windows (armed to confirmed private), longest ${x.watchdog.longestMinutes} min (upper bound), ${x.watchdog.unclosed.length} unclosed${
          x.watchdog.unclosed.length
            ? ` (${x.watchdog.unclosed
                .map((u) =>
                  u.boundMinutes === null
                    ? `duration unknown (armed ${u.armedAt})`
                    : `armed ${u.armedAt}, up to ${u.boundMinutes} min (${u.boundedBy})`,
                )
                .join("; ")})`
            : ""
        }`,
  );
  const d = x.deadman;
  parts.push(
    d === null
      ? `dead-man log missing (${DEADMAN_LOG})`
      : `dead-man: ${d.flippedPrivate} flipped private, ${d.flipUnconfirmed} flip unconfirmed${d.otherIncidents ? `, ${d.otherIncidents} other incidents` : ""}${d.undated ? ` (+${d.undated} undated)` : ""}${d.notAdminPolls ? `; WARNING: ${d.notAdminPolls} not-admin polls (the dead-man token cannot flip)` : ""}`,
  );
  rows.push(["6", "Exposure", parts.join("; ")]);
  const g = r.landings;
  let landText;
  if (g === null) landText = `landing ledger missing (${LANDINGS_FILE})`;
  else {
    const routes = Object.entries(g.routes)
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${k} ${n}`)
      .join(", ");
    landText = [
      `${g.rows} of ${g.mergedInWindow} merged PRs have a landing row${routes ? ` (${routes})` : ""}`,
      g.reviewed
        ? `review: median ${g.medianReviewRounds} rounds, ${g.firstPass} of ${g.reviewed} first-pass`
        : "review: no verdicts found",
      g.medianLines === null
        ? "size: n/a"
        : `size: median ${g.medianLines} lines, ${g.over400} over 400, ${g.over600} over 600`,
      `rework: ${g.rework}`,
      g.costed
        ? `cost: median $${g.medianCostUsd} (${g.costed} of ${g.rows} costed)`
        : "cost: none costed",
    ].join("; ");
  }
  rows.push(["7", "Landings", landText]);
  const lines = [
    `# Factory scoreboard: ${r.window.since.slice(0, 10)} to ${r.window.until.slice(0, 10)}`,
    "",
    "| # | Number | Value |",
    "|---|---|---|",
    ...rows.map((c) => `| ${c.join(" | ")} |`),
  ];
  return lines.join("\n") + "\n";
}

// ─── main ─────────────────────────────────────────────────────────────────────────────────────
async function main(opts) {
  const fixture = opts.fixture ? path.resolve(opts.fixture) : null;
  const nowText = fixture ? readOptional(fixture, "now.txt", "") : null;
  const nowMs =
    nowText && Number.isFinite(Date.parse(nowText.trim()))
      ? Date.parse(nowText.trim())
      : Date.now();
  const sinceMs =
    opts.since !== null ? Date.parse(opts.since) : nowMs - DEFAULT_WINDOW_DAYS * DAY_MS;
  if (sinceMs >= nowMs) throw new UsageError(`--since must be in the past: ${opts.since}`);

  const root = fixture ? fixture : mainCheckoutRoot();
  const ctx = { fixture, sinceMs, nowMs, root };
  const merges = verifiedMerges(ctx);
  const esc = await escapes(ctx);
  const expo = exposure(ctx);
  const land = landings(ctx, merges.window.total + merges.window.trains);
  const report = buildReport({ sinceMs, nowMs, usagePct: opts.usagePct, merges, esc, expo, land });
  const md = toMarkdown(report);
  console.log(opts.json ? JSON.stringify(report, null, 2) : md.trimEnd());

  if (opts.write) {
    const dir = path.join(root, SCOREBOARD_DIR);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${new Date(nowMs).toISOString().slice(0, 10)}.md`);
    fs.writeFileSync(file, md);
    console.error(`factory-scoreboard: wrote ${file}`);
  }
  return 0;
}

// Validate the arguments before anything else runs: a bad flag never reaches a command, a read or a write.
let cli;
try {
  cli = parseArgs(process.argv.slice(2));
} catch (err) {
  if (!(err instanceof UsageError)) throw err;
  console.error(`factory-scoreboard: ${err.message}\n${USAGE}`);
  process.exit(2);
}
if (cli.help) {
  console.log(USAGE);
  process.exit(0);
}

main(cli)
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`factory-scoreboard: ${err && err.message ? err.message : String(err)}`);
    process.exit(err instanceof UsageError ? 2 : 1);
  });
