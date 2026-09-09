#!/usr/bin/env node
// CI advisory gate for `npm audit` — distinguishes a REAL finding from a
// REGISTRY OUTAGE.
//
// WHY THIS EXISTS
// `npm audit --omit=dev --audit-level=critical` calls the registry's
// `/-/npm/v1/security/audits/quick` endpoint. That endpoint has started
// returning 500 with the notice "This endpoint is being retired. Use the bulk
// advisory endpoint instead." — npm's own client then retries internally for
// ~12 minutes before giving up, which blew the `Fail on critical production
// advisories` step's `timeout-minutes: 20` twice in one day (2026-09-03 and
// 2026-09-04, 8 minutes apart). The follow-on "Report high-severity
// advisories" step hit the same failure but was masked by `|| true`.
//
// This script fails ONLY on an actual critical (or, in --report-only mode,
// reports without ever failing) — never on the registry being unavailable. A
// registry/transport error gets a small bounded number of retries and then a
// `::warning::` + a clean exit, so an upstream deprecation can never wedge
// every PR. Dependabot alerts remain the standing net while the gate is
// skipped for a run.
//
// USAGE
//   node scripts/ci-audit-critical.mjs                             # audit-level critical, fails on findings
//   node scripts/ci-audit-critical.mjs --level high --report-only  # never fails; prints counts only
//
// TEST-ONLY OVERRIDES (never set these in a real CI run — see
// apps/api/src/common/ci-audit-script.spec.ts)
//   CI_AUDIT_CMD          JSON array of argv, e.g. '["node","/tmp/fake-npm-audit.mjs"]',
//                         replacing the real `npm[.cmd] audit ...` invocation entirely so
//                         specs can drive a fake with no network.
//   CI_AUDIT_BACKOFF_MS   Comma-separated backoff delays in ms (default "15000,45000") so
//                         specs don't sleep for real minutes.
//   CI_AUDIT_ALLOWLIST    Path to an allowlist JSON file, replacing the default
//                         security/audit-allowlist.json (resolved from this script's own
//                         location, not process.cwd()) so specs can point at a temp fixture.
//
// EXPIRING ALLOWLIST
// security/audit-allowlist.json (or CI_AUDIT_ALLOWLIST) lists { id, package, reason, expires,
// ackedBy, ackedOn, followUp } entries. A critical advisory is suppressed only when an entry's
// `id` + `package` match it AND today (UTC) is <= `expires`; suppression prints
// `::warning::ALLOWLISTED …`. A missing allowlist file is fine (no allowlist configured); a
// present-but-malformed one (bad JSON, missing field, bad date) fails closed — `::error::` +
// exit 1 — without ever running npm audit. An entry past its `expires` always fails the gate
// (`::error::ALLOWLIST EXPIRED …`), even if the advisory it names no longer appears in the
// current audit output, so a stale entry can't rot silently. --report-only never fails on any
// of this — it only gains the extra ALLOWLISTED/EXPIRED lines for visibility.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_BUFFER = 64 * 1024 * 1024; // 64 MiB
// 3 attempts x 60s + the default 15s + 45s backoff = 4 min worst case per
// step. This script runs as two steps in CI (the blocking critical gate and
// the --report-only high-severity report), so ~8 min worst case total —
// inside the job's `timeout-minutes: 20` with ~7 min of margin left over the
// rest of the job body (checkout, install, build) on the worst observed run.
const ATTEMPT_TIMEOUT_MS = 60_000; // 1 min per attempt
const MAX_ATTEMPTS = 3;
const DEFAULT_BACKOFF_MS = [15_000, 45_000];

// Any of these anywhere in the combined stdout+stderr+spawn-error text means the
// registry/transport failed us, not that it found something. The 5xx pattern
// requires npm/HTTP context (e.g. "npm error 500 Internal Server Error",
// "HTTP 500", "status 500") so it never matches an unrelated 3-digit number
// buried in unparseable, non-registry output (e.g. "cannot read lockfile at
// offset 503 bytes") — that case must fail closed via branch (D), not be
// mistaken for an outage.
const OUTAGE_PATTERNS = [
  /audit endpoint returned an error/i,
  /ENOAUDIT/,
  /\b(npm (warn|error)|HTTP|status)\b[^\n]*\b5\d\d\b/i,
  /ECONNRESET/,
  /ETIMEDOUT/,
  /ENOTFOUND/,
  /being retired/i,
];

function parseArgs(argv) {
  let level = "critical";
  let reportOnly = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--level") {
      level = argv[++i];
    } else if (arg.startsWith("--level=")) {
      level = arg.slice("--level=".length);
    } else if (arg === "--report-only") {
      reportOnly = true;
    }
  }
  return { level, reportOnly };
}

function backoffSchedule() {
  const raw = process.env.CI_AUDIT_BACKOFF_MS;
  if (!raw) return DEFAULT_BACKOFF_MS;
  const parsed = raw
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n >= 0);
  return parsed.length > 0 ? parsed : DEFAULT_BACKOFF_MS;
}

function auditCommand(level) {
  const overrideRaw = process.env.CI_AUDIT_CMD;
  if (overrideRaw) {
    // Test-only — see the header comment.
    const argv = JSON.parse(overrideRaw);
    return { cmd: argv[0], args: argv.slice(1) };
  }
  const args = ["audit", "--omit=dev", `--audit-level=${level}`, "--json"];
  if (process.platform === "win32") {
    // spawnSync cannot launch a .cmd shim directly with shell:false — Node
    // refuses since the CVE-2024-27980 hardening (EINVAL), and this script
    // deliberately never sets shell:true. npm ships a real JS entrypoint next
    // to the node binary on every Windows install; invoke that through node
    // instead so the real CI codepath below (plain "npm", ubuntu-latest only)
    // stays untouched and this still works for a local Windows run.
    const npmCli = path.join(
      path.dirname(process.execPath),
      "node_modules",
      "npm",
      "bin",
      "npm-cli.js",
    );
    if (fs.existsSync(npmCli)) {
      return { cmd: process.execPath, args: [npmCli, ...args] };
    }
  }
  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
  return { cmd: npmCmd, args };
}

function isOutage(text) {
  return OUTAGE_PATTERNS.some((re) => re.test(text));
}

// scripts/ci-audit-critical.mjs -> scripts/ -> repo root. Anchored to this file's own
// location (not process.cwd()) so the default allowlist resolves the same way whether this
// runs from CI's checkout root or a spec that spawns it from apps/api.
function repoRoot() {
  return path.dirname(path.dirname(fileURLToPath(import.meta.url)));
}

function defaultAllowlistPath() {
  return path.join(repoRoot(), "security", "audit-allowlist.json");
}

function todayUtcDate() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD, UTC
}

const ALLOWLIST_REQUIRED_FIELDS = ["id", "package", "reason", "expires", "ackedBy", "followUp"];
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Loads and validates the allowlist. A missing file is NOT an error (no allowlist configured
// yet) — { ok: true, entries: [] }. A present-but-malformed file fails closed — { ok: false }
// — having already printed ::error:: for the caller to surface; the caller must not fall back
// to "no allowlist" in that case.
function loadAllowlist() {
  const allowlistPath = process.env.CI_AUDIT_ALLOWLIST || defaultAllowlistPath();
  if (!fs.existsSync(allowlistPath)) {
    return { ok: true, entries: [] };
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(allowlistPath, "utf8"));
  } catch (e) {
    console.log(`::error::CI audit allowlist ${allowlistPath} is not valid JSON: ${e.message}`);
    return { ok: false, entries: [] };
  }
  if (!parsed || !Array.isArray(parsed.entries)) {
    console.log(`::error::CI audit allowlist ${allowlistPath} must have an "entries" array`);
    return { ok: false, entries: [] };
  }
  for (const entry of parsed.entries) {
    for (const field of ALLOWLIST_REQUIRED_FIELDS) {
      if (!entry || typeof entry[field] !== "string" || entry[field].trim() === "") {
        console.log(
          `::error::CI audit allowlist ${allowlistPath} has an entry missing "${field}": ${JSON.stringify(entry)}`,
        );
        return { ok: false, entries: [] };
      }
    }
    if (!ISO_DATE_RE.test(entry.expires)) {
      console.log(
        `::error::CI audit allowlist ${allowlistPath} entry ${entry.id} has an invalid "expires" (want YYYY-MM-DD): ${entry.expires}`,
      );
      return { ok: false, entries: [] };
    }
  }
  return { ok: true, entries: parsed.entries };
}

// The GHSA id usually lives in a `via` detail's `url`
// (https://github.com/advisories/GHSA-xxxx-xxxx-xxxx); fall back to `.source`/`.name` in case a
// future npm audit shape moves it.
function ghsaIdFromVia(v) {
  const candidates = [v.url, v.source, v.name].filter((s) => typeof s === "string");
  for (const candidate of candidates) {
    const m = candidate.match(/GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}/i);
    if (m) return m[0];
  }
  return null;
}

function matchingAllowlistEntry(row, allowlist) {
  if (!row.ghsaId) return null;
  return allowlist.find((e) => e.id === row.ghsaId && e.package === row.name) || null;
}

// Splits rows into still-blocking (`remaining`) vs suppressed-by-an-unexpired-entry
// (`suppressed`). A row whose matching entry is itself expired stays in `remaining` — the
// separate expiry rot-guard in main() fails the gate independently of this partition.
function partitionByAllowlist(rows, allowlist, today) {
  const remaining = [];
  const suppressed = [];
  for (const row of rows) {
    const entry = matchingAllowlistEntry(row, allowlist);
    if (entry && entry.expires >= today) {
      suppressed.push({ row, entry });
    } else {
      remaining.push(row);
    }
  }
  return { remaining, suppressed };
}

function printSuppressed(suppressed) {
  for (const { entry } of suppressed) {
    console.log(
      `::warning::ALLOWLISTED ${entry.id} (${entry.package}) until ${entry.expires} — ${entry.reason}`,
    );
  }
}

// Synchronous sleep with no dependency — spawnSync already makes this script
// blocking end-to-end, so a blocking backoff between attempts is consistent.
function sleepSync(ms) {
  if (ms <= 0) return;
  const view = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(view, 0, 0, ms);
}

function tryParseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function lastErrorLine(result) {
  const combined = `${result.stdout || ""}\n${result.stderr || ""}`;
  const lines = combined
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length > 0) return lines[lines.length - 1];
  return result.error ? result.error.message : "unknown error";
}

function buildRows(json, severities) {
  const vulns = json.vulnerabilities || {};
  const rows = [];
  for (const [name, info] of Object.entries(vulns)) {
    if (!severities.includes(info.severity)) continue;
    const viaList = Array.isArray(info.via) ? info.via : [info.via];
    const detailed = viaList.filter((v) => v && typeof v === "object");
    if (detailed.length === 0) {
      rows.push({
        name,
        severity: info.severity,
        title: "(see npm audit for detail)",
        range: info.range || "(range unknown)",
        ghsaId: null,
      });
      continue;
    }
    for (const v of detailed) {
      rows.push({
        name,
        severity: info.severity,
        title: v.title || v.name || "(untitled advisory)",
        range: v.range || info.range || "(range unknown)",
        ghsaId: ghsaIdFromVia(v),
      });
    }
  }
  return rows;
}

function printRows(rows, { noticePrefix = false } = {}) {
  rows.forEach((r, i) => {
    const label = r.severity.toUpperCase();
    const prefix = noticePrefix && i === 0 ? "::notice::" : "";
    console.log(
      `${prefix}${label}: ${r.name} (severity=${r.severity}) — ${r.title} — range ${r.range}`,
    );
  });
}

function printAdvisories(json, { severities = ["critical"], noticePrefix = false } = {}) {
  printRows(buildRows(json, severities), { noticePrefix });
}

function runAttempt(level) {
  const { cmd, args } = auditCommand(level);
  return spawnSync(cmd, args, {
    shell: false,
    timeout: ATTEMPT_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER,
    env: process.env,
    encoding: "utf8",
  });
}

function runAuditLoop({ level, reportOnly, backoffs, allowlist, today }) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const result = runAttempt(level);
    const json = tryParseJson(result.stdout);

    // (A)/(B): a usable audit result — decide on its content, not its exit code
    // (npm exits non-zero for a real finding at/above --audit-level, and 0 for
    // a clean audit; both cases parse here).
    if (json && json.metadata && json.metadata.vulnerabilities) {
      const counts = json.metadata.vulnerabilities;
      const critical = counts.critical || 0;
      const high = counts.high || 0;
      if (reportOnly) {
        console.log(`advisories: critical=${critical} high=${high} (report-only, level=${level})`);
        if (high + critical > 0) {
          printAdvisories(json, { severities: ["critical", "high"], noticePrefix: true });
        }
        if (critical > 0) {
          const { suppressed } = partitionByAllowlist(
            buildRows(json, ["critical"]),
            allowlist,
            today,
          );
          printSuppressed(suppressed);
        }
        return 0;
      }
      if (critical > 0) {
        const { remaining, suppressed } = partitionByAllowlist(
          buildRows(json, ["critical"]),
          allowlist,
          today,
        );
        printSuppressed(suppressed);
        if (remaining.length > 0) {
          printRows(remaining);
          console.log(`::error::${remaining.length} critical production advisory(ies) found`);
          return 1;
        }
        console.log("all critical advisories are allowlisted (expiring)");
        return 0;
      }
      console.log(`advisories: critical=0 (level=${level}) — no critical production advisories`);
      return 0;
    }

    // No usable JSON. Decide (C) outage vs (D) unknown failure from the raw text.
    const combinedText = `${result.stdout || ""}\n${result.stderr || ""}\n${
      result.error ? result.error.message : ""
    }`;

    if (isOutage(combinedText)) {
      if (attempt < MAX_ATTEMPTS) {
        const wait = backoffs[attempt - 1] ?? backoffs[backoffs.length - 1] ?? 0;
        console.log(
          `npm audit attempt ${attempt}/${MAX_ATTEMPTS} hit a registry/transport error, retrying in ${wait}ms: ${lastErrorLine(result)}`,
        );
        sleepSync(wait);
        continue;
      }
      console.log(
        `::warning::npm advisory registry unavailable after ${MAX_ATTEMPTS} attempts (${lastErrorLine(result)}) — critical-advisory gate SKIPPED for this run; Dependabot alerts remain the standing net`,
      );
      return 0;
    }

    // (D) Any other non-zero exit / unparseable output that isn't a recognized
    // outage — fail closed, unless this is the always-green report-only lane.
    console.log(`npm audit failed unexpectedly (exit ${result.status}, level=${level})`);
    const stderrTail = (result.stderr || "").split(/\r?\n/).slice(-20).join("\n").trim();
    if (stderrTail) console.log(stderrTail);
    if (reportOnly) {
      console.log("::warning::report-only advisory check failed unexpectedly — not blocking");
      return 0;
    }
    console.log(`::error::npm audit failed unexpectedly (exit ${result.status})`);
    return 1;
  }

  // Unreachable — the loop always returns — but keep a safe fallback.
  return reportOnly ? 0 : 1;
}

function main() {
  const { level, reportOnly } = parseArgs(process.argv.slice(2));
  const backoffs = backoffSchedule();

  const allowlistLoad = loadAllowlist();
  if (!allowlistLoad.ok) {
    // Already printed ::error::. Fail closed on the blocking gate; --report-only never fails,
    // consistent with every other branch below.
    return reportOnly ? 0 : 1;
  }
  const allowlist = allowlistLoad.entries;
  const today = todayUtcDate();
  const expired = allowlist.filter((e) => e.expires < today);
  for (const e of expired) {
    console.log(`::error::ALLOWLIST EXPIRED ${e.id} — ${e.followUp}`);
  }

  const exitCode = runAuditLoop({ level, reportOnly, backoffs, allowlist, today });

  if (!reportOnly && expired.length > 0) {
    // Rot guard: an expired entry fails the blocking gate regardless of what this run's audit
    // found — otherwise a fixed/no-longer-reported advisory would let a stale entry hide forever.
    return 1;
  }
  return exitCode;
}

process.exit(main());
