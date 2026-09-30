#!/usr/bin/env node
// closeout.mjs
//
// One command for dev-pipeline / bug-pipeline S8 close-out (see the plan at
// .claude/plans/please-plan-on-what-sorted-sifakis.md, Part 3 §D1): given a
// finished run's directory, it
//   1. resolves the project, run slug, mode/scale/startedAt/endedAt/runId,
//   2. runs model-routing/scripts/session-usage.mjs for true telemetry,
//   3. appends one row to <project>/.claude/pipeline/cost-ledger.jsonl via
//      model-routing/scripts/pipeline-ledger.mjs append,
//   4. inserts a RUN-LOG.md stub (Caught/Wasted pre-filled, Knob/Deviation
//      left TODO for a human),
//   5. on bugfix runs, inserts a LESSONS.md stub and bumps _meta.json.nextId,
//   6. prints (never edits) code-map TODOs for any touched file with no
//      existing map entry,
//   7. writes a .claude/handoffs/<date>-<slug>.md card,
//   8. prints the S8 checklist (done / MANUAL / failed).
// Every write is idempotent by run slug, and --dry performs steps 1-2 and
// previews 3-7 as a diff without writing anything.
//
// No dependencies. Node >= 18. ES module.
//
// Usage:
//   node closeout.mjs <runDir> [--project <dir>] [--session <id> | --latest]
//       [--dry] [--no-usage --reason "<why>"] [--branch <name>] [--pr <n>]
//       [--ledger <file>] [--runlog <file>]
//       [--light [--scale small|major] [--findings <json>]]
//   node closeout.mjs selftest
//
// --project   Project root. Resolved via `git -C <runDir> rev-parse
//             --git-common-dir` (its parent is the MAIN checkout, which is
//             what carries the real ~/.claude/projects/<enc> transcript dir
//             and the real ledger -- a worktree's own path encodes to a
//             transcript dir that never existed, since the session ran in
//             the main checkout). Falls back to walking up from <runDir> to
//             the nearest ancestor that has, or IS named, '.claude' only
//             when git is unavailable. Explicit --project always wins over
//             both. Which resolution fired is logged as a warning.
// --session   Session id to hand to session-usage.mjs. Default (and what
//             bare --latest also means): --latest.
// --no-usage  Skip session-usage.mjs entirely -- requires --reason "<why>"
//             (P2(b), 2026-09-11: true telemetry or no close-out). Without
//             --reason this is a usage error (exit 2, nothing written).
//             With it, the ledger row is appended with --telemetry legacy
//             and usageOverrideReason "<why>". A session-usage attempt that
//             is NOT skipped via --no-usage and then genuinely FAILS is
//             fatal (throws, nothing written) -- there is no silent
//             fallback to a legacy row any more.
// --ledger    Overrides the ledger file used for the idempotency check and
//             the append. Must end in '.claude/pipeline/cost-ledger.jsonl'
//             (pipeline-ledger.mjs derives its project dir from that suffix)
//             -- for testability (selftest), not normal use.
// --runlog    Overrides the RUN-LOG.md path (default: this skill's own
//             references/RUN-LOG.md) -- for testability, not normal use.
// --dry       Preview every write as a unified-diff-ish block; write nothing
//             (not even session-usage.json).
// --light     Light-loop close-out. Auto-triggers whenever <runDir> has no
//             result.json at all, even without this flag; pass it explicitly
//             to (a) force reconstruction even when a result.json already
//             exists, and (b) additionally unblock the RUN-LOG stub for the
//             auto-triggered case (a missing result.json with no --light
//             gets a ledger row but the RUN-LOG step refuses -- see stepRunLog).
//             Builds a minimal result object (mode "light-loop") from
//             session-usage.mjs telemetry so the ledger append and RUN-LOG
//             stub have something to record instead of recording nothing.
// --scale     Only meaningful for a light-loop result: 'small' or 'major'.
// --findings  Only meaningful for a light-loop result: a JSON object
//             '{"remaining":[{severity,file,summary}],"confirmedByPhase":{}}'
//             used to set the synthesized result's clean/remainingFindings/
//             confirmedByPhase fields. Malformed JSON is ignored (treated as
//             no findings given, i.e. clean:true).
//
// This script only ever reads:
//   - <runDir>/{result.json, RESUME.md, pipeline-args.json}
//   - <project>/.claude/{pipeline/cost-ledger.jsonl, lessons/*, code-map/*.md}
//   - this skill's references/RUN-LOG.md (or --runlog)
//   - git plumbing in <project> (read-only commands only)
//   - a temp directory under os.tmpdir() (selftest only)
// and only ever writes (never under --dry):
//   - <runDir>/session-usage.json (via session-usage.mjs --out)
//   - <runDir>/result.json (light-loop synthesis only: when it was missing,
//     or when --light explicitly forces reconstruction of an existing one)
//   - the ledger file (via pipeline-ledger.mjs append, a real subprocess)
//   - the RUN-LOG.md file (a new entry, never touching existing ones)
//   - <project>/.claude/lessons/{LESSONS.md,_meta.json} (bugfix runs only)
//   - <project>/.claude/handoffs/<date>-<slug>.md
//   - a temp directory under os.tmpdir() (selftest only)
// It never edits .claude/code-map/**, pipeline.js, or any SKILL.md.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(__filename);
const SESSION_USAGE_SCRIPT = path.join(SCRIPT_DIR, "..", "..", "model-routing", "scripts", "session-usage.mjs");
const PIPELINE_LEDGER_SCRIPT = path.join(SCRIPT_DIR, "..", "..", "model-routing", "scripts", "pipeline-ledger.mjs");
const DEFAULT_RUN_LOG_PATH = path.join(SCRIPT_DIR, "..", "references", "RUN-LOG.md");

class CloseoutError extends Error {
  constructor(message, code = 2) {
    super(message);
    this.name = "CloseoutError";
    this.code = code;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function parseFlags(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
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

function loadJsonSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function readTextSafe(p) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

// Local date, not UTC -- a UTC slice puts a run in "tomorrow" for anyone west
// of Greenwich in the evening, which is what mis-dated a handoff filename on
// 2026-09-10 (see handoffFileBase below for the matching double-prefix fix).
function todayStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function fmtHM(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return null;
  const totalMin = Math.round(Math.abs(ms) / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${h}:${String(m).padStart(2, "0")}`;
}

function fmtCost(trueCost, estCost) {
  if (typeof trueCost === "number" && Number.isFinite(trueCost)) return `$${trueCost.toFixed(2)}`;
  if (typeof estCost === "number" && Number.isFinite(estCost)) return `~$${estCost.toFixed(2)} (est.)`;
  return "cost n/a";
}

function runNode(scriptPath, args, cwd) {
  // env explicit (not just inherited) so CLOSEOUT_SELFTEST=1 is guaranteed to
  // reach any child process this spawns (session-usage.mjs, pipeline-ledger.mjs).
  return spawnSync(process.execPath, [scriptPath, ...args], { encoding: "utf8", cwd, env: process.env });
}

// ---------------------------------------------------------------------------
// selftest write guard -- structural defense-in-depth. When
// CLOSEOUT_SELFTEST=1 (set by runSelftest at its start, inherited by any
// child process runNode spawns), every write-capable step below refuses to
// touch a path outside os.tmpdir(). This is what stops a selftest fixture
// from ever landing in this skill's real references/RUN-LOG.md again (see
// the 2026-09-10-workflow-redesign RUN-LOG entry: a `run1` stub leaked into
// the real file because a selftest call omitted --runlog).
function assertSelftestSafePath(p) {
  if (process.env.CLOSEOUT_SELFTEST !== "1") return;
  const resolved = path.resolve(p);
  const tmpRoot = path.resolve(os.tmpdir());
  const rel = path.relative(tmpRoot, resolved);
  const underTmp = rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  if (!underTmp) {
    throw new Error(`selftest guard: refusing to write outside tmpdir: ${resolved}`);
  }
}

function firstLine(s) {
  return (s || "").trim().split(/\r?\n/)[0] || "";
}

// ---------------------------------------------------------------------------
// step 1: project/slug/mode/scale/startedAt/runId resolution
// ---------------------------------------------------------------------------

// P2(a) 2026-09-11: resolves the MAIN checkout root via git plumbing --
// the parent of `git rev-parse --git-common-dir` run at <cwd>. git-common-dir
// always points at the one real .git directory shared by every worktree, so
// from a worktree this resolves to the main checkout, not the worktree's own
// path. That matters because the worktree's own path encodes to a
// ~/.claude/projects/<enc> transcript dir that never existed (the session
// ran in the main checkout) -- session-usage.mjs then fails and the row
// used to fall back to "legacy" silently. Returns null (never throws) when
// git is unavailable or <cwd> is not inside a git repo, so the caller can
// fall back to the walk-up below.
function resolveProjectViaGit(cwd) {
  let res;
  try {
    res = spawnSync("git", ["-C", cwd, "rev-parse", "--git-common-dir"], { encoding: "utf8" });
  } catch {
    return null;
  }
  if (!res || res.error || res.status !== 0) return null;
  const raw = (res.stdout || "").trim();
  if (!raw) return null;
  const gitCommonDir = path.resolve(cwd, raw);
  return path.dirname(gitCommonDir);
}

// Returns { project, note } -- note is a one-line, human-readable record of
// which resolution strategy fired (--project / git-common-dir / walk-up),
// pushed onto the caller's warnings/audit trail so it's always visible which
// one was used for a given run.
function resolveProject(runDir, projectFlag) {
  if (typeof projectFlag === "string" && projectFlag.length) {
    const p = path.resolve(projectFlag);
    return { project: p, note: `project: resolved via --project -> ${p}` };
  }
  const viaGit = resolveProjectViaGit(runDir);
  if (viaGit) {
    return { project: viaGit, note: `project: resolved via git-common-dir -> ${viaGit}` };
  }
  let dir = path.resolve(runDir);
  for (;;) {
    if (path.basename(dir) === ".claude") {
      const p = path.dirname(dir);
      return { project: p, note: `project: resolved via .claude walk-up, git unavailable -> ${p}` };
    }
    const candidate = path.join(dir, ".claude");
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return { project: dir, note: `project: resolved via .claude walk-up, git unavailable -> ${dir}` };
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new CloseoutError(
    `cannot find a '.claude' directory walking up from '${runDir}', and git resolution failed too. Pass --project <dir>.`
  );
}

// True when `child` is `parentDir` itself or a descendant of it.
function isUnderDir(child, parentDir) {
  const rel = path.relative(parentDir, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

// RESUME.md carries mode/scale in prose like "(bug-pipeline, mode bugfix,
// scale minor)" and runId/startedAt on their own lines (see
// 2026-09-08-B263-scan-price-tray/RESUME.md) -- match loosely rather than
// assuming one exact format.
function extractModeScale(text) {
  if (!text) return { mode: null, scale: null };
  const modeM = text.match(/\bmode:?\s*[`'"]?(bugfix|feature)[`'"]?\b/i);
  const scaleM = text.match(/\bscale:?\s*[`'"]?(trivial|small|major|minor)[`'"]?\b/i);
  return {
    mode: modeM ? modeM[1].toLowerCase() : null,
    scale: scaleM ? scaleM[1].toLowerCase() : null,
  };
}

function extractStartedAt(text) {
  if (!text) return null;
  const m = text.match(/startedAt:?\s*[`'"]?(\d{4}-\d{2}-\d{2}T[\d:.Z]+)[`'"]?/i);
  return m ? m[1] : null;
}

function extractRunId(text) {
  if (!text) return null;
  let m = text.match(/runId:?\s*`?(wf_[A-Za-z0-9_-]+)`?/i);
  if (m) return m[1];
  m = text.match(/\b(wf_[A-Za-z0-9_-]+)\b/);
  return m ? m[1] : null;
}

// E6 fix (2026-09-15): closeout used to have no single, authoritative place
// this resolution happened, and the caller effectively fell back to guessing
// a workflow id from the RUN DIRECTORY'S FOLDER NAME (a human slug like
// "2026-09-14-743-fix-round", never the Workflow tool's own wf_<hex> id) --
// that guess matches nothing in the session transcript, and closeout.mjs
// used to swallow the resulting session-usage mismatch by keying off
// usage.session instead of usage.workflows[...], attributing the WHOLE
// SESSION's cost ($108.61) to one run that actually cost $7.33 (run
// wf_a3822206-ba6). Resolution order, first hit wins, and the folder name
// (`slug`) is NEVER consulted:
//   1. --wf <runId> on the closeout.mjs command line (explicit override)
//   2. a `runId:`/`wf_...` pattern in <runDir>/RESUME.md
//   3. result.json's `runId` or `workflowId` field
//   4. a `runId:`/`wf_...` pattern in <runDir>/progress.md
// Finding nothing returns runId:null and the three paths checked, so the
// caller can abort loudly instead of writing a ledger row for the wrong run.
function resolveRunId({ flags, runDir, resumeText, result }) {
  const resumePath = path.join(runDir, "RESUME.md");
  const resultPath = path.join(runDir, "result.json");
  const progressPath = path.join(runDir, "progress.md");

  if (typeof flags.wf === "string" && flags.wf.trim()) {
    return { runId: flags.wf.trim(), source: "--wf flag", resumePath, resultPath, progressPath };
  }
  const fromResume = extractRunId(resumeText);
  if (fromResume) return { runId: fromResume, source: resumePath, resumePath, resultPath, progressPath };

  const fromResult =
    (typeof result?.runId === "string" && result.runId.trim() && result.runId) ||
    (typeof result?.workflowId === "string" && result.workflowId.trim() && result.workflowId) ||
    null;
  if (fromResult) {
    return { runId: fromResult, source: `${resultPath} (runId/workflowId)`, resumePath, resultPath, progressPath };
  }

  const fromProgress = extractRunId(readTextSafe(progressPath));
  if (fromProgress) return { runId: fromProgress, source: progressPath, resumePath, resultPath, progressPath };

  return { runId: null, source: null, resumePath, resultPath, progressPath };
}

// Matches a runId against usage.workflows the same way pipeline-ledger.mjs's
// selectMatchedWorkflow does (exact key, "wf_" prefix stripped either way,
// or a >= 8 char shared-prefix truncated match) -- kept in sync deliberately
// so closeout's pre-flight gate and the ledger's own matching never disagree
// about whether a run id "matched".
function findMatchedWorkflowUsage(usage, runId) {
  if (!usage || !usage.workflows || typeof usage.workflows !== "object" || !runId) return null;
  const strip = (id) => (typeof id === "string" && id.startsWith("wf_") ? id.slice(3) : id);
  const key = strip(runId);
  if (Object.prototype.hasOwnProperty.call(usage.workflows, key)) return usage.workflows[key];
  if (Object.prototype.hasOwnProperty.call(usage.workflows, runId)) return usage.workflows[runId];
  let best = null;
  let bestLen = 0;
  for (const k of Object.keys(usage.workflows)) {
    const sk = strip(k);
    const shorter = sk.length <= key.length ? sk : key;
    const longer = sk.length <= key.length ? key : sk;
    if (shorter.length >= 8 && longer.startsWith(shorter) && shorter.length > bestLen) {
      best = usage.workflows[k];
      bestLen = shorter.length;
    }
  }
  return best;
}

function hasMatchingWorkflow(usage, runId) {
  return findMatchedWorkflowUsage(usage, runId) != null;
}

// approach: dev-pipeline|superpowers|raw. --approach flag wins, then a
// RESUME.md mention, else "dev-pipeline" (this skill's own default arm).
function extractApproach(text) {
  if (!text) return null;
  const m = text.match(/\bapproach:?\s*[`'"]?(dev-pipeline|superpowers|raw)[`'"]?\b/i);
  return m ? m[1].toLowerCase() : null;
}

// engineSha: the staged-engine sha this run built against, if the workdir
// recorded one. Never fatal -- a missing/unreadable file just means null.
function resolveEngineSha(project) {
  const text = readTextSafe(path.join(project, "local-assets", "tooling", "STAGED-ENGINE.md"));
  if (!text) return null;
  const m = text.match(/sha256:?\s*`?([0-9a-f]{16,64})`?/i);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// step 2: session-usage
// ---------------------------------------------------------------------------

// P2(b) 2026-09-11: "true telemetry or no close-out" -- a session-usage
// failure used to be swallowed here (skipped:true, telemetry:"legacy") and
// the close-out proceeded anyway, which is how all 29 real ledger rows
// ended up with no true telemetry. Now: --no-usage requires an explicit
// --reason (recorded as usageOverrideReason); with neither flag, an actual
// session-usage failure is FATAL (throws, nothing is written) instead of a
// silent fallback.
function stepSessionUsage({ flags, runDir, project, runId, dry, lightMode }) {
  // Selftest-only stub (mirrors the SCHEMA_DRIFT_PRISMA_CLI pattern used
  // elsewhere in this house): when CLOSEOUT_SELFTEST=1 AND
  // CLOSEOUT_SELFTEST_USAGE_JSON names a file, read that file directly
  // instead of spawning the real session-usage.mjs subprocess. Lets the
  // selftest exercise "session-usage succeeded but usage.workflows has no
  // entry for this runId" without needing a real session transcript.
  if (
    process.env.CLOSEOUT_SELFTEST === "1" &&
    typeof process.env.CLOSEOUT_SELFTEST_USAGE_JSON === "string" &&
    process.env.CLOSEOUT_SELFTEST_USAGE_JSON
  ) {
    let stubUsage;
    try {
      stubUsage = JSON.parse(fs.readFileSync(process.env.CLOSEOUT_SELFTEST_USAGE_JSON, "utf8"));
    } catch (err) {
      throw new CloseoutError(`selftest: cannot read CLOSEOUT_SELFTEST_USAGE_JSON -- ${err.message}`, 3);
    }
    return {
      skipped: false,
      reason: null,
      usage: stubUsage,
      telemetry: "true",
      outFile: null,
      usageOverrideReason: null,
    };
  }
  if (flags["no-usage"]) {
    const reasonFlag = typeof flags.reason === "string" ? flags.reason.trim() : "";
    if (!reasonFlag) {
      throw new CloseoutError(
        "--no-usage requires --reason \"<why>\" -- true telemetry is mandatory for a ledger row unless " +
          "you explicitly record why it's being skipped.\n" +
          "Usage: closeout.mjs <runDir> --no-usage --reason \"<why>\"",
        2
      );
    }
    return {
      skipped: true,
      reason: "--no-usage",
      usage: null,
      telemetry: "legacy",
      outFile: null,
      usageOverrideReason: reasonFlag,
    };
  }
  const sessionArgs = [];
  if (flags.latest) sessionArgs.push("--latest");
  else if (typeof flags.session === "string") sessionArgs.push(flags.session);
  else sessionArgs.push("--latest"); // default: try the newest session

  const outFile = path.join(runDir, "session-usage.json");
  const args = [...sessionArgs, "--project", project, "--json"];
  if (runId) args.push("--wf", runId);
  // A light loop rarely runs through the Workflow tool, so there is usually
  // no wf_* run to key --wf on -- --all additionally pulls agents.byType
  // (per-agentType groups), which is what buildLightResult's phaseReport
  // rows fall back to when there is no PHASE-tagged workflow at all.
  if (lightMode) args.push("--all");
  if (!dry) args.push("--out", outFile); // --dry: read-only preview, no file written

  const res = runNode(SESSION_USAGE_SCRIPT, args);
  if (res.error || res.status !== 0) {
    const reason = firstLine(res.stderr) || res.error?.message || "unknown error";
    // No silent fallback: an unanticipated session-usage failure aborts the
    // whole close-out (nothing written) unless the caller pre-declared the
    // skip with --no-usage --reason (handled above, before this attempt is
    // even made). Code 3 so it is distinguishable from the usage-error (2)
    // above and from a general CloseoutError (default 2) elsewhere.
    //
    // 2026-09-11 fix: under --dry this is a preview, not a real close-out --
    // nothing is written either way, so there is nothing to protect by
    // aborting. Report it as a non-fatal "warn" status instead and let the
    // (already read-only) rest of the dry preview continue. A REAL run keeps
    // throwing exactly as before -- this must never get lenient enough to
    // fall through to stepLedger and append an estimated row.
    if (dry) {
      return {
        skipped: false,
        reason: null,
        usage: null,
        telemetry: "none",
        outFile: null,
        usageOverrideReason: null,
        status: "warn",
        warnMessage: `session-usage: ${reason} (dry preview -- a real run would abort here)`,
      };
    }
    throw new CloseoutError(
      `session-usage failed -- ${reason}\n` +
        "True telemetry is required for close-out (P2(b), 2026-09-11 owner ruling). Either fix the " +
        "underlying failure (a worktree cwd is the common cause -- see 'Project resolution' in this " +
        `file's header) and re-run, or record an explicit override:\n` +
        `  node "${__filename}" "${runDir}" --project "${project}" --no-usage --reason "<why>"`,
      3
    );
  }
  let usage = null;
  try {
    usage = JSON.parse(res.stdout);
  } catch {
    /* leave usage null; still not fatal */
  }
  return {
    skipped: false,
    reason: null,
    usage,
    telemetry: "true",
    outFile: dry ? null : outFile,
    usageOverrideReason: null,
  };
}

// ---------------------------------------------------------------------------
// step 2b: light-loop result synthesis (2026-09-10 audit finding "light-loop
// close-out records nothing"). When <runDir> has no result.json -- or --light
// is passed to force it -- build the minimal object pipeline-ledger.mjs and
// stepRunLog actually need from session-usage.mjs telemetry, so the ledger
// append works completely unchanged (it just reads result.json off disk).
// ---------------------------------------------------------------------------

function numOrNull(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// The model with the most tokens in a byModel bucket -- pipeline-ledger.mjs's
// phase rows carry a single `model` field, never a mix.
function dominantModel(byModel) {
  if (!byModel || typeof byModel !== "object") return null;
  let best = null;
  let bestTokens = -1;
  for (const [model, b] of Object.entries(byModel)) {
    const t = typeof b?.tokens === "number" ? b.tokens : 0;
    if (t > bestTokens) {
      bestTokens = t;
      best = model;
    }
  }
  return best;
}

// One phaseReport row per session-usage.mjs `byPhase` group (from any
// PHASE-tagged workflow run under this session) and per `agents.byType`
// group -- a light loop rarely runs through the Workflow tool, so agentType
// is usually the only grouping session-usage.mjs's --all (see
// stepSessionUsage) can offer at all.
function phaseRowsFromUsage(usage) {
  const rows = [];
  const workflows = usage?.workflows && typeof usage.workflows === "object" ? usage.workflows : {};
  for (const wf of Object.values(workflows)) {
    const byPhase = wf?.byPhase && typeof wf.byPhase === "object" ? wf.byPhase : {};
    for (const [phase, entry] of Object.entries(byPhase)) {
      rows.push({
        phase,
        ran: true,
        agents: numOrNull(entry?.agents),
        tokens: numOrNull(entry?.total?.tokens),
        model: dominantModel(entry?.byModel),
        effort: null,
      });
    }
  }
  const byType = usage?.agents?.byType && typeof usage.agents.byType === "object" ? usage.agents.byType : {};
  for (const [agentType, entry] of Object.entries(byType)) {
    rows.push({
      phase: agentType,
      ran: true,
      agents: numOrNull(entry?.agents),
      tokens: numOrNull(entry?.total?.tokens),
      model: dominantModel(entry?.byModel),
      effort: null,
    });
  }
  return rows;
}

function parseFindingsFlag(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// Builds the minimal result.json a light loop never wrote on its own. Every
// field here mirrors what buildRow() in pipeline-ledger.mjs actually reads
// (phaseReport[], mode/scale/clean, confirmedByPhase, remainingFindings) plus
// a self-reported telemetry marker -- see stepLedger's telemetry decision for
// why a light-loop row reads "true" rather than "legacy" even without a
// matched --usage file.
function buildLightResult({ usage, flags, fallbackStartedAt, endedAt }) {
  const findings = parseFindingsFlag(typeof flags.findings === "string" ? flags.findings : null);
  const remaining = findings && Array.isArray(findings.remaining) ? findings.remaining : [];
  const confirmedByPhase =
    findings && findings.confirmedByPhase && typeof findings.confirmedByPhase === "object"
      ? findings.confirmedByPhase
      : {};

  const scaleRaw = typeof flags.scale === "string" ? flags.scale.toLowerCase() : null;
  const scale = scaleRaw === "small" || scaleRaw === "major" ? scaleRaw : null;

  return {
    mode: "light-loop",
    scale,
    clean: remaining.length === 0,
    startedAt: usage?.session?.firstAt ?? fallbackStartedAt ?? null,
    endedAt: usage?.session?.lastAt ?? endedAt,
    phaseReport: phaseRowsFromUsage(usage),
    confirmedByPhase,
    remainingFindings: remaining,
    telemetry: "true",
  };
}

// ---------------------------------------------------------------------------
// slug normalization -- shared by the ledger/RUN-LOG/LESSONS idempotence
// checks below. A run slug that already carries its own 'YYYY-MM-DD-' prefix
// (the common case -- pipeline run dirs are named that way) can drift
// against a ledger row / RUN-LOG heading / LESSONS marker recorded under the
// OTHER form across sessions. Mirrors stop-global.mjs's stripDatePrefix rule
// so all three "already done" checks here agree with the stop hook.
// ---------------------------------------------------------------------------

const DATE_PREFIX_RE = /^\d{4}-\d{2}-\d{2}-/;

function stripDatePrefix(s) {
  return typeof s === "string" ? s.replace(DATE_PREFIX_RE, "") : s;
}

// True when `a` and `b` name the same run, with or without either side's
// leading date prefix.
function slugMatches(a, b) {
  return a === b || stripDatePrefix(a) === stripDatePrefix(b);
}

// ---------------------------------------------------------------------------
// step 3: ledger append (idempotent by slug)
// ---------------------------------------------------------------------------

function defaultLedgerPath(project) {
  return path.join(project, ".claude", "pipeline", "cost-ledger.jsonl");
}

// Inverse of pipeline-ledger.mjs's getLedgerPath(projectDir): given a full
// ledger path ending in '.claude/pipeline/cost-ledger.jsonl', recover the
// project dir so the real script (which only accepts --project) can be
// pointed at an arbitrary ledger location for testability.
function projectDirFromLedgerPath(ledgerPath) {
  const segs = ledgerPath.split(/[\\/]/);
  const idx = segs.lastIndexOf(".claude");
  if (idx <= 0) return null;
  return segs.slice(0, idx).join(path.sep);
}

// --- true-telemetry cutoff predicate (P2(d)) -------------------------------
// DUPLICATED VERBATIM from C:/Users/nakram/.claude/hooks/stop-global.mjs
// (its `violatesTrueTelemetryCutoff` + TRUE_TELEMETRY_CUTOFF carry the
// mirror-image comment naming this file). A shared import is impractical
// there -- see that file's G5 note: the harness invokes each hook as a bare
// file, so hooks keep every helper inline. The two copies MUST stay
// character-identical: the row that hook BLOCKS on is exactly the row the
// repair path below rewrites. Change one, change the other in the same edit.
const TRUE_TELEMETRY_CUTOFF = "2026-09-12T12:00:00Z";
const TRUE_TELEMETRY_CUTOFF_MS = Date.parse(TRUE_TELEMETRY_CUTOFF);

function violatesTrueTelemetryCutoff(row) {
  if (!row || typeof row.run !== "string") return false;
  const t = Date.parse(row.endedAt || "");
  if (Number.isNaN(t) || t < TRUE_TELEMETRY_CUTOFF_MS) return false;
  if (row.telemetry === "true") return false;
  if (row.usageOverrideReason) return false;
  return true;
}

// Every ledger line in file order, with its parsed row, its 1-based row
// ordinal (JSON rows only -- blank lines don't count) and the exact chunk of
// the file it occupies INCLUDING its line terminator. The repair path below
// rewrites exactly one chunk and joins the rest back byte-for-byte.
function readLedgerEntries(ledgerPath) {
  if (!fs.existsSync(ledgerPath)) return [];
  const raw = fs.readFileSync(ledgerPath, "utf8");
  const entries = [];
  let ordinal = 0;
  // Split AFTER each newline so every chunk keeps its own terminator (and
  // the last chunk keeps "no trailing newline" when that is what the file
  // has).
  for (const chunk of raw.split(/(?<=\n)/)) {
    if (!chunk.trim()) {
      entries.push({ chunk, row: null, ordinal: null });
      continue;
    }
    let row = null;
    try {
      row = JSON.parse(chunk);
    } catch {
      /* malformed line -- kept verbatim, never matched */
    }
    ordinal += 1;
    entries.push({ chunk, row, ordinal });
  }
  return entries;
}

function stepLedger(ctx) {
  const { flags, project, runDir, slug, dry, startedAt, endedAt, branch, pr, usageResult, mode, scale, result } = ctx;
  const ledgerPath = typeof flags.ledger === "string" ? path.resolve(flags.ledger) : defaultLedgerPath(project);

  // Idempotence by slug -- with ONE repair exception. An existing row
  // normally means "closed, nothing to do". But a post-cutoff row that
  // violates the true-telemetry rule is a PERMANENT Stop-hook block (see
  // violatesTrueTelemetryCutoff above -- the same predicate stop-global.mjs
  // blocks on), so when THIS run carries true telemetry we rewrite that one
  // line in place. Never a second row for the slug, never a reorder, never
  // another line touched. Last matching row wins, as stop-global's
  // findLedgerRow does.
  const entries = readLedgerEntries(ledgerPath);
  let existing = null;
  for (const e of entries) {
    if (e.row && typeof e.row.run === "string" && slugMatches(e.row.run, slug)) existing = e;
  }
  const hasTrueTelemetry = Boolean(usageResult && usageResult.outFile);
  const repair = Boolean(existing && violatesTrueTelemetryCutoff(existing.row) && hasTrueTelemetry);
  if (existing && !repair) {
    return { status: "skipped-idempotent", ledgerPath, message: `ledger: already has ${slug} (skipped)` };
  }

  const resultJsonPath = path.join(runDir, "result.json");
  if (!fs.existsSync(resultJsonPath)) {
    return { status: "failed", ledgerPath, message: `ledger: no result.json at '${resultJsonPath}' -- cannot append` };
  }

  let appendProjectDir = project;
  if (typeof flags.ledger === "string") {
    const derived = projectDirFromLedgerPath(ledgerPath);
    if (!derived) {
      return {
        status: "failed",
        ledgerPath,
        message: `ledger: --ledger must end in '.claude/pipeline/cost-ledger.jsonl' (got '${ledgerPath}')`,
      };
    }
    appendProjectDir = derived;
  }

  const args = ["append", resultJsonPath, "--run", slug, "--project", appendProjectDir, "--ended", endedAt];
  if (startedAt) args.push("--started", startedAt);
  if (branch) args.push("--branch", branch);
  if (pr != null) args.push("--pr", String(pr));
  if (ctx.approach) args.push("--approach", ctx.approach);
  if (ctx.engineSha) args.push("--engine-sha", ctx.engineSha);
  if (usageResult && usageResult.outFile) {
    args.push("--usage", usageResult.outFile);
    if (ctx.runId) args.push("--run-id", ctx.runId);
  } else if (mode === "light-loop") {
    // A light-loop result.json self-reports telemetry:"true" (see
    // buildLightResult) even when no --usage file matched this run (e.g.
    // --no-usage, or no session transcript found) -- mark the ledger row
    // "true" rather than "legacy", which is reserved for runs that predate
    // this telemetry mechanism entirely.
    args.push("--telemetry", "true");
  } else {
    args.push("--telemetry", "legacy");
  }
  // P2(c): the recorded reason for a --no-usage override lands on the row
  // as usageOverrideReason, so a legacy row is distinguishable from one that
  // never even declared why it has no true telemetry.
  if (usageResult && usageResult.usageOverrideReason) {
    args.push("--usage-override-reason", usageResult.usageOverrideReason);
  }

  if (repair && dry) {
    return {
      status: "dry",
      ledgerPath,
      message: `ledger: would upgrade ${slug} to true telemetry (row ${existing.ordinal})`,
    };
  }

  if (dry) {
    const telemetryPreview = usageResult?.outFile || mode === "light-loop" ? "true" : "legacy";
    return {
      status: "dry",
      ledgerPath,
      message: `ledger: would run 'node pipeline-ledger.mjs ${args.join(" ")}'`,
      preview:
        `+ run=${slug} mode=${mode ?? "n/a"} scale=${scale ?? "n/a"} startedAt=${startedAt ?? "n/a"} ` +
        `estimatedCostUsd=${result?.estimatedCostUsd ?? "n/a"} telemetry=${telemetryPreview}`,
    };
  }

  assertSelftestSafePath(ledgerPath);

  if (repair) {
    // Build the replacement row through the SAME code path a fresh append
    // uses (pipeline-ledger.mjs buildRow) by appending into a throwaway
    // ledger under tmpdir, then take the line it produced.
    const tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), "closeout-ledger-upgrade-"));
    try {
      const repairArgs = args.slice();
      const projIdx = repairArgs.indexOf("--project");
      repairArgs[projIdx + 1] = tmpProject;
      const repairRes = runNode(PIPELINE_LEDGER_SCRIPT, repairArgs);
      if (repairRes.error || repairRes.status !== 0) {
        return {
          status: "failed",
          ledgerPath,
          message: `ledger: upgrade failed -- ${firstLine(repairRes.stderr) || repairRes.error?.message}`,
        };
      }
      const produced = fs
        .readFileSync(defaultLedgerPath(tmpProject), "utf8")
        .split(/\r?\n/)
        .filter((l) => l.trim())
        .pop();
      if (!produced) {
        return { status: "failed", ledgerPath, message: "ledger: upgrade failed -- pipeline-ledger wrote no row" };
      }
      // Substitute exactly one chunk, keeping its original line terminator;
      // every other chunk is joined back unchanged (byte-identical).
      const eol = (existing.chunk.match(/\r?\n$/) || [""])[0];
      const rewritten = entries.map((e) => (e === existing ? produced + eol : e.chunk)).join("");
      const tmpOut = path.join(path.dirname(ledgerPath), `.cost-ledger.upgrade-${process.pid}.tmp`);
      assertSelftestSafePath(tmpOut);
      fs.writeFileSync(tmpOut, rewritten, "utf8");
      fs.renameSync(tmpOut, ledgerPath);
      return {
        status: "upgraded",
        ledgerPath,
        message: `ledger: upgraded ${slug} to true telemetry (row ${existing.ordinal})`,
      };
    } finally {
      fs.rmSync(tmpProject, { recursive: true, force: true });
    }
  }

  const res = runNode(PIPELINE_LEDGER_SCRIPT, args);
  if (res.error || res.status !== 0) {
    return { status: "failed", ledgerPath, message: `ledger: append failed -- ${firstLine(res.stderr) || res.error?.message}` };
  }
  return { status: "appended", ledgerPath, message: `ledger: appended '${slug}' -> ${ledgerPath}` };
}

// ---------------------------------------------------------------------------
// step 4: RUN-LOG.md stub (idempotent by slug)
// ---------------------------------------------------------------------------

function top3Confirmed(confirmedByPhase) {
  if (!confirmedByPhase || typeof confirmedByPhase !== "object") return null;
  const entries = Object.entries(confirmedByPhase).filter(([, v]) => typeof v === "number");
  if (!entries.length) return null;
  entries.sort((a, b) => b[1] - a[1]);
  return entries.slice(0, 3);
}

function wastedSignals(result) {
  const out = [];
  const rg = result?.redGate;
  if (rg && typeof rg.attempts === "number" && rg.attempts > 1) {
    out.push(`red gate needed ${rg.attempts} attempts (remediateOn: ${rg.remediateOn ?? "n/a"})`);
  }
  if (typeof result?.fixRounds === "number" && result.fixRounds > 1) {
    out.push(`${result.fixRounds} fix rounds`);
  } else if (typeof result?.fixPlanning?.rounds === "number" && result.fixPlanning.rounds > 1) {
    out.push(`${result.fixPlanning.rounds} fix-planning rounds`);
  }
  const skipped = result?.mutationProbe?.skippedTargets;
  if (Array.isArray(skipped) && skipped.length) out.push(`${skipped.length} mutation-probe targets skipped`);
  const lensesSkipped = result?.escalation?.lensesSkipped;
  if (Array.isArray(lensesSkipped) && lensesSkipped.length) {
    out.push(`${lensesSkipped.length} lenses skipped (density escalation)`);
  }
  const missed = result?.cascadeAudit?.missedFindings;
  if (typeof missed === "number" && missed > 0) out.push(`cascade audit missed ${missed} findings`);
  const merged = result?.dedupeStats?.merged;
  if (typeof merged === "number" && merged > 0) out.push(`${merged} findings deduped`);
  if (typeof result?.note === "string" && result.note.trim()) {
    out.push(result.note.trim().replace(/\s+/g, " ").slice(0, 140));
  }
  return out.length ? out.join("; ") : "(none identified from result.json fields)";
}

function runLogPathFor(flags) {
  return typeof flags.runlog === "string" ? path.resolve(flags.runlog) : DEFAULT_RUN_LOG_PATH;
}

// Extracts the slug token from every '## <slug> · ...' heading in RUN-LOG.md
// (headings with a different shape, e.g. '## Retro — ...', don't match the
// ' ·' separator and are ignored).
function runLogHeadingSlugs(text) {
  const out = [];
  const re = /^##\s+(\S+)\s+·/gm;
  let m;
  while ((m = re.exec(text))) out.push(m[1]);
  return out;
}

function runLogHasSlug(text, slug) {
  return runLogHeadingSlugs(text).some((heading) => slugMatches(heading, slug));
}

function buildRunLogEntry({ slug, mode, scale, costStr, timeStr, dateStr, caughtStr, wastedStr }) {
  return [
    `## ${slug} · ${mode ?? "unknown-mode"} · ${scale ?? "unknown-scale"} · ${costStr} · ${timeStr} · ${dateStr}`,
    "",
    `- Caught: ${caughtStr}`,
    `- Wasted: ${wastedStr}`,
    `- Knob candidate: TODO (one change WITH evidence)`,
    `- Deviation: TODO`,
  ].join("\n");
}

// Newest-first: insert right after the file's '---' marker line, leaving
// exactly one blank line on each side of the new entry.
function insertAfterDashLine(text, entryBlock) {
  const lines = text.split(/\r?\n/);
  const dashIdx = lines.findIndex((l) => l.trim() === "---");
  if (dashIdx === -1) {
    return text.replace(/\n?$/, "\n\n" + entryBlock + "\n");
  }
  const before = lines.slice(0, dashIdx + 1);
  const after = lines.slice(dashIdx + 1);
  return [...before, "", ...entryBlock.split("\n"), ...after].join("\n");
}

function stepRunLog(ctx) {
  const { flags, dry, slug, fields, noResultNoLight } = ctx;
  const runLogPath = runLogPathFor(flags);
  const text = readTextSafe(runLogPath);
  if (text == null) {
    return { status: "failed", runLogPath, message: `RUN-LOG: cannot read '${runLogPath}'` };
  }
  if (runLogHasSlug(text, slug)) {
    return { status: "skipped-idempotent", runLogPath, message: `RUN-LOG: already has ${slug} (skipped)` };
  }
  // Guard (2026-09-10 audit finding 3): the ledger auto-builds a light-loop
  // result whenever result.json is missing (see step 2b), but RUN-LOG.md is
  // the shared, hand-curated house file -- refuse to insert a synthetic stub
  // there on a bare missing-file inference alone. Require the user to opt in
  // with --light before a run with no real result.json gets a RUN-LOG entry.
  if (noResultNoLight) {
    return { status: "failed", runLogPath, message: "no result — nothing to log" };
  }
  const entryBlock = buildRunLogEntry(fields);
  if (dry) {
    return {
      status: "dry",
      runLogPath,
      message: `RUN-LOG: would insert an entry for '${slug}'`,
      preview: entryBlock
        .split("\n")
        .map((l) => (l ? "+ " + l : "+"))
        .join("\n"),
    };
  }
  assertSelftestSafePath(runLogPath);
  fs.writeFileSync(runLogPath, insertAfterDashLine(text, entryBlock), "utf8");
  return { status: "appended", runLogPath, message: `RUN-LOG: entry added for '${slug}' -> ${runLogPath}` };
}

// ---------------------------------------------------------------------------
// step 5: LESSONS.md stub (bugfix only; idempotent by slug marker)
// ---------------------------------------------------------------------------

// True when LESSONS.md already carries a '<!-- run: X -->' marker for this
// slug, in either date-prefix form (see slugMatches above).
function lessonsHasSlugMarker(text, slug) {
  const re = /<!-- run: (\S+) -->/g;
  let m;
  while ((m = re.exec(text))) {
    if (slugMatches(m[1], slug)) return true;
  }
  return false;
}

// Places the stub under a literal '## TODO-category' section (a human moves
// it into the real category later) -- created just above the first existing
// '## ' heading, or appended at the end of a header-only file.
function insertLessonsStub(text, entryBlock) {
  const marker = "## TODO-category";
  const markerIdx = text.indexOf(marker);
  if (markerIdx !== -1) {
    const lineEnd = text.indexOf("\n", markerIdx);
    const insertAt = lineEnd === -1 ? text.length : lineEnd + 1;
    return text.slice(0, insertAt) + "\n" + entryBlock + "\n" + text.slice(insertAt);
  }
  const firstH2 = text.search(/^## /m);
  const section = `${marker}\n\n${entryBlock}\n\n`;
  if (firstH2 === -1) return text.replace(/\n?$/, "\n\n" + section);
  return text.slice(0, firstH2) + section + text.slice(firstH2);
}

function stepLessons(ctx) {
  const { flags, project, slug, mode, dry } = ctx;
  if (mode !== "bugfix") {
    return { status: "na", message: "LESSONS: n/a (mode is not bugfix)" };
  }
  const lessonsDir = path.join(project, ".claude", "lessons");
  const metaPath = path.join(lessonsDir, "_meta.json");
  const lessonsPath = path.join(lessonsDir, "LESSONS.md");
  const meta = loadJsonSafe(metaPath);
  if (!meta) {
    return {
      status: "skipped",
      message: `LESSONS: skipped ('${metaPath}' not found -- bootstrap with the lessons-learned skill first)`,
    };
  }
  const text = readTextSafe(lessonsPath) ?? "# Lessons Learned\n\n---\n";
  const marker = `<!-- run: ${slug} -->`;
  if (lessonsHasSlugMarker(text, slug)) {
    return { status: "skipped-idempotent", message: `LESSONS: already has a stub for ${slug} (skipped)` };
  }
  const nextId = typeof meta.nextId === "number" ? meta.nextId : 1;
  const activeCount = typeof meta.activeCount === "number" ? meta.activeCount : 0;
  // Defaults mirror scripts/validate-lessons.mjs's DEFAULT_MAX_ENTRIES (40) /
  // DEFAULT_MAX_BYTES (25 KB) -- but a project's own _meta.json (RouteFlow's
  // is 40 entries / 40,960 bytes) always wins.
  const maxEntries = Number.isInteger(meta.maxEntries) ? meta.maxEntries : 40;
  const maxBytes = Number.isInteger(meta.maxBytes) ? meta.maxBytes : 40960;
  const idPadded = String(nextId).padStart(3, "0");
  const entry = [
    `### L-${idPadded} · ${todayStr()} · TODO-category`,
    marker,
    "- **Symptom:** TODO",
    "- **Root cause:** TODO",
    "- **Lesson:** TODO",
    "- **Guard:** TODO",
  ].join("\n");

  // Check cap headroom BEFORE writing anything (and before the --dry branch,
  // so --dry surfaces the same ✗ a real run would hit). projectedBytes is the
  // full post-insert file size, i.e. current bytes + stub bytes in one call.
  const updatedText = insertLessonsStub(text, entry);
  const projectedBytes = Buffer.byteLength(updatedText, "utf8");
  if (activeCount >= maxEntries || projectedBytes > maxBytes) {
    return {
      status: "failed",
      message:
        `lessons: register at cap (${activeCount}/${maxEntries}, ${projectedBytes}/${maxBytes}) ` +
        `— archive one entry for headroom, then re-run`,
    };
  }

  if (dry) {
    return {
      status: "dry",
      message: `LESSONS: would add L-${idPadded} stub, bump nextId to ${nextId + 1} and activeCount to ${activeCount + 1}`,
      preview: entry
        .split("\n")
        .map((l) => "+ " + l)
        .join("\n"),
    };
  }

  assertSelftestSafePath(lessonsPath);
  assertSelftestSafePath(metaPath);
  fs.writeFileSync(lessonsPath, updatedText, "utf8");
  fs.writeFileSync(
    metaPath,
    JSON.stringify(
      { ...meta, nextId: nextId + 1, activeCount: activeCount + 1, updatedAt: new Date().toISOString() },
      null,
      2
    ) + "\n",
    "utf8"
  );
  return {
    status: "appended",
    message: `LESSONS: added L-${idPadded} stub, nextId -> ${nextId + 1}, activeCount -> ${activeCount + 1}`,
  };
}

// ---------------------------------------------------------------------------
// step 6: code-map TODOs (print only -- never edits the map)
// ---------------------------------------------------------------------------

function collectTouchedPaths(result) {
  // Priority 1 (A14 task-loop shape, not yet real anywhere -- covered by a
  // synthetic selftest fixture only): result.tasks[].files, flattened +
  // deduped across every task that carries an array `files` field. Tasks
  // with no `files` or a non-array `files` are ignored, not fatal.
  if (Array.isArray(result?.tasks) && result.tasks.length && result.tasks.some((t) => Array.isArray(t?.files))) {
    const all = [];
    for (const t of result.tasks) {
      if (!Array.isArray(t?.files)) continue;
      for (const f of t.files) {
        if (typeof f === "string") all.push(f);
      }
    }
    return [...new Set(all)].filter(Boolean);
  }
  // Priority 2 (today's real shape): manifest.files, scoped to entries that
  // are actually in-progress/landed source (not every dirty path in the
  // tree -- handoff cards, .gitignore, and the code-map's own files used to
  // all get flagged as "missing a code-map entry" alongside the handful of
  // real source/spec/test files). Any non-deleted status counts -- a brand
  // new `added`/`untracked` file is exactly the case most likely to need a
  // NEW code-map TODO, since it has zero chance of already being mentioned
  // in the code-map text; only `deleted` is excluded, since a deleted file
  // needs no code-map entry.
  const CODE_MAP_SCAN_STATUSES = ["planned", "modified", "added", "untracked"];
  if (result?.manifest?.files && Array.isArray(result.manifest.files)) {
    return result.manifest.files
      .filter(
        (f) =>
          f &&
          CODE_MAP_SCAN_STATUSES.includes(f.status) &&
          typeof f.path === "string" &&
          /^(apps|packages|scripts)\//.test(f.path)
      )
      .map((f) => f.path)
      .filter(Boolean);
  }
  // Priority 3 (legacy fallback, unchanged semantics): result.touchedFiles.
  if (Array.isArray(result?.touchedFiles)) {
    return result.touchedFiles
      .map((f) => (typeof f === "string" ? f : f && typeof f.path === "string" ? f.path : null))
      .filter(Boolean);
  }
  return null;
}

function guessArea(p) {
  const parts = p.split("/");
  if ((parts[0] === "apps" || parts[0] === "packages") && parts[1]) return parts[1];
  return parts[0];
}

function stepCodeMap({ project, result }) {
  const paths = collectTouchedPaths(result);
  if (!paths) {
    return { status: "na", missing: null, message: "code-map: no manifest.files/touchedFiles in result.json -- nothing to check", lines: [] };
  }
  const codeMapDir = path.join(project, ".claude", "code-map");
  let mdText = "";
  try {
    for (const f of fs.readdirSync(codeMapDir)) {
      if (f.endsWith(".md")) mdText += fs.readFileSync(path.join(codeMapDir, f), "utf8") + "\n";
    }
  } catch {
    /* no code-map dir yet -- every path is "missing" */
  }
  const missing = paths.filter((p) => !mdText.includes(p));
  return {
    status: "checked",
    missing,
    message: `code-map: ${missing.length}/${paths.length} touched path(s) missing a map entry`,
    lines: missing.map((p) => `code-map: TODO entry for ${p} (area ${guessArea(p)})`),
  };
}

// ---------------------------------------------------------------------------
// step 7: handoff card
// ---------------------------------------------------------------------------

function gitInfo(project) {
  const run = (args) => {
    const r = spawnSync("git", args, { cwd: project, encoding: "utf8" });
    return r.status === 0 ? r.stdout.trim() : null;
  };
  const branch = run(["branch", "--show-current"]);
  const sha = run(["rev-parse", "--short", "HEAD"]);
  const statusOut = run(["status", "--short"]);
  const uncommittedN = statusOut != null ? statusOut.split(/\r?\n/).filter((l) => l.trim()).length : null;
  const worktreesOut = run(["worktree", "list"]);
  const worktreeLines = worktreesOut != null ? worktreesOut.split(/\r?\n/).filter((l) => l.trim()) : [];
  return {
    branch: branch || "unknown",
    sha: sha || "unknown",
    uncommitted: uncommittedN == null ? "unknown" : uncommittedN === 0 ? "none" : `${uncommittedN} files`,
    worktrees: worktreeLines.length > 1 ? `${worktreeLines.length - 1} extra` : "none",
  };
}

function lastCheckpointPhase(runDir) {
  const phasesDir = path.join(runDir, "phases");
  let files;
  try {
    files = fs
      .readdirSync(phasesDir)
      .filter((f) => f.endsWith(".json"))
      .sort();
  } catch {
    return null;
  }
  if (!files.length) return null;
  const last = files[files.length - 1];
  const data = loadJsonSafe(path.join(phasesDir, last));
  // A checkpoint's top-level `phase` is the buildPhaseRow() OBJECT
  // ({phase, ran, agents, ...}), not a string -- .phase.phase is the title
  // ("Fix"). Stringifying the object itself used to print "[object Object]"
  // on every handoff card.
  return data?.phase?.phase || last.replace(/\.json$/, "");
}

function buildHandoffCard(ctx) {
  const git = gitInfo(ctx.project);
  const phase = lastCheckpointPhase(ctx.runDir);

  const decided = [
    `Ledger ${ctx.ledgerResult.status}`,
    `RUN-LOG ${ctx.runLogResult.status}`,
    ctx.mode === "bugfix" ? `LESSONS ${ctx.lessonsResult.status}` : null,
  ].filter(Boolean);

  const todos = [
    "walk the coverage matrix (R# -> T# -> result) out loud",
    "set the Status line (IMPLEMENTED/CLOSED) on every artifact",
    "fill in the RUN-LOG Knob candidate + Deviation with real evidence",
  ];
  if (ctx.mode === "bugfix") todos.push("fill in the LESSONS L-xxx Symptom/Root cause/Lesson/Guard body");
  if (ctx.codeMapResult.missing && ctx.codeMapResult.missing.length) {
    const shown = ctx.codeMapResult.missing.slice(0, 2);
    const more = ctx.codeMapResult.missing.length - shown.length;
    todos.push(`code-map: add entries for ${shown.join(", ")}${more > 0 ? ` (+${more} more)` : ""}`);
  }

  const build = (todoCount, decidedCount) =>
    [
      `# Handoff — ${ctx.dateStr} · ${ctx.slug}`,
      `- Task: close out pipeline run '${ctx.slug}' (${ctx.mode ?? "unknown mode"}, ${ctx.scale ?? "unknown scale"})`,
      `- State: closed out`,
      `- Branch/tree: ${git.branch} @ ${git.sha} · uncommitted: ${git.uncommitted} · worktrees: ${git.worktrees}`,
      `- Run: ${ctx.runDir} · runId ${ctx.runId ?? "unknown"} · last phase ${phase ?? "n/a"}`,
      `- Decided: ${decided.slice(0, decidedCount).join("; ") || "none"}`,
      `- Next: ${todos.slice(0, todoCount).join("; ")}`,
      `- Open for owner: none`,
      `- Do not: re-run closeout blindly — it is idempotent by slug; check the printed skip reasons first`,
      "",
    ].join("\n");

  let card = build(todos.length, decided.length);
  if (Buffer.byteLength(card, "utf8") > 2048) card = build(3, 2);
  if (Buffer.byteLength(card, "utf8") > 2048) card = build(2, 1);
  return card;
}

// A run slug that already carries its own 'YYYY-MM-DD-' prefix (the common
// case -- pipeline run dirs are named that way) must not get dateStr
// prefixed a second time (2026-09-10 audit finding: a `run1` selftest stub
// leaked as '2026-09-11-2026-09-10-lightloop.md').
function handoffFileBase(dateStr, slug) {
  return /^\d{4}-\d{2}-\d{2}-/.test(slug) ? slug : `${dateStr}-${slug}`;
}

function stepHandoff(ctx) {
  const handoffsDir = path.join(ctx.project, ".claude", "handoffs");
  const cardPath = path.join(handoffsDir, `${handoffFileBase(ctx.dateStr, ctx.slug)}.md`);
  const card = buildHandoffCard(ctx);
  const bytes = Buffer.byteLength(card, "utf8");
  if (ctx.dry) {
    return {
      status: "dry",
      cardPath,
      bytes,
      message: `handoff: would write ${cardPath} (${bytes} bytes)`,
      preview: card
        .split("\n")
        .map((l) => (l ? "+ " + l : "+"))
        .join("\n"),
    };
  }
  assertSelftestSafePath(handoffsDir);
  assertSelftestSafePath(cardPath);
  fs.mkdirSync(handoffsDir, { recursive: true });
  fs.writeFileSync(cardPath, card, "utf8");
  return { status: "written", cardPath, bytes, message: `handoff: wrote ${cardPath} (${bytes} bytes)` };
}

// ---------------------------------------------------------------------------
// step 8: checklist + report
// ---------------------------------------------------------------------------

function buildChecklist(ctx) {
  const mark = (r) => (r.status === "failed" ? "✗" : "✓");
  const lines = [];
  lines.push(`${mark(ctx.ledgerResult)} ledger append -- ${ctx.ledgerResult.status}`);
  lines.push(`${mark(ctx.runLogResult)} RUN-LOG stub -- ${ctx.runLogResult.status}`);
  lines.push(
    ctx.mode === "bugfix"
      ? `${mark(ctx.lessonsResult)} LESSONS stub -- ${ctx.lessonsResult.status}`
      : `✓ LESSONS stub -- n/a (mode != bugfix)`
  );
  lines.push(
    `${ctx.codeMapResult.status === "na" ? "✓" : "✓"} code-map TODOs -- ` +
      (ctx.codeMapResult.missing ? `${ctx.codeMapResult.missing.length} missing (printed above, never edited)` : "n/a")
  );
  lines.push(`${mark(ctx.handoffResult)} handoff card -- ${ctx.handoffResult.status}`);
  lines.push("MANUAL walk the coverage matrix (R# -> T# -> result) out loud");
  lines.push("MANUAL set the Status line (IMPLEMENTED/CLOSED) on every artifact and reconcile code-map entries");
  lines.push("MANUAL write the RUN-LOG entry's Knob candidate line with real evidence");
  if (ctx.mode === "bugfix") lines.push("MANUAL write the LESSONS entry's Symptom/Root cause/Lesson/Guard body");
  return lines;
}

// ---------------------------------------------------------------------------
// retro-due advisory -- printed at the end of every close-out. Never blocks,
// never writes; mirrors /retro's and /cost's due-ness clock exactly (see
// ~/.claude/commands/retro.md step 1) so all three agree on one number.
// ---------------------------------------------------------------------------

function newestFile(dir, isMatch) {
  if (!fs.existsSync(dir)) return null;
  let best = null;
  let bestMtime = -1;
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }
  for (const name of entries) {
    if (!isMatch(name)) continue;
    const full = path.join(dir, name);
    try {
      const st = fs.statSync(full);
      if (st.isFile() && st.mtimeMs > bestMtime) {
        best = full;
        bestMtime = st.mtimeMs;
      }
    } catch {
      /* skip unreadable entry */
    }
  }
  return best;
}

// True-telemetry rows whose endedAt/startedAt postdates the newest
// retro-*.md's mtime; a row with neither timestamp falls back to its ledger
// line index vs rowCountAtRetro in .retro-marker.json. `pipelineDir` is the
// directory holding cost-ledger.jsonl -- the dirname of whatever ledger path
// step 3 actually used (respects --ledger the same way stepLedger does).
function computeRetroAdvisory(pipelineDir) {
  const raw = readTextSafe(path.join(pipelineDir, "cost-ledger.jsonl"));
  if (raw == null) return "retro: no cost-ledger.jsonl yet";

  const rows = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      /* skip malformed line */
    }
  }
  const trueRows = rows.filter((r) => r && r.telemetry === "true");

  const retroFile = newestFile(pipelineDir, (n) => /^retro-.*\.md$/.test(n));
  const retroCutoffMs = retroFile ? fs.statSync(retroFile).mtimeMs : 0;
  const marker = loadJsonSafe(path.join(pipelineDir, ".retro-marker.json"));
  const rowCountAtRetro = typeof marker?.rowCountAtRetro === "number" ? marker.rowCountAtRetro : 0;

  let sinceRetro = 0;
  trueRows.forEach((r, idx) => {
    const t = Date.parse((r && (r.endedAt || r.startedAt)) || "");
    if (!Number.isNaN(t)) {
      if (t > retroCutoffMs) sinceRetro++;
    } else if (idx >= rowCountAtRetro) {
      sinceRetro++;
    }
  });

  const lastRetroDate = marker?.lastRetroAt
    ? String(marker.lastRetroAt).slice(0, 10)
    : retroFile
      ? new Date(retroCutoffMs).toISOString().slice(0, 10)
      : "never";
  return `retro: ${sinceRetro}/10 true-telemetry rows since the last retro (${lastRetroDate})`;
}

function printReport(s) {
  console.log(`closeout: ${s.slug}  (project: ${s.project})`);
  console.log(
    `  mode=${s.mode ?? "unknown"} scale=${s.scale ?? "unknown"} startedAt=${s.startedAt ?? "unknown"} ` +
      `endedAt=${s.endedAt} runId=${s.runId ?? "unknown"}${s.dry ? "  [DRY RUN -- nothing written]" : ""}`
  );
  if (s.warnings.length) {
    console.log("\nWarnings:");
    for (const w of s.warnings) console.log(`  - ${w}`);
  }
  console.log("\n" + s.ledgerResult.message);
  if (s.dry && s.ledgerResult.preview) console.log(s.ledgerResult.preview);
  console.log(s.runLogResult.message);
  if (s.dry && s.runLogResult.preview) console.log(s.runLogResult.preview);
  console.log(s.lessonsResult.message);
  if (s.dry && s.lessonsResult.preview) console.log(s.lessonsResult.preview);
  console.log(s.codeMapResult.message);
  for (const l of s.codeMapResult.lines || []) console.log("  " + l);
  console.log(s.handoffResult.message);
  if (s.dry && s.handoffResult.preview) console.log(s.handoffResult.preview);

  console.log("\n=== S8 close-out checklist ===");
  for (const line of s.checklist) console.log(line);

  if (s.failedSteps && s.failedSteps.length) {
    console.log("\nFAILED:");
    for (const f of s.failedSteps) console.log(`  - ${f}`);
  }

  console.log("\n" + s.retroAdvisory);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function runMain(argv) {
  const { positional, flags } = parseFlags(argv);
  if (!positional[0]) throw new CloseoutError("missing <runDir>. See --help.");

  const runDir = path.resolve(positional[0]);
  if (!fs.existsSync(runDir) || !fs.statSync(runDir).isDirectory()) {
    throw new CloseoutError(`runDir '${runDir}' does not exist or is not a directory.`);
  }

  const dry = Boolean(flags.dry);
  const slug = path.basename(runDir);
  const warnings = [];
  const { project, note: projectResolutionNote } = resolveProject(
    runDir,
    typeof flags.project === "string" ? flags.project : null
  );
  warnings.push(projectResolutionNote);

  // Two stray ledgers from the pre-fix project-resolution bug already exist
  // under ~/.claude (2026-09-11 audit) -- never deleted here (not this
  // script's job), but any run whose resolved ledger path lands there again
  // is almost certainly another mis-resolution, so it's surfaced loudly.
  const ledgerPathForWarning =
    typeof flags.ledger === "string" ? path.resolve(flags.ledger) : defaultLedgerPath(project);
  const homeClaudeDir = path.join(os.homedir(), ".claude");
  if (isUnderDir(ledgerPathForWarning, homeClaudeDir)) {
    warnings.push(
      `WARNING: resolved ledger path is under ~/.claude (${ledgerPathForWarning}) -- this is the ` +
        `signature of the pre-2026-09-11 project-resolution bug; verify --project/git resolution is correct`
    );
  }

  let result = loadJsonSafe(path.join(runDir, "result.json"));
  const resumeText = readTextSafe(path.join(runDir, "RESUME.md"));
  const pipelineArgs = loadJsonSafe(path.join(runDir, "pipeline-args.json"));
  const { mode: resumeMode, scale: resumeScale } = extractModeScale(resumeText);

  // Finding 1/3 (2026-09-10 audit): a missing result.json always synthesizes
  // a light-loop one (below) so the ledger keeps recording something, but
  // RUN-LOG.md -- the shared, curated house file -- only accepts a stub for
  // that auto-triggered case when the user explicitly opted in with --light.
  const originalResultMissing = !result;
  const explicitLight = Boolean(flags.light);
  const lightMode = explicitLight || originalResultMissing;
  const noResultNoLight = originalResultMissing && !explicitLight;

  let mode = result?.mode ?? pipelineArgs?.mode ?? resumeMode ?? null;
  let scale = result?.scale ?? pipelineArgs?.scale ?? resumeScale ?? null;
  let startedAt = result?.startedAt ?? pipelineArgs?.startedAt ?? extractStartedAt(resumeText) ?? null;
  const endedAt = new Date().toISOString();
  const runIdResolution = resolveRunId({ flags, runDir, resumeText, result });
  const runId = runIdResolution.runId;
  const dateStr = todayStr();

  // A real (non-light) run whose telemetry isn't explicitly waived must
  // resolve a genuine runId -- see resolveRunId's header comment for why the
  // folder name is never an acceptable substitute (E6, 2026-09-15). A light
  // loop rarely runs through the Workflow tool at all (no wf_* id to find),
  // and --no-usage --reason is an explicit, already-gated operator override,
  // so neither is held to this.
  const requireRunId = !lightMode && !flags["no-usage"];
  if (requireRunId && !runId) {
    throw new CloseoutError(
      `cannot resolve a workflow run id for '${runDir}'. Looked in, in order: (1) --wf flag (not given), ` +
        `(2) '${runIdResolution.resumePath}', (3) '${runIdResolution.resultPath}' (runId/workflowId fields), ` +
        `(4) '${runIdResolution.progressPath}'. Refusing to guess one from the run directory's folder name and ` +
        "refusing to fall back to the whole-session cost -- pass --wf <runId> explicitly, fix RESUME.md/" +
        'result.json/progress.md, or use --light / --no-usage --reason "<why>" if this genuinely has no workflow.',
      2
    );
  }
  if (runId) warnings.push(`runId: resolved from ${runIdResolution.source}`);

  const usageResult = stepSessionUsage({ flags, runDir, project, runId, dry, lightMode });
  if (usageResult.skipped) warnings.push(`session-usage: skipped (${usageResult.reason})`);
  // usageResult.status === "warn" only happens under --dry (a real failure
  // still throws out of stepSessionUsage above) -- surfaced as a warning, and
  // deliberately NOT added to `candidates` below, so it never flips
  // process.exitCode under --dry.
  if (usageResult.status === "warn") warnings.push(usageResult.warnMessage);

  // E6 fix (2026-09-15): session-usage.mjs succeeding is not enough -- it can
  // still report a usage.workflows blob that has no entry for THIS runId
  // (wrong id, stale transcript, run split across sessions, ...). Continuing
  // past that used to silently key the ledger row off usage.session instead,
  // i.e. the whole session's cost. Abort instead: nothing is written.
  if (requireRunId && !dry && usageResult.usage && !hasMatchingWorkflow(usageResult.usage, runId)) {
    const haveKeys = Object.keys(usageResult.usage.workflows || {});
    throw new CloseoutError(
      `session-usage.mjs found no usage.workflows entry for runId '${runId}' (have: ${haveKeys.join(", ") || "none"}). ` +
        "Refusing to fall back to the session-wide aggregate cost -- verify the run id and --project/--session " +
        'resolution, or pass --no-usage --reason "<why>" to explicitly skip true telemetry for this run.',
      3
    );
  }

  if (lightMode) {
    result = buildLightResult({
      usage: usageResult.usage,
      flags,
      fallbackStartedAt: startedAt,
      endedAt,
    });
    mode = result.mode;
    scale = result.scale ?? scale;
    startedAt = result.startedAt ?? startedAt;
    warnings.push(
      explicitLight
        ? "light-loop: synthesized result.json from session-usage (--light)"
        : "light-loop: synthesized result.json from session-usage (no result.json found)"
    );
    if (!dry) {
      const lightResultPath = path.join(runDir, "result.json");
      assertSelftestSafePath(lightResultPath);
      fs.writeFileSync(lightResultPath, JSON.stringify(result, null, 2) + "\n", "utf8");
    }
  }

  if (!mode) warnings.push("mode could not be determined (checked result.json, pipeline-args.json, RESUME.md)");
  if (!scale) warnings.push("scale could not be determined");
  if (typeof flags.scale === "string" && !["small", "major"].includes(flags.scale.toLowerCase())) {
    warnings.push(`--scale '${flags.scale}' is not 'small' or 'major' -- ignored`);
  }

  const approach = (typeof flags.approach === "string" && flags.approach.trim()) || extractApproach(resumeText) || "dev-pipeline";
  const engineSha = resolveEngineSha(project);

  const ledgerResult = stepLedger({
    flags,
    project,
    runDir,
    slug,
    result,
    usageResult,
    dry,
    startedAt,
    endedAt,
    runId,
    mode,
    scale,
    approach,
    engineSha,
    branch: typeof flags.branch === "string" ? flags.branch : null,
    pr: typeof flags.pr === "string" ? flags.pr : null,
  });

  // session-usage.mjs keys usage.workflows by the run id WITHOUT its "wf_"
  // prefix (dirName.slice("wf_".length)), while runId here (resolved from
  // result.json or extractRunId's `wf_...` capture) always carries it -- an
  // unstripped lookup misses every time and silently falls back to the
  // whole-session cost instead of this run's own scoped total.
  const matchedWfUsage = findMatchedWorkflowUsage(usageResult.usage, runId);
  // requireRunId guarantees (by the abort above) that a matched workflow
  // entry exists whenever one was mandatory -- so this session fallback only
  // ever fires for the light-loop / --no-usage-override paths that were
  // never held to the "must match a workflow" rule in the first place.
  const trueCost = matchedWfUsage?.total?.costUsd ?? (requireRunId ? null : usageResult.usage?.session?.total?.costUsd);
  const costStr = fmtCost(trueCost, result?.estimatedCostUsd);
  const timeStr = fmtHM(usageResult.usage?.session?.activeMs) ?? fmtHM(result?.durationMs) ?? "n/a";
  const top3 = top3Confirmed(result?.confirmedByPhase);
  const caughtStr = top3 && top3.length ? top3.map(([p, n]) => `${p} (${n})`).join(", ") : "(no confirmedByPhase data in result.json)";
  const wastedStr = wastedSignals(result);

  const runLogResult = stepRunLog({
    flags,
    dry,
    slug,
    fields: { slug, mode, scale, costStr, timeStr, dateStr, caughtStr, wastedStr },
    noResultNoLight,
  });

  const lessonsResult = stepLessons({ flags, project, slug, mode, dry });
  const codeMapResult = stepCodeMap({ project, result });
  const handoffResult = stepHandoff({
    project,
    slug,
    dateStr,
    mode,
    scale,
    runDir,
    runId,
    ledgerResult,
    runLogResult,
    lessonsResult,
    codeMapResult,
    dry,
  });

  const checklist = buildChecklist({ ledgerResult, runLogResult, lessonsResult, codeMapResult, handoffResult, mode });

  // Finding 2 (2026-09-10 audit): a real (non-dry) run with any failed step
  // exits non-zero so a CI/hook caller can actually detect it, instead of
  // always exiting 0 regardless of what the checklist's ✗ marks said.
  // skipped-idempotent and dry runs never count as failures here.
  const failedSteps = [];
  if (!dry) {
    const candidates = [
      ["ledger", ledgerResult],
      ["RUN-LOG", runLogResult],
      ["handoff", handoffResult],
    ];
    if (mode === "bugfix") candidates.push(["LESSONS", lessonsResult]);
    for (const [name, r] of candidates) {
      if (r && r.status === "failed") failedSteps.push(`${name}: ${r.message}`);
    }
  }
  if (failedSteps.length) process.exitCode = 1;

  const summary = {
    runDir,
    project,
    slug,
    mode,
    scale,
    startedAt,
    endedAt,
    runId,
    dateStr,
    dry,
    warnings,
    usageResult,
    ledgerResult,
    runLogResult,
    lessonsResult,
    codeMapResult,
    handoffResult,
    checklist,
    failedSteps,
    retroAdvisory: computeRetroAdvisory(path.dirname(ledgerResult.ledgerPath)),
  };

  printReport(summary);
  return summary;
}

function printHelp() {
  console.log(`closeout.mjs - one command for dev-pipeline/bug-pipeline S8 close-out

Usage:
  node closeout.mjs <runDir> [--project <dir>] [--session <id> | --latest]
      [--dry] [--no-usage --reason "<why>"] [--branch <name>] [--pr <n>]
      [--ledger <file>] [--runlog <file>]
      [--light [--scale small|major] [--findings <json>]]

  node closeout.mjs selftest

See the file header for flag semantics and exactly what is read/written.`);
}

// ---------------------------------------------------------------------------
// selftest
// ---------------------------------------------------------------------------

// Real, never-to-be-touched-by-selftest paths, snapshotted before and after
// the whole selftest run. RUN-LOG is this skill's own file; the routeflow
// ledger is an arbitrary real project ledger used purely as a read-only
// canary -- if it doesn't exist on this machine, statSnapshot returns null
// both times and the comparison still passes.
const REAL_RUN_LOG_PATH = DEFAULT_RUN_LOG_PATH;
const REAL_ROUTEFLOW_LEDGER_PATH = "C:\\ClaudeCode\\routeflow\\.claude\\pipeline\\cost-ledger.jsonl";

function statSnapshot(p) {
  try {
    const st = fs.statSync(p);
    return { size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

function runSelftest() {
  const beforeRunLog = statSnapshot(REAL_RUN_LOG_PATH);
  const beforeRouteflowLedger = statSnapshot(REAL_ROUTEFLOW_LEDGER_PATH);
  process.env.CLOSEOUT_SELFTEST = "1";
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "closeout-selftest-"));
  let ok = true;
  try {
    const project = path.join(tmpBase, "proj");
    const slug = "selftest-run";
    const runDir = path.join(project, ".claude", "pipeline", slug);
    fs.mkdirSync(runDir, { recursive: true });
    fs.mkdirSync(path.join(project, ".claude", "lessons"), { recursive: true });
    fs.mkdirSync(path.join(project, ".claude", "code-map"), { recursive: true });
    fs.mkdirSync(path.join(project, ".claude", "handoffs"), { recursive: true });

    const fixtureSrc = path.join(SCRIPT_DIR, "..", "..", "model-routing", "scripts", "fixtures", "f14-result.json");
    fs.copyFileSync(fixtureSrc, path.join(runDir, "result.json"));

    // f14-result.json carries no `mode` -- RESUME.md is the fallback under
    // test (mirrors real B263-style RESUME cards: prose mode/scale + a
    // `runId:` line the fixture's own result.json also omits).
    fs.writeFileSync(
      path.join(runDir, "RESUME.md"),
      "# RESUME — selftest fixture (bug-pipeline, mode bugfix, scale major)\n" +
        "runId: wf_selftest0001 (task none)\n" +
        "startedAt: 2026-09-02T02:00:00.000Z\n",
      "utf8"
    );

    fs.writeFileSync(
      path.join(project, ".claude", "lessons", "_meta.json"),
      JSON.stringify({ nextId: 42, activeCount: 5, updatedAt: "2026-09-01T00:00:00.000Z", schemaVersion: 1 }, null, 2) + "\n",
      "utf8"
    );
    fs.writeFileSync(
      path.join(project, ".claude", "lessons", "LESSONS.md"),
      "# Lessons Learned\n\n> intro\n\n## process\n\n### L-041 · 2026-09-01 · process\n" +
        "- **Symptom:** x\n- **Root cause:** y\n- **Lesson:** z\n- **Guard:** none\n",
      "utf8"
    );

    const runLogPath = path.join(tmpBase, "RUN-LOG.md");
    fs.writeFileSync(
      runLogPath,
      "# Run log\n\nheader text\n\n---\n\n## some-other-run · feature · small · $1.00 · 0:10 · 2026-01-01\n\n" +
        "- Caught: x\n- Wasted: none\n- Knob candidate: n/a\n- Deviation: none\n",
      "utf8"
    );

    const ledgerPath = path.join(tmpBase, "ledger-project", ".claude", "pipeline", "cost-ledger.jsonl");
    const NO_USAGE_REASON = "selftest fixture: no real session transcript to attach";
    const baseArgs = [
      runDir,
      "--project",
      project,
      "--no-usage",
      "--reason",
      NO_USAGE_REASON,
      "--runlog",
      runLogPath,
      "--ledger",
      ledgerPath,
    ];

    // --- --dry writes nothing ---
    const dryResult = runMain([...baseArgs, "--dry"]);
    assert(dryResult.ledgerResult.status === "dry", `expected dry ledger status, got '${dryResult.ledgerResult.status}'`);
    assert(!fs.existsSync(ledgerPath), "dry run must not create the ledger file");
    assert(!fs.readFileSync(runLogPath, "utf8").includes(slug), "dry run must not touch RUN-LOG.md");
    assert(
      !fs.existsSync(path.join(project, ".claude", "handoffs", `${dryResult.dateStr}-${slug}.md`)),
      "dry run must not write a handoff card"
    );
    const metaAfterDry = loadJsonSafe(path.join(project, ".claude", "lessons", "_meta.json"));
    assert(metaAfterDry.nextId === 42, `dry run must not bump lessons nextId, got ${metaAfterDry.nextId}`);

    // --- first real run ---
    const r1 = runMain(baseArgs);
    assert(r1.mode === "bugfix", `expected mode 'bugfix' via RESUME.md fallback, got '${r1.mode}'`);
    assert(r1.ledgerResult.status === "appended", `expected ledger appended, got '${r1.ledgerResult.status}'`);
    assert(r1.runLogResult.status === "appended", `expected RUN-LOG appended, got '${r1.runLogResult.status}'`);
    assert(r1.lessonsResult.status === "appended", `expected LESSONS appended, got '${r1.lessonsResult.status}'`);

    const ledgerLines1 = fs.readFileSync(ledgerPath, "utf8").split(/\r?\n/).filter(Boolean);
    assert(ledgerLines1.length === 1, `expected 1 ledger line, got ${ledgerLines1.length}`);
    assert(JSON.parse(ledgerLines1[0]).run === slug, "ledger row 'run' field mismatch");

    const runLogEntryCount1 = (fs.readFileSync(runLogPath, "utf8").match(/^## /gm) || []).length;
    assert(runLogEntryCount1 === 2, `expected 2 RUN-LOG entries (1 existing + 1 new), got ${runLogEntryCount1}`);

    const metaAfter1 = loadJsonSafe(path.join(project, ".claude", "lessons", "_meta.json"));
    assert(metaAfter1.nextId === 43, `expected nextId bumped to 43, got ${metaAfter1.nextId}`);
    assert(metaAfter1.activeCount === 6, `expected activeCount bumped to 6 (non-full register), got ${metaAfter1.activeCount}`);

    const handoffPath = path.join(project, ".claude", "handoffs", `${r1.dateStr}-${slug}.md`);
    assert(fs.existsSync(handoffPath), "expected a handoff card to be written");
    const handoffBytes = Buffer.byteLength(fs.readFileSync(handoffPath, "utf8"), "utf8");
    assert(handoffBytes <= 2048, `expected handoff card <= 2048 bytes, got ${handoffBytes}`);

    // --- second run: idempotent no-op everywhere ---
    const r2 = runMain(baseArgs);
    assert(r2.ledgerResult.status === "skipped-idempotent", `expected ledger idempotent skip, got '${r2.ledgerResult.status}'`);
    assert(r2.runLogResult.status === "skipped-idempotent", `expected RUN-LOG idempotent skip, got '${r2.runLogResult.status}'`);
    assert(r2.lessonsResult.status === "skipped-idempotent", `expected LESSONS idempotent skip, got '${r2.lessonsResult.status}'`);

    const ledgerLines2 = fs.readFileSync(ledgerPath, "utf8").split(/\r?\n/).filter(Boolean);
    assert(ledgerLines2.length === 1, `expected still 1 ledger line after re-run, got ${ledgerLines2.length}`);
    const runLogEntryCount2 = (fs.readFileSync(runLogPath, "utf8").match(/^## /gm) || []).length;
    assert(runLogEntryCount2 === 2, `expected still 2 RUN-LOG entries after re-run, got ${runLogEntryCount2}`);
    const metaAfter2 = loadJsonSafe(path.join(project, ".claude", "lessons", "_meta.json"));
    assert(metaAfter2.nextId === 43, `expected nextId to stay 43 after idempotent re-run, got ${metaAfter2.nextId}`);

    // --- full register (activeCount == maxEntries): no write, ✗ on the checklist ---
    const metaBeforeCap = loadJsonSafe(path.join(project, ".claude", "lessons", "_meta.json"));
    fs.writeFileSync(
      path.join(project, ".claude", "lessons", "_meta.json"),
      JSON.stringify({ ...metaBeforeCap, activeCount: 40, maxEntries: 40, maxBytes: 40960 }, null, 2) + "\n",
      "utf8"
    );
    const cappedSlug = "selftest-run-capped";
    const cappedRunDir = path.join(project, ".claude", "pipeline", cappedSlug);
    fs.mkdirSync(cappedRunDir, { recursive: true });
    fs.copyFileSync(path.join(runDir, "result.json"), path.join(cappedRunDir, "result.json"));
    fs.writeFileSync(
      path.join(cappedRunDir, "RESUME.md"),
      "# RESUME — selftest fixture capped (bug-pipeline, mode bugfix, scale major)\n" +
        "runId: wf_selftest0002 (task none)\n" +
        "startedAt: 2026-09-02T02:00:00.000Z\n",
      "utf8"
    );
    const cappedArgs = [
      cappedRunDir,
      "--project",
      project,
      "--no-usage",
      "--reason",
      NO_USAGE_REASON,
      "--runlog",
      runLogPath,
      "--ledger",
      ledgerPath,
    ];
    const lessonsMdBeforeCap = fs.readFileSync(path.join(project, ".claude", "lessons", "LESSONS.md"), "utf8");
    const metaJsonBeforeCap = fs.readFileSync(path.join(project, ".claude", "lessons", "_meta.json"), "utf8");

    const rCapped = runMain(cappedArgs);
    assert(
      rCapped.lessonsResult.status === "failed",
      `expected lessons capped status 'failed', got '${rCapped.lessonsResult.status}'`
    );
    assert(
      /register at cap/.test(rCapped.lessonsResult.message),
      `expected a 'register at cap' message, got '${rCapped.lessonsResult.message}'`
    );
    assert(
      fs.readFileSync(path.join(project, ".claude", "lessons", "LESSONS.md"), "utf8") === lessonsMdBeforeCap,
      "capped run must not write LESSONS.md"
    );
    assert(
      fs.readFileSync(path.join(project, ".claude", "lessons", "_meta.json"), "utf8") === metaJsonBeforeCap,
      "capped run must not write _meta.json"
    );
    const cappedChecklistLine = rCapped.checklist.find((l) => l.includes("LESSONS stub"));
    assert(
      cappedChecklistLine && cappedChecklistLine.startsWith("✗"),
      `expected a ✗ LESSONS checklist line for the full register, got '${cappedChecklistLine}'`
    );

    // --- finding 2: a real run with a failed step sets process.exitCode = 1
    // (the capped run above had a failed LESSONS step and was not --dry) ---
    assert(
      process.exitCode === 1,
      `expected process.exitCode 1 after the capped run's failed LESSONS step, got ${process.exitCode}`
    );

    // --- findings 1/2/3: --light on a run dir with no result.json at all
    // still gets a real ledger row (mode 'light-loop', telemetry 'true')
    // instead of recording nothing, and --dry still writes nothing ---
    const lightSlug = "selftest-run-light";
    const lightRunDir = path.join(project, ".claude", "pipeline", lightSlug);
    fs.mkdirSync(lightRunDir, { recursive: true });
    fs.writeFileSync(
      path.join(lightRunDir, "RESUME.md"),
      "# RESUME — selftest light-loop fixture (no result.json)\n",
      "utf8"
    );
    const lightArgs = [
      lightRunDir,
      "--project",
      project,
      "--no-usage",
      "--reason",
      NO_USAGE_REASON,
      "--runlog",
      runLogPath,
      "--ledger",
      ledgerPath,
      "--light",
      "--scale",
      "small",
    ];

    const rLightDry = runMain([...lightArgs, "--dry"]);
    assert(rLightDry.mode === "light-loop", `expected dry light-loop mode, got '${rLightDry.mode}'`);
    assert(!fs.existsSync(path.join(lightRunDir, "result.json")), "dry --light run must not write result.json");

    const rLight = runMain(lightArgs);
    assert(rLight.mode === "light-loop", `expected mode 'light-loop', got '${rLight.mode}'`);
    assert(rLight.scale === "small", `expected scale 'small' from --scale, got '${rLight.scale}'`);
    assert(fs.existsSync(path.join(lightRunDir, "result.json")), "expected a synthesized result.json to be written");
    const lightResultOnDisk = loadJsonSafe(path.join(lightRunDir, "result.json"));
    assert(lightResultOnDisk.clean === true, `expected synthesized result clean:true (no --findings), got ${lightResultOnDisk.clean}`);
    assert(Array.isArray(lightResultOnDisk.phaseReport), "expected synthesized result.phaseReport to be an array");
    assert(
      rLight.ledgerResult.status === "appended",
      `expected light-loop ledger append, got '${rLight.ledgerResult.status}'`
    );
    assert(
      rLight.runLogResult.status === "appended",
      `expected light-loop RUN-LOG append (--light given explicitly), got '${rLight.runLogResult.status}'`
    );

    const lightLedgerRows = fs
      .readFileSync(ledgerPath, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const lightRow = lightLedgerRows.find((r) => r.run === lightSlug);
    assert(lightRow, "expected a ledger row for the --light run");
    assert(lightRow.telemetry === "true", `expected ledger row telemetry 'true' for light-loop run, got '${lightRow.telemetry}'`);
    assert(lightRow.scale === "small", `expected ledger row scale 'small', got '${lightRow.scale}'`);

    // --- finding 3: missing result.json with NO --light still gets a ledger
    // row (finding 1 is unconditional), but RUN-LOG refuses -----------------
    const autoSlug = "selftest-run-auto-light";
    const autoRunDir = path.join(project, ".claude", "pipeline", autoSlug);
    fs.mkdirSync(autoRunDir, { recursive: true });
    fs.writeFileSync(
      path.join(autoRunDir, "RESUME.md"),
      "# RESUME — selftest auto light-loop fixture (no result.json, no --light)\n",
      "utf8"
    );
    const autoArgs = [
      autoRunDir,
      "--project",
      project,
      "--no-usage",
      "--reason",
      NO_USAGE_REASON,
      "--runlog",
      runLogPath,
      "--ledger",
      ledgerPath,
    ];

    process.exitCode = 0; // reset so the assertion below is unambiguous
    const rAuto = runMain(autoArgs);
    assert(rAuto.mode === "light-loop", `expected auto-light mode 'light-loop', got '${rAuto.mode}'`);
    assert(
      rAuto.ledgerResult.status === "appended",
      `expected auto-light ledger append even without --light, got '${rAuto.ledgerResult.status}'`
    );
    assert(
      rAuto.runLogResult.status === "failed",
      `expected RUN-LOG to refuse without --light, got '${rAuto.runLogResult.status}'`
    );
    assert(
      rAuto.runLogResult.message === "no result — nothing to log",
      `expected the exact 'no result — nothing to log' message, got '${rAuto.runLogResult.message}'`
    );
    assert(
      process.exitCode === 1,
      `expected process.exitCode 1 after the auto-light run's failed RUN-LOG step, got ${process.exitCode}`
    );
    process.exitCode = 0; // reset before the drift block below

    // --- B3: date-prefix drift -- dir carries a 'YYYY-MM-DD-' prefix but
    // the ledger row / RUN-LOG heading recorded the SAME run WITHOUT it.
    // Both idempotence checks must recognize the match (stripDatePrefix,
    // same rule stop-global.mjs's hook uses) instead of writing a duplicate
    // ledger row / RUN-LOG entry -------------------------------------------
    const driftBareSlug = "drift-test";
    const driftSlug = "2026-09-05-" + driftBareSlug;
    const driftRunDir = path.join(project, ".claude", "pipeline", driftSlug);
    fs.mkdirSync(driftRunDir, { recursive: true });
    fs.copyFileSync(path.join(runDir, "result.json"), path.join(driftRunDir, "result.json"));
    fs.writeFileSync(
      path.join(driftRunDir, "RESUME.md"),
      "# RESUME — selftest drift fixture (bug-pipeline, mode bugfix, scale major)\n" +
        "runId: wf_selftest0003 (task none)\n" +
        "startedAt: 2026-09-05T02:00:00.000Z\n",
      "utf8"
    );
    fs.appendFileSync(
      ledgerPath,
      JSON.stringify({ run: driftBareSlug, telemetry: "true", endedAt: "2026-09-05T03:00:00.000Z" }) + "\n",
      "utf8"
    );
    fs.appendFileSync(
      runLogPath,
      `\n## ${driftBareSlug} · bugfix · major · $1.00 · 0:10 · 2026-09-05\n\n` +
        "- Caught: x\n- Wasted: none\n- Knob candidate: n/a\n- Deviation: none\n",
      "utf8"
    );
    const driftArgs = [
      driftRunDir,
      "--project",
      project,
      "--no-usage",
      "--reason",
      NO_USAGE_REASON,
      "--runlog",
      runLogPath,
      "--ledger",
      ledgerPath,
    ];
    const rDrift = runMain(driftArgs);
    assert(
      rDrift.ledgerResult.status === "skipped-idempotent",
      `expected date-prefix-drift ledger idempotent skip (dir '${driftSlug}' vs row '${driftBareSlug}'), got '${rDrift.ledgerResult.status}'`
    );
    assert(
      rDrift.runLogResult.status === "skipped-idempotent",
      `expected date-prefix-drift RUN-LOG idempotent skip (dir '${driftSlug}' vs heading '${driftBareSlug}'), got '${rDrift.runLogResult.status}'`
    );

    // --- P2(b): true telemetry or no close-out ------------------------------
    // (1) session-usage failure with NO override is FATAL: closeout throws,
    // nothing is written. Not mocked -- this project dir has no matching
    // ~/.claude/projects/<enc> transcript dir, so the real session-usage.mjs
    // subprocess genuinely fails on --latest.
    const noOverrideSlug = "selftest-run-no-override";
    const noOverrideRunDir = path.join(project, ".claude", "pipeline", noOverrideSlug);
    fs.mkdirSync(noOverrideRunDir, { recursive: true });
    fs.copyFileSync(path.join(runDir, "result.json"), path.join(noOverrideRunDir, "result.json"));
    fs.writeFileSync(
      path.join(noOverrideRunDir, "RESUME.md"),
      "# RESUME — selftest no-override fixture (bug-pipeline, mode bugfix, scale major)\n" +
        "runId: wf_selftestnooverride (task none)\n" +
        "startedAt: 2026-09-02T02:00:00.000Z\n",
      "utf8"
    );
    const ledgerLinesBeforeFail = fs.existsSync(ledgerPath)
      ? fs.readFileSync(ledgerPath, "utf8").split(/\r?\n/).filter(Boolean).length
      : 0;
    const noOverrideArgs = [noOverrideRunDir, "--project", project, "--runlog", runLogPath, "--ledger", ledgerPath];
    let threwNoOverride = null;
    try {
      runMain(noOverrideArgs);
    } catch (err) {
      threwNoOverride = err;
    }
    assert(threwNoOverride, "expected closeout to throw when session-usage fails with no override recorded");
    assert(
      threwNoOverride.name === "CloseoutError",
      `expected a CloseoutError on unhandled session-usage failure, got '${threwNoOverride && threwNoOverride.name}'`
    );
    assert(
      typeof threwNoOverride.code === "number" && threwNoOverride.code !== 2,
      `expected a fatal exit code distinct from the --no-usage usage-error code (2), got ${threwNoOverride && threwNoOverride.code}`
    );
    const ledgerLinesAfterFail = fs.readFileSync(ledgerPath, "utf8").split(/\r?\n/).filter(Boolean);
    assert(
      ledgerLinesAfterFail.length === ledgerLinesBeforeFail,
      `expected NO ledger write on the fatal no-override failure, went from ${ledgerLinesBeforeFail} to ${ledgerLinesAfterFail.length} lines`
    );
    assert(
      !ledgerLinesAfterFail.some((l) => JSON.parse(l).run === noOverrideSlug),
      "expected no ledger row at all for the failed no-override run"
    );

    // (2a) --no-usage with NO --reason is a usage error (exit code 2),
    // before any write happens.
    let threwBareNoUsage = null;
    try {
      runMain([noOverrideRunDir, "--project", project, "--runlog", runLogPath, "--ledger", ledgerPath, "--no-usage"]);
    } catch (err) {
      threwBareNoUsage = err;
    }
    assert(threwBareNoUsage, "expected --no-usage with no --reason to throw");
    assert(
      threwBareNoUsage.code === 2,
      `expected exit code 2 for --no-usage without --reason, got ${threwBareNoUsage && threwBareNoUsage.code}`
    );

    // (2b) --no-usage --reason "<text>" is the recorded override: proceeds,
    // ledger row lands with telemetry legacy + usageOverrideReason.
    const overrideReasonText = "sandbox has no session transcripts for this fixture";
    const rOverride = runMain([
      noOverrideRunDir,
      "--project",
      project,
      "--runlog",
      runLogPath,
      "--ledger",
      ledgerPath,
      "--no-usage",
      "--reason",
      overrideReasonText,
    ]);
    assert(
      rOverride.usageResult.telemetry === "legacy",
      `expected legacy telemetry on the recorded-override run, got '${rOverride.usageResult.telemetry}'`
    );
    assert(
      rOverride.usageResult.usageOverrideReason === overrideReasonText,
      `expected usageResult.usageOverrideReason recorded, got '${JSON.stringify(rOverride.usageResult.usageOverrideReason)}'`
    );
    assert(rOverride.ledgerResult.status === "appended", `expected the override run's ledger append to succeed, got '${rOverride.ledgerResult.status}'`);
    const ledgerLinesAfterOverride = fs
      .readFileSync(ledgerPath, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const overrideRow = ledgerLinesAfterOverride.find((r) => r.run === noOverrideSlug);
    assert(overrideRow, "expected a ledger row for the --no-usage --reason override run");
    assert(overrideRow.telemetry === "legacy", `expected ledger row telemetry 'legacy', got '${overrideRow.telemetry}'`);
    assert(
      overrideRow.usageOverrideReason === overrideReasonText,
      `expected ledger row usageOverrideReason recorded, got '${JSON.stringify(overrideRow.usageOverrideReason)}'`
    );

    // --- E6 (2026-09-15): run-id resolution never falls back to the folder
    // name, and a missing/unmatched run id aborts loudly instead of writing
    // a session-scoped ledger row. Three cases -----------------------------

    // (i) RESUME.md carries a runId -> resolved, close-out proceeds.
    const e6ResumeSlug = "e6-resume-runid";
    const e6ResumeRunDir = path.join(project, ".claude", "pipeline", e6ResumeSlug);
    fs.mkdirSync(e6ResumeRunDir, { recursive: true });
    fs.copyFileSync(path.join(runDir, "result.json"), path.join(e6ResumeRunDir, "result.json"));
    fs.writeFileSync(
      path.join(e6ResumeRunDir, "RESUME.md"),
      "# RESUME — E6 selftest fixture (bug-pipeline, mode bugfix, scale major)\n" +
        "runId: wf_e6resumeok (task none)\n" +
        "startedAt: 2026-09-02T02:00:00.000Z\n",
      "utf8"
    );
    const rE6Resume = runMain([
      e6ResumeRunDir,
      "--project",
      project,
      "--runlog",
      runLogPath,
      "--ledger",
      ledgerPath,
      "--no-usage",
      "--reason",
      NO_USAGE_REASON,
    ]);
    assert(
      rE6Resume.runId === "wf_e6resumeok",
      `expected runId resolved from RESUME.md, got '${rE6Resume.runId}'`
    );
    assert(
      rE6Resume.warnings.some((w) => w.includes("runId: resolved from") && w.includes("RESUME.md")),
      "expected a warning naming RESUME.md as the runId source"
    );

    // (ii) No id anywhere (no --wf, no RESUME.md runId, no result.json
    // runId/workflowId, no progress.md) -> non-zero exit (CloseoutError),
    // NOTHING written -- never guess one from the folder name.
    const e6NoIdSlug = "e6-no-runid-anywhere";
    const e6NoIdRunDir = path.join(project, ".claude", "pipeline", e6NoIdSlug);
    fs.mkdirSync(e6NoIdRunDir, { recursive: true });
    const e6NoIdResult = JSON.parse(fs.readFileSync(path.join(runDir, "result.json"), "utf8"));
    delete e6NoIdResult.runId;
    delete e6NoIdResult.workflowId;
    fs.writeFileSync(path.join(e6NoIdRunDir, "result.json"), JSON.stringify(e6NoIdResult), "utf8");
    fs.writeFileSync(
      path.join(e6NoIdRunDir, "RESUME.md"),
      "# RESUME — E6 selftest fixture, no runId anywhere (bug-pipeline, mode bugfix, scale major)\n",
      "utf8"
    );
    const ledgerLinesBeforeNoId = fs.readFileSync(ledgerPath, "utf8").split(/\r?\n/).filter(Boolean).length;
    let threwNoId = null;
    try {
      runMain([e6NoIdRunDir, "--project", project, "--runlog", runLogPath, "--ledger", ledgerPath]);
    } catch (err) {
      threwNoId = err;
    }
    assert(threwNoId, "expected closeout to throw when no runId can be resolved anywhere");
    assert(
      threwNoId.name === "CloseoutError" && typeof threwNoId.code === "number" && threwNoId.code !== 0,
      `expected a non-zero-exit CloseoutError, got '${threwNoId && threwNoId.name}' code=${threwNoId && threwNoId.code}`
    );
    assert(
      /folder name/i.test(threwNoId.message) && /RESUME\.md/.test(threwNoId.message) && /progress\.md/.test(threwNoId.message),
      `expected the error to name RESUME.md/result.json/progress.md and the folder-name refusal, got: ${threwNoId.message}`
    );
    const ledgerLinesAfterNoId = fs.readFileSync(ledgerPath, "utf8").split(/\r?\n/).filter(Boolean).length;
    assert(
      ledgerLinesAfterNoId === ledgerLinesBeforeNoId,
      `expected no ledger row written when no runId resolves, got ${ledgerLinesBeforeNoId} -> ${ledgerLinesAfterNoId} lines`
    );

    // (iii) A runId resolves fine, but the (stubbed) session-usage JSON has
    // no usage.workflows entry for it -> non-zero exit, NOTHING written --
    // never fall back to usage.session (the exact E6 defect).
    const e6MismatchSlug = "e6-usage-mismatch";
    const e6MismatchRunDir = path.join(project, ".claude", "pipeline", e6MismatchSlug);
    fs.mkdirSync(e6MismatchRunDir, { recursive: true });
    fs.copyFileSync(path.join(runDir, "result.json"), path.join(e6MismatchRunDir, "result.json"));
    fs.writeFileSync(
      path.join(e6MismatchRunDir, "RESUME.md"),
      "# RESUME — E6 selftest fixture, usage mismatch (bug-pipeline, mode bugfix, scale major)\n" +
        "runId: wf_e6mismatch (task none)\n" +
        "startedAt: 2026-09-02T02:00:00.000Z\n",
      "utf8"
    );
    const e6StubUsagePath = path.join(tmpBase, "e6-stub-session-usage.json");
    fs.writeFileSync(
      e6StubUsagePath,
      JSON.stringify({
        v: 1,
        sessionId: "sess-e6-selftest",
        project,
        session: { total: { costUsd: 108.61 }, activeMs: 32400000 },
        // Deliberately NO entry for "e6mismatch" -- this is the whole-session
        // blob a caller must never fall back to.
        workflows: { "some-other-run": { total: { costUsd: 7.33 } } },
      }),
      "utf8"
    );
    const ledgerLinesBeforeMismatch = fs.readFileSync(ledgerPath, "utf8").split(/\r?\n/).filter(Boolean).length;
    let threwMismatch = null;
    process.env.CLOSEOUT_SELFTEST_USAGE_JSON = e6StubUsagePath;
    try {
      runMain([e6MismatchRunDir, "--project", project, "--runlog", runLogPath, "--ledger", ledgerPath]);
    } catch (err) {
      threwMismatch = err;
    } finally {
      delete process.env.CLOSEOUT_SELFTEST_USAGE_JSON;
    }
    assert(threwMismatch, "expected closeout to throw when session-usage has no workflow entry for this runId");
    assert(
      threwMismatch.name === "CloseoutError" && typeof threwMismatch.code === "number" && threwMismatch.code !== 0,
      `expected a non-zero-exit CloseoutError, got '${threwMismatch && threwMismatch.name}' code=${threwMismatch && threwMismatch.code}`
    );
    assert(
      /session-wide aggregate/i.test(threwMismatch.message),
      `expected the error to explain the session-wide-aggregate refusal, got: ${threwMismatch.message}`
    );
    const ledgerLinesAfterMismatch = fs.readFileSync(ledgerPath, "utf8").split(/\r?\n/).filter(Boolean).length;
    assert(
      ledgerLinesAfterMismatch === ledgerLinesBeforeMismatch,
      `expected no ledger row written on a usage-mismatch abort, got ${ledgerLinesBeforeMismatch} -> ${ledgerLinesAfterMismatch} lines`
    );

    // --- P2(a): project resolution via git-common-dir -----------------------
    // A real git worktree, checked out from a real main repo -- proves
    // resolveProject (and therefore the default ledger path) lands on the
    // MAIN checkout, not the worktree's own path, when --project is not
    // given (the exact 2026-09-11 bug: a worktree's own path encodes to a
    // ~/.claude/projects/<enc> dir that never existed).
    function runGitCmd(args, cwd) {
      return spawnSync("git", args, { cwd, encoding: "utf8" });
    }
    const gitMainRepo = path.join(tmpBase, "git-main-repo");
    fs.mkdirSync(gitMainRepo, { recursive: true });
    let gitRes = runGitCmd(["init", "-q"], gitMainRepo);
    assert(gitRes.status === 0, `selftest setup: git init failed -- ${gitRes.stderr}`);
    fs.writeFileSync(path.join(gitMainRepo, "README.md"), "selftest fixture\n", "utf8");
    gitRes = runGitCmd(["add", "."], gitMainRepo);
    assert(gitRes.status === 0, `selftest setup: git add failed -- ${gitRes.stderr}`);
    gitRes = runGitCmd(
      ["-c", "user.email=selftest@example.com", "-c", "user.name=selftest", "commit", "-q", "-m", "init"],
      gitMainRepo
    );
    assert(gitRes.status === 0, `selftest setup: git commit failed -- ${gitRes.stderr}`);
    const gitWorktreeDir = path.join(tmpBase, "git-worktree");
    gitRes = runGitCmd(["worktree", "add", "-q", gitWorktreeDir], gitMainRepo);
    assert(gitRes.status === 0, `selftest setup: git worktree add failed -- ${gitRes.stderr}`);

    const gitRunDir = path.join(gitWorktreeDir, ".claude", "pipeline", "git-worktree-run");
    fs.mkdirSync(gitRunDir, { recursive: true });
    fs.writeFileSync(
      path.join(gitRunDir, "RESUME.md"),
      "# RESUME — selftest git-worktree fixture (feature, mode feature, scale small)\n",
      "utf8"
    );
    const gitRunLogPath = path.join(tmpBase, "RUN-LOG-git.md");
    fs.writeFileSync(gitRunLogPath, "# Run log\n\nheader text\n\n---\n", "utf8");

    // Deliberately NO --project and NO --ledger -- both must resolve via
    // git-common-dir alone.
    const rGit = runMain([
      gitRunDir,
      "--no-usage",
      "--reason",
      NO_USAGE_REASON,
      "--runlog",
      gitRunLogPath,
      "--light",
      "--scale",
      "small",
    ]);
    assert(
      rGit.project === gitMainRepo,
      `expected project resolved to the MAIN checkout '${gitMainRepo}' via git-common-dir (not the worktree '${gitWorktreeDir}'), got '${rGit.project}'`
    );
    assert(
      rGit.warnings.some((w) => w.includes("git-common-dir")),
      `expected a warning recording git-common-dir resolution, got ${JSON.stringify(rGit.warnings)}`
    );
    const expectedGitLedgerPath = path.join(gitMainRepo, ".claude", "pipeline", "cost-ledger.jsonl");
    assert(
      rGit.ledgerResult.ledgerPath === expectedGitLedgerPath,
      `expected the default ledger path to resolve under the main checkout, got '${rGit.ledgerResult.ledgerPath}'`
    );
    assert(fs.existsSync(expectedGitLedgerPath), "expected a real ledger file written under the main checkout");
    const gitLedgerRows = fs
      .readFileSync(expectedGitLedgerPath, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    assert(
      gitLedgerRows.some((r) => r.run === "git-worktree-run"),
      "expected a ledger row for the git-worktree-run slug under the main checkout's ledger"
    );

    // --- B3: retro advisory -- every close-out summary (dry or real) carries
    // a well-formed 'retro: N/10 ...' line, present even before any ledger
    // file exists ------------------------------------------------------------
    assert(
      typeof dryResult.retroAdvisory === "string" && dryResult.retroAdvisory.length > 0,
      "expected a retro advisory even on the very first --dry run (before the ledger file exists)"
    );
    assert(
      /^retro: \d+\/10 true-telemetry rows since the last retro \(.+\)$/.test(rDrift.retroAdvisory),
      `expected a well-formed retro advisory line once the ledger exists, got '${rDrift.retroAdvisory}'`
    );

    // --- P2(d) repair path: a post-cutoff row with no true telemetry is a
    // PERMANENT Stop-hook block unless close-out can replace it. ONE run
    // with true telemetry rewrites exactly that line (count + order
    // unchanged, every other line byte-identical); a second identical run is
    // a plain idempotent skip; stop-global then reports no violation. A run
    // WITHOUT true telemetry never rewrites and never appends. -------------
    {
      const upProject = path.join(tmpBase, "upgrade-project");
      const upLedger = path.join(upProject, ".claude", "pipeline", "cost-ledger.jsonl");
      fs.mkdirSync(path.dirname(upLedger), { recursive: true });
      const upSlug = "selftest-upgrade-me";
      const upRunDir = path.join(project, ".claude", "pipeline", upSlug);
      fs.mkdirSync(upRunDir, { recursive: true });
      fs.copyFileSync(path.join(runDir, "result.json"), path.join(upRunDir, "result.json"));

      const rowsBefore = [
        JSON.stringify({ run: "pre-cutoff-row", telemetry: "legacy", endedAt: "2026-09-10T00:00:00Z" }),
        JSON.stringify({ run: upSlug, telemetry: "legacy", endedAt: "2026-09-13T00:00:00Z", trueCostUsd: null }),
        JSON.stringify({ run: "post-cutoff-true-row", telemetry: "true", endedAt: "2026-09-13T00:00:00Z" }),
      ];
      fs.writeFileSync(upLedger, rowsBefore.join("\n") + "\n", "utf8");

      const usageFile = path.join(tmpBase, "selftest-session-usage.json");
      fs.writeFileSync(
        usageFile,
        JSON.stringify({
          sessionId: "selftest-session-0001",
          session: { total: { costUsd: 1.23 }, cacheHitRatio: 0.5, activeMs: 60000 },
          workflows: {},
        }),
        "utf8"
      );

      const upCtx = {
        flags: { ledger: upLedger },
        project,
        runDir: upRunDir,
        slug: upSlug,
        dry: false,
        startedAt: "2026-09-13T00:00:00.000Z",
        endedAt: "2026-09-13T01:00:00.000Z",
        branch: null,
        pr: null,
        usageResult: { outFile: usageFile, telemetry: "true" },
        mode: "bugfix",
        scale: "small",
        result: {},
      };

      // repro-first: the real Stop hook BLOCKS on this ledger before repair.
      const stopHook = path.join(os.homedir(), ".claude", "hooks", "stop-global.mjs");
      const stopHookPresent = fs.existsSync(stopHook);
      if (stopHookPresent) {
        const stopBefore = spawnSync(process.execPath, [stopHook, "--project", upProject], { encoding: "utf8" });
        assert(
          stopBefore.status === 2,
          `expected stop-global to BLOCK (exit 2) on the un-upgraded ledger, got ${stopBefore.status}`
        );
      }

      const up1 = stepLedger(upCtx);
      assert(up1.status === "upgraded", `expected ledger status 'upgraded', got '${up1.status}' (${up1.message})`);
      assert(
        up1.message === `ledger: upgraded ${upSlug} to true telemetry (row 2)`,
        `expected the upgrade message to name row 2, got '${up1.message}'`
      );
      const linesAfter = fs.readFileSync(upLedger, "utf8").split(/\r?\n/).filter(Boolean);
      assert(linesAfter.length === 3, `expected the ledger row COUNT unchanged at 3, got ${linesAfter.length}`);
      assert(linesAfter[0] === rowsBefore[0], "expected ledger row 1 byte-identical after the upgrade");
      assert(linesAfter[2] === rowsBefore[2], "expected ledger row 3 byte-identical after the upgrade");
      const upgradedRow = JSON.parse(linesAfter[1]);
      assert(upgradedRow.run === upSlug, `expected row 2 to still be '${upSlug}', got '${upgradedRow.run}'`);
      assert(upgradedRow.telemetry === "true", `expected row 2 telemetry 'true', got '${upgradedRow.telemetry}'`);
      assert(
        upgradedRow.trueCostUsd === 1.23,
        `expected row 2 trueCostUsd from the usage file, got ${upgradedRow.trueCostUsd}`
      );

      const up2 = stepLedger(upCtx);
      assert(
        up2.status === "skipped-idempotent",
        `expected a second identical run to be a plain idempotent skip, got '${up2.status}'`
      );
      assert(
        fs.readFileSync(upLedger, "utf8").split(/\r?\n/).filter(Boolean).length === 3,
        "expected the second run to leave the row count at 3"
      );

      if (stopHookPresent) {
        const stopAfter = spawnSync(process.execPath, [stopHook, "--project", upProject], { encoding: "utf8" });
        assert(
          stopAfter.status === 0,
          `expected stop-global to PASS (exit 0) after the upgrade, got ${stopAfter.status}: ${stopAfter.stderr}`
        );
      }

      // A run with NO true telemetry never rewrites an existing row and
      // never appends a duplicate, even when that row violates the cutoff.
      const noTelLedger = path.join(tmpBase, "no-telemetry-project", ".claude", "pipeline", "cost-ledger.jsonl");
      fs.mkdirSync(path.dirname(noTelLedger), { recursive: true });
      const noTelBefore = rowsBefore.join("\n") + "\n";
      fs.writeFileSync(noTelLedger, noTelBefore, "utf8");
      const up3 = stepLedger({ ...upCtx, flags: { ledger: noTelLedger }, usageResult: null });
      assert(up3.status === "skipped-idempotent", `expected a run with no true telemetry to skip, got '${up3.status}'`);
      assert(
        fs.readFileSync(noTelLedger, "utf8") === noTelBefore,
        "expected a run with no true telemetry to leave the ledger byte-identical"
      );
    }

    // --- B19: collectTouchedPaths/stepCodeMap scope the TODO scan to the
    // run's actual touched files -- manifest entries filtered to
    // status planned|modified|added|untracked (any non-deleted status) under
    // apps|packages|scripts/ -- instead of every dirty path in the tree
    // (handoff cards, .gitignore, and the code-map's own files are excluded
    // by directory; only `deleted` rows are excluded by status, since a
    // deleted file needs no code-map entry) ---------------------------------
    {
      const scopeProject = path.join(tmpBase, "codemap-scope-project");
      const scopeCodeMapDir = path.join(scopeProject, ".claude", "code-map");
      fs.mkdirSync(scopeCodeMapDir, { recursive: true });
      fs.writeFileSync(path.join(scopeCodeMapDir, "area.md"), "# Area\n\nNo touched paths mentioned here.\n", "utf8");

      const IN_SCOPE = [
        "apps/api/src/foo.service.ts", // modified
        "packages/pricing/src/bar.ts", // planned
        "scripts/baz.mjs", // modified
        "apps/web/app/page.tsx", // untracked -- a brand-new file is the most likely to need a NEW code-map TODO
        "apps/mobile/src/new-screen.tsx", // added -- same reasoning as untracked
      ];
      const OUT_OF_SCOPE = [
        ".claude/handoffs/2026-09-12-x.md", // right-ish status, wrong directory
        ".gitignore", // wrong directory
        "apps/api/src/deleted.service.ts", // right directory, wrong status (deleted) -- the one status that stays excluded
      ];
      const mixedManifestResult = {
        manifest: {
          files: [
            { path: IN_SCOPE[0], status: "modified" },
            { path: IN_SCOPE[1], status: "planned" },
            { path: IN_SCOPE[2], status: "modified" },
            { path: IN_SCOPE[3], status: "untracked" },
            { path: IN_SCOPE[4], status: "added" },
            { path: OUT_OF_SCOPE[0], status: "modified" },
            { path: OUT_OF_SCOPE[1], status: "modified" },
            { path: OUT_OF_SCOPE[2], status: "deleted" },
          ],
        },
      };

      const scopedTouched = collectTouchedPaths(mixedManifestResult);
      assert(
        Array.isArray(scopedTouched) && new Set(scopedTouched).size === IN_SCOPE.length,
        `expected exactly ${IN_SCOPE.length} in-scope touched paths from the mixed manifest, got ${JSON.stringify(scopedTouched)}`
      );
      for (const p of IN_SCOPE) {
        assert(scopedTouched.includes(p), `expected in-scope path '${p}' in collectTouchedPaths result`);
      }
      for (const p of OUT_OF_SCOPE) {
        assert(!scopedTouched.includes(p), `expected out-of-scope path '${p}' NOT in collectTouchedPaths result`);
      }

      const scopedCodeMap = stepCodeMap({ project: scopeProject, result: mixedManifestResult });
      assert(
        scopedCodeMap.missing.length === IN_SCOPE.length,
        `expected exactly ${IN_SCOPE.length} missing code-map entries for the mixed manifest, got ${scopedCodeMap.missing.length}: ${JSON.stringify(scopedCodeMap.missing)}`
      );
      assert(!scopedCodeMap.missing.includes(OUT_OF_SCOPE[1]), "expected '.gitignore' NOT flagged as a missing code-map entry");
      assert(
        !scopedCodeMap.missing.includes(OUT_OF_SCOPE[0]),
        "expected the handoff card NOT flagged as a missing code-map entry"
      );
    }

    // --- B19: result.tasks[].files (new task-loop shape, A14) takes
    // priority over manifest.files entirely, flattened + deduped across
    // tasks; not exercisable against any real result.json today, so this is
    // a synthetic fixture -----------------------------------------------
    {
      const tasksResult = {
        tasks: [
          { id: "T1", files: ["apps/x.ts"] },
          { id: "T2", files: ["packages/y.ts", "apps/x.ts"] },
        ],
        manifest: {
          files: [{ path: "apps/should-be-ignored.ts", status: "modified" }],
        },
      };
      const taskTouched = collectTouchedPaths(tasksResult);
      assert(Array.isArray(taskTouched), "expected collectTouchedPaths to return an array for the tasks[] shape");
      const taskTouchedSet = new Set(taskTouched);
      assert(
        taskTouchedSet.size === 2 && taskTouchedSet.has("apps/x.ts") && taskTouchedSet.has("packages/y.ts"),
        `expected exactly {'apps/x.ts','packages/y.ts'} from tasks[].files (deduped), got ${JSON.stringify(taskTouched)}`
      );
      assert(
        !taskTouched.includes("apps/should-be-ignored.ts"),
        "expected manifest.files to be ignored entirely when result.tasks[] is present and usable"
      );
    }

    // --- C6 (Task 42): a result.json carrying approach:'dev-pipeline',
    // profile:'lean' lands on the ledger row with those EXACT values via the
    // real `append` code path (stepLedger -> pipeline-ledger.mjs append,
    // never append-manual), with NO --approach/--profile flag anywhere in
    // stepLedger's args (confirmed by reading it: the append invocation
    // passes only --run/--project/--ended/--started/--branch/--pr/--usage/
    // --usage-override-reason/--telemetry -- never --approach or --profile).
    // pipeline-ledger.mjs's own buildRow reads
    // profile: pickField(result.profile, meta.profile) and
    // approach: pickField(result.approach, meta.approach), and pickField
    // prefers a non-empty resultVal over metaVal -- so with no CLI flag,
    // meta.approach/meta.profile are undefined and result.json's own fields
    // flow straight through untouched. This proves closeout.mjs needed ZERO
    // production-code change once pipeline.js's A14 payload sets
    // result.approach/result.profile: the pass-through is automatic. ------
    {
      const apSlug = "selftest-approach-profile";
      const apRunDir = path.join(project, ".claude", "pipeline", apSlug);
      fs.mkdirSync(apRunDir, { recursive: true });
      const apResult = { ...loadJsonSafe(fixtureSrc), approach: "dev-pipeline", profile: "lean" };
      fs.writeFileSync(path.join(apRunDir, "result.json"), JSON.stringify(apResult, null, 2) + "\n", "utf8");

      const apCtx = {
        flags: { ledger: ledgerPath },
        project,
        runDir: apRunDir,
        slug: apSlug,
        dry: false,
        startedAt: "2026-09-12T00:00:00.000Z",
        endedAt: "2026-09-12T01:00:00.000Z",
        branch: null,
        pr: null,
        usageResult: null,
        mode: "feature",
        scale: "small",
        result: {},
      };
      const apLedgerResult = stepLedger(apCtx);
      assert(
        apLedgerResult.status === "appended",
        `expected the approach/profile fixture's ledger append to succeed, got '${apLedgerResult.status}' (${apLedgerResult.message})`
      );
      const apLedgerRows = fs
        .readFileSync(apLedgerResult.ledgerPath, "utf8")
        .split(/\r?\n/)
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      const apRow = apLedgerRows.find((r) => r.run === apSlug);
      assert(apRow, "expected a ledger row for the approach/profile fixture run");
      assert(
        apRow.approach === "dev-pipeline",
        `expected ledger row approach 'dev-pipeline' via result.json alone (no --approach flag passed), got '${JSON.stringify(apRow.approach)}'`
      );
      assert(
        apRow.profile === "lean",
        `expected ledger row profile 'lean' via result.json alone (no --profile flag passed), got '${JSON.stringify(apRow.profile)}'`
      );
    }

    // --- proof the real RUN-LOG.md / real routeflow ledger were never
    // touched by any of the runs above (this is what the 2026-09-10 leak
    // would have failed) ---
    const afterRunLog = statSnapshot(REAL_RUN_LOG_PATH);
    const afterRouteflowLedger = statSnapshot(REAL_ROUTEFLOW_LEDGER_PATH);
    assert(
      JSON.stringify(beforeRunLog) === JSON.stringify(afterRunLog),
      `selftest must leave the real RUN-LOG.md untouched (before=${JSON.stringify(beforeRunLog)} after=${JSON.stringify(afterRunLog)})`
    );
    assert(
      JSON.stringify(beforeRouteflowLedger) === JSON.stringify(afterRouteflowLedger),
      `selftest must leave the real routeflow ledger untouched (before=${JSON.stringify(beforeRouteflowLedger)} after=${JSON.stringify(afterRouteflowLedger)})`
    );

    console.log("SELFTEST PASSED");
  } catch (err) {
    ok = false;
    console.error("SELFTEST FAILED: " + err.message);
    console.error(err.stack);
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    delete process.env.CLOSEOUT_SELFTEST;
  }
  process.exitCode = ok ? 0 : 1;
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === "selftest") {
    runSelftest();
    return;
  }
  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") {
    printHelp();
    process.exitCode = argv.length === 0 ? 1 : 0;
    return;
  }
  try {
    runMain(argv);
  } catch (err) {
    if (err instanceof CloseoutError) {
      process.stderr.write(err.message + "\n");
      process.exitCode = err.code || 2;
      return;
    }
    throw err;
  }
}

main();
