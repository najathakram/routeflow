#!/usr/bin/env node
/**
 * RouteFlow release-health comparator — read-only Sentry API report/gate.
 *
 * Compares two releases (Sentry `release` = the deployed git sha, tagged by
 * apps/api/src/instrument.ts and apps/web/components/SentryInit.tsx — see
 * feat/release-health-tagging) and reports:
 *   - new issue groups first seen in the newer release
 *   - total error events per release, normalized per hour
 *   - the top 5 offenders (by event count), with file/line when Sentry has it
 *
 * Exits non-zero ONLY when the count of new issue groups at/above --min-severity
 * (default "critical") exceeds --threshold (default 0) — a real regression signal.
 * Read-only: every request is a Sentry API GET, nothing is ever mutated.
 *
 * USAGE
 *   node scripts/release-health.mjs <newRelease> <prevRelease> [--json]
 *     [--threshold N] [--min-severity critical|error|warning|info]
 *     [--project <slug>] [--window-hours N]
 *
 *   <newRelease>/<prevRelease> are Sentry release versions (git shas). The literal
 *   values "current"/"previous" resolve to the two most-recently-created releases
 *   for --project via the Sentry API instead of a literal version.
 *
 * ENV (never hardcoded — see apps/api/.env.example / apps/web/.env.example)
 *   SENTRY_AUTH_TOKEN  — required. An internal integration token with project:read + org:read.
 *   SENTRY_ORG         — required. Org slug.
 *   SENTRY_PROJECT     — default --project when not passed on the CLI.
 *   SENTRY_API_BASE    — default "https://sentry.io/api/0". TEST-ONLY override point — specs
 *                        point this at a local fixture HTTP server, never a real Sentry org
 *                        (see apps/api/src/common/release-health-script.spec.ts).
 *
 * FAIL-OPEN vs FAIL-CLOSED (matches scripts/ci-audit-critical.mjs / ci-freshness-guard.mjs):
 * missing credentials, an unreachable/erroring Sentry API, or an unparseable response all print
 * `::warning::` and exit 0 — a monitoring outage must never block a deploy. Exit 1 is reserved
 * for a real comparison result crossing the threshold.
 */

import http from "node:http";
import https from "node:https";
import { pathToFileURL } from "node:url";

const DEFAULT_BASE = "https://sentry.io/api/0";
const DEFAULT_THRESHOLD = 0;
const DEFAULT_MIN_SEVERITY = "critical";
const DEFAULT_WINDOW_HOURS = 24;
const TOP_OFFENDER_COUNT = 5;
const REQUEST_TIMEOUT_MS = Number(process.env.RELEASE_HEALTH_TIMEOUT_MS || 20_000);
const SEVERITY_RANK = { critical: 4, error: 3, warning: 2, info: 1, debug: 0 };

function parseArgs(argv) {
  const args = {
    json: false,
    threshold: DEFAULT_THRESHOLD,
    minSeverity: DEFAULT_MIN_SEVERITY,
    project: process.env.SENTRY_PROJECT,
    windowHours: null,
    positional: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") args.json = true;
    else if (a === "--threshold") args.threshold = Number(argv[++i]);
    else if (a.startsWith("--threshold=")) args.threshold = Number(a.slice(12));
    else if (a === "--min-severity") args.minSeverity = argv[++i];
    else if (a.startsWith("--min-severity=")) args.minSeverity = a.slice(15);
    else if (a === "--project") args.project = argv[++i];
    else if (a.startsWith("--project=")) args.project = a.slice(10);
    else if (a === "--window-hours") args.windowHours = Number(argv[++i]);
    else if (a.startsWith("--window-hours=")) args.windowHours = Number(a.slice(15));
    else args.positional.push(a);
  }
  return args;
}

function severityRank(s) {
  return s in SEVERITY_RANK ? SEVERITY_RANK[s] : -1;
}

// ── Pure functions — unit-tested directly against fixture payloads, never the network. ───────

/** Issues (Sentry issue objects) whose `level` is at/above minSeverity. */
export function issuesAtOrAboveSeverity(issues, minSeverity) {
  const floor = severityRank(minSeverity);
  return issues.filter((i) => severityRank(i.level) >= floor);
}

/** Top N issues by event count, mapped to a compact offender row with file/line. */
export function topOffenders(issues, n = TOP_OFFENDER_COUNT) {
  return [...issues]
    .sort((a, b) => Number(b.count ?? 0) - Number(a.count ?? 0))
    .slice(0, n)
    .map((i) => ({
      title: i.title || i.metadata?.type || "(untitled)",
      culprit: i.culprit || "(unknown)",
      file: i.metadata?.filename ?? null,
      line: typeof i.metadata?.lineno === "number" ? i.metadata.lineno : null,
      level: i.level || "unknown",
      count: Number(i.count ?? 0),
      permalink: i.permalink || null,
    }));
}

/** Total event count across an events-stats-shaped bucket list: [[ts, [{count}]], ...]. */
export function totalEventsFromStats(statsData) {
  if (!Array.isArray(statsData)) return 0;
  return statsData.reduce((sum, bucket) => {
    const points = Array.isArray(bucket) ? bucket[1] : null;
    if (!Array.isArray(points)) return sum;
    return sum + points.reduce((s, p) => s + Number(p?.count ?? 0), 0);
  }, 0);
}

/** Events/hour, guarding against a zero or missing window. */
export function eventsPerHour(totalEvents, windowHours) {
  if (!windowHours || windowHours <= 0) return null;
  return totalEvents / windowHours;
}

/**
 * Combines everything already fetched into one comparison result — the single function the
 * CLI's exit code and both report formats derive from. Takes plain data; never touches the
 * network, which is what makes it directly unit-testable against fixture payloads.
 */
export function buildComparison({
  newRelease,
  previousRelease,
  newIssues,
  newEventStats,
  newWindowHours,
  previousEventStats,
  previousWindowHours,
  threshold,
  minSeverity,
}) {
  const newTotalEvents = totalEventsFromStats(newEventStats);
  const previousTotalEvents = totalEventsFromStats(previousEventStats);
  const qualifyingNewIssues = issuesAtOrAboveSeverity(newIssues, minSeverity);

  const result = {
    newRelease,
    previousRelease,
    minSeverity,
    threshold,
    newIssueGroups: {
      total: newIssues.length,
      atOrAboveThresholdSeverity: qualifyingNewIssues.length,
      topOffenders: topOffenders(newIssues),
    },
    eventRates: {
      new: {
        totalEvents: newTotalEvents,
        windowHours: newWindowHours,
        perHour: eventsPerHour(newTotalEvents, newWindowHours),
      },
      previous: {
        totalEvents: previousTotalEvents,
        windowHours: previousWindowHours,
        perHour: eventsPerHour(previousTotalEvents, previousWindowHours),
      },
    },
  };
  result.regression = qualifyingNewIssues.length > threshold;
  return result;
}

export function formatReport(result) {
  const lines = [];
  lines.push(`Release health: ${result.previousRelease} -> ${result.newRelease}`);
  lines.push(
    `New issue groups: ${result.newIssueGroups.total} total, ` +
      `${result.newIssueGroups.atOrAboveThresholdSeverity} at/above "${result.minSeverity}" ` +
      `(threshold ${result.threshold})`,
  );
  const newRate = result.eventRates.new.perHour;
  const prevRate = result.eventRates.previous.perHour;
  lines.push(
    `Error events/hour: new=${newRate !== null ? newRate.toFixed(2) : "n/a"} ` +
      `previous=${prevRate !== null ? prevRate.toFixed(2) : "n/a"}`,
  );
  if (result.newIssueGroups.topOffenders.length > 0) {
    lines.push("Top offenders:");
    for (const o of result.newIssueGroups.topOffenders) {
      const loc = o.file ? `${o.file}${o.line ? `:${o.line}` : ""}` : "(no file)";
      lines.push(`  [${o.level}] ${o.title} — ${o.culprit} — ${loc} — ${o.count} events`);
    }
  }
  lines.push(
    result.regression
      ? `REGRESSION: ${result.newIssueGroups.atOrAboveThresholdSeverity} new "${result.minSeverity}"+ ` +
          `issue group(s) exceeds threshold ${result.threshold}`
      : "OK: no new issue groups exceed the threshold",
  );
  return lines.join("\n");
}

// ── Sentry HTTP client — real network, never exercised directly by specs (see header). ───────

function sentryBase() {
  return (process.env.SENTRY_API_BASE || DEFAULT_BASE).replace(/\/+$/, "");
}

// Node's http/https clients (agent: false), NOT the global `fetch`. Reproduced locally: fetch's
// default undici keep-alive connection either hangs the process past a caller's spawn timeout
// (natural exit) or crashes it outright with a native libuv assertion
// ("!(handle->flags & UV_HANDLE_CLOSING)") on an explicit process.exit() — both are worse than
// this script's own fail-open verdict. `agent: false` opens a fresh, non-pooled socket per
// request and closes it as soon as the response ends, so nothing lingers to hang or crash on.
function sentryGet(pathAndQuery) {
  return new Promise((resolve) => {
    let target;
    try {
      target = new URL(`${sentryBase()}${pathAndQuery}`);
    } catch (e) {
      resolve({ ok: false, json: null, error: e });
      return;
    }
    const token = process.env.SENTRY_AUTH_TOKEN;
    const client = target.protocol === "https:" ? https : http;
    const req = client.get(
      target,
      {
        agent: false,
        timeout: REQUEST_TIMEOUT_MS,
        headers: token ? { authorization: `Bearer ${token}` } : {},
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          let json = null;
          try {
            json = body ? JSON.parse(body) : null;
          } catch {
            // Non-JSON body — caller treats a null `json` the same as an outage.
          }
          resolve({ ok: status >= 200 && status < 300, json });
        });
      },
    );
    req.on("timeout", () =>
      req.destroy(new Error(`request timed out after ${REQUEST_TIMEOUT_MS}ms`)),
    );
    req.on("error", (error) => resolve({ ok: false, json: null, error }));
  });
}

async function resolveReleaseVersions(org, project) {
  const { ok, json } = await sentryGet(
    `/organizations/${encodeURIComponent(org)}/releases/?project=${encodeURIComponent(project)}&sort=date&per_page=2`,
  );
  if (!ok || !Array.isArray(json) || json.length < 2) return null;
  return { current: json[0]?.version, previous: json[1]?.version };
}

async function fetchNewIssues(org, project, version) {
  const { ok, json } = await sentryGet(
    `/organizations/${encodeURIComponent(org)}/issues/?project=${encodeURIComponent(project)}` +
      `&query=${encodeURIComponent(`firstRelease:${version}`)}&statsPeriod=14d&sort=freq`,
  );
  return ok && Array.isArray(json) ? json : null;
}

async function fetchEventStats(org, project, version, windowHours) {
  const { ok, json } = await sentryGet(
    `/organizations/${encodeURIComponent(org)}/events-stats/?project=${encodeURIComponent(project)}` +
      `&query=${encodeURIComponent(`release:${version}`)}&statsPeriod=${windowHours}h&interval=1h&yAxis=count()`,
  );
  if (!ok) return null;
  // events-stats returns {data:[...]} in the common (ungrouped) shape this script asks for.
  return Array.isArray(json?.data) ? json.data : null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const org = process.env.SENTRY_ORG;
  const token = process.env.SENTRY_AUTH_TOKEN;
  const project = args.project;
  const windowHours = args.windowHours || DEFAULT_WINDOW_HOURS;

  // Every bare "::warning::"/"::error::" ANNOTATION (as opposed to the report itself, printed
  // once below via stdout) goes to stderr — so stdout is always either empty or exactly ONE
  // thing: the human-readable report or, with --json, a single parseable JSON document. A CI
  // step that pipes stdout to `jq`/JSON.parse must never see a stray annotation line mixed in.
  if (!org || !token || !project) {
    console.error(
      "::warning::release-health.mjs: missing SENTRY_ORG/SENTRY_AUTH_TOKEN/--project " +
        "(or SENTRY_PROJECT) — skipping; monitoring config gaps must never fail a deploy",
    );
    return 0;
  }

  let [newVersion, prevVersion] = args.positional;
  if (!newVersion || !prevVersion) {
    console.error(
      "::error::usage: release-health.mjs <newRelease|current> <prevRelease|previous> " +
        "[--json] [--threshold N] [--min-severity S] [--project P] [--window-hours N]",
    );
    return 1;
  }

  if (newVersion === "current" || prevVersion === "previous") {
    const resolved = await resolveReleaseVersions(org, project);
    if (!resolved?.current || !resolved?.previous) {
      console.error(
        "::warning::release-health.mjs: could not resolve current/previous releases from " +
          "the Sentry API — skipping",
      );
      return 0;
    }
    if (newVersion === "current") newVersion = resolved.current;
    if (prevVersion === "previous") prevVersion = resolved.previous;
  }

  const [newIssues, newStats, prevStats] = await Promise.all([
    fetchNewIssues(org, project, newVersion),
    fetchEventStats(org, project, newVersion, windowHours),
    fetchEventStats(org, project, prevVersion, windowHours),
  ]);

  if (newIssues === null || newStats === null || prevStats === null) {
    console.error(
      "::warning::release-health.mjs: the Sentry API was unavailable or returned an " +
        "unexpected shape — skipping (fail-open, matches scripts/ci-audit-critical.mjs)",
    );
    return 0;
  }

  const result = buildComparison({
    newRelease: newVersion,
    previousRelease: prevVersion,
    newIssues,
    newEventStats: newStats,
    newWindowHours: windowHours,
    previousEventStats: prevStats,
    previousWindowHours: windowHours,
    threshold: args.threshold,
    minSeverity: args.minSeverity,
  });

  console.log(args.json ? JSON.stringify(result, null, 2) : formatReport(result));

  if (result.regression) {
    console.error(
      `::error::release-health regression detected between ${prevVersion} and ${newVersion}`,
    );
    return 1;
  }
  return 0;
}

// pathToFileURL (not a bare `file://${argv[1]}` template), because on Windows argv[1] is a
// backslash path like `C:\...\release-health.mjs` — `file://` + that string never equals
// import.meta.url's `file:///C:/...` form, so the naive check silently never runs main() at all
// (reproduced locally: the script printed nothing and exited 0, which look identical to the
// intentional fail-open path from the outside). pathToFileURL normalizes both platforms.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // `process.exitCode = code`, never a forced `process.exit()` — let the event loop drain
  // naturally. Belt-and-suspenders alongside the `agent: false` fix above: an explicit
  // process.exit() right after an in-flight HTTP client crashed the whole process on Windows
  // with a native libuv assertion ("!(handle->flags & UV_HANDLE_CLOSING)") instead of a clean
  // exit, which a CI step would misread as an unrelated infra failure rather than this script's
  // real verdict.
  main().then((code) => {
    process.exitCode = code;
  });
}
