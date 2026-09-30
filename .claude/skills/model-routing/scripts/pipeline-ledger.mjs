#!/usr/bin/env node
// pipeline-ledger.mjs
//
// Persists dev-pipeline (pipeline.js) run results to a per-project JSONL ledger
// and summarizes that ledger, so the pipeline's tuning rules ("cut a phase
// with zero confirmed findings across ten runs", etc.) can actually be
// evaluated instead of re-argued from memory every time.
//
// No dependencies. Node >= 18. ES module.
//
// Commands:
//   append <result.json> --run <name> [--started <iso>] [--ended <iso>]
//          [--project <dir>] [--branch <name>] [--pr <n>] [--note <text>]
//          [--approach dev-pipeline|superpowers|raw] [--task-ref <id>]
//          [--profile <name>] [--usage-override-reason <text>]
//   append-manual --run <slug> --approach superpowers|raw --session <sid>
//          [--project <dir>] [--task-ref <id>] [--first-pass-green true|false]
//          [--findings <critical>,<important>,<minor>] [--human-minutes <n>]
//          [--files-touched <n>] [--lines-changed <n>]
//          [--started <iso>] [--ended <iso>]
//   attribute --run <slug> --bug <id> [--project <dir>]
//   compare [--min-n 10] [--json] [--project <dir>]
//   summary [--project <dir>] [--last N] [--json]
//   selftest
//
// This script only ever reads/writes:
//   - the result.json path given on the command line (append)
//   - <project>/.claude/pipeline/cost-ledger.jsonl (append/append-manual/
//     attribute/summary/compare; project defaults to the current working
//     directory)
//   - a temp directory under os.tmpdir() (selftest only)
//
// append-manual shells out to session-usage.mjs (next to this script) via
// execFileSync to get true cost/active time for the whole session -- there
// is no phaseReport for a superpowers/raw run to estimate from. The
// PIPELINE_LEDGER_USAGE_SCRIPT env var overrides which script path is
// invoked, and is honoured ONLY when set -- selftest points it at a tiny
// fake script so the real transcript-scanning script is never exercised by
// a unit test; normal use never sets it.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(__filename);

// Part C 2026-09-12: the three first-class evaluation arms an `approach`
// field (row-level, or the `append`/`append-manual` --approach flag) is
// constrained to. A value outside this set is refused at the CLI boundary
// (buildRow itself stays permissive -- it just passes through whatever a
// trusted result.json/meta value already is).
const APPROACH_VALUES = ["dev-pipeline", "superpowers", "raw"];

// Override for the session-usage.mjs path append-manual shells out to.
// Used ONLY when set (selftest points this at a tiny fake script so the
// real transcript-scanning script is never exercised by a unit test); real
// use always resolves session-usage.mjs next to this script.
const USAGE_SCRIPT_ENV = "PIPELINE_LEDGER_USAGE_SCRIPT";

// Canonical phase order, per the dev-pipeline engine.
const PHASE_ORDER = [
  "Baseline",
  "Author tests",
  "Red gate",
  "Implement",
  "Gate & Review",
  "Verify",
  "UI verify",
  "Mutation probe",
  "Fix",
  "Final pass",
];

// Phases that can author brand-new findings (as opposed to Verify/UI
// verify/Fix, which consume or act on findings other phases produced).
const AUTHORING_PHASES = ["Baseline", "Red gate", "Gate & Review", "Mutation probe", "Final pass"];
const CONSUMING_PHASES = ["Verify", "UI verify", "Fix"];

// A7 signal-not-volume lens families (ROUTING-PLAN.md A7 / skills-upgrade
// ruling A7), per the methodologyNotes in routing-scorecard-2026-09-10.json:
// deep lenses carry the correctness check; pattern lenses are the routine
// reviewers. A lens name outside both lists still gets a lensScorecard row,
// it just cannot be classified into the Gate & Review level split.
const PATTERN_LENSES = ["test-quality", "design-system", "operability", "scope-coverage"];
const DEEP_LENSES = ["correctness", "edge-cases-and-security", "spec-compliance"];

function lensFamily(lensName) {
  if (DEEP_LENSES.includes(lensName)) return "deep";
  if (PATTERN_LENSES.includes(lensName)) return "pattern";
  return null;
}

// task levels for the routing scorecard (owner ruling, ROUTING-PLAN.md §2/§9).
// "Gate & Review" is not listed here -- it is split into synthetic
// "Gate & Review (pattern lenses)" / "Gate & Review (deep lenses)" phase
// labels by computeRoutingScorecard, keyed on each lens's own family, only
// when row.lenses actually tells them apart.
const LEVEL_PHASES = {
  mechanical: ["Baseline"],
  routineBuild: ["Author tests", "Implement"],
  routineVerdict: ["Mutation probe", "UI verify"],
  highRiskVerdict: ["Red gate", "Verify", "Final pass"],
  fixExecution: ["Fix"],
};
const PHASE_TO_LEVEL = {};
for (const [level, phaseNames] of Object.entries(LEVEL_PHASES)) {
  for (const name of phaseNames) PHASE_TO_LEVEL[name] = level;
}

// Extracts per-lens A7 telemetry from a pipeline result.json, in the ledger's
// storage shape: {lens, model, rawFindings, executionConfirmed, overturned}.
// Two producer shapes are supported -- `result.lensReport` (an array of
// already-aggregated per-lens objects) or `result.confirmedFindings[].lens`
// (a flat per-finding list this function tallies itself). Neither has
// shipped in ANY result.json examined for this change (verified against
// every run under C:\ClaudeCode\routeflow\.claude\pipeline\, 2026-09-11) --
// this stays inert ([]) until pipeline.js actually emits one of the two.
function extractLenses(result) {
  if (Array.isArray(result?.lensReport)) {
    return result.lensReport
      .map((l) => ({
        lens: l?.lens ?? l?.name ?? null,
        model: l?.model ?? null,
        rawFindings: numOrNull(l?.rawFindings),
        executionConfirmed: numOrNull(l?.executionConfirmed ?? l?.confirmed),
        overturned: numOrNull(l?.overturned),
      }))
      .filter((l) => typeof l.lens === "string");
  }
  const confirmedFindings = arrOrEmpty(result?.confirmedFindings);
  if (!confirmedFindings.some((f) => f && typeof f.lens === "string")) return [];
  const byLens = new Map();
  for (const f of confirmedFindings) {
    if (!f || typeof f.lens !== "string") continue;
    const entry =
      byLens.get(f.lens) ?? { lens: f.lens, model: f.model ?? null, rawFindings: 0, executionConfirmed: 0, overturned: 0 };
    entry.rawFindings += 1;
    if (f.overturned === true) entry.overturned += 1;
    else entry.executionConfirmed += 1;
    byLens.set(f.lens, entry);
  }
  return [...byLens.values()];
}

class LedgerError extends Error {
  constructor(message, code = 2) {
    super(message);
    this.name = "LedgerError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

// Strips a leading UTF-8 BOM (U+FEFF) from file content before JSON.parse.
// A BOM is a normal, common artifact of how some tools/editors write UTF-8
// on Windows (e.g. PowerShell's default `>`/Out-File encoding) -- it is not
// malformed input, but JSON.parse rejects it outright ("Unexpected token
// '﻿'") even though the rest of the content is perfectly valid JSON.
// This script never WRITES a BOM itself (fs.writeFileSync/appendFileSync
// with "utf8" never emit one) -- this only guards content this script reads
// back in that may have been produced by another tool/process.
function stripBom(text) {
  return typeof text === "string" && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function numOrNull(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function arrOrEmpty(v) {
  return Array.isArray(v) ? v : [];
}

function mean(values) {
  const nums = values.filter((v) => typeof v === "number" && Number.isFinite(v));
  if (nums.length === 0) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function sum(values) {
  return values
    .filter((v) => typeof v === "number" && Number.isFinite(v))
    .reduce((a, b) => a + b, 0);
}

function median(values) {
  const nums = values.filter((v) => typeof v === "number" && Number.isFinite(v)).sort((a, b) => a - b);
  if (nums.length === 0) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 === 0 ? (nums[mid - 1] + nums[mid]) / 2 : nums[mid];
}

function fmtMoney(v) {
  return v == null ? "n/a" : `$${v.toFixed(2)}`;
}

function fmtNum(v, digits = 1) {
  return v == null ? "n/a" : v.toFixed(digits);
}

function fmtPct(fraction) {
  return fraction == null ? "n/a" : `${(fraction * 100).toFixed(1)}%`;
}

function fmtDuration(ms) {
  if (ms == null || !Number.isFinite(ms)) return "n/a";
  const sign = ms < 0 ? "-" : "";
  const totalSec = Math.round(Math.abs(ms) / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${sign}${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// Generic aligned-column table printer for plain-text summary output.
function printTable(headers, rows) {
  const widths = headers.map((h, i) =>
    Math.max(String(h).length, ...rows.map((r) => String(r[i]).length), 0)
  );
  const fmtRow = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join("  ");
  console.log(fmtRow(headers));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const r of rows) console.log(fmtRow(r));
}

function parseFlags(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === "--json") {
      flags.json = true;
      continue;
    }
    if (tok.startsWith("--")) {
      const name = tok.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        flags[name] = true;
      } else {
        flags[name] = next;
        i++;
      }
      continue;
    }
    positional.push(tok);
  }
  return { positional, flags };
}

function getLedgerPath(projectDir) {
  return path.join(projectDir, ".claude", "pipeline", "cost-ledger.jsonl");
}

function printHelp() {
  console.log(`pipeline-ledger.mjs - append/summarize dev-pipeline run results

Usage:
  node pipeline-ledger.mjs append <result.json> --run <name>
      [--started <iso>] [--ended <iso>] [--project <dir>]
      [--branch <name>] [--pr <n>] [--note <text>]
      [--usage <session-usage.json>] [--run-id <id>]
      [--telemetry legacy|true] [--usage-override-reason <text>]
      [--approach dev-pipeline|superpowers|raw] [--task-ref <id>]
      [--profile <name>]

      Appends one JSON line for this run to
      <project>/.claude/pipeline/cost-ledger.jsonl (project defaults to
      the current working directory). Refuses (exit 2) if <result.json>
      is missing, not valid JSON, or has no phaseReport array.

      --usage <file>   Output of model-routing/scripts/session-usage.mjs
                        for the session that ran this pipeline. When given,
                        the matching workflow run (by --run-id, or the sole
                        entry in usage.workflows when there is only one) is
                        used to fill each phases[].tokens with the true
                        per-phase token count (phases[].tokensSource becomes
                        "session-usage", phases[].usage carries the byPhase
                        entry, phases[].costUsd the true per-phase cost),
                        and to set the row-level sessionUsage, cacheHitRatio,
                        activeMs and trueCostUsd fields. Phases with no
                        match keep tokensSource "budget" and costUsd null.
      --run-id <id>    Disambiguates which usage.workflows[...] entry is
                        this run, when --usage's session covers more than
                        one workflow run. Ignored without --usage.
      --telemetry <v>  Overrides the row's telemetry marker ("legacy" or
                        "true"). Defaults to "true" when --usage is given,
                        else "legacy" -- lets old ledger rows and new
                        true-telemetry rows be told apart and kept out of
                        the same ten-run denominator.
      --subagent-tokens  Deprecated, ignored. This flag was documented in
                        CLAUDE.md/bug-pipeline SKILL.md but the underlying
                        mechanism never existed; --usage replaces it. Passing
                        it prints a warning and has no effect.
      --usage-override-reason <text>
                        P2(c) 2026-09-11: the recorded reason a caller (e.g.
                        closeout.mjs --no-usage --reason) gave for skipping
                        real telemetry. Stored on the row as
                        usageOverrideReason (null when not given) -- lets a
                        legacy row that explicitly declared why it has no
                        true telemetry be told apart from one that didn't.
      --approach <x>   Part C 2026-09-12: dev-pipeline|superpowers|raw. Which
                        evaluation arm this run belongs to. result.approach
                        wins when result.json already carries one (e.g.
                        closeout.mjs stamps it); this is the pass-through for
                        callers that don't.
      --task-ref <id>  Plane/registry id (or a one-line head) this run did.
                        result.taskRef wins over this flag when both are given.
      --profile <name> dev-pipeline profile (e.g. "lean"/"standard"). Feeds
                        the routing scorecard's profile split and the
                        approach-comparison arms below. result.profile wins
                        over this flag when both are given.

  node pipeline-ledger.mjs append-manual --run <slug>
      --approach superpowers|raw --session <sid> [--project <dir>]
      [--task-ref <id>] [--first-pass-green true|false]
      [--findings <critical>,<important>,<minor>] [--human-minutes <n>]
      [--files-touched <n>] [--lines-changed <n>]
      [--started <iso>] [--ended <iso>]

      Part C 2026-09-12: records one whole-session non-engine (superpowers or
      raw) run. There is no phaseReport to estimate from, so true cost and
      active time are read straight from session-usage.mjs (or the
      PIPELINE_LEDGER_USAGE_SCRIPT override -- see the module header) via
      "<script> <sid> --all --project <dir> --json". Refuses (exit 2) without
      --run/--approach/--session, or with --approach outside
      superpowers|raw. Never overwrites an existing --run slug: prints the
      existing row and refuses (exit 3).

  node pipeline-ledger.mjs attribute --run <slug> --bug <id> [--project <dir>]

      Part C 2026-09-12: attaches one escaped bug found after the fact to an
      already-appended row -- bumps that row's quality.escapedDefects and
      appends to quality.escapedBugs. Rewrites the whole ledger file (JSONL
      has no in-place row update). Refuses (exit 3) if --run isn't found.

  node pipeline-ledger.mjs compare [--min-n 10] [--json] [--project <dir>]

      Part C 2026-09-12: compares the three evaluation arms (dev-pipeline,
      sub-grouped by profile; superpowers; raw) over telemetry:'true' rows
      with a non-null trueCostUsd -- n, mean/median true cost, median active
      minutes, first-pass-green rate, mean review findings by severity, and
      mean escaped defects. An arm with n below --min-n (default 10) prints
      "insufficient (n=<k>)" and is excluded from ranking. The final line
      names the cheapest arm among sufficient, AUDITED arms (at least one row
      ever touched by \`attribute\`) whose escaped-defect rate is not worse
      than the best -- an arm nobody has ever audited (meanEscapedDefects
      null, shown as "n/a") can never win or tie for cheapest against a
      confirmed-clean one, even when it is cheaper.

  node pipeline-ledger.mjs summary [--project <dir>] [--last N] [--json]

      Reads the ledger and prints run stats, a phase table split by
      tokensSource (budget vs session-usage -- their token counts are never
      mixed in one share-of-total denominator), the ten-run tuning-rule
      evaluations (Red gate counted via redGate.audits[].blockers, not
      phases[].confirmed, so a working red gate with real findings is never
      mistaken for a zero-finding candidate), verify economics, red gate
      stats, final pass stats, overlap counts, and the routing scorecard
      (grouped by level/phase/model/profile/approach). Also reports
      meanTrueCostUsd, meanActiveMs and costEstimateError (mean of
      trueCostUsd/estimatedCostUsd) over rows carrying true telemetry.
      --last N restricts to the newest N rows. --json prints the same data
      as JSON instead of text.

  node pipeline-ledger.mjs selftest

      Copies fixtures/f14-result.json into a temp project dir, appends it
      twice under different run names (one plain, one with a synthetic
      --usage file), runs summary, and asserts the ledger and summary --
      including the tokensSource split and true-cost fields -- look right.
      Also exercises append-manual/attribute/compare against scratch ledgers.
      Exits 0 on success, 1 on a failed assertion.

  node pipeline-ledger.mjs --help

Ledger path: <project>/.claude/pipeline/cost-ledger.jsonl (JSON Lines,
append-only, one row per run).

PIPELINE_LEDGER_USAGE_SCRIPT (env var): overrides the session-usage.mjs path
append-manual shells out to. Honoured ONLY when set -- selftest points it at
a tiny fake script; normal use never sets it.`);
}

// ---------------------------------------------------------------------------
// append
// ---------------------------------------------------------------------------

// Picks the one usage.workflows[...] entry that is this run: --run-id when
// given, else the sole entry when there is exactly one, else none (the
// caller falls back to tokensSource "budget" throughout and the append
// summary notes the run went unmatched).
// Strips a "wf_" prefix if present, for prefix-matching truncated run ids.
function stripWfPrefix(id) {
  return typeof id === "string" && id.startsWith("wf_") ? id.slice(3) : id;
}

// Transcript directories (and therefore usage.workflows keys, or --run-id
// values sourced from them) can carry a TRUNCATED run id -- e.g.
// "wf_1ca39e59-6ea" standing in for a longer "wf_1ca39e59-6ea1-4f2b-...".
// Two ids match when one is a prefix of the other with at least 8 shared
// characters after the "wf_" prefix (short of that, a truncated id is too
// likely to collide with an unrelated run to trust).
function idsMatchAsTruncated(a, b) {
  const sa = stripWfPrefix(a);
  const sb = stripWfPrefix(b);
  if (!sa || !sb) return false;
  const shorter = sa.length <= sb.length ? sa : sb;
  const longer = sa.length <= sb.length ? sb : sa;
  return shorter.length >= 8 && longer.startsWith(shorter);
}

function selectMatchedWorkflow(usage, runId) {
  if (!usage || !usage.workflows || typeof usage.workflows !== "object") {
    return { workflow: null, reason: usage ? "no workflows in usage file" : null };
  }
  const keys = Object.keys(usage.workflows);
  if (runId) {
    if (Object.prototype.hasOwnProperty.call(usage.workflows, runId)) {
      return { workflow: usage.workflows[runId], reason: null };
    }
    // Exact key not found -- try truncated-id prefix matching. On multiple
    // candidates, prefer the longest common prefix (the closest match).
    const candidates = keys
      .filter((k) => idsMatchAsTruncated(k, runId))
      .map((k) => {
        const sa = stripWfPrefix(k) || "";
        const sb = stripWfPrefix(runId) || "";
        let commonLen = 0;
        while (commonLen < sa.length && commonLen < sb.length && sa[commonLen] === sb[commonLen]) commonLen++;
        return { key: k, commonLen };
      })
      .sort((x, y) => y.commonLen - x.commonLen);
    if (candidates.length > 0) {
      return { workflow: usage.workflows[candidates[0].key], reason: null };
    }
    return { workflow: null, reason: `--run-id '${runId}' not found in usage.workflows (have: ${keys.join(", ") || "none"})` };
  }
  if (keys.length === 1) return { workflow: usage.workflows[keys[0]], reason: null };
  if (keys.length === 0) return { workflow: null, reason: "usage.workflows is empty" };
  return {
    workflow: null,
    reason: `usage.workflows has ${keys.length} entries (${keys.join(", ")}) and no --run-id was given -- none applied`,
  };
}

// redGate.audits is an array of {attempt, ran, structurallyRed,
// behaviorallyRed, properlyRed, tests, blockers} in most real result.json
// files (blockers: string[], one per STRUCTURAL/BEHAVIORAL finding) -- but
// in aggregate-truncated runs (result.json > 64KB, reconstructed from the
// journal) redGate.audits degrades to a bare count with no blockers array
// at all (verified against C:\ClaudeCode\routeflow\.claude\pipeline\
// 2026-09-08-numbering-siblings\result.json, where audits:2). Only the
// former is countable; the latter must stay "not evaluable", never "zero
// findings" -- treating missing data as zero is exactly the bug that would
// cut a working red gate.
function computeRedGateBlockers(redGate) {
  if (!redGate || !Array.isArray(redGate.audits)) return { countable: false, blockersCount: null };
  let total = 0;
  let sawBlockersField = false;
  for (const a of redGate.audits) {
    if (a && Array.isArray(a.blockers)) {
      sawBlockersField = true;
      total += a.blockers.length;
    }
  }
  return sawBlockersField ? { countable: true, blockersCount: total } : { countable: false, blockersCount: null };
}

// Part C 2026-09-12: result.<field> wins over the matching CLI pass-through
// (meta.<field>) when both are given -- a trusted engine-authored value on
// the result object outranks an operator-typed flag on the append command.
function pickField(resultVal, metaVal) {
  if (typeof resultVal === "string" && resultVal.length > 0) return resultVal;
  if (typeof metaVal === "string" && metaVal.length > 0) return metaVal;
  return null;
}

// Derives quality.reviewFindings from result.confirmedFindings[].severity
// (blocker -> critical, major -> important, minor -> minor). Missing data
// (confirmedFindings not an array at all) stays null -- "unknown" is not
// the same claim as "zero findings", same principle as computeRedGateBlockers.
function computeReviewFindings(result) {
  if (!Array.isArray(result?.confirmedFindings)) return null;
  const out = { critical: 0, important: 0, minor: 0 };
  for (const f of result.confirmedFindings) {
    const sev = f?.severity;
    if (sev === "blocker") out.critical++;
    else if (sev === "major") out.important++;
    else if (sev === "minor") out.minor++;
  }
  return out;
}

// Part C 2026-09-12: the cross-approach quality rubric every ledger row
// carries (engine rows derive what they can from result.json; append-manual
// rows build this object directly from CLI flags instead of calling this).
// All null-safe -- missing source data reads as null, never a guessed 0/false.
function computeQuality(result) {
  const gatePassVal = result?.gate?.pass;
  const fixRoundsVal = numOrNull(result?.fixRounds);
  const firstPassGreen =
    typeof gatePassVal === "boolean" && fixRoundsVal != null ? gatePassVal === true && fixRoundsVal === 0 : null;

  const manifestFiles = result?.manifest?.files;
  const hasManifest = Array.isArray(manifestFiles);
  const touchedFiles = hasManifest
    ? manifestFiles.filter((f) => f && (f.status === "modified" || f.status === "planned"))
    : [];

  return {
    firstPassGreen,
    reviewFindings: computeReviewFindings(result),
    humanMinutes: numOrNull(result?.quality?.humanMinutes),
    escapedDefects: numOrNull(result?.quality?.escapedDefects),
    filesTouched: hasManifest ? touchedFiles.length : null,
    linesChanged: hasManifest ? sum(touchedFiles.map((f) => f?.changedLines)) : null,
  };
}

// Build the ledger row from a pipeline result object + run metadata.
// Every field on `result` is treated as optional/nullable. `usage` is the
// parsed output of session-usage.mjs (or null when --usage was not given).
function buildRow(result, meta, usage = null) {
  const { workflow: matchedWorkflow, reason: matchReason } = selectMatchedWorkflow(usage, meta.runId);
  // NOTE: an unmatched --run-id deliberately does NOT throw here -- F5
  // (2026-09-12) already gives this its own tracked shape: telemetry stays
  // "true" (real data was available), usageMatchNote records why nothing
  // matched, trueCostUsd/usageScope fall back to the session aggregate below,
  // and the summary's costEstimateError excludes these rows rather than
  // blending a session-blob cost into the matched-workflow mean. Other
  // callers (scorecards, manual comparisons) rely on that leniency and are
  // covered by this file's own selftest. The E6 fix (2026-09-15) -- refusing
  // to let an AUTOMATED close-out silently write a session-scoped row -- is
  // enforced upstream in closeout.mjs, which checks usage.workflows itself
  // and aborts (no append attempted at all) before ever calling this script.

  const phases = arrOrEmpty(result.phaseReport).map((p) => {
    const byPhaseEntry = matchedWorkflow?.byPhase?.[p?.phase] ?? null;
    return {
      phase: p?.phase ?? null,
      ran: p?.ran ?? null,
      agents: numOrNull(p?.agents),
      rawFindings: numOrNull(p?.rawFindings),
      // Confirmed counts are tracked per-phase-name on the result object,
      // not on the phaseReport entry itself.
      confirmed: numOrNull(result.confirmedByPhase?.[p?.phase]),
      tokens: byPhaseEntry ? numOrNull(byPhaseEntry.total?.tokens) : numOrNull(p?.tokens),
      estUsd: numOrNull(p?.estUsd),
      tokensSource: byPhaseEntry ? "session-usage" : "budget",
      usage: byPhaseEntry,
      costUsd: byPhaseEntry ? numOrNull(byPhaseEntry.total?.costUsd) : null,
      // Per-agent durationMs landed on session-usage.mjs's byPhase buckets
      // (wave 3's prior step) -- true wall-clock inside that phase, summed
      // across its agents. null when no matched --usage byPhase entry.
      durationMs: byPhaseEntry ? numOrNull(byPhaseEntry.durationMs) : null,
      effort: p?.effort ?? null,
      model: p?.model ?? null,
      overlappedWith: p?.overlappedWith ?? null,
      note: p?.note ?? null,
    };
  });

  const remainingList = arrOrEmpty(result.remainingFindings);
  const bySeverity = { blocker: 0, major: 0, minor: 0 };
  for (const f of remainingList) {
    const sev = f?.severity;
    if (sev === "blocker" || sev === "major" || sev === "minor") bySeverity[sev]++;
  }

  const ui = result.uiVerify ?? null;
  const mp = result.mutationProbe ?? null;
  const fp = result.finalPass ?? null;
  const ca = result.cascadeAudit ?? null;
  const esc = result.escalation ?? null;

  return {
    v: 1,
    run: meta.run,
    branch: meta.branch,
    pr: meta.pr,
    note: meta.note,
    scale: result.scale ?? null,
    clean: typeof result.clean === "boolean" ? result.clean : null,
    startedAt: meta.startedAt ?? null,
    endedAt: meta.endedAt ?? null,
    durationMs: meta.durationMs,
    estimatedCostUsd: numOrNull(result.estimatedCostUsd),
    pricesAsOf: result.pricesAsOf ?? null,
    riskSummary: result.riskSummary ?? null,
    fixRouting: result.fixRouting ?? null,
    fixRounds: numOrNull(result.fixRounds),
    remaining: { total: remainingList.length, bySeverity },
    phases,
    // A7 signal-not-volume per-lens telemetry (see extractLenses) -- [] on
    // every result.json examined so far; wired for when pipeline.js starts
    // emitting result.lensReport or confirmedFindings[].lens.
    lenses: extractLenses(result),
    redGate: result.redGate
      ? { ...result.redGate, ...computeRedGateBlockers(result.redGate) }
      : null,
    verify: result.verify ?? null,
    uiVerify: ui
      ? {
          ran: ui.ran ?? null,
          completed: ui.completed ?? null,
          findings: arrOrEmpty(ui.findings).length,
          reVerified: Boolean(ui.reVerify),
        }
      : null,
    mutationProbe: mp
      ? {
          ran: mp.ran ?? null,
          skipped: mp.skipped ?? null,
          targets: numOrNull(mp.targets),
          probed: numOrNull(mp.probed),
          allCaught: mp.allCaught ?? null,
          restoredVerified: mp.restoredVerified ?? null,
          skippedTargets: arrOrEmpty(mp.skippedTargets).length,
        }
      : null,
    finalPass: fp
      ? {
          ran: fp.ran ?? null,
          skipped: fp.skipped ?? null,
          completed: fp.completed ?? null,
          model: fp.model ?? null,
          effort: fp.effort ?? null,
          fallback: fp.fallback ?? null,
          findings: arrOrEmpty(fp.findings).length,
        }
      : null,
    overlap: result.overlap ?? null,
    cascadeAudit: ca
      ? {
          sampled: arrOrEmpty(ca.sampled).length,
          missedFindings: numOrNull(ca.missedFindings),
          completed: ca.completed ?? null,
        }
      : null,
    escalation: esc
      ? {
          triggered: esc.triggered ?? null,
          lensesSkipped: arrOrEmpty(esc.lensesSkipped),
        }
      : null,
    gatePass: result.gate?.pass ?? null,
    // --- P2(c) 2026-09-11: run-shape fields the telemetry gate and the
    // routing scorecard both need to interpret a row correctly ------------
    mode: result.mode ?? null,
    // The session id session-usage.mjs reports for the transcript it read
    // -- null when no --usage file was attached (legacy/override rows).
    sessionId: usage?.sessionId ?? null,
    // Fable-to-Opus fallback flag: changes what any quality claim on this
    // row means, so it travels with the row rather than staying buried in
    // result.finalPass.
    fallback: result.fallback ?? result.finalPass?.fallback ?? null,
    siblingSweep:
      result.siblingSweep && typeof result.siblingSweep === "object"
        ? {
            ran: result.siblingSweep.ran ?? null,
            supplied: numOrNull(result.siblingSweep.supplied),
            patterns: arrOrEmpty(result.siblingSweep.patterns),
            skipped: result.siblingSweep.skipped ?? null,
          }
        : null,
    // The recorded reason a caller declared for skipping real telemetry
    // (closeout.mjs --no-usage --reason) -- null when none was given.
    usageOverrideReason: meta.usageOverrideReason ?? null,
    // --- Part C 2026-09-12: approach/profile/taskRef + quality rubric -----
    profile: pickField(result.profile, meta.profile),
    approach: pickField(result.approach, meta.approach),
    taskRef: pickField(result.taskRef, meta.taskRef),
    // E6 (2026-09-15): the staged-engine sha this run built against, when
    // known (closeout.mjs reads it from local-assets/tooling/STAGED-ENGINE.md).
    engineSha: pickField(result.engineSha, meta.engineSha),
    // "workflow" when trueCostUsd/cacheHitRatio came from this run's own
    // matched usage.workflows entry; "session" when usage exists but no
    // --run-id matched one (legacy/light-loop fallback); null with no usage
    // at all. Lets a reader tell a run-scoped row from a session-blob row.
    usageScope: usage ? (matchedWorkflow ? "workflow" : "session") : null,
    quality: computeQuality(result),
    // --- true telemetry (session-usage.mjs), C2 -------------------------
    telemetry: meta.telemetry ?? (usage ? "true" : "legacy"),
    sessionUsage: usage?.session ?? null,
    // cacheHitRatio/trueCostUsd prefer the matched workflow run (this run's
    // own cache efficiency/cost); activeMs has no per-run breakdown in
    // session-usage.mjs today so it is the whole session's active time --
    // approximate when a session spans more than one pipeline run.
    cacheHitRatio: matchedWorkflow?.cacheHitRatio ?? usage?.session?.cacheHitRatio ?? null,
    activeMs: numOrNull(usage?.session?.activeMs),
    trueCostUsd: numOrNull(matchedWorkflow?.total?.costUsd ?? usage?.session?.total?.costUsd),
    usageMatchNote: usage ? matchReason : null,
  };
}

function printAppendSummary(row, ledgerPath) {
  const top3 = [...row.phases]
    .filter((p) => typeof p.tokens === "number")
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 3);

  const lines = [];
  lines.push(`Appended run '${row.run}' -> ${ledgerPath}`);
  lines.push(`  scale: ${row.scale ?? "n/a"}   clean: ${row.clean === null ? "n/a" : row.clean}`);
  lines.push(`  est. cost: ${fmtMoney(row.estimatedCostUsd)}   duration: ${fmtDuration(row.durationMs)}`);
  lines.push("  top phases by tokens:");
  if (top3.length === 0) {
    lines.push("    (none)");
  } else {
    for (const p of top3) {
      lines.push(`    ${p.phase}: ${p.tokens.toLocaleString()} tokens`);
    }
  }
  console.log(lines.join("\n"));
}

// argv is everything after "append" (no leading "node script.mjs append").
function runAppend(argv) {
  const { positional, flags } = parseFlags(argv);
  const resultPathArg = positional[0];
  if (!resultPathArg) {
    throw new LedgerError("append: missing <result.json> path. See --help.");
  }
  if (typeof flags.run !== "string" || flags.run.length === 0) {
    throw new LedgerError("append: --run <name> is required.");
  }

  const resolvedResultPath = path.resolve(resultPathArg);
  let raw;
  try {
    raw = fs.readFileSync(resolvedResultPath, "utf8");
  } catch (err) {
    throw new LedgerError(`append: cannot read result file '${resolvedResultPath}': ${err.message}`);
  }

  let result;
  try {
    result = JSON.parse(stripBom(raw));
  } catch (err) {
    throw new LedgerError(`append: '${resolvedResultPath}' is not valid JSON: ${err.message}`);
  }

  if (!result || typeof result !== "object" || !Array.isArray(result.phaseReport)) {
    throw new LedgerError(
      `append: '${resolvedResultPath}' has no phaseReport array - refusing to append (not a pipeline result?).`
    );
  }

  const projectDir = path.resolve(typeof flags.project === "string" ? flags.project : process.cwd());
  const ledgerPath = getLedgerPath(projectDir);
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });

  const startedAtRaw = typeof flags.started === "string" ? flags.started : result.startedAt ?? null;
  const endedAtRaw = typeof flags.ended === "string" ? flags.ended : new Date().toISOString();
  const startedMs = startedAtRaw ? Date.parse(startedAtRaw) : NaN;
  const endedMs = endedAtRaw ? Date.parse(endedAtRaw) : NaN;
  const durationMs =
    Number.isFinite(startedMs) && Number.isFinite(endedMs) ? endedMs - startedMs : null;

  let pr = null;
  if (typeof flags.pr === "string") {
    const n = Number(flags.pr);
    pr = Number.isFinite(n) ? n : flags.pr;
  }

  if (flags["subagent-tokens"] !== undefined) {
    process.stderr.write(
      "append: --subagent-tokens is deprecated and ignored (it never existed as a real mechanism; " +
        "use --usage <session-usage.json> instead). See --help.\n"
    );
  }

  let usage = null;
  if (typeof flags.usage === "string") {
    const resolvedUsagePath = path.resolve(flags.usage);
    let usageRaw;
    try {
      usageRaw = fs.readFileSync(resolvedUsagePath, "utf8");
    } catch (err) {
      throw new LedgerError(`append: cannot read --usage file '${resolvedUsagePath}': ${err.message}`);
    }
    try {
      usage = JSON.parse(stripBom(usageRaw));
    } catch (err) {
      throw new LedgerError(`append: --usage file '${resolvedUsagePath}' is not valid JSON: ${err.message}`);
    }
  }

  let telemetry;
  if (typeof flags.telemetry === "string") {
    if (flags.telemetry !== "legacy" && flags.telemetry !== "true") {
      throw new LedgerError(`append: --telemetry must be 'legacy' or 'true', got '${flags.telemetry}'.`);
    }
    telemetry = flags.telemetry;
  }

  if (typeof flags.approach === "string" && !APPROACH_VALUES.includes(flags.approach)) {
    throw new LedgerError(`append: --approach must be one of ${APPROACH_VALUES.join(", ")}, got '${flags.approach}'.`);
  }

  const row = buildRow(
    result,
    {
      run: flags.run,
      branch: typeof flags.branch === "string" ? flags.branch : null,
      pr,
      note: typeof flags.note === "string" ? flags.note : null,
      startedAt: startedAtRaw,
      endedAt: endedAtRaw,
      durationMs,
      runId: typeof flags["run-id"] === "string" ? flags["run-id"] : null,
      telemetry,
      usageOverrideReason:
        typeof flags["usage-override-reason"] === "string" ? flags["usage-override-reason"] : null,
      approach: typeof flags.approach === "string" ? flags.approach : null,
      taskRef: typeof flags["task-ref"] === "string" ? flags["task-ref"] : null,
      profile: typeof flags.profile === "string" ? flags.profile : null,
      engineSha: typeof flags["engine-sha"] === "string" ? flags["engine-sha"] : null,
    },
    usage
  );

  fs.appendFileSync(ledgerPath, JSON.stringify(row) + "\n", "utf8");
  printAppendSummary(row, ledgerPath);
  if (usage && row.usageMatchNote) {
    console.log(`  note: ${row.usageMatchNote}`);
  }
  return row;
}

// ---------------------------------------------------------------------------
// summary
// ---------------------------------------------------------------------------

function readLedgerRows(ledgerPath) {
  if (!fs.existsSync(ledgerPath)) return [];
  const raw = stripBom(fs.readFileSync(ledgerPath, "utf8"));
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const rows = [];
  lines.forEach((line, idx) => {
    try {
      rows.push(JSON.parse(line));
    } catch (err) {
      process.stderr.write(`summary: skipping malformed line ${idx + 1}: ${err.message}\n`);
    }
  });
  return rows;
}

// A phase entry's token source, defaulting missing/legacy entries to
// "budget" -- old ledger rows predate the tokensSource field entirely.
function phaseTokensSource(p) {
  return p?.tokensSource === "session-usage" ? "session-usage" : "budget";
}

// cacheHitRatio derived from a phase entry's own usage.total bucket (when
// --usage populated it), independent of any row-level cacheHitRatio.
function phaseCacheHitRatio(p) {
  const u = p?.usage?.total;
  if (!u) return null;
  const denom = numOrNull(u.cacheRead) + numOrNull(u.cacheWrite5m) + numOrNull(u.cacheWrite1h) + numOrNull(u.input);
  return denom > 0 ? numOrNull(u.cacheRead) / denom : null;
}

// Builds one phase-table (see computeSummary b.) from only the phase
// entries whose tokensSource matches `source` -- budget-estimated and
// true session-usage token counts must never share a shareOfTotalTokens
// denominator (they are not the same measurement).
function buildPhaseTable(rows, orderedNames, source) {
  const totalTokensAll = sum(
    rows.flatMap((r) => arrOrEmpty(r.phases).filter((p) => phaseTokensSource(p) === source).map((p) => p.tokens))
  );
  const table = [];
  for (const name of orderedNames) {
    const entries = [];
    rows.forEach((r) => {
      const p = arrOrEmpty(r.phases).find((x) => x.phase === name && phaseTokensSource(x) === source);
      if (p) entries.push(p);
    });
    if (entries.length === 0) continue;
    const tokensList = entries.map((e) => e.tokens);
    const estList = entries.map((e) => e.estUsd);
    const confirmedList = entries.map((e) => e.confirmed);
    const costList = entries.map((e) => e.costUsd);
    const cacheHitList = entries.map((e) => phaseCacheHitRatio(e));
    const phaseTokenSum = sum(tokensList);
    table.push({
      phase: name,
      tokensSource: source,
      runsPresent: entries.length,
      runsRan: entries.filter((e) => e.ran === true).length,
      meanTokens: mean(tokensList),
      meanEstUsd: mean(estList),
      meanCostUsd: mean(costList),
      meanCacheHitRatio: mean(cacheHitList),
      shareOfTotalTokens: totalTokensAll > 0 ? phaseTokenSum / totalTokensAll : null,
      meanConfirmed: mean(confirmedList),
      runsConfirmedZero: entries.filter((e) => e.confirmed === 0).length,
    });
  }
  return table.sort((a, b) => (b.meanTokens ?? -1) - (a.meanTokens ?? -1));
}

// Per-phase quality-signal formula for the routing scorecard (task 2). Every
// phase not named here ("reviewers") uses mean confirmed findings per run --
// including the two Gate & Review lens-split synthetic phase labels, which
// have no confirmed-by-lens count to draw on (only the whole round's
// phases[].confirmed exists), so they share the reviewers default too.
function qualitySignalFor(phaseName) {
  if (phaseName === "Red gate") {
    return {
      label: "behavioralRedRate",
      fn: (row) => (row.redGate?.behaviorallyRed === true ? 1 : row.redGate?.behaviorallyRed === false ? 0 : null),
    };
  }
  if (phaseName === "Mutation probe") {
    return {
      label: "caughtRate",
      // phaseEntry.confirmed is escaped-mutant count (result.confirmedByPhase
      // has no entry for phases that don't author findings via that map, but
      // Mutation probe does -- see AUTHORING_PHASES); caught = probed - escaped.
      fn: (row, phaseEntry) => {
        const probed = numOrNull(row.mutationProbe?.probed);
        const confirmed = numOrNull(phaseEntry?.confirmed);
        if (probed == null || probed === 0 || confirmed == null) return null;
        return (probed - confirmed) / probed;
      },
    };
  }
  if (phaseName === "Verify") {
    return {
      label: "droppedFindingRate",
      fn: (row) => {
        const judged = numOrNull(row.verify?.judged);
        const dropped = numOrNull(row.verify?.dropped);
        if (judged == null || judged === 0 || dropped == null) return null;
        return dropped / judged;
      },
    };
  }
  if (phaseName === "Fix") {
    return { label: "meanFixRounds", fn: (row) => numOrNull(row.fixRounds) };
  }
  return { label: "meanConfirmed", fn: (row, phaseEntry) => numOrNull(phaseEntry?.confirmed) };
}

// A "true-telemetry row" is telemetry:'true' AND a non-null trueCostUsd --
// a "true" row with trueCostUsd:null exists in the stray ledgers (a
// resolution bug wrote it before this fix) and must not count as evidence
// of real cost data. This is the single definition; every report in this
// file that counts or filters true-telemetry rows must use it.
const isTrueTelemetryRow = (r) => r.telemetry === "true" && r.trueCostUsd != null;

// A7 routing scorecard: cost/time/quality grouped by (level, phase, model),
// built ONLY from telemetry:'true' rows (a budget-estimated phase has no
// trustworthy per-phase cost/duration to compare models on). Gate & Review is
// split into pattern-lens / deep-lens synthetic phase labels using each
// row's own lenses[] -- when a row's Gate & Review ran but lenses[] is empty
// (true today for every real row), that phase is excluded from the table
// rather than guessed into either level.
function computeRoutingScorecard(rows) {
  const trueRows = rows.filter(isTrueTelemetryRow);
  const groups = new Map();

  function addSample(level, phase, model, row, phaseEntry) {
    const profile = row.profile || "legacy";
    const approach = row.approach || "legacy";
    const key = `${level} ${phase} ${model || "unknown"} ${profile} ${approach}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        level,
        phase,
        model: model || "unknown",
        profile,
        approach,
        runs: 0,
        costs: [],
        minutes: [],
        qualityLabel: null,
        qualityValues: [],
      };
      groups.set(key, g);
    }
    g.runs += 1;
    if (typeof phaseEntry?.costUsd === "number") g.costs.push(phaseEntry.costUsd);
    if (typeof phaseEntry?.durationMs === "number") g.minutes.push(phaseEntry.durationMs / 60000);
    const { label, fn } = qualitySignalFor(phase);
    g.qualityLabel = label;
    const v = fn(row, phaseEntry);
    if (typeof v === "number" && Number.isFinite(v)) g.qualityValues.push(v);
  }

  for (const row of trueRows) {
    for (const phaseEntry of arrOrEmpty(row.phases)) {
      const phaseName = phaseEntry.phase;
      if (phaseName === "Gate & Review") {
        const lenses = arrOrEmpty(row.lenses);
        if (lenses.length === 0) continue; // can't tell pattern from deep -- excluded, not guessed
        const patternModels = new Set(lenses.filter((l) => lensFamily(l.lens) === "pattern").map((l) => l.model).filter(Boolean));
        const deepModels = new Set(lenses.filter((l) => lensFamily(l.lens) === "deep").map((l) => l.model).filter(Boolean));
        for (const model of patternModels) addSample("routineVerdict", "Gate & Review (pattern lenses)", model, row, phaseEntry);
        for (const model of deepModels) addSample("highRiskVerdict", "Gate & Review (deep lenses)", model, row, phaseEntry);
        continue;
      }
      const level = PHASE_TO_LEVEL[phaseName];
      if (!level) continue; // Dedupe/Checkpoints/etc. -- not part of any level
      addSample(level, phaseName, phaseEntry.model, row, phaseEntry);
    }
  }

  const table = [...groups.values()]
    .map((g) => ({
      level: g.level,
      phase: g.phase,
      model: g.model,
      profile: g.profile,
      approach: g.approach,
      runs: g.runs,
      meanCostUsd: mean(g.costs),
      meanMinutes: mean(g.minutes),
      qualitySignalLabel: g.qualityLabel,
      qualitySignal: mean(g.qualityValues),
    }))
    .sort(
      (a, b) =>
        a.level.localeCompare(b.level) ||
        a.phase.localeCompare(b.phase) ||
        a.profile.localeCompare(b.profile) ||
        a.approach.localeCompare(b.approach) ||
        (a.meanCostUsd ?? 0) - (b.meanCostUsd ?? 0)
    );

  return { table, trueTelemetryRowsUsed: trueRows.length, excludedRowsCount: rows.length - trueRows.length };
}

// A7 per-lens scorecard (task 3) -- confirmed-per-call and noise ratio, from
// every row's lenses[] regardless of telemetry marker (a findings signal,
// not a cost one). [] until any result.json carries lensReport data.
function computeLensScorecard(rows) {
  const byLens = new Map();
  for (const row of rows) {
    for (const l of arrOrEmpty(row.lenses)) {
      if (!l || typeof l.lens !== "string") continue;
      const entry = byLens.get(l.lens) ?? { lens: l.lens, runs: 0, rawFindings: 0, executionConfirmed: 0, overturned: 0 };
      entry.runs += 1;
      entry.rawFindings += numOrNull(l.rawFindings) ?? 0;
      entry.executionConfirmed += numOrNull(l.executionConfirmed) ?? 0;
      entry.overturned += numOrNull(l.overturned) ?? 0;
      byLens.set(l.lens, entry);
    }
  }
  return [...byLens.values()]
    .map((e) => ({
      ...e,
      confirmedPerCall: e.runs > 0 ? e.executionConfirmed / e.runs : null,
      noiseRatio: e.rawFindings > 0 ? e.overturned / e.rawFindings : null,
    }))
    .sort((a, b) => (b.confirmedPerCall ?? -1) - (a.confirmedPerCall ?? -1));
}

function computeSummary(rows) {
  // --- a. Runs -------------------------------------------------------
  const startedTimes = rows.map((r) => Date.parse(r.startedAt)).filter(Number.isFinite);
  const endedTimes = rows.map((r) => Date.parse(r.endedAt)).filter(Number.isFinite);
  const costs = rows.map((r) => r.estimatedCostUsd).filter((v) => typeof v === "number");
  const durations = rows.map((r) => r.durationMs).filter((v) => typeof v === "number");
  const cleanFlags = rows.map((r) => r.clean).filter((v) => typeof v === "boolean");
  const trueCosts = rows.map((r) => r.trueCostUsd).filter((v) => typeof v === "number");
  const activeMss = rows.map((r) => r.activeMs).filter((v) => typeof v === "number");
  // Only rows whose --usage matched a specific workflow run (usageMatchNote
  // == null) go into costEstimateError -- a row that fell back to the whole
  // session's totals (usageMatchNote set) is comparing this run's estimate
  // against costs that may include OTHER runs in the same session, which is
  // not a like-for-like error signal. Those fallback rows are still surfaced,
  // just kept out of the primary mean and reported separately.
  const costEstimateErrorCandidates = rows.filter(
    (r) => typeof r.trueCostUsd === "number" && typeof r.estimatedCostUsd === "number" && r.estimatedCostUsd !== 0
  );
  const costEstimateErrors = costEstimateErrorCandidates
    .filter((r) => r.usageMatchNote == null)
    .map((r) => r.trueCostUsd / r.estimatedCostUsd);
  const costEstimateErrorsExcluded = costEstimateErrorCandidates
    .filter((r) => r.usageMatchNote != null)
    .map((r) => r.trueCostUsd / r.estimatedCostUsd);

  const runs = {
    count: rows.length,
    trueTelemetryCount: rows.filter((r) => r.telemetry === "true").length,
    // P2(c) 2026-09-11: the "true-telemetry rows" count the telemetry gate
    // and any ten-run rule must use -- telemetry==="true" alone is not
    // enough, since a "true" row with a null trueCostUsd exists in the
    // stray ledgers (a resolution bug wrote it before this fix) and must
    // not count as evidence of real cost data.
    trueTelemetryRowsCount: rows.filter(isTrueTelemetryRow).length,
    dateRange: {
      from: startedTimes.length ? new Date(Math.min(...startedTimes)).toISOString() : null,
      to: endedTimes.length ? new Date(Math.max(...endedTimes)).toISOString() : null,
    },
    meanCostUsd: mean(costs),
    totalCostUsd: costs.length ? sum(costs) : null,
    meanDurationMs: mean(durations),
    cleanRate: cleanFlags.length ? cleanFlags.filter(Boolean).length / cleanFlags.length : null,
    meanTrueCostUsd: mean(trueCosts),
    meanActiveMs: mean(activeMss),
    costEstimateError: mean(costEstimateErrors),
    costEstimateErrorExcluded: mean(costEstimateErrorsExcluded),
    costEstimateErrorExcludedCount: costEstimateErrorsExcluded.length,
  };

  // --- b. Phase table (split by tokensSource; never mixed) -------------
  const seen = new Set(PHASE_ORDER);
  rows.forEach((r) =>
    arrOrEmpty(r.phases).forEach((p) => {
      if (p.phase) seen.add(p.phase);
    })
  );
  const orderedNames = [...PHASE_ORDER, ...[...seen].filter((n) => !PHASE_ORDER.includes(n))];

  const phaseTable = {
    budget: buildPhaseTable(rows, orderedNames, "budget"),
    sessionUsage: buildPhaseTable(rows, orderedNames, "session-usage"),
  };

  // --- c. Ten-run rules --------------------------------------------------
  // "Red gate" findings live in row.redGate.audits[].blockers, not in
  // phases[].confirmed (redGate has no confirmedByPhase entry at all in
  // real result.json) -- keying the cut rule on confirmed made a red gate
  // that is finding real structural/behavioral blockers on every run look
  // like a zero-finding candidate. Runs where audits degraded to a bare
  // count (aggregate-truncated result.json) are excluded from ranCount
  // rather than counted as zero -- missing data is not "no findings".
  const cutRules = AUTHORING_PHASES.map((name) => {
    if (name === "Red gate") {
      // Recomputed from each row's raw redGate.audits here (not read from a
      // stored countable/blockersCount field) so this is retroactive over
      // ledger rows appended before this fix existed, not just new ones.
      const ranRows = rows.filter((r) => r.redGate?.ran === true);
      const withBlockers = ranRows.map((r) => ({ r, ...computeRedGateBlockers(r.redGate) }));
      const countableRows = withBlockers.filter((x) => x.countable);
      const uncountableCount = ranRows.length - countableRows.length;
      const ranCount = countableRows.length;
      const zeroCount = countableRows.filter((x) => x.blockersCount === 0).length;
      const evaluable = ranCount >= 10;
      const verdict = evaluable
        ? `evaluable: yes - ${name} produced 0 blockers in ${zeroCount}/${ranCount} runs` +
          (uncountableCount ? ` (${uncountableCount} more ran but blockers were not recorded)` : "")
        : `evaluable: no (${ranCount}/10 runs with countable redGate.audits[].blockers` +
          (uncountableCount ? `; ${uncountableCount} ran but blockers were not recorded` : "") +
          ")";
      return {
        phase: name,
        ranCount,
        zeroCount,
        criterion: "redGate.audits[].blockers=0",
        evaluable,
        verdict,
      };
    }

    const entries = [];
    rows.forEach((r) => {
      const p = arrOrEmpty(r.phases).find((x) => x.phase === name);
      if (p) entries.push(p);
    });
    const ranEntries = entries.filter((e) => e.ran === true);
    const ranCount = ranEntries.length;

    // Final pass findings route to remainingFindings, not confirmedByPhase,
    // so its "zero findings" signal is rawFindings=0 instead of confirmed=0.
    const usesRawFindings = name === "Final pass";
    const zeroCount = usesRawFindings
      ? ranEntries.filter((e) => e.rawFindings === 0).length
      : ranEntries.filter((e) => e.confirmed === 0).length;

    const evaluable = ranCount >= 10;
    const verdict = evaluable
      ? `evaluable: yes - ${name} produced 0 confirmed in ${zeroCount}/${ranCount} runs`
      : `evaluable: no (${ranCount}/10 runs)`;

    return {
      phase: name,
      ranCount,
      zeroCount,
      criterion: usesRawFindings ? "rawFindings=0" : "confirmed=0",
      evaluable,
      verdict,
    };
  });

  const consumingNote =
    "Verify, UI verify, and Fix consume/act on findings other phases produced " +
    "rather than authoring new ones, so they are not subject to the cut rule.";

  const caEntries = rows.filter((r) => r.cascadeAudit != null);
  const caCount = caEntries.length;
  const caMissedTotal = sum(caEntries.map((r) => r.cascadeAudit.missedFindings));
  const cascadeAudit = {
    runsWithCascadeAudit: caCount,
    totalMissedFindings: caMissedTotal,
    verdict:
      caCount >= 10
        ? caMissedTotal === 0
          ? `justified only if 0 across 10 runs: justified (0 missed across ${caCount} runs)`
          : `justified only if 0 across 10 runs: NOT justified (${caMissedTotal} missed findings across ${caCount} runs)`
        : `justified only if 0 across 10 runs: not yet evaluable (${caCount}/10 runs)`,
  };

  const escEntries = rows.filter((r) => r.escalation != null);
  const escalation = {
    runsTriggered: escEntries.filter((r) => r.escalation.triggered === true).length,
    totalLensesSkipped: sum(escEntries.map((r) => arrOrEmpty(r.escalation.lensesSkipped).length)),
  };

  // --- d. Verify economics -------------------------------------------
  const verifyEntries = rows.filter((r) => r.verify != null);
  const verify = {
    runsWithVerify: verifyEntries.length,
    meanVotesCast: mean(verifyEntries.map((r) => r.verify.votesCast)),
    meanJudged: mean(verifyEntries.map((r) => r.verify.judged)),
    meanDropped: mean(verifyEntries.map((r) => r.verify.dropped)),
    meanFirstVoteRefutedRate: mean(verifyEntries.map((r) => r.verify.firstVoteRefutedRate)),
    totalTieBreaks: sum(verifyEntries.map((r) => r.verify.tieBreaks)),
    shareLazy: verifyEntries.length
      ? verifyEntries.filter((r) => r.verify.lazy === true).length / verifyEntries.length
      : null,
  };

  // --- e. Red gate ------------------------------------------------------
  const rgEntries = rows.filter((r) => r.redGate != null);
  const attemptsDist = {};
  rgEntries.forEach((r) => {
    const a = r.redGate.attempts;
    const key = typeof a === "number" ? String(a) : "n/a";
    attemptsDist[key] = (attemptsDist[key] || 0) + 1;
  });
  const redGate = {
    runsWithRedGate: rgEntries.length,
    attemptsDist,
    structuralRedRate: rgEntries.length
      ? rgEntries.filter((r) => r.redGate.structurallyRed === true).length / rgEntries.length
      : null,
    behavioralRedRate: rgEntries.length
      ? rgEntries.filter((r) => r.redGate.behaviorallyRed === true).length / rgEntries.length
      : null,
    remediateStructuralShare: rgEntries.length
      ? rgEntries.filter((r) => r.redGate.remediateOn === "structural").length / rgEntries.length
      : null,
  };

  // --- f. Final pass ------------------------------------------------------
  const fpEntries = rows.filter((r) => r.finalPass != null);
  const skippedByReason = {};
  fpEntries.forEach((r) => {
    const s = r.finalPass.skipped;
    if (s) skippedByReason[s] = (skippedByReason[s] || 0) + 1;
  });
  const finalPass = {
    ranCount: fpEntries.filter((r) => r.finalPass.ran === true).length,
    skippedByReason,
    fallbackCount: fpEntries.filter((r) => r.finalPass.fallback === true).length,
    meanFindings: mean(fpEntries.map((r) => r.finalPass.findings)),
  };

  // --- g. Overlaps ------------------------------------------------------
  const overlapEntries = rows.filter((r) => r.overlap != null);
  const overlapKeys = ["verifyWithUiVerify", "finalGateWithFinalPass", "redAuditWithImplement"];
  const overlap = {};
  overlapKeys.forEach((k) => {
    overlap[k] = overlapEntries.filter((r) => Boolean(r.overlap[k])).length;
  });

  return {
    runs,
    phaseTable,
    tenRunRules: { cutRules, consumingNote, cascadeAudit, escalation },
    verify,
    redGate,
    finalPass,
    overlap,
    routingScorecard: computeRoutingScorecard(rows),
    lensScorecard: computeLensScorecard(rows),
  };
}

function printSummaryText(summary) {
  const { runs, phaseTable, tenRunRules, verify, redGate, finalPass, overlap, routingScorecard, lensScorecard } = summary;

  console.log("=== Runs ===");
  console.log(`count: ${runs.count}   true-telemetry count: ${runs.trueTelemetryCount}`);
  console.log(`true-telemetry rows: ${runs.trueTelemetryRowsCount} (telemetry==="true" AND trueCostUsd != null)`);
  console.log(`date range: ${runs.dateRange.from ?? "n/a"} -> ${runs.dateRange.to ?? "n/a"}`);
  console.log(`mean cost: ${fmtMoney(runs.meanCostUsd)}   total cost: ${fmtMoney(runs.totalCostUsd)}`);
  console.log(`mean duration: ${fmtDuration(runs.meanDurationMs)}`);
  console.log(`clean rate: ${fmtPct(runs.cleanRate)}`);
  console.log(
    `mean TRUE cost: ${fmtMoney(runs.meanTrueCostUsd)}   mean active time: ${fmtDuration(runs.meanActiveMs)}   ` +
      `cost-estimate error (true/estimated, matched-workflow rows only): ${fmtNum(runs.costEstimateError, 3)}`
  );
  if (runs.costEstimateErrorExcludedCount > 0) {
    console.log(
      `  (${runs.costEstimateErrorExcludedCount} row(s) fell back to session totals -- excluded above; their own error: ${fmtNum(runs.costEstimateErrorExcluded, 3)})`
    );
  }

  const printPhaseTable = (label, table) => {
    console.log(`\n=== Phases (token source: ${label}; ranked by mean tokens desc) ===`);
    if (table.length === 0) {
      console.log("(none)");
      return;
    }
    printTable(
      ["phase", "ran", "mean tokens", "mean est$", "mean true$", "token share", "mean confirmed", "runs confirmed=0", "mean cache-hit"],
      table.map((p) => [
        p.phase,
        String(p.runsRan),
        p.meanTokens == null ? "n/a" : Math.round(p.meanTokens).toLocaleString(),
        fmtMoney(p.meanEstUsd),
        fmtMoney(p.meanCostUsd),
        fmtPct(p.shareOfTotalTokens),
        fmtNum(p.meanConfirmed),
        String(p.runsConfirmedZero),
        fmtPct(p.meanCacheHitRatio),
      ])
    );
  };
  // Budget (estimated) and session-usage (true) token counts are never
  // combined into one table/denominator -- see buildPhaseTable.
  printPhaseTable("budget / estimated", phaseTable.budget);
  printPhaseTable("session-usage / true", phaseTable.sessionUsage);

  console.log("\n=== Ten-run rules ===");
  console.log(tenRunRules.consumingNote);
  for (const cr of tenRunRules.cutRules) {
    console.log(
      `${cr.phase}: ran ${cr.ranCount} runs, ${cr.zeroCount} with ${cr.criterion} (of those that ran)`
    );
    console.log(`  ${cr.verdict}`);
  }
  console.log(
    `Cascade audit: ${tenRunRules.cascadeAudit.runsWithCascadeAudit} runs sampled, ` +
      `${tenRunRules.cascadeAudit.totalMissedFindings} total missedFindings`
  );
  console.log(`  ${tenRunRules.cascadeAudit.verdict}`);
  console.log(
    `Density escalation: ${tenRunRules.escalation.runsTriggered} runs triggered, ` +
      `${tenRunRules.escalation.totalLensesSkipped} total lensesSkipped`
  );

  console.log("\n=== Verify economics ===");
  console.log(`runs with verify: ${verify.runsWithVerify}`);
  console.log(`mean votesCast: ${fmtNum(verify.meanVotesCast)}`);
  console.log(`mean judged: ${fmtNum(verify.meanJudged)}`);
  console.log(`mean dropped: ${fmtNum(verify.meanDropped)}`);
  console.log(`mean firstVoteRefutedRate: ${fmtPct(verify.meanFirstVoteRefutedRate)}`);
  console.log(`total tieBreaks: ${verify.totalTieBreaks}`);
  console.log(`share lazy: ${fmtPct(verify.shareLazy)}`);

  console.log("\n=== Red gate ===");
  console.log(`runs with red gate: ${redGate.runsWithRedGate}`);
  console.log(`attempts distribution: ${JSON.stringify(redGate.attemptsDist)}`);
  console.log(`structural-red rate: ${fmtPct(redGate.structuralRedRate)}`);
  console.log(`behavioral-red rate: ${fmtPct(redGate.behavioralRedRate)}`);
  console.log(`remediateOn=structural share: ${fmtPct(redGate.remediateStructuralShare)}`);

  console.log("\n=== Final pass ===");
  console.log(`ran: ${finalPass.ranCount}`);
  console.log(
    `skipped by reason: ${
      Object.keys(finalPass.skippedByReason).length ? JSON.stringify(finalPass.skippedByReason) : "(none)"
    }`
  );
  console.log(`fallback: ${finalPass.fallbackCount}`);
  console.log(`mean findings: ${fmtNum(finalPass.meanFindings)}`);

  console.log("\n=== Overlaps ===");
  for (const [k, v] of Object.entries(overlap)) {
    console.log(`${k}: ${v}`);
  }

  console.log("\n=== Routing scorecard (level x model, A7 signal-not-volume) ===");
  console.log("Rule: cheapest model holding the level's quality signal at the shortest time wins.");
  if (routingScorecard.trueTelemetryRowsUsed === 0) {
    console.log("no true-telemetry rows yet");
  } else if (routingScorecard.table.length === 0) {
    console.log("true-telemetry rows exist but no phase could be classified into a level yet");
  } else {
    printTable(
      ["level", "phase", "model", "profile", "approach", "runs", "mean cost", "mean minutes", "quality signal"],
      routingScorecard.table.map((r) => [
        r.level,
        r.phase,
        r.model,
        r.profile,
        r.approach,
        String(r.runs),
        fmtMoney(r.meanCostUsd),
        fmtNum(r.meanMinutes),
        `${r.qualitySignalLabel}=${fmtNum(r.qualitySignal, 3)}`,
      ])
    );
  }
  console.log(
    `(${routingScorecard.trueTelemetryRowsUsed} true-telemetry row(s) used; ${routingScorecard.excludedRowsCount} row(s) excluded -- not true telemetry)`
  );

  console.log("\n=== Lens scorecard (A7 per-lens signal) ===");
  if (lensScorecard.length === 0) {
    console.log("no lens data yet");
  } else {
    printTable(
      ["lens", "runs", "rawFindings", "executionConfirmed", "overturned", "confirmedPerCall", "noiseRatio"],
      lensScorecard.map((l) => [
        l.lens,
        String(l.runs),
        String(l.rawFindings),
        String(l.executionConfirmed),
        String(l.overturned),
        fmtNum(l.confirmedPerCall, 2),
        fmtPct(l.noiseRatio),
      ])
    );
  }
}

// argv is everything after "summary".
function runSummary(argv) {
  const { flags } = parseFlags(argv);
  const projectDir = path.resolve(typeof flags.project === "string" ? flags.project : process.cwd());
  const ledgerPath = getLedgerPath(projectDir);
  let rows = readLedgerRows(ledgerPath);

  if (typeof flags.last === "string") {
    const n = Number(flags.last);
    if (Number.isFinite(n) && n > 0) rows = rows.slice(-n);
  }

  if (rows.length === 0) {
    console.log("no rows");
    return null;
  }

  const summary = computeSummary(rows);
  if (flags.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    printSummaryText(summary);
  }
  return summary;
}

// ---------------------------------------------------------------------------
// append-manual / attribute / compare (Part C 2026-09-12)
// ---------------------------------------------------------------------------

// Fix round 1 (2026-09-12 review, Minor): a numeric append-manual flag that
// silently coerced bad input to null (Number("abc") -> NaN -> numOrNull ->
// null) hid a typo as "no data given" instead of refusing it -- the same
// standard --approach/--first-pass-green/--findings already hold themselves
// to. Returns null when the flag is absent; throws when it is present but
// not a finite number.
function parseNumericFlag(flags, name) {
  if (typeof flags[name] !== "string") return null;
  const n = Number(flags[name]);
  if (!Number.isFinite(n)) {
    throw new LedgerError(`append-manual: --${name} must be a number, got '${flags[name]}'.`);
  }
  return n;
}

// Parses "<critical>,<important>,<minor>" into {critical, important, minor}
// (numbers). Returns null on anything else (missing flag, wrong shape).
function parseFindingsFlag(str) {
  if (typeof str !== "string") return null;
  const parts = str.split(",").map((s) => s.trim());
  if (parts.length !== 3) return null;
  const nums = parts.map(Number);
  if (nums.some((n) => !Number.isFinite(n))) return null;
  return { critical: nums[0], important: nums[1], minor: nums[2] };
}

// argv is everything after "append-manual". Records one whole-session
// non-engine (superpowers/raw) run: true cost + active time come from
// session-usage.mjs, never from an estimate -- there is no phaseReport to
// estimate from. See PIPELINE_LEDGER_USAGE_SCRIPT (module header) for the
// selftest-only stub-script override.
function runAppendManual(argv) {
  const { flags } = parseFlags(argv);

  if (typeof flags.run !== "string" || flags.run.length === 0) {
    throw new LedgerError("append-manual: --run <slug> is required.");
  }
  if (typeof flags.approach !== "string" || !["superpowers", "raw"].includes(flags.approach)) {
    throw new LedgerError("append-manual: --approach must be 'superpowers' or 'raw'.");
  }
  if (typeof flags.session !== "string" || flags.session.length === 0) {
    throw new LedgerError("append-manual: --session <sid> is required.");
  }

  const projectDir = path.resolve(typeof flags.project === "string" ? flags.project : process.cwd());
  const ledgerPath = getLedgerPath(projectDir);
  const existing = readLedgerRows(ledgerPath).find((r) => r.run === flags.run);
  if (existing) {
    console.log(JSON.stringify(existing, null, 2));
    throw new LedgerError(`append-manual: run '${flags.run}' already exists in the ledger -- refusing to overwrite.`, 3);
  }

  let firstPassGreen = null;
  if (typeof flags["first-pass-green"] === "string") {
    if (flags["first-pass-green"] === "true") firstPassGreen = true;
    else if (flags["first-pass-green"] === "false") firstPassGreen = false;
    else throw new LedgerError("append-manual: --first-pass-green must be 'true' or 'false'.");
  }

  let reviewFindings = null;
  if (typeof flags.findings === "string") {
    reviewFindings = parseFindingsFlag(flags.findings);
    if (!reviewFindings) {
      throw new LedgerError("append-manual: --findings must be '<critical>,<important>,<minor>' (three numbers).");
    }
  }

  const humanMinutes = parseNumericFlag(flags, "human-minutes");
  const filesTouched = parseNumericFlag(flags, "files-touched");
  const linesChanged = parseNumericFlag(flags, "lines-changed");

  const usageScriptPath = process.env[USAGE_SCRIPT_ENV] || path.join(SCRIPT_DIR, "session-usage.mjs");
  let usage;
  try {
    const usageRaw = execFileSync(
      process.execPath,
      [usageScriptPath, flags.session, "--all", "--project", projectDir, "--json"],
      { encoding: "utf8" }
    );
    usage = JSON.parse(stripBom(usageRaw));
  } catch (err) {
    throw new LedgerError(`append-manual: session-usage.mjs failed for session '${flags.session}': ${err.message}`, 3);
  }

  const startedAt = typeof flags.started === "string" ? flags.started : usage?.session?.firstAt ?? null;
  const endedAt = typeof flags.ended === "string" ? flags.ended : usage?.session?.lastAt ?? new Date().toISOString();
  const startedMs = startedAt ? Date.parse(startedAt) : NaN;
  const endedMs = endedAt ? Date.parse(endedAt) : NaN;
  const durationMs = Number.isFinite(startedMs) && Number.isFinite(endedMs) ? endedMs - startedMs : null;

  const row = {
    v: 1,
    run: flags.run,
    approach: flags.approach,
    profile: null,
    taskRef: typeof flags["task-ref"] === "string" ? flags["task-ref"] : null,
    telemetry: "true",
    trueCostUsd: numOrNull(usage?.session?.total?.costUsd),
    estimatedCostUsd: null,
    phaseReport: [],
    clean: null,
    fixRounds: null,
    remaining: null,
    quality: {
      firstPassGreen,
      reviewFindings,
      humanMinutes,
      escapedDefects: 0,
      filesTouched,
      linesChanged,
    },
    startedAt,
    endedAt,
    durationMs,
    activeMs: numOrNull(usage?.session?.activeMs),
    mode: "manual",
    scale: null,
    sessionId: flags.session,
  };

  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.appendFileSync(ledgerPath, JSON.stringify(row) + "\n", "utf8");
  console.log(`Appended manual run '${row.run}' (${row.approach}) -> ${ledgerPath}`);
  console.log(`  true cost: ${fmtMoney(row.trueCostUsd)}   active: ${fmtDuration(row.activeMs)}`);
  return row;
}

// argv is everything after "attribute". Attaches one escaped bug to a
// ledger row after the fact -- the audit's quality signal that can only be
// known once a defect from a past run surfaces later. Rewrites the whole
// ledger file (JSONL has no in-place row update).
function runAttribute(argv) {
  const { flags } = parseFlags(argv);
  if (typeof flags.run !== "string" || flags.run.length === 0) {
    throw new LedgerError("attribute: --run <slug> is required.");
  }
  if (typeof flags.bug !== "string" || flags.bug.length === 0) {
    throw new LedgerError("attribute: --bug <id> is required.");
  }

  const projectDir = path.resolve(typeof flags.project === "string" ? flags.project : process.cwd());
  const ledgerPath = getLedgerPath(projectDir);
  const rows = readLedgerRows(ledgerPath);
  const idx = rows.findIndex((r) => r.run === flags.run);
  if (idx === -1) {
    throw new LedgerError(`attribute: run '${flags.run}' not found in the ledger.`, 3);
  }

  const priorQuality = rows[idx].quality && typeof rows[idx].quality === "object" ? rows[idx].quality : {};
  const priorCount = typeof priorQuality.escapedDefects === "number" ? priorQuality.escapedDefects : 0;
  const priorBugs = Array.isArray(priorQuality.escapedBugs) ? priorQuality.escapedBugs : [];
  const quality = { ...priorQuality, escapedDefects: priorCount + 1, escapedBugs: [...priorBugs, flags.bug] };
  rows[idx] = { ...rows[idx], quality };

  fs.writeFileSync(ledgerPath, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  console.log(`attribute: run '${flags.run}' escapedDefects now ${quality.escapedDefects} (added ${flags.bug})`);
  return rows[idx];
}

// Groups telemetry:'true' + trueCostUsd!=null rows by approach||'legacy'
// (dev-pipeline rows sub-grouped by profile||'legacy'), and ranks arms with
// n >= minN by true cost -- never on an estimate, never below the n floor.
function computeCompare(rows, minN) {
  const trueRows = rows.filter(isTrueTelemetryRow);
  const arms = new Map();

  for (const r of trueRows) {
    const approach = r.approach || "legacy";
    const isDevPipeline = approach === "dev-pipeline";
    const profile = isDevPipeline ? r.profile || "legacy" : null;
    const key = isDevPipeline ? `${approach}:${profile}` : approach;
    let arm = arms.get(key);
    if (!arm) {
      arm = { approach, profile, rows: [] };
      arms.set(key, arm);
    }
    arm.rows.push(r);
  }

  const results = [...arms.values()].map((arm) => {
    const n = arm.rows.length;
    const costs = arm.rows.map((r) => r.trueCostUsd);
    const activeMinutes = arm.rows
      .map((r) => (typeof r.activeMs === "number" ? r.activeMs / 60000 : null))
      .filter((v) => v != null);
    const fpgFlags = arm.rows.map((r) => r.quality?.firstPassGreen).filter((v) => typeof v === "boolean");
    const critical = arm.rows.map((r) => r.quality?.reviewFindings?.critical).filter((v) => typeof v === "number");
    const important = arm.rows.map((r) => r.quality?.reviewFindings?.important).filter((v) => typeof v === "number");
    const minor = arm.rows.map((r) => r.quality?.reviewFindings?.minor).filter((v) => typeof v === "number");
    const escaped = arm.rows.map((r) => r.quality?.escapedDefects).filter((v) => typeof v === "number");

    return {
      approach: arm.approach,
      profile: arm.profile,
      n,
      meanTrueCostUsd: mean(costs),
      medianTrueCostUsd: median(costs),
      medianActiveMinutes: median(activeMinutes),
      firstPassGreenRate: fpgFlags.length ? fpgFlags.filter(Boolean).length / fpgFlags.length : null,
      meanReviewFindings: { critical: mean(critical), important: mean(important), minor: mean(minor) },
      meanEscapedDefects: mean(escaped),
      sufficient: n >= minN,
    };
  });

  results.sort((a, b) => a.approach.localeCompare(b.approach) || (a.profile || "").localeCompare(b.profile || ""));

  const sufficientArms = results.filter((a) => a.sufficient && a.meanTrueCostUsd != null);
  // Fix round 1 (2026-09-12 review): meanEscapedDefects null means "never
  // audited via `attribute`", not "confirmed zero" -- coercing it to 0 with
  // `?? 0` let an unaudited arm win or tie against a confirmed-clean arm,
  // rewarding under-monitoring. Policy: only an arm with at least one
  // attribute-derived data point (meanEscapedDefects != null) is eligible to
  // set the best escaped-defect rate or to be ranked against it; an
  // unaudited arm still prints in the table (as "n/a") but can never be
  // named, or tied for, cheapest.
  const auditedArms = sufficientArms.filter((a) => a.meanEscapedDefects != null);
  let cheapest = null;
  if (auditedArms.length > 0) {
    const bestEscapedRate = Math.min(...auditedArms.map((a) => a.meanEscapedDefects));
    const eligible = auditedArms.filter((a) => a.meanEscapedDefects <= bestEscapedRate);
    cheapest = eligible.reduce(
      (best, a) => (best == null || (a.meanTrueCostUsd ?? Infinity) < (best.meanTrueCostUsd ?? Infinity) ? a : best),
      null
    );
  }

  return { arms: results, minN, cheapest };
}

function printCompareText(result) {
  console.log(`=== Compare (min n = ${result.minN}) ===`);
  const rows = [];
  for (const a of result.arms) {
    const label = a.profile ? `${a.approach}:${a.profile}` : a.approach;
    if (!a.sufficient) {
      console.log(`${label}: insufficient (n=${a.n})`);
      continue;
    }
    rows.push([
      label,
      String(a.n),
      fmtMoney(a.meanTrueCostUsd),
      fmtMoney(a.medianTrueCostUsd),
      fmtNum(a.medianActiveMinutes),
      fmtPct(a.firstPassGreenRate),
      `${fmtNum(a.meanReviewFindings.critical, 2)}/${fmtNum(a.meanReviewFindings.important, 2)}/${fmtNum(a.meanReviewFindings.minor, 2)}`,
      fmtNum(a.meanEscapedDefects, 2),
    ]);
  }
  if (rows.length > 0) {
    printTable(
      ["arm", "n", "mean $", "median $", "median active min", "first-pass-green", "findings c/i/m", "escaped defects"],
      rows
    );
  }
  if (result.cheapest) {
    const label = result.cheapest.profile ? `${result.cheapest.approach}:${result.cheapest.profile}` : result.cheapest.approach;
    console.log(
      `Cheapest sufficient arm with no worse escaped-defect rate: ${label} (${fmtMoney(result.cheapest.meanTrueCostUsd)}/run, n=${result.cheapest.n})`
    );
  } else {
    const sufficientArms = result.arms.filter((a) => a.sufficient);
    if (sufficientArms.length === 0) {
      console.log(`no arm has n >= ${result.minN}`);
    } else {
      console.log("no arm has escaped-defect data yet (run `attribute` at least once per arm to establish a baseline)");
    }
  }
}

// argv is everything after "compare".
function runCompare(argv) {
  const { flags } = parseFlags(argv);
  const projectDir = path.resolve(typeof flags.project === "string" ? flags.project : process.cwd());
  const ledgerPath = getLedgerPath(projectDir);
  const rows = readLedgerRows(ledgerPath);
  const minNFlag = typeof flags["min-n"] === "string" ? Number(flags["min-n"]) : NaN;
  const minN = Number.isFinite(minNFlag) ? minNFlag : 10;

  const result = computeCompare(rows, minN);
  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printCompareText(result);
  }
  return result;
}

// ---------------------------------------------------------------------------
// selftest
// ---------------------------------------------------------------------------

function runSelftest() {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-ledger-selftest-"));
  const fixtureSrc = path.join(SCRIPT_DIR, "fixtures", "f14-result.json");
  const fixtureDest = path.join(tmpBase, "f14-result.json");
  let ok = true;

  try {
    fs.copyFileSync(fixtureSrc, fixtureDest);

    runAppend([
      fixtureDest,
      "--run",
      "selftest-run-1",
      "--project",
      tmpBase,
      "--started",
      "2026-09-02T02:00:00.000Z",
      "--ended",
      "2026-09-02T03:00:00.000Z",
    ]);

    // Second run, different name, started/ended 30 minutes apart.
    runAppend([
      fixtureDest,
      "--run",
      "selftest-run-2",
      "--project",
      tmpBase,
      "--started",
      "2026-09-02T04:00:00.000Z",
      "--ended",
      "2026-09-02T04:30:00.000Z",
    ]);

    // Third run: same fixture, but with --usage attached so one phase
    // ("Gate & Review") gets true telemetry instead of the budget estimate.
    const usagePath = path.join(tmpBase, "session-usage.json");
    const gateReviewUsage = {
      total: { input: 1000, cacheWrite5m: 200, cacheWrite1h: 0, cacheRead: 9000, output: 500, tokens: 10700, costUsd: 0.246 },
      byModel: {
        "claude-opus-5": {
          input: 1000,
          cacheWrite5m: 200,
          cacheWrite1h: 0,
          cacheRead: 9000,
          output: 500,
          tokens: 10700,
          costUsd: 0.246,
        },
      },
      agents: 6,
      labels: ["lens-a", "lens-b"],
    };
    fs.writeFileSync(
      usagePath,
      JSON.stringify({
        v: 1,
        sessionId: "sess-selftest",
        project: tmpBase,
        pricesAsOf: "2026-06-24",
        session: {
          byModel: gateReviewUsage.byModel,
          total: gateReviewUsage.total,
          messages: 6,
          firstAt: "2026-09-02T02:00:00.000Z",
          lastAt: "2026-09-02T02:30:00.000Z",
          activeMs: 1500000,
          cacheHitRatio: 0.88,
        },
        workflows: {
          "run-usage-1": {
            byPhase: { "Gate & Review": gateReviewUsage },
            byLabel: {},
            byModel: gateReviewUsage.byModel,
            total: gateReviewUsage.total,
            agents: 6,
            cacheHitRatio: 0.88,
          },
        },
        warnings: [],
      }),
      "utf8"
    );

    const usageRow = runAppend([
      fixtureDest,
      "--run",
      "selftest-run-3-usage",
      "--project",
      tmpBase,
      "--started",
      "2026-09-02T05:00:00.000Z",
      "--ended",
      "2026-09-02T06:00:00.000Z",
      "--usage",
      usagePath,
      "--run-id",
      "run-usage-1",
    ]);

    assert(usageRow.telemetry === "true", `expected telemetry 'true' on the --usage run, got '${usageRow.telemetry}'`);
    assert(
      Math.abs(usageRow.trueCostUsd - 0.246) < 1e-9,
      `expected trueCostUsd 0.246, got ${usageRow.trueCostUsd}`
    );
    assert(usageRow.activeMs === 1500000, `expected activeMs 1500000, got ${usageRow.activeMs}`);
    const gr = usageRow.phases.find((p) => p.phase === "Gate & Review");
    assert(gr, "expected a 'Gate & Review' phase entry on the --usage run");
    assert(
      gr.tokensSource === "session-usage",
      `expected Gate & Review tokensSource 'session-usage', got '${gr.tokensSource}'`
    );
    assert(gr.tokens === 10700, `expected Gate & Review tokens 10700, got ${gr.tokens}`);
    assert(Math.abs(gr.costUsd - 0.246) < 1e-9, `expected Gate & Review costUsd 0.246, got ${gr.costUsd}`);
    const baseline = usageRow.phases.find((p) => p.phase === "Baseline");
    assert(
      baseline.tokensSource === "budget",
      `expected an unmatched phase to stay tokensSource 'budget', got '${baseline.tokensSource}'`
    );

    // --- BOM fixture handling (real-world bug, 2026-09-13): a genuine
    // result.json written by a Windows-side process (a Haiku agent) carried
    // a leading UTF-8 BOM (U+FEFF) -- a normal encoding artifact, not
    // malformed input -- and `append` failed with "not valid JSON:
    // Unexpected token '﻿'" even though the JSON itself was perfectly
    // valid. A BOM-prefixed copy of the same fixture must append
    // successfully and produce the exact same row (aside from `run`) as the
    // BOM-free original. Uses its own isolated --project dir so its two
    // extra appends don't perturb the shared tmpBase ledger's line-count
    // assertions below.
    const bomProjectDir = path.join(tmpBase, "bom-project");
    const bomFixturePath = path.join(tmpBase, "bom-result.json");
    fs.writeFileSync(bomFixturePath, "﻿" + fs.readFileSync(fixtureDest, "utf8"), "utf8");

    const bomRow = runAppend([
      bomFixturePath,
      "--run",
      "selftest-bom-result",
      "--project",
      bomProjectDir,
      "--started",
      "2026-09-13T00:00:00.000Z",
      "--ended",
      "2026-09-13T01:00:00.000Z",
    ]);
    const noBomRow = runAppend([
      fixtureDest,
      "--run",
      "selftest-bom-result-control",
      "--project",
      bomProjectDir,
      "--started",
      "2026-09-13T00:00:00.000Z",
      "--ended",
      "2026-09-13T01:00:00.000Z",
    ]);
    assert(
      JSON.stringify({ ...bomRow, run: null }) === JSON.stringify({ ...noBomRow, run: null }),
      "expected a BOM-prefixed result.json to append the exact same row as its BOM-free original (aside from `run`)"
    );

    // A plain append (no --usage) still defaults to telemetry 'legacy' and
    // every phase stays tokensSource 'budget' -- confirmed on run 1/2 above.
    const legacyLedgerLines = stripBom(fs.readFileSync(getLedgerPath(tmpBase), "utf8"))
      .split(/\r?\n/)
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l));
    assert(
      legacyLedgerLines[0].telemetry === "legacy",
      `expected run 1 telemetry 'legacy', got '${legacyLedgerLines[0].telemetry}'`
    );

    const ledgerPath = getLedgerPath(tmpBase);
    const lineCount = fs
      .readFileSync(ledgerPath, "utf8")
      .split(/\r?\n/)
      .filter((l) => l.trim().length > 0).length;
    assert(lineCount === 3, `expected 3 ledger lines, got ${lineCount}`);

    console.log("\n--- summary output ---\n");
    const summary = runSummary(["--project", tmpBase]);

    assert(summary && summary.phaseTable.budget.length > 0, "budget phase table is empty");
    assert(
      summary.phaseTable.budget[0].phase === "Gate & Review",
      `expected 'Gate & Review' to rank first by mean tokens in the budget table, got '${summary.phaseTable.budget[0].phase}'`
    );
    // The session-usage phase table must never be polluted by budget-sourced
    // entries, and vice versa (the "never mix" requirement).
    assert(
      summary.phaseTable.budget.every((p) => p.tokensSource === "budget"),
      "budget phase table contains a non-budget entry"
    );
    assert(
      summary.phaseTable.sessionUsage.every((p) => p.tokensSource === "session-usage"),
      "session-usage phase table contains a non-session-usage entry"
    );
    const grStats = summary.phaseTable.sessionUsage.find((p) => p.phase === "Gate & Review");
    assert(grStats, "expected a session-usage 'Gate & Review' row in the phase table");
    assert(grStats.runsPresent === 1, `expected 1 session-usage run for Gate & Review, got ${grStats.runsPresent}`);
    assert(
      Math.abs(grStats.meanCostUsd - 0.246) < 1e-9,
      `expected meanCostUsd 0.246 for session-usage Gate & Review, got ${grStats.meanCostUsd}`
    );
    assert(grStats.meanCacheHitRatio != null, "expected a computed meanCacheHitRatio for session-usage Gate & Review");

    assert(summary.runs.meanTrueCostUsd != null, "expected runs.meanTrueCostUsd to be set once a --usage row exists");
    assert(summary.runs.costEstimateError != null, "expected runs.costEstimateError to be computable");

    // Red gate cut-rule: the f14 fixture's redGate has no audits array at
    // all, so it must show up as NOT evaluable/not-zero, never silently
    // counted as a zero-finding run (which is what phases[].confirmed would
    // have done, since redGate has no confirmedByPhase entry).
    const redGateRule = summary.tenRunRules.cutRules.find((c) => c.phase === "Red gate");
    assert(redGateRule, "expected a Red gate cut-rule entry");
    assert(
      redGateRule.criterion === "redGate.audits[].blockers=0",
      `expected Red gate criterion to key on blockers, got '${redGateRule.criterion}'`
    );
    assert(
      redGateRule.ranCount === 0,
      `expected Red gate ranCount 0 (fixture's redGate.audits is absent, not countable), got ${redGateRule.ranCount}`
    );

    // --- Truncated-id matching (F6) -------------------------------------
    // A transcript directory can carry a TRUNCATED run id (e.g.
    // "wf_1ca39e59-6ea" standing in for the full "wf_1ca39e59-6ea1-4f2b-
    // 9c3d-000000000000"), so usage.workflows can be keyed by either the
    // short or the long form while --run-id carries the other. Match when
    // one id is a prefix of the other with >= 8 shared characters after
    // "wf_"; too little shared prefix must NOT match.
    const truncUsagePath = path.join(tmpBase, "session-usage-trunc.json");
    fs.writeFileSync(
      truncUsagePath,
      JSON.stringify({
        v: 1,
        sessionId: "sess-selftest-trunc",
        project: tmpBase,
        pricesAsOf: "2026-06-24",
        session: {
          byModel: gateReviewUsage.byModel,
          total: gateReviewUsage.total,
          messages: 6,
          firstAt: "2026-09-02T07:00:00.000Z",
          lastAt: "2026-09-02T07:30:00.000Z",
          activeMs: 900000,
          cacheHitRatio: 0.75,
        },
        workflows: {
          "wf_1ca39e59-6ea": {
            byPhase: { "Gate & Review": gateReviewUsage },
            byLabel: {},
            byModel: gateReviewUsage.byModel,
            total: gateReviewUsage.total,
            agents: 4,
            cacheHitRatio: 0.75,
          },
        },
        warnings: [],
      }),
      "utf8"
    );

    const truncRow = runAppend([
      fixtureDest,
      "--run",
      "selftest-run-4-trunc-id",
      "--project",
      tmpBase,
      "--started",
      "2026-09-02T07:00:00.000Z",
      "--ended",
      "2026-09-02T07:30:00.000Z",
      "--usage",
      truncUsagePath,
      "--run-id",
      "wf_1ca39e59-6ea1-4f2b-9c3d-000000000000",
    ]);
    assert(
      truncRow.telemetry === "true",
      `expected telemetry 'true' on the truncated-id match run, got '${truncRow.telemetry}'`
    );
    assert(
      truncRow.usageMatchNote === null,
      `expected a truncated-id match to resolve with no usageMatchNote, got '${JSON.stringify(truncRow.usageMatchNote)}'`
    );
    assert(
      Math.abs(truncRow.trueCostUsd - 0.246) < 1e-9,
      `expected truncated-id match trueCostUsd 0.246, got ${truncRow.trueCostUsd}`
    );

    const noMatchRow = runAppend([
      fixtureDest,
      "--run",
      "selftest-run-5-trunc-nomatch",
      "--project",
      tmpBase,
      "--started",
      "2026-09-02T08:00:00.000Z",
      "--ended",
      "2026-09-02T08:30:00.000Z",
      "--usage",
      truncUsagePath,
      "--run-id",
      "wf_1ca39e5-different",
    ]);
    // --usage was still given and parsed, so telemetry stays "true" (it only
    // reflects whether real session data was AVAILABLE) -- but with no run
    // matched, trueCostUsd falls back to the whole session's total (F5's
    // "fell back to session totals" case), and usageMatchNote records why.
    assert(
      noMatchRow.telemetry === "true",
      `expected telemetry to stay 'true' when --usage was given even on a failed match, got '${noMatchRow.telemetry}'`
    );
    assert(
      typeof noMatchRow.usageMatchNote === "string" && noMatchRow.usageMatchNote.includes("not found"),
      `expected a usageMatchNote explaining the failed match, got '${JSON.stringify(noMatchRow.usageMatchNote)}'`
    );

    // F5: costEstimateError must exclude rows with a non-null usageMatchNote
    // (fallback-to-session-totals rows), reporting their own error separately
    // as costEstimateErrorExcluded instead of silently blending it into the
    // primary, matched-workflow mean.
    const summary2 = runSummary(["--project", tmpBase]);
    assert(
      summary2.runs.costEstimateErrorExcludedCount >= 1,
      `expected at least 1 row excluded from costEstimateError as a session-total fallback, got ${summary2.runs.costEstimateErrorExcludedCount}`
    );
    assert(
      summary2.runs.costEstimateErrorExcluded != null,
      "expected costEstimateErrorExcluded to be computable once a fallback row exists"
    );

    // --- Routing scorecard + lens scorecard (wave 3A) -------------------
    // A synthetic result.json carrying phaseReport entries for every level's
    // named phases, plus a lensReport splitting Gate & Review into pattern
    // (Sonnet) and deep (Opus) lenses -- the shape computeRoutingScorecard
    // and computeLensScorecard consume. No real result.json has this shape
    // yet (see extractLenses' comment), so this is the only place it is
    // exercised.
    const scorecardResult = {
      scale: "small",
      clean: true,
      startedAt: "2026-09-11T00:00:00.000Z",
      estimatedCostUsd: 5,
      phaseReport: [
        { phase: "Baseline", ran: true, agents: 1, rawFindings: 0, tokens: 1000, model: "claude-haiku-4-5", effort: "low", estUsd: 0.01 },
        { phase: "Author tests", ran: true, agents: 1, rawFindings: 0, tokens: 2000, model: "claude-sonnet-5", effort: "medium", estUsd: 0.02 },
        { phase: "Red gate", ran: true, agents: 1, rawFindings: 2, tokens: 3000, model: "claude-opus-5", effort: "high", estUsd: 0.5 },
        { phase: "Implement", ran: true, agents: 1, rawFindings: 0, tokens: 4000, model: "claude-sonnet-5", effort: "medium", estUsd: 0.04 },
        { phase: "Gate & Review", ran: true, agents: 2, rawFindings: 5, tokens: 5000, model: "claude-sonnet-5 (pattern) + claude-opus-5 (deep)", effort: "high", estUsd: 1.0 },
        { phase: "Verify", ran: true, agents: 1, rawFindings: 0, tokens: 1500, model: "claude-opus-5", effort: "high", estUsd: 0.3 },
        { phase: "Mutation probe", ran: true, agents: 1, rawFindings: 1, tokens: 1200, model: "claude-sonnet-5", effort: "medium", estUsd: 0.12 },
        { phase: "Fix", ran: true, agents: 1, rawFindings: 0, tokens: 2500, model: "claude-opus-5", effort: "high", estUsd: 0.6 },
      ],
      confirmedByPhase: { Baseline: 0, "Red gate": 2, "Gate & Review": 4, "Mutation probe": 1 },
      redGate: { ran: true, remediateOn: "behavioral", properlyRed: true, structurallyRed: true, behaviorallyRed: true, attempts: 1 },
      verify: { ran: true, lazy: false, judged: 10, dropped: 2, votesCast: 12, firstVoteRefuted: 1, firstVoteRefutedRate: 0.1, tieBreaks: 0 },
      mutationProbe: { ran: true, skipped: null, targets: 5, probed: 5, allCaught: false, restoredVerified: true, skippedTargets: [] },
      fixRounds: 2,
      lensReport: [
        { lens: "test-quality", model: "claude-sonnet-5", rawFindings: 3, executionConfirmed: 2, overturned: 1 },
        { lens: "design-system", model: "claude-sonnet-5", rawFindings: 2, executionConfirmed: 1, overturned: 1 },
        { lens: "correctness", model: "claude-opus-5", rawFindings: 4, executionConfirmed: 3, overturned: 1 },
      ],
      finalPass: null,
      uiVerify: { ran: false, completed: false, findings: [], reVerify: null },
      overlap: {},
      cascadeAudit: null,
      escalation: null,
      remainingFindings: [],
      gate: { pass: true, skipped: false, results: [] },
    };
    const scorecardResultPath = path.join(tmpBase, "scorecard-result.json");
    fs.writeFileSync(scorecardResultPath, JSON.stringify(scorecardResult), "utf8");

    function scorecardUsage(runIdKey, fixModel) {
      const perPhase = {
        Baseline: { model: "claude-haiku-4-5", costUsd: 0.01, durationMs: 30000 },
        "Author tests": { model: "claude-sonnet-5", costUsd: 0.02, durationMs: 60000 },
        "Red gate": { model: "claude-opus-5", costUsd: 0.5, durationMs: 300000 },
        Implement: { model: "claude-sonnet-5", costUsd: 0.04, durationMs: 90000 },
        "Gate & Review": { model: "mixed", costUsd: 1.0, durationMs: 400000 },
        Verify: { model: "claude-opus-5", costUsd: 0.3, durationMs: 200000 },
        "Mutation probe": { model: "claude-sonnet-5", costUsd: 0.12, durationMs: 120000 },
        Fix: { model: fixModel, costUsd: fixModel === "claude-opus-5" ? 0.6 : 0.2, durationMs: fixModel === "claude-opus-5" ? 700000 : 250000 },
      };
      const byPhase = {};
      let totalCost = 0;
      let totalTokens = 0;
      for (const [phase, p] of Object.entries(perPhase)) {
        const bucket = { input: 100, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 900, output: 100, tokens: 1100, costUsd: p.costUsd };
        byPhase[phase] = { total: bucket, byModel: { [p.model]: bucket }, agents: 1, labels: [], durationMs: p.durationMs };
        totalCost += p.costUsd;
        totalTokens += 1100;
      }
      const total = { input: 800, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 7200, output: 800, tokens: totalTokens, costUsd: totalCost };
      return {
        v: 1,
        sessionId: `sess-scorecard-${runIdKey}`,
        project: tmpBase,
        pricesAsOf: "2026-06-24",
        session: { byModel: {}, total, messages: 8, firstAt: "2026-09-11T00:00:00.000Z", lastAt: "2026-09-11T00:30:00.000Z", activeMs: 1800000, cacheHitRatio: 0.9 },
        workflows: { [runIdKey]: { byPhase, byLabel: {}, byModel: {}, total, agents: 8, cacheHitRatio: 0.9 } },
        warnings: [],
      };
    }

    const scorecardUsagePath1 = path.join(tmpBase, "scorecard-usage-1.json");
    fs.writeFileSync(scorecardUsagePath1, JSON.stringify(scorecardUsage("run-scorecard-1", "claude-opus-5")), "utf8");
    runAppend([
      scorecardResultPath,
      "--run",
      "scorecard-run-1",
      "--project",
      tmpBase,
      "--started",
      "2026-09-11T00:00:00.000Z",
      "--ended",
      "2026-09-11T00:30:00.000Z",
      "--usage",
      scorecardUsagePath1,
      "--run-id",
      "run-scorecard-1",
    ]);

    // Second run: same fixture, Fix on Sonnet instead of Opus (own
    // phaseReport entry, not just the usage file, since phase.model is read
    // from result.phaseReport -- see buildRow) and half the fixRounds --
    // gives the fixExecution level two distinct model groups to compare,
    // and a different meanFixRounds per group.
    const scorecardResult2 = {
      ...scorecardResult,
      fixRounds: 1,
      phaseReport: scorecardResult.phaseReport.map((p) =>
        p.phase === "Fix" ? { ...p, model: "claude-sonnet-5", estUsd: 0.2 } : p
      ),
    };
    const scorecardResultPath2 = path.join(tmpBase, "scorecard-result-2.json");
    fs.writeFileSync(scorecardResultPath2, JSON.stringify(scorecardResult2), "utf8");
    const scorecardUsagePath2 = path.join(tmpBase, "scorecard-usage-2.json");
    fs.writeFileSync(scorecardUsagePath2, JSON.stringify(scorecardUsage("run-scorecard-2", "claude-sonnet-5")), "utf8");
    runAppend([
      scorecardResultPath2,
      "--run",
      "scorecard-run-2",
      "--project",
      tmpBase,
      "--started",
      "2026-09-11T01:00:00.000Z",
      "--ended",
      "2026-09-11T01:30:00.000Z",
      "--usage",
      scorecardUsagePath2,
      "--run-id",
      "run-scorecard-2",
    ]);

    const summary3 = runSummary(["--project", tmpBase]);

    // trueTelemetryCount: run-3-usage, run-4-trunc-id, run-5-trunc-nomatch,
    // scorecard-run-1, scorecard-run-2 = 5 true rows out of 7 total.
    assert(summary3.runs.count === 7, `expected 7 ledger rows total, got ${summary3.runs.count}`);
    assert(
      summary3.runs.trueTelemetryCount === 5,
      `expected trueTelemetryCount 5, got ${summary3.runs.trueTelemetryCount}`
    );

    const sc = summary3.routingScorecard;
    assert(sc.trueTelemetryRowsUsed === 5, `expected routingScorecard to use 5 true rows, got ${sc.trueTelemetryRowsUsed}`);
    assert(sc.excludedRowsCount === 2, `expected 2 rows excluded from the routing scorecard, got ${sc.excludedRowsCount}`);

    const findRow = (level, phase, model) => sc.table.find((r) => r.level === level && r.phase === phase && r.model === model);

    // NOTE on expected counts below: the three earlier true-telemetry rows
    // in this same selftest (selftest-run-3-usage, -4-trunc-id,
    // -5-trunc-nomatch) all carry the f14 fixture, which shares several
    // (level, phase, model) keys with the scorecard fixture (Baseline on
    // claude-haiku-4-5, Author tests/Implement on claude-sonnet-5, Red gate/
    // Verify/Fix on claude-opus-5) -- those groups legitimately MERGE across
    // fixtures, which is the grouping mechanism working as designed. Only
    // Mutation probe (f14 is claude-opus-5, this fixture is claude-sonnet-5)
    // and the lensReport-driven Gate & Review split (f14 has no lensReport)
    // are exclusive to the two scorecard rows.
    const baselineRow = findRow("mechanical", "Baseline", "claude-haiku-4-5");
    assert(baselineRow, "expected a mechanical/Baseline/claude-haiku-4-5 row");
    assert(baselineRow.runs === 5, `expected Baseline row runs=5 (3 f14 + 2 scorecard), got ${baselineRow.runs}`);

    const redGateRow2 = findRow("highRiskVerdict", "Red gate", "claude-opus-5");
    const expectedRedGateRate = (3 * 0 + 2 * 1) / 5; // f14 behaviorallyRed=false x3, scorecard=true x2
    assert(redGateRow2, "expected a highRiskVerdict/Red gate/claude-opus-5 row");
    assert(redGateRow2.qualitySignalLabel === "behavioralRedRate", "expected Red gate qualitySignalLabel behavioralRedRate");
    assert(
      Math.abs(redGateRow2.qualitySignal - expectedRedGateRate) < 1e-9,
      `expected Red gate behavioralRedRate ${expectedRedGateRate}, got ${redGateRow2.qualitySignal}`
    );

    const mutationRow = findRow("routineVerdict", "Mutation probe", "claude-sonnet-5");
    assert(mutationRow, "expected a routineVerdict/Mutation probe/claude-sonnet-5 row");
    assert(mutationRow.runs === 2, `expected Mutation probe/claude-sonnet-5 to be exclusive to the 2 scorecard rows, got ${mutationRow.runs}`);
    assert(mutationRow.qualitySignalLabel === "caughtRate", "expected Mutation probe qualitySignalLabel caughtRate");
    assert(Math.abs(mutationRow.qualitySignal - 0.8) < 1e-9, `expected Mutation probe caughtRate 0.8 ((5-1)/5), got ${mutationRow.qualitySignal}`);

    const verifyRow2 = findRow("highRiskVerdict", "Verify", "claude-opus-5");
    const expectedVerifyRate = (3 * (2 / 13) + 2 * (2 / 10)) / 5; // f14: dropped=2/judged=13 x3; scorecard: 2/10 x2
    assert(verifyRow2, "expected a highRiskVerdict/Verify/claude-opus-5 row");
    assert(verifyRow2.qualitySignalLabel === "droppedFindingRate", "expected Verify qualitySignalLabel droppedFindingRate");
    assert(
      Math.abs(verifyRow2.qualitySignal - expectedVerifyRate) < 1e-9,
      `expected Verify droppedFindingRate ${expectedVerifyRate}, got ${verifyRow2.qualitySignal}`
    );

    const fixOpusRow = findRow("fixExecution", "Fix", "claude-opus-5");
    const fixSonnetRow = findRow("fixExecution", "Fix", "claude-sonnet-5");
    assert(fixOpusRow && fixOpusRow.runs === 4, `expected fixExecution/Fix/claude-opus-5 runs=4 (3 f14 + scorecard-run-1), got ${fixOpusRow && fixOpusRow.runs}`);
    assert(fixSonnetRow && fixSonnetRow.runs === 1, "expected a 1-run fixExecution/Fix/claude-sonnet-5 row (scorecard-run-2, exclusive)");
    assert(fixOpusRow.qualitySignalLabel === "meanFixRounds", "expected Fix qualitySignalLabel meanFixRounds");
    assert(Math.abs(fixOpusRow.qualitySignal - 2) < 1e-9, `expected Opus Fix meanFixRounds 2 ((2+2+2+2)/4), got ${fixOpusRow.qualitySignal}`);
    assert(Math.abs(fixSonnetRow.qualitySignal - 1) < 1e-9, `expected Sonnet Fix meanFixRounds 1, got ${fixSonnetRow.qualitySignal}`);

    const gateReviewPattern = findRow("routineVerdict", "Gate & Review (pattern lenses)", "claude-sonnet-5");
    const gateReviewDeep = findRow("highRiskVerdict", "Gate & Review (deep lenses)", "claude-opus-5");
    assert(gateReviewPattern, "expected Gate & Review to split a pattern-lens row into routineVerdict on claude-sonnet-5");
    assert(gateReviewDeep, "expected Gate & Review to split a deep-lens row into highRiskVerdict on claude-opus-5");
    assert(gateReviewPattern.qualitySignalLabel === "meanConfirmed", "expected Gate & Review split rows to use the reviewers default (meanConfirmed)");

    // Rows without lenses[] (every other selftest row, and every real ledger
    // row today) must never contribute a guessed Gate & Review level entry.
    assert(
      !sc.table.some((r) => r.phase === "Gate & Review"),
      "raw 'Gate & Review' phase name must never appear un-split in the routing scorecard"
    );

    const lsc = summary3.lensScorecard;
    const tq = lsc.find((l) => l.lens === "test-quality");
    const ds = lsc.find((l) => l.lens === "design-system");
    const co = lsc.find((l) => l.lens === "correctness");
    assert(tq && tq.runs === 2 && tq.rawFindings === 6 && tq.executionConfirmed === 4 && tq.overturned === 2, "unexpected test-quality lens totals");
    assert(Math.abs(tq.confirmedPerCall - 2) < 1e-9, `expected test-quality confirmedPerCall 2, got ${tq.confirmedPerCall}`);
    assert(Math.abs(tq.noiseRatio - 2 / 6) < 1e-9, `expected test-quality noiseRatio 1/3, got ${tq.noiseRatio}`);
    assert(ds && ds.runs === 2 && Math.abs(ds.noiseRatio - 0.5) < 1e-9, "unexpected design-system lens totals");
    assert(co && co.runs === 2 && co.rawFindings === 8 && co.executionConfirmed === 6 && co.overturned === 2, "unexpected correctness lens totals");

    // --- P2(c) 2026-09-11: new ledger row fields --------------------------
    const fieldsResult = {
      ...JSON.parse(stripBom(fs.readFileSync(fixtureDest, "utf8"))),
      mode: "bugfix",
      fallback: true,
      siblingSweep: { ran: true, supplied: 3, patterns: ["**/*.spec.ts"], skipped: false },
    };
    const fieldsResultPath = path.join(tmpBase, "fields-result.json");
    fs.writeFileSync(fieldsResultPath, JSON.stringify(fieldsResult), "utf8");

    const fieldsUsagePath = path.join(tmpBase, "fields-usage.json");
    fs.writeFileSync(
      fieldsUsagePath,
      JSON.stringify({
        v: 1,
        sessionId: "sess-fields-test",
        project: tmpBase,
        pricesAsOf: "2026-06-24",
        session: {
          byModel: {},
          total: { input: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0, tokens: 0, costUsd: 0.01 },
          messages: 1,
          firstAt: null,
          lastAt: null,
          activeMs: 0,
          cacheHitRatio: null,
        },
        workflows: {},
        warnings: [],
      }),
      "utf8"
    );

    const fieldsRow = runAppend([
      fieldsResultPath,
      "--run",
      "selftest-fields-run",
      "--project",
      tmpBase,
      "--started",
      "2026-09-11T00:00:00.000Z",
      "--ended",
      "2026-09-11T00:10:00.000Z",
      "--usage",
      fieldsUsagePath,
    ]);
    assert(fieldsRow.mode === "bugfix", `expected row.mode 'bugfix' (from result.mode), got '${fieldsRow.mode}'`);
    assert(
      fieldsRow.sessionId === "sess-fields-test",
      `expected row.sessionId from usage.sessionId, got '${fieldsRow.sessionId}'`
    );
    assert(fieldsRow.fallback === true, `expected row.fallback true (from result.fallback), got ${fieldsRow.fallback}`);
    assert(
      fieldsRow.siblingSweep && fieldsRow.siblingSweep.supplied === 3 && fieldsRow.siblingSweep.ran === true,
      `expected row.siblingSweep to pass through result.siblingSweep, got ${JSON.stringify(fieldsRow.siblingSweep)}`
    );
    assert(
      fieldsRow.usageOverrideReason === null,
      `expected row.usageOverrideReason null with no --usage-override-reason flag, got '${JSON.stringify(fieldsRow.usageOverrideReason)}'`
    );

    const overrideReasonRow = runAppend([
      fixtureDest,
      "--run",
      "selftest-fields-override-reason",
      "--project",
      tmpBase,
      "--started",
      "2026-09-11T01:00:00.000Z",
      "--ended",
      "2026-09-11T01:10:00.000Z",
      "--usage-override-reason",
      "sandbox has no transcripts",
    ]);
    assert(
      overrideReasonRow.usageOverrideReason === "sandbox has no transcripts",
      `expected row.usageOverrideReason from --usage-override-reason, got '${JSON.stringify(overrideReasonRow.usageOverrideReason)}'`
    );
    // defaults: no mode/siblingSweep on the fixture result (it does carry
    // its own top-level fallback:false, which must survive as-is -- false
    // is not nullish), no --usage-override-reason flag on this call.
    assert(overrideReasonRow.mode === null, `expected default row.mode null, got ${overrideReasonRow.mode}`);
    assert(overrideReasonRow.sessionId === null, `expected default row.sessionId null (no --usage), got ${overrideReasonRow.sessionId}`);
    assert(
      overrideReasonRow.fallback === false,
      `expected row.fallback false (fixture's own top-level fallback:false), got ${overrideReasonRow.fallback}`
    );
    assert(overrideReasonRow.siblingSweep === null, `expected default row.siblingSweep null, got ${overrideReasonRow.siblingSweep}`);

    // --- P2(c): "true-telemetry rows" must require telemetry==="true" AND
    // trueCostUsd != null -- a "true" row with a null cost must not count.
    const summaryBeforeStray = runSummary(["--project", tmpBase]);
    assert(
      typeof summaryBeforeStray.runs.trueTelemetryRowsCount === "number",
      "expected runs.trueTelemetryRowsCount to be present"
    );
    const strayCountBefore = summaryBeforeStray.runs.trueTelemetryRowsCount;
    const telemetryCountBefore = summaryBeforeStray.runs.trueTelemetryCount;
    fs.appendFileSync(
      getLedgerPath(tmpBase),
      JSON.stringify({ run: "stray-null-cost", telemetry: "true", trueCostUsd: null, endedAt: "2026-09-11T02:00:00Z" }) + "\n",
      "utf8"
    );
    const summaryAfterStray = runSummary(["--project", tmpBase]);
    assert(
      summaryAfterStray.runs.trueTelemetryCount === telemetryCountBefore + 1,
      `expected trueTelemetryCount to include the stray null-cost row (${telemetryCountBefore + 1}), got ${summaryAfterStray.runs.trueTelemetryCount}`
    );
    assert(
      summaryAfterStray.runs.trueTelemetryRowsCount === strayCountBefore,
      `expected trueTelemetryRowsCount to EXCLUDE the null-cost row (stayed at ${strayCountBefore}), got ${summaryAfterStray.runs.trueTelemetryRowsCount}`
    );

    // --- B18 + C1 (2026-09-12): profile/approach/taskRef/quality on buildRow ---
    const profileResult = {
      ...JSON.parse(stripBom(fs.readFileSync(fixtureDest, "utf8"))),
      profile: "lean",
      approach: "dev-pipeline",
      taskRef: "B18",
      fixRounds: 0,
      gate: { pass: true, skipped: false, results: [] },
      manifest: {
        files: [
          { path: "a.ts", status: "modified", risk: "LOW", changedLines: 10 },
          { path: "b.ts", status: "planned", risk: "LOW", changedLines: 5 },
          { path: "c.ts", status: "untracked", risk: "LOW", changedLines: 3 },
        ],
        validCommands: [],
        artifacts: [],
      },
      confirmedFindings: [
        { severity: "blocker", lens: "correctness" },
        { severity: "major", lens: "correctness" },
        { severity: "minor", lens: "test-quality" },
        { severity: "minor", lens: "test-quality" },
      ],
    };
    const profileResultPath = path.join(tmpBase, "profile-result.json");
    fs.writeFileSync(profileResultPath, JSON.stringify(profileResult), "utf8");

    const profileRow = runAppend([
      profileResultPath,
      "--run",
      "selftest-profile-lean",
      "--project",
      tmpBase,
      "--started",
      "2026-09-12T00:00:00.000Z",
      "--ended",
      "2026-09-12T00:10:00.000Z",
      "--profile",
      "lean",
    ]);
    assert(profileRow.profile === "lean", `expected row.profile 'lean' (from result.profile), got '${profileRow.profile}'`);
    assert(profileRow.approach === "dev-pipeline", `expected row.approach 'dev-pipeline' (from result.approach), got '${profileRow.approach}'`);
    assert(profileRow.taskRef === "B18", `expected row.taskRef 'B18' (from result.taskRef), got '${profileRow.taskRef}'`);
    assert(profileRow.quality.firstPassGreen === true, `expected quality.firstPassGreen true (gate.pass && fixRounds===0), got ${profileRow.quality.firstPassGreen}`);
    assert(
      profileRow.quality.reviewFindings &&
        profileRow.quality.reviewFindings.critical === 1 &&
        profileRow.quality.reviewFindings.important === 1 &&
        profileRow.quality.reviewFindings.minor === 2,
      `expected reviewFindings {critical:1,important:1,minor:2} from confirmedFindings severities, got ${JSON.stringify(profileRow.quality.reviewFindings)}`
    );
    assert(profileRow.quality.filesTouched === 2, `expected quality.filesTouched 2 (modified+planned), got ${profileRow.quality.filesTouched}`);
    assert(profileRow.quality.linesChanged === 15, `expected quality.linesChanged 15 (10+5), got ${profileRow.quality.linesChanged}`);
    assert(profileRow.quality.humanMinutes === null, `expected quality.humanMinutes null (not on this result), got ${profileRow.quality.humanMinutes}`);
    assert(profileRow.quality.escapedDefects === null, `expected quality.escapedDefects null (unknown at append time), got ${profileRow.quality.escapedDefects}`);

    // --approach/--task-ref/--profile flag pass-through when result carries none.
    const legacyProfileResult = JSON.parse(stripBom(fs.readFileSync(fixtureDest, "utf8")));
    const legacyProfileResultPath = path.join(tmpBase, "legacy-profile-result.json");
    fs.writeFileSync(legacyProfileResultPath, JSON.stringify(legacyProfileResult), "utf8");
    const flagRow = runAppend([
      legacyProfileResultPath,
      "--run",
      "selftest-profile-legacy-flags",
      "--project",
      tmpBase,
      "--started",
      "2026-09-12T01:00:00.000Z",
      "--ended",
      "2026-09-12T01:10:00.000Z",
      "--profile",
      "standard",
      "--approach",
      "superpowers",
      "--task-ref",
      "C1",
    ]);
    assert(flagRow.profile === "standard", `expected row.profile from --profile flag when result has none, got '${flagRow.profile}'`);
    assert(flagRow.approach === "superpowers", `expected row.approach from --approach flag when result has none, got '${flagRow.approach}'`);
    assert(flagRow.taskRef === "C1", `expected row.taskRef from --task-ref flag when result has none, got '${flagRow.taskRef}'`);

    // result field wins over the flag when both are given.
    const overrideRow = runAppend([
      profileResultPath,
      "--run",
      "selftest-profile-result-wins",
      "--project",
      tmpBase,
      "--started",
      "2026-09-12T02:00:00.000Z",
      "--ended",
      "2026-09-12T02:10:00.000Z",
      "--profile",
      "standard",
      "--approach",
      "raw",
      "--task-ref",
      "ZZZ",
    ]);
    assert(overrideRow.profile === "lean", `expected result.profile to win over --profile flag, got '${overrideRow.profile}'`);
    assert(overrideRow.approach === "dev-pipeline", `expected result.approach to win over --approach flag, got '${overrideRow.approach}'`);
    assert(overrideRow.taskRef === "B18", `expected result.taskRef to win over --task-ref flag, got '${overrideRow.taskRef}'`);

    // an invalid --approach value is refused.
    let threwOnBadApproach = false;
    try {
      runAppend([legacyProfileResultPath, "--run", "selftest-bad-approach", "--project", tmpBase, "--approach", "bogus"]);
    } catch (err) {
      threwOnBadApproach = err instanceof LedgerError;
    }
    assert(threwOnBadApproach, "expected append --approach bogus to be refused with a LedgerError");

    // old rows without the new fields still parse (usageRow predates this change).
    assert(usageRow.profile === null, `expected legacy row.profile null, got ${usageRow.profile}`);
    assert(usageRow.approach === null, `expected legacy row.approach null, got ${usageRow.approach}`);
    assert(usageRow.taskRef === null, `expected legacy row.taskRef null, got ${usageRow.taskRef}`);
    assert(usageRow.quality.firstPassGreen === false, `expected legacy row quality.firstPassGreen false (gate.pass=true, fixRounds=2), got ${usageRow.quality.firstPassGreen}`);
    assert(usageRow.quality.reviewFindings === null, `expected legacy row quality.reviewFindings null (no confirmedFindings), got ${JSON.stringify(usageRow.quality.reviewFindings)}`);
    assert(usageRow.quality.filesTouched === null, `expected legacy row quality.filesTouched null (no manifest), got ${usageRow.quality.filesTouched}`);
    assert(usageRow.quality.linesChanged === null, `expected legacy row quality.linesChanged null (no manifest), got ${usageRow.quality.linesChanged}`);
    assert(usageRow.quality.humanMinutes === null, `expected legacy row quality.humanMinutes null, got ${usageRow.quality.humanMinutes}`);
    assert(usageRow.quality.escapedDefects === null, `expected legacy row quality.escapedDefects null, got ${usageRow.quality.escapedDefects}`);

    // --- B18: profile split in the routing scorecard ---------------------
    const leanResult = { ...scorecardResult, profile: "lean", fixRounds: 1 };
    const leanResultPath = path.join(tmpBase, "lean-result.json");
    fs.writeFileSync(leanResultPath, JSON.stringify(leanResult), "utf8");
    const leanUsagePath = path.join(tmpBase, "lean-usage.json");
    fs.writeFileSync(leanUsagePath, JSON.stringify(scorecardUsage("run-lean-1", "claude-opus-5")), "utf8");
    runAppend([
      leanResultPath,
      "--run",
      "scorecard-run-lean",
      "--project",
      tmpBase,
      "--started",
      "2026-09-12T03:00:00.000Z",
      "--ended",
      "2026-09-12T03:30:00.000Z",
      "--usage",
      leanUsagePath,
      "--run-id",
      "run-lean-1",
    ]);

    const summary4 = runSummary(["--project", tmpBase]);
    const sc2 = summary4.routingScorecard;
    const baselineLean = sc2.table.find(
      (r) => r.level === "mechanical" && r.phase === "Baseline" && r.model === "claude-haiku-4-5" && r.profile === "lean"
    );
    const baselineLegacy = sc2.table.find(
      (r) => r.level === "mechanical" && r.phase === "Baseline" && r.model === "claude-haiku-4-5" && r.profile === "legacy"
    );
    assert(baselineLean, "expected a profile='lean' mechanical/Baseline/claude-haiku-4-5 scorecard row");
    assert(baselineLean.runs === 1, `expected the lean Baseline row to have runs=1, got ${baselineLean.runs}`);
    assert(baselineLegacy, "expected a profile='legacy' mechanical/Baseline/claude-haiku-4-5 scorecard row (rows with no profile)");
    // 5 from summary3 (3 f14-usage rows + 2 scorecard rows) + fieldsRow
    // (appended earlier in this same selftest with --usage, also f14-shaped,
    // profile/approach both unset) = 6 -- the lean-profiled row above must
    // stay a SEPARATE group rather than inflating this one.
    assert(baselineLegacy.runs === 6, `expected the legacy Baseline row to keep its prior 6 runs, got ${baselineLegacy.runs}`);

    // --- C1: approach split in the routing scorecard ----------------------
    const approachResult = { ...scorecardResult, approach: "raw", fixRounds: 3 };
    const approachResultPath = path.join(tmpBase, "approach-result.json");
    fs.writeFileSync(approachResultPath, JSON.stringify(approachResult), "utf8");
    const approachUsagePath = path.join(tmpBase, "approach-usage.json");
    fs.writeFileSync(approachUsagePath, JSON.stringify(scorecardUsage("run-approach-1", "claude-opus-5")), "utf8");
    runAppend([
      approachResultPath,
      "--run",
      "scorecard-run-approach",
      "--project",
      tmpBase,
      "--started",
      "2026-09-12T04:00:00.000Z",
      "--ended",
      "2026-09-12T04:30:00.000Z",
      "--usage",
      approachUsagePath,
      "--run-id",
      "run-approach-1",
    ]);

    const summary5 = runSummary(["--project", tmpBase]);
    const sc3 = summary5.routingScorecard;
    const baselineRaw = sc3.table.find(
      (r) => r.level === "mechanical" && r.phase === "Baseline" && r.model === "claude-haiku-4-5" && r.approach === "raw"
    );
    assert(baselineRaw, "expected an approach='raw' mechanical/Baseline/claude-haiku-4-5 scorecard row");
    assert(baselineRaw.profile === "legacy", `expected the raw-approach row to default profile 'legacy', got '${baselineRaw.profile}'`);

    // --- C1: append-manual against a scratch ledger, stubbed session-usage ---
    const fakeUsagePath = path.join(tmpBase, "fake-session-usage.mjs");
    fs.writeFileSync(
      fakeUsagePath,
      [
        "#!/usr/bin/env node",
        "const args = process.argv.slice(2);",
        "const costUsd = Number(process.env.FAKE_USAGE_COST || 4.5);",
        "const activeMs = Number(process.env.FAKE_USAGE_ACTIVE_MS || 1200000);",
        "console.log(JSON.stringify({",
        "  v: 1, sessionId: args[0], project: 'fake-project', pricesAsOf: '2026-06-24',",
        "  session: { byModel: {}, total: { input:0,cacheWrite5m:0,cacheWrite1h:0,cacheRead:0,output:0,tokens:0,costUsd }, messages:1, firstAt:'2026-09-12T00:00:00.000Z', lastAt:'2026-09-12T00:20:00.000Z', activeMs, cacheHitRatio:0.5 },",
        "  workflows: {}, warnings: [],",
        "}));",
        "",
      ].join("\n"),
      "utf8"
    );

    function withFakeUsage(costUsd, activeMs, fn) {
      const priorScript = process.env.PIPELINE_LEDGER_USAGE_SCRIPT;
      const priorCost = process.env.FAKE_USAGE_COST;
      const priorActive = process.env.FAKE_USAGE_ACTIVE_MS;
      process.env.PIPELINE_LEDGER_USAGE_SCRIPT = fakeUsagePath;
      process.env.FAKE_USAGE_COST = String(costUsd);
      process.env.FAKE_USAGE_ACTIVE_MS = String(activeMs);
      try {
        return fn();
      } finally {
        if (priorScript === undefined) delete process.env.PIPELINE_LEDGER_USAGE_SCRIPT;
        else process.env.PIPELINE_LEDGER_USAGE_SCRIPT = priorScript;
        if (priorCost === undefined) delete process.env.FAKE_USAGE_COST;
        else process.env.FAKE_USAGE_COST = priorCost;
        if (priorActive === undefined) delete process.env.FAKE_USAGE_ACTIVE_MS;
        else process.env.FAKE_USAGE_ACTIVE_MS = priorActive;
      }
    }

    const manualLedgerDir = path.join(tmpBase, "manual-project");
    const manualRow = withFakeUsage(4.5, 1200000, () =>
      runAppendManual([
        "--run",
        "manual-superpowers-1",
        "--approach",
        "superpowers",
        "--session",
        "sess-fake-1",
        "--project",
        manualLedgerDir,
        "--task-ref",
        "C1",
        "--first-pass-green",
        "true",
        "--findings",
        "0,1,2",
        "--human-minutes",
        "12",
        "--files-touched",
        "3",
        "--lines-changed",
        "40",
      ])
    );
    assert(manualRow.approach === "superpowers", `expected manual row approach 'superpowers', got '${manualRow.approach}'`);
    assert(manualRow.telemetry === "true", `expected manual row telemetry 'true', got '${manualRow.telemetry}'`);
    assert(Math.abs(manualRow.trueCostUsd - 4.5) < 1e-9, `expected manual row trueCostUsd 4.5 from the stubbed session-usage, got ${manualRow.trueCostUsd}`);
    assert(manualRow.activeMs === 1200000, `expected manual row activeMs 1200000, got ${manualRow.activeMs}`);
    assert(manualRow.quality.firstPassGreen === true, `expected manual row quality.firstPassGreen true, got ${manualRow.quality.firstPassGreen}`);
    assert(
      manualRow.quality.reviewFindings.critical === 0 &&
        manualRow.quality.reviewFindings.important === 1 &&
        manualRow.quality.reviewFindings.minor === 2,
      `expected manual row reviewFindings {0,1,2}, got ${JSON.stringify(manualRow.quality.reviewFindings)}`
    );
    assert(manualRow.quality.humanMinutes === 12, `expected manual row humanMinutes 12, got ${manualRow.quality.humanMinutes}`);
    assert(manualRow.quality.filesTouched === 3, `expected manual row filesTouched 3, got ${manualRow.quality.filesTouched}`);
    assert(manualRow.quality.linesChanged === 40, `expected manual row linesChanged 40, got ${manualRow.quality.linesChanged}`);
    assert(Array.isArray(manualRow.phaseReport) && manualRow.phaseReport.length === 0, "expected manual row phaseReport []");
    assert(manualRow.mode === "manual", `expected manual row mode 'manual', got '${manualRow.mode}'`);
    assert(manualRow.taskRef === "C1", `expected manual row taskRef 'C1', got '${manualRow.taskRef}'`);
    assert(manualRow.profile === null, `expected manual row profile null, got ${manualRow.profile}`);

    let threwNoApproach = false;
    try {
      runAppendManual(["--run", "x", "--session", "sess-x", "--project", manualLedgerDir]);
    } catch (err) {
      threwNoApproach = err instanceof LedgerError && err.code === 2;
    }
    assert(threwNoApproach, "expected append-manual without --approach to refuse with exit 2");

    let threwNoSession = false;
    try {
      runAppendManual(["--run", "y", "--approach", "raw", "--project", manualLedgerDir]);
    } catch (err) {
      threwNoSession = err instanceof LedgerError && err.code === 2;
    }
    assert(threwNoSession, "expected append-manual without --session to refuse with exit 2");

    // Fix round 1 (2026-09-12 review, Minor): a non-numeric --human-minutes/
    // --files-touched/--lines-changed must be refused, not silently coerced
    // to null (Number("abc") -> NaN -> numOrNull -> null hides a typo).
    let threwOnBadHumanMinutes = false;
    withFakeUsage(1, 1000, () => {
      try {
        runAppendManual([
          "--run",
          "manual-bad-numeric-flag",
          "--approach",
          "raw",
          "--session",
          "sess-bad-numeric",
          "--project",
          manualLedgerDir,
          "--human-minutes",
          "not-a-number",
        ]);
      } catch (err) {
        threwOnBadHumanMinutes = err instanceof LedgerError;
      }
    });
    assert(threwOnBadHumanMinutes, "expected append-manual --human-minutes not-a-number to be refused with a LedgerError");

    let threwOnDup = false;
    withFakeUsage(9, 1000, () => {
      try {
        runAppendManual([
          "--run",
          "manual-superpowers-1",
          "--approach",
          "raw",
          "--session",
          "sess-fake-2",
          "--project",
          manualLedgerDir,
          "--first-pass-green",
          "false",
          "--findings",
          "0,0,0",
          "--human-minutes",
          "5",
        ]);
      } catch (err) {
        threwOnDup = err instanceof LedgerError && err.code === 3;
      }
    });
    assert(threwOnDup, "expected append-manual to refuse overwriting an existing run slug with exit 3");

    // --- C1: attribute -----------------------------------------------------
    const beforeAttr = readLedgerRows(getLedgerPath(manualLedgerDir)).find((r) => r.run === "manual-superpowers-1");
    assert(beforeAttr && beforeAttr.quality.escapedDefects === 0, `expected pre-attribute escapedDefects 0, got ${beforeAttr && beforeAttr.quality.escapedDefects}`);

    const attrRow = runAttribute(["--run", "manual-superpowers-1", "--bug", "B999", "--project", manualLedgerDir]);
    assert(attrRow.quality.escapedDefects === 1, `expected escapedDefects 1 after attribute, got ${attrRow.quality.escapedDefects}`);
    assert(
      Array.isArray(attrRow.quality.escapedBugs) && attrRow.quality.escapedBugs.includes("B999"),
      `expected escapedBugs to include 'B999', got ${JSON.stringify(attrRow.quality.escapedBugs)}`
    );

    const attrRow2 = runAttribute(["--run", "manual-superpowers-1", "--bug", "B1000", "--project", manualLedgerDir]);
    assert(attrRow2.quality.escapedDefects === 2, `expected escapedDefects 2 after a second attribute, got ${attrRow2.quality.escapedDefects}`);
    assert(attrRow2.quality.escapedBugs.length === 2, `expected escapedBugs length 2, got ${attrRow2.quality.escapedBugs.length}`);

    let threwOnMissingRun = false;
    try {
      runAttribute(["--run", "does-not-exist", "--bug", "B1", "--project", manualLedgerDir]);
    } catch (err) {
      threwOnMissingRun = err instanceof LedgerError && err.code === 3;
    }
    assert(threwOnMissingRun, "expected attribute on a missing run to refuse with exit 3");

    // --- C1: compare ---------------------------------------------------------
    const compareDir = path.join(tmpBase, "compare-project");
    fs.mkdirSync(compareDir, { recursive: true });
    function minimalResult(extra) {
      return {
        scale: "small",
        clean: true,
        startedAt: "2026-09-12T00:00:00.000Z",
        estimatedCostUsd: 1,
        phaseReport: [],
        confirmedByPhase: {},
        redGate: null,
        verify: null,
        uiVerify: null,
        mutationProbe: null,
        finalPass: null,
        overlap: {},
        cascadeAudit: null,
        escalation: null,
        remainingFindings: [],
        gate: { pass: true, skipped: false, results: [] },
        fixRounds: 0,
        ...extra,
      };
    }
    function appendCompareRow(approach, profile, run, costUsd, activeMs, fpg, findings) {
      const resultPath = path.join(compareDir, `${run}-result.json`);
      fs.writeFileSync(
        resultPath,
        JSON.stringify(
          minimalResult({
            confirmedFindings: [
              ...Array(findings.critical).fill({ severity: "blocker" }),
              ...Array(findings.important).fill({ severity: "major" }),
              ...Array(findings.minor).fill({ severity: "minor" }),
            ],
            fixRounds: fpg ? 0 : 1,
          })
        ),
        "utf8"
      );
      const usagePath = path.join(compareDir, `${run}-usage.json`);
      fs.writeFileSync(
        usagePath,
        JSON.stringify({
          v: 1,
          sessionId: `sess-${run}`,
          project: compareDir,
          pricesAsOf: "2026-06-24",
          session: {
            byModel: {},
            total: { input: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0, tokens: 0, costUsd },
            messages: 1,
            firstAt: null,
            lastAt: null,
            activeMs,
            cacheHitRatio: null,
          },
          workflows: {},
          warnings: [],
        }),
        "utf8"
      );
      const args = [resultPath, "--run", run, "--project", compareDir, "--usage", usagePath];
      if (approach) args.push("--approach", approach);
      if (profile) args.push("--profile", profile);
      return runAppend(args);
    }
    function appendManualCompareRow(approach, run, costUsd, activeMs, fpg, findings, escaped) {
      const row = withFakeUsage(costUsd, activeMs, () =>
        runAppendManual([
          "--run",
          run,
          "--approach",
          approach,
          "--session",
          `sess-${run}`,
          "--project",
          compareDir,
          "--first-pass-green",
          String(fpg),
          "--findings",
          `${findings.critical},${findings.important},${findings.minor}`,
          "--human-minutes",
          "10",
        ])
      );
      for (let i = 0; i < escaped; i++) runAttribute(["--run", run, "--bug", `B-${run}-${i}`, "--project", compareDir]);
      return row;
    }

    appendCompareRow("dev-pipeline", "lean", "cmp-dp-1", 2.0, 600000, true, { critical: 0, important: 0, minor: 1 });
    appendCompareRow("dev-pipeline", "lean", "cmp-dp-2", 3.0, 900000, false, { critical: 0, important: 1, minor: 0 });
    appendCompareRow(null, null, "cmp-legacy-1", 5.0, 1200000, false, { critical: 1, important: 0, minor: 0 });
    appendCompareRow(null, null, "cmp-legacy-2", 6.0, 1500000, false, { critical: 0, important: 0, minor: 0 });
    appendManualCompareRow("superpowers", "cmp-sp-1", 1.0, 300000, true, { critical: 0, important: 0, minor: 0 }, 0);
    appendManualCompareRow("superpowers", "cmp-sp-2", 1.5, 400000, true, { critical: 0, important: 0, minor: 1 }, 0);
    appendManualCompareRow("raw", "cmp-raw-1", 0.5, 200000, false, { critical: 0, important: 1, minor: 0 }, 1);
    appendManualCompareRow("raw", "cmp-raw-2", 0.7, 250000, true, { critical: 0, important: 0, minor: 0 }, 0);

    const cmp10 = runCompare(["--project", compareDir, "--min-n", "10"]);
    assert(cmp10.arms.length === 4, `expected 4 arms (dev-pipeline, legacy, superpowers, raw), got ${cmp10.arms.length}`);
    for (const arm of cmp10.arms) {
      assert(
        arm.sufficient === false,
        `expected arm ${arm.approach}${arm.profile ? ":" + arm.profile : ""} to be insufficient at min-n 10 (n=${arm.n})`
      );
    }
    assert(cmp10.cheapest === null, "expected no cheapest arm at min-n 10 (every arm insufficient)");

    const cmp1 = runCompare(["--project", compareDir, "--min-n", "1"]);
    assert(cmp1.arms.every((a) => a.sufficient === true), "expected every arm sufficient at min-n 1");
    assert(cmp1.cheapest, "expected a cheapest arm at min-n 1");
    assert(cmp1.cheapest.approach === "superpowers", `expected cheapest arm 'superpowers' at min-n 1, got '${cmp1.cheapest.approach}'`);
    assert(
      Math.abs(cmp1.cheapest.meanTrueCostUsd - 1.25) < 1e-9,
      `expected cheapest arm mean cost 1.25, got ${cmp1.cheapest.meanTrueCostUsd}`
    );

    // old rows without the new fields still parse through compare too.
    const cmpMain = runCompare(["--project", tmpBase, "--min-n", "1"]);
    assert(Array.isArray(cmpMain.arms), "expected compare on the main ledger (old + new rows) to run without throwing");
    const legacyArmMain = cmpMain.arms.find((a) => a.approach === "legacy" && a.profile === null);
    assert(legacyArmMain, "expected the main ledger's old true-telemetry rows (no approach field) to form a 'legacy' arm");

    // --- Fix round 1 (2026-09-12 review): an unaudited arm (meanEscapedDefects
    // null, no `attribute` ever run against any of its rows) must never win or
    // tie against a confirmed-clean arm (meanEscapedDefects 0) for "cheapest",
    // even when the unaudited arm is cheaper -- coercing null to 0 with `?? 0`
    // rewards under-monitoring instead of a clean track record.
    const nullVsZeroDir = path.join(tmpBase, "null-vs-zero-project");
    fs.mkdirSync(nullVsZeroDir, { recursive: true });

    function writeMinimalCompareResult(dir, run, findings) {
      const resultPath = path.join(dir, `${run}-result.json`);
      fs.writeFileSync(
        resultPath,
        JSON.stringify(
          minimalResult({
            confirmedFindings: [
              ...Array(findings.critical).fill({ severity: "blocker" }),
              ...Array(findings.important).fill({ severity: "major" }),
              ...Array(findings.minor).fill({ severity: "minor" }),
            ],
          })
        ),
        "utf8"
      );
      return resultPath;
    }
    function writeMinimalCompareUsage(dir, run, costUsd, activeMs) {
      const usagePath = path.join(dir, `${run}-usage.json`);
      fs.writeFileSync(
        usagePath,
        JSON.stringify({
          v: 1,
          sessionId: `sess-${run}`,
          project: dir,
          pricesAsOf: "2026-06-24",
          session: {
            byModel: {},
            total: { input: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0, tokens: 0, costUsd },
            messages: 1,
            firstAt: null,
            lastAt: null,
            activeMs,
            cacheHitRatio: null,
          },
          workflows: {},
          warnings: [],
        }),
        "utf8"
      );
      return usagePath;
    }

    // two never-attributed dev-pipeline rows -- cheap, but meanEscapedDefects
    // stays null (computeQuality's escapedDefects is null until `attribute`
    // ever runs against a row; the engine never sets it itself).
    for (const [run, costUsd] of [
      ["nvz-dp-1", 0.4],
      ["nvz-dp-2", 0.6],
    ]) {
      const resultPath = writeMinimalCompareResult(nullVsZeroDir, run, { critical: 0, important: 0, minor: 0 });
      const usagePath = writeMinimalCompareUsage(nullVsZeroDir, run, costUsd, 60000);
      runAppend([resultPath, "--run", run, "--project", nullVsZeroDir, "--usage", usagePath, "--approach", "dev-pipeline"]);
    }

    // one manual raw row -- pricier, but confirmed-clean: append-manual
    // hardcodes escapedDefects:0 at creation, and it is never attributed
    // against here, so it stays a real 0, not null.
    withFakeUsage(5.0, 100000, () =>
      runAppendManual([
        "--run",
        "nvz-raw-1",
        "--approach",
        "raw",
        "--session",
        "sess-nvz-raw-1",
        "--project",
        nullVsZeroDir,
        "--first-pass-green",
        "true",
        "--findings",
        "0,0,0",
        "--human-minutes",
        "5",
      ])
    );

    const cmpNvz = runCompare(["--project", nullVsZeroDir, "--min-n", "1"]);
    const dpArmNvz = cmpNvz.arms.find((a) => a.approach === "dev-pipeline");
    const rawArmNvz = cmpNvz.arms.find((a) => a.approach === "raw");
    assert(
      dpArmNvz && dpArmNvz.meanEscapedDefects === null,
      `expected the never-attributed dev-pipeline arm to have meanEscapedDefects null, got ${dpArmNvz && dpArmNvz.meanEscapedDefects}`
    );
    assert(
      rawArmNvz && rawArmNvz.meanEscapedDefects === 0,
      `expected the manual raw arm to have meanEscapedDefects 0 (confirmed clean), got ${rawArmNvz && rawArmNvz.meanEscapedDefects}`
    );
    assert(
      dpArmNvz.meanTrueCostUsd < rawArmNvz.meanTrueCostUsd,
      "test setup: the never-audited arm must be cheaper for this to be a meaningful regression check"
    );
    assert(cmpNvz.cheapest, "expected a cheapest arm once at least one audited arm exists");
    assert(
      cmpNvz.cheapest.approach !== "dev-pipeline",
      `expected the never-audited dev-pipeline arm (cheaper, meanEscapedDefects=null) to NEVER be named or tied for cheapest, got '${cmpNvz.cheapest.approach}'`
    );
    assert(
      cmpNvz.cheapest.approach === "raw",
      `expected the only audited arm (raw, confirmed-zero) to win cheapest despite higher cost, got '${cmpNvz.cheapest.approach}'`
    );

    console.log("\nSELFTEST PASSED");
  } catch (err) {
    ok = false;
    console.error("SELFTEST FAILED: " + err.message);
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }

  process.exitCode = ok ? 0 : 1;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const rest = argv.slice(1);

  if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
    printHelp();
    process.exitCode = cmd ? 0 : 1;
    return;
  }

  try {
    switch (cmd) {
      case "append":
        runAppend(rest);
        break;
      case "append-manual":
        runAppendManual(rest);
        break;
      case "attribute":
        runAttribute(rest);
        break;
      case "compare":
        runCompare(rest);
        break;
      case "summary":
        runSummary(rest);
        break;
      case "selftest":
        runSelftest();
        break;
      default:
        process.stderr.write(`Unknown command '${cmd}'.\n\n`);
        printHelp();
        process.exitCode = 1;
    }
  } catch (err) {
    if (err instanceof LedgerError) {
      process.stderr.write(err.message + "\n");
      process.exitCode = err.code || 2;
      return;
    }
    throw err;
  }
}

main();
