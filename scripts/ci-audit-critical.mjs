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
// present-but-malformed one (bad JSON, missing field, bad date, or an `ackedOn` after today —
// an ack can't be timestamped in the future) fails closed — `::error::` + exit 1 — without ever
// running npm audit. An entry past its `expires` always fails the blocking gate
// (`::error::ALLOWLIST EXPIRED …`), even if the advisory it names no longer appears in the
// current audit output, so a stale entry can't rot silently. --report-only never fails on any of
// this — an expired entry there prints `::warning::ALLOWLIST EXPIRED …` instead (still visible,
// never blocking), and both the ALLOWLISTED and EXPIRED lines are derived by walking
// `vulnerabilities` directly rather than npm's `metadata.vulnerabilities` rollup, same as the
// blocking lane.
//
// A package also floors back to its own npm-reported severity when a `via` entry is a bare
// string naming a package with NO top-level entry in `vulnerabilities` at all — npm's pointer
// invariant (a string via always points to another top-level package) is violated, so that
// pointer's severity is unknowable and the gate fails closed on it rather than trusting whatever
// (possibly lower) rows remain.

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

const ALLOWLIST_REQUIRED_FIELDS = [
  "id",
  "package",
  "reason",
  "expires",
  "ackedBy",
  "ackedOn",
  "followUp",
];
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ALLOWLIST_WINDOW_DAYS = 60;
const MS_PER_DAY = 86_400_000;

// A real UTC calendar date, not just YYYY-MM-DD shape: "2026-13-45" and "2026-02-30" both match
// the shape regex, but neither round-trips through Date — the first parses to Invalid Date
// (NaN), the second silently rolls over to 2026-03-02. Round-tripping through toISOString and
// comparing back to the original string catches both.
function isValidUtcDate(s) {
  if (typeof s !== "string" || !ISO_DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return false;
  return d.toISOString().slice(0, 10) === s;
}

// Loads and validates the allowlist. A missing file is NOT an error (no allowlist configured
// yet) — { ok: true, entries: [] }. A present-but-malformed file fails closed — { ok: false }
// — having already printed ::error:: for the caller to surface; the caller must not fall back
// to "no allowlist" in that case. `today` (UTC YYYY-MM-DD) is passed in rather than recomputed
// here so main() and this function agree on one instant — Round-4 pin 2: an entry whose
// `ackedOn` is after `today` (a plain string compare, valid for zero-padded ISO dates) fails
// closed too, before npm is ever spawned — an ack timestamped in the future is unverifiable.
function loadAllowlist(today) {
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
    if (!isValidUtcDate(entry.expires)) {
      console.log(
        `::error::CI audit allowlist ${allowlistPath} entry ${entry.id} has an invalid "expires" (want a real UTC calendar date, YYYY-MM-DD): ${entry.expires}`,
      );
      return { ok: false, entries: [] };
    }
    if (!isValidUtcDate(entry.ackedOn)) {
      console.log(
        `::error::CI audit allowlist ${allowlistPath} entry ${entry.id} has an invalid "ackedOn" (want a real UTC calendar date, YYYY-MM-DD): ${entry.ackedOn}`,
      );
      return { ok: false, entries: [] };
    }
    if (entry.ackedOn > today) {
      console.log(
        `::error::CI audit allowlist ${allowlistPath} entry ${entry.id} has "ackedOn" ${entry.ackedOn} in the future (today is ${today})`,
      );
      return { ok: false, entries: [] };
    }
    const expiresMs = Date.parse(`${entry.expires}T00:00:00Z`);
    const ackedMs = Date.parse(`${entry.ackedOn}T00:00:00Z`);
    const windowDays = (expiresMs - ackedMs) / MS_PER_DAY;
    if (windowDays < 0) {
      console.log(
        `::error::CI audit allowlist ${allowlistPath} entry ${entry.id} has "expires" ${entry.expires} before "ackedOn" ${entry.ackedOn}`,
      );
      return { ok: false, entries: [] };
    }
    if (windowDays > MAX_ALLOWLIST_WINDOW_DAYS) {
      console.log(
        `::error::CI audit allowlist ${allowlistPath} entry ${entry.id} spans ${windowDays} days from "ackedOn" ${entry.ackedOn} to "expires" ${entry.expires} — max ${MAX_ALLOWLIST_WINDOW_DAYS}`,
      );
      return { ok: false, entries: [] };
    }
  }
  return { ok: true, entries: parsed.entries };
}

// The GHSA id usually lives in a `via` detail's `url`
// (https://github.com/advisories/GHSA-xxxx-xxxx-xxxx); fall back to `.source`/`.name` in case a
// future npm audit shape moves it.
// Right-anchored so a malformed/longer id (e.g. a URL slug ending "…GHSA-xxxx-xxxx-xxxx00")
// never matches as a substring — (?![0-9a-z]) refuses a match whose last group is immediately
// followed by another alnum character, under the same /i flag as the rest of the pattern.
function ghsaIdFromVia(v) {
  const candidates = [v.url, v.source, v.name].filter((s) => typeof s === "string");
  for (const candidate of candidates) {
    const m = candidate.match(/GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}(?![0-9a-z])/i);
    if (m) return m[0];
  }
  return null;
}

// A row's own severity for gate purposes: the via's own `severity` when the via is an object
// that carries one, else the fallback (the package-level severity buildRows already fell back
// to for a string via / no detail).
function advisorySeverityOf(v, fallback) {
  return v && typeof v === "object" && typeof v.severity === "string" ? v.severity : fallback;
}

function matchingAllowlistEntry(row, allowlist) {
  if (!row.ghsaId) return null;
  // Exact equality, case-insensitive: the extracted id is lowercased and compared against the
  // allowlist entry's id lowercased — never a substring/startsWith check.
  const rowId = row.ghsaId.toLowerCase();
  return allowlist.find((e) => e.id.toLowerCase() === rowId && e.package === row.name) || null;
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
      // No object via to read a per-advisory severity from (a string/transitive reference, or
      // no via at all) — conservative fallback: keep the package's reported severity, and since
      // ghsaId is null this row can never match an allowlist entry either (see
      // matchingAllowlistEntry) — it cannot be suppressed.
      rows.push({
        name,
        severity: info.severity,
        advisorySeverity: info.severity,
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
        advisorySeverity: advisorySeverityOf(v, info.severity),
        title: v.title || v.name || "(untitled advisory)",
        range: v.range || info.range || "(range unknown)",
        ghsaId: ghsaIdFromVia(v),
      });
    }
  }
  return rows;
}

// Names (restricted to `severities`) of packages whose `via` list contains at least one bare
// string. In real npm audit output a string via is a POINTER to another package's own top-level
// `vulnerabilities` entry (e.g. `next`'s via list routinely includes a plain "postcss" alongside
// two dozen detailed GHSA objects) — it is not itself an addressable advisory, so buildRows never
// makes a row for it when detailed object vias are also present. MINOR 7: if suppression removes
// every one of a package's detailed rows and it had a string via, we can't tell whether that via
// independently justified the package's reported severity — so its severity is floored back in
// by applyStringViaFloor, but ONLY when suppression would otherwise leave zero remaining rows.
// When other non-suppressed rows already remain (e.g. `next`'s 21 non-critical advisories), the
// package is already correctly represented and the floor must not re-add it.
function packagesWithStringVia(json, severities) {
  const vulns = json.vulnerabilities || {};
  const names = new Set();
  for (const [name, info] of Object.entries(vulns)) {
    if (!severities.includes(info.severity)) continue;
    const viaList = Array.isArray(info.via) ? info.via : [info.via];
    if (viaList.some((v) => typeof v === "string")) names.add(name);
  }
  return names;
}

// Mutates `remaining` in place, appending one unsuppressible floor row (ghsaId null) for each
// package in `stringViaPackages` that has zero rows left in `remaining` — see
// packagesWithStringVia for the rule.
function applyStringViaFloor(remaining, stringViaPackages, json) {
  const remainingNames = new Set(remaining.map((r) => r.name));
  for (const name of stringViaPackages) {
    if (remainingNames.has(name)) continue;
    const info = json.vulnerabilities[name];
    if (!info) continue;
    remaining.push({
      name,
      severity: info.severity,
      advisorySeverity: info.severity,
      title: "(see npm audit for detail — string via, all known advisories suppressed)",
      range: info.range || "(range unknown)",
      ghsaId: null,
    });
  }
}

// Names (restricted to `severities`) of packages whose `via` list contains at least one bare
// string that does NOT correspond to a top-level entry in `vulnerabilities`. In real npm audit
// output a string via is a POINTER to another package's own top-level entry — that's an
// invariant of the format. Round-4 pin 1: when a package's pointer names something with no
// top-level entry at all, the invariant is violated and we cannot read that pointer's severity,
// so we can't trust the package's other (possibly lower) remaining rows to speak for it. This is
// deliberately broader than packagesWithStringVia's MINOR-7 case — it floors the package even
// when it still has other non-suppressed rows, because none of those rows can vouch for a
// pointer target we can't see.
function packagesWithGhostStringVia(json, severities) {
  const vulns = json.vulnerabilities || {};
  const names = new Set();
  for (const [name, info] of Object.entries(vulns)) {
    if (!severities.includes(info.severity)) continue;
    const viaList = Array.isArray(info.via) ? info.via : [info.via];
    if (viaList.some((v) => typeof v === "string" && !(v in vulns))) names.add(name);
  }
  return names;
}

// Mutates `remaining` in place. For each package in `ghostPackages` (see
// packagesWithGhostStringVia), ensures at least one remaining row's advisorySeverity reaches the
// package's own npm-reported severity — appending an unsuppressible floor row (ghsaId null)
// unless a remaining row already reaches that severity. Runs after applyStringViaFloor so a
// package the MINOR-7 floor already restored to its reported severity is never floored twice.
function applyGhostViaFloor(remaining, ghostPackages, json) {
  for (const name of ghostPackages) {
    const info = json.vulnerabilities[name];
    if (!info) continue;
    const alreadyFloored = remaining.some(
      (r) => r.name === name && severityRank(r.advisorySeverity) >= severityRank(info.severity),
    );
    if (alreadyFloored) continue;
    remaining.push({
      name,
      severity: info.severity,
      advisorySeverity: info.severity,
      title:
        "(see npm audit for detail — dangling string via, pointer target missing from vulnerabilities)",
      range: info.range || "(range unknown)",
      ghsaId: null,
    });
  }
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

// npm's own severity ordering.
const SEVERITY_RANK = { critical: 4, high: 3, moderate: 2, low: 1, info: 0 };

function severityRank(severity) {
  return severity in SEVERITY_RANK ? SEVERITY_RANK[severity] : -1;
}

// A package's effective severity AFTER suppression = the max advisorySeverity over its still-
// remaining (non-suppressed) rows. A package whose only row is the string-via/no-detail
// fallback (advisorySeverity pinned to the package severity, ghsaId null — see buildRows) can
// never be suppressed, so it always keeps contributing its reported severity here.
function effectiveSeverityByPackage(rows) {
  const bySeverity = new Map();
  for (const row of rows) {
    const current = bySeverity.get(row.name);
    if (current === undefined || severityRank(row.advisorySeverity) > severityRank(current)) {
      bySeverity.set(row.name, row.advisorySeverity);
    }
  }
  return bySeverity;
}

// Rows for packages whose effective severity is still critical after suppression. Only rows
// whose OWN advisorySeverity is "critical" get the CRITICAL: prefix (that's why the package is
// still blocking); a package's other remaining, non-critical rows print underneath it as
// "  also: <severity> — <title> — range <range>" so they're visible without being counted as
// critical. Returns the number of CRITICAL: rows printed — the caller uses this, not
// rows.length, as N in the ::error:: line.
function printCriticalRemainingRows(rows) {
  const byPackage = new Map();
  for (const r of rows) {
    if (!byPackage.has(r.name)) byPackage.set(r.name, []);
    byPackage.get(r.name).push(r);
  }
  let criticalCount = 0;
  for (const packageRows of byPackage.values()) {
    for (const r of packageRows) {
      if (r.advisorySeverity !== "critical") continue;
      console.log(
        `CRITICAL: ${r.name} (advisory=${r.advisorySeverity}, package=${r.severity}) — ${r.title} — range ${r.range}`,
      );
      criticalCount++;
    }
    for (const r of packageRows) {
      if (r.advisorySeverity === "critical") continue;
      console.log(`  also: ${r.advisorySeverity} — ${r.title} — range ${r.range}`);
    }
  }
  return criticalCount;
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
        // Round-4 pin 3: whether to print advisories/suppressions is decided by walking
        // `json.vulnerabilities` itself (buildRows), never by npm's `metadata.vulnerabilities`
        // rollup (`critical`/`high` above are logged for visibility only) — the same
        // never-trust-the-rollup rule the blocking lane already follows, so a stale/inconsistent
        // rollup can never hide a real advisory from this report either.
        const advisoryRows = buildRows(json, ["critical", "high"]);
        if (advisoryRows.length > 0) {
          printRows(advisoryRows, { noticePrefix: true });
        }
        const criticalRows = buildRows(json, ["critical"]);
        if (criticalRows.length > 0) {
          const { suppressed } = partitionByAllowlist(criticalRows, allowlist, today);
          printSuppressed(suppressed);
        }
        return 0;
      }
      // npm's package-level metadata rollup (`counts.critical`) is printed below as an info
      // line ONLY — it is never read for the pass/fail decision. The decision is always derived
      // by walking `json.vulnerabilities` itself (via buildRows/effectiveSeverityByPackage), so
      // a stale or inconsistent rollup (metadata says 0 while a package entry is still
      // `severity: "critical"`) can never let a real critical slip through.
      const { remaining, suppressed } = partitionByAllowlist(
        buildRows(json, ["critical"]),
        allowlist,
        today,
      );
      applyStringViaFloor(remaining, packagesWithStringVia(json, ["critical"]), json);
      applyGhostViaFloor(remaining, packagesWithGhostStringVia(json, ["critical"]), json);
      console.log(`npm metadata: critical=${critical}`);
      printSuppressed(suppressed);

      const effectiveSeverity = effectiveSeverityByPackage(remaining);
      const criticalPackages = new Set(
        [...effectiveSeverity.entries()]
          .filter(([, severity]) => severity === "critical")
          .map(([name]) => name),
      );

      if (criticalPackages.size > 0) {
        const blockingRows = remaining.filter((r) => criticalPackages.has(r.name));
        const criticalRowCount = printCriticalRemainingRows(blockingRows);
        console.log(`::error::${criticalRowCount} critical production advisory(ies) found`);
        return 1;
      }

      if (suppressed.length > 0) {
        for (const name of new Set(suppressed.map((s) => s.row.name))) {
          const k = remaining.filter((r) => r.name === name).length;
          if (k > 0) {
            console.log(
              `${name}: ${k} non-critical advisory(ies) remain (see the high-severity report step)`,
            );
          }
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
  const today = todayUtcDate();

  const allowlistLoad = loadAllowlist(today);
  if (!allowlistLoad.ok) {
    // Already printed ::error::. Fail closed on the blocking gate; --report-only never fails,
    // consistent with every other branch below.
    return reportOnly ? 0 : 1;
  }
  const allowlist = allowlistLoad.entries;
  const expired = allowlist.filter((e) => e.expires < today);
  for (const e of expired) {
    // Round-4 pin 3: --report-only never fails, so an expired entry there is only a warning —
    // ::error:: is reserved for the blocking gate, which still fails via the rot guard below.
    const prefix = reportOnly ? "::warning::" : "::error::";
    console.log(`${prefix}ALLOWLIST EXPIRED ${e.id} — ${e.followUp}`);
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
