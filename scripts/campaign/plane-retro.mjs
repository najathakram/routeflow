#!/usr/bin/env node
// plane-retro.mjs — the learning step (build-plan.md WP4, .claude/pipeline/
// 2026-09-12-plane-learning/spec.md R4). Reads `local-assets/plane/
// runs.jsonl` (every plane-*.mjs tool's own appendRun() telemetry, R2),
// windows it by `--days` (default 14), computes per-tool metrics, evaluates
// the six fixed rules (spec.md's hard-line rule shape) against
// `scripts/campaign/plane-knobs.json`, and — only with `--apply` — writes
// knob changes + a history entry. NEVER calls Plane: no PLANE_API_KEY read,
// no createClient(), no network of any kind. Every knob it can move is
// `autoTune: true`; `applyManualBudgetPerDay` (autoTune:false) never
// changes here, only ever by a human editing the tracked file directly.
//
// A knob moves at most once per retro window (spec.md hard line): before
// writing, this checks `history` for an entry on the same knob with `ts`
// inside the `--days` window measured from THIS run's clock — a second
// `--apply` against an unchanged ledger sees that entry and reports
// "held (moved this window)" instead of moving the knob again.
//
// Output: `<outDir>/<date>.md` (+ `<date>.json`) where outDir is `--out
// <dir>`, else `PLANE_RETRO_OUT` (gated on PLANE_SYNC_SELF_TEST=1, same
// test-only-override pattern as PLANE_KNOBS_PATH/PLANE_RUNS_PATH/
// PLANE_DENYLIST_PATH elsewhere in this family), else
// `local-assets/plane/retro/`. Candidate lessons (never auto-filed into
// `.claude/lessons`) append to `lessons-candidates.md` in the PARENT of
// outDir (i.e. `local-assets/plane/` by default, or `--out`'s parent under
// a test override) — one line per hotspot, per spec.md's literal line shape.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { appendRun, gitEnv, loadKnobs, repoRoot, runsPath } from "./plane-client.mjs";
import { currentBranch } from "./plane-sync.mjs";

// Literal spec.md R1 defaults — the "step back toward the default" rule
// (sync-settle-back) needs a fixed baseline independent of whatever the
// tracked knobs file currently holds (that file IS the thing being moved).
const DEFAULT_KNOB_VALUES = {
  clientRatePerMin: 50,
  triageGetBudget: 16,
  gate5MaxWrites: 25,
  syncMaxWrites: 250,
  applyManualBudgetPerDay: 20,
  staleStartedDays: 7,
};

const DAY_MS = 24 * 60 * 60 * 1000;
const round2 = (n) => Math.round(n * 100) / 100;

// ── knobs file: raw read/write (plane-client's resolveKnobsPath() is not
// exported — replicated here verbatim, per the same PLANE_SYNC_SELF_TEST=1-
// gated override pattern as every other test-only path in this family) ────
function knobsFilePath() {
  return process.env.PLANE_SYNC_SELF_TEST === "1" && process.env.PLANE_KNOBS_PATH
    ? process.env.PLANE_KNOBS_PATH
    : join(repoRoot(), "scripts", "campaign", "plane-knobs.json");
}

function readKnobsFileRaw() {
  return JSON.parse(readFileSync(knobsFilePath(), "utf8"));
}

function writeKnobsFileRaw(obj) {
  writeFileSync(knobsFilePath(), `${JSON.stringify(obj, null, 2)}\n`);
}

// ── output paths ─────────────────────────────────────────────────────────
function resolveOutDir(argv) {
  const outIdx = argv.indexOf("--out");
  if (outIdx !== -1 && argv[outIdx + 1]) return argv[outIdx + 1];
  if (process.env.PLANE_SYNC_SELF_TEST === "1" && process.env.PLANE_RETRO_OUT) {
    return process.env.PLANE_RETRO_OUT;
  }
  return join(repoRoot(), "local-assets", "plane", "retro");
}

// Default (no --out): parent of the retro dir, i.e. local-assets/plane/ —
// a sibling of the retro/ subdir, per spec.md R4's own example path.
// With an explicit --out <dir>: UNDER that dir, alongside the dated report
// — an explicit --out names one flat output location for everything this
// run produces, and a test fixture pointed at a throwaway --out dir has no
// access to (and no reason to assume anything about) that dir's parent.
function lessonsCandidatesPath(outDir, outFlagGiven) {
  return outFlagGiven
    ? join(outDir, "lessons-candidates.md")
    : join(dirname(outDir), "lessons-candidates.md");
}

// ── runs.jsonl ───────────────────────────────────────────────────────────
// Skips (and counts) any line that fails to parse or carries no usable
// `ts` — never throws on a malformed ledger line, matching every other
// reader in this family (writesToday()'s "malformed line skipped, never a
// thrown crash").
function readRuns(days, now) {
  const path = runsPath();
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { runs: [], unparsable: 0 };
  }
  const cutoff = now - days * DAY_MS;
  const runs = [];
  let unparsable = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      unparsable++;
      continue;
    }
    const t = Date.parse(rec?.ts);
    if (!Number.isFinite(t)) {
      unparsable++;
      continue;
    }
    if (t < cutoff || t > now) continue;
    runs.push({ ...rec, _t: t });
  }
  runs.sort((a, b) => a._t - b._t);
  return { runs, unparsable };
}

function byTool(runs) {
  const map = new Map();
  for (const r of runs) {
    const list = map.get(r.tool) ?? [];
    list.push(r);
    map.set(r.tool, list);
  }
  return map;
}

function share(runs, pred) {
  if (!runs.length) return 0;
  return runs.filter(pred).length / runs.length;
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function errorClass(rec) {
  if (!rec.error) return null;
  const idx = String(rec.error).indexOf(":");
  return idx === -1 ? rec.error : rec.error.slice(0, idx);
}

// ── per-tool metrics (R4's named sections) ──────────────────────────────
function metricsForTool(tool, runs) {
  const byErrorClass = {};
  for (const r of runs) {
    if (!r.error) continue;
    const cls = errorClass(r) ?? "unknown";
    byErrorClass[cls] = (byErrorClass[cls] ?? 0) + 1;
  }
  const durations = runs.map((r) => r.durationMs).filter((n) => Number.isFinite(n));
  const gets = runs.map((r) => r.gets).filter((n) => Number.isFinite(n));
  const forbiddenByPattern = {};
  for (const r of runs) {
    const bp = r.forbidden?.byPattern;
    if (!bp) continue;
    for (const [k, v] of Object.entries(bp))
      forbiddenByPattern[k] = (forbiddenByPattern[k] ?? 0) + v;
  }
  const sleeps = runs.map((r) => r.rateLimitSleeps ?? 0);
  const meanRateLimitSleeps = sleeps.length
    ? round2(sleeps.reduce((a, b) => a + b, 0) / sleeps.length)
    : 0;
  const driftTrend = runs
    .filter((r) => r.sync?.drift !== undefined || r.triage?.drift !== undefined)
    .slice(-10)
    .map((r) => (r.sync ? r.sync.drift : r.triage.drift));
  return {
    runs: runs.length,
    failureRate: round2(share(runs, (r) => !!r.error)),
    byErrorClass,
    p50DurationMs: percentile(durations, 50),
    p95DurationMs: percentile(durations, 95),
    p50Gets: percentile(gets, 50),
    p95Gets: percentile(gets, 95),
    deferredRate: round2(share(runs, (r) => (r.deferred ?? 0) > 0)),
    forbiddenByPattern,
    meanRateLimitSleeps,
    driftTrend,
  };
}

// Global, not per-tool (R4 names it as its own section) — always rendered
// even in a window with zero plane-intake runs, so the report's section
// list is stable regardless of which tools happened to run.
function intakeVolume(runs) {
  return runs
    .filter((r) => r.tool === "plane-intake")
    .reduce(
      (acc, r) => {
        const i = r.intake ?? {};
        acc.listed += i.listed ?? 0;
        acc.pending += i.pending ?? 0;
        acc.filed += i.filed ?? 0;
        acc.relinked += i.relinked ?? 0;
        return acc;
      },
      { listed: 0, pending: 0, filed: 0, relinked: 0 },
    );
}

// Max writes on any single UTC day, across every tool other than
// plane-sync (informational — feeds no autoTune rule; applyManualBudgetPerDay
// is autoTune:false and only ever moves by hand).
function manualBudgetUsage(runs) {
  const perDay = new Map();
  for (const r of runs) {
    if (r.tool === "plane-sync") continue;
    const day = new Date(r._t).toISOString().slice(0, 10);
    perDay.set(day, (perDay.get(day) ?? 0) + (r.writes ?? 0));
  }
  let max = 0;
  for (const v of perDay.values()) if (v > max) max = v;
  return max;
}

// ── "landing without sync" (R4/R6) ──────────────────────────────────────
// m5(a) (fix-round ruling): a feature-branch worktree's own HEAD is a poor
// proxy for "did a landing happen without a sync" — it only sees commits on
// THIS branch, not what actually reached the shared integration line. Prefer
// `origin/master` (what everyone else's syncs are actually measured against)
// whenever the remote-tracking ref exists at all; a repo with no such ref
// (a throwaway fixture, a shallow clone with no origin) falls back to HEAD,
// same as before.
function refExists(root, ref) {
  const res = spawnSync("git", ["rev-parse", "--verify", "--quiet", ref], {
    cwd: root,
    env: gitEnv(),
    encoding: "utf8",
  });
  return Boolean(res && !res.error && res.status === 0);
}

function commitsTouchingStatus(days, now, root) {
  const since = new Date(now - days * DAY_MS).toISOString();
  const ref = refExists(root, "origin/master") ? "origin/master" : "HEAD";
  const res = spawnSync(
    "git",
    ["log", ref, `--since=${since}`, "--format=%H|%cI", "--", ".claude/campaign/status"],
    { cwd: root, env: gitEnv(), encoding: "utf8" },
  );
  if (!res || res.status !== 0 || !res.stdout) return [];
  return res.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [sha, ts] = line.split("|");
      return { sha, ts, t: Date.parse(ts) };
    })
    .filter((c) => Number.isFinite(c.t));
}

function landingWithoutSyncIncidents(commits, syncRuns) {
  const sixH = 6 * 60 * 60 * 1000;
  return commits.filter((c) => !syncRuns.some((r) => r._t >= c.t && r._t <= c.t + sixH));
}

// ── the six rules (spec.md hard-line shape) ─────────────────────────────
// `tool: "*"` = evaluated over every run in the window regardless of tool
// (the shared client's rate ceiling and the denylist apply across every
// plane-*.mjs invocation, not one tool alone).
const RULES = [
  {
    id: "sync-deferred",
    tool: "plane-sync",
    minRuns: 10,
    metricName: "deferredRate",
    metric: (runs) => share(runs, (r) => (r.deferred ?? 0) > 0),
    when: (v) => v >= 0.3,
    propose: (runs, knobs) => {
      const proposals = [{ knob: "syncMaxWrites", to: knobs.syncMaxWrites.value + 50 }];
      // Gate 5 is the only caller that ever passes --budget-ms (spec.md R14
      // note in plane-sync.mjs) — a deferred run carrying that flag is a
      // Gate 5 run, so its own write ceiling gets the companion bump.
      const gate5Deferred = runs.some(
        (r) => (r.deferred ?? 0) > 0 && Array.isArray(r.flags) && r.flags.includes("--budget-ms"),
      );
      if (gate5Deferred)
        proposals.push({ knob: "gate5MaxWrites", to: knobs.gate5MaxWrites.value + 10 });
      return proposals;
    },
  },
  {
    id: "rate-limit-sleeps",
    tool: "*",
    minRuns: 10,
    metricName: "rateLimitSleepsMean",
    metric: (runs) => runs.reduce((a, r) => a + (r.rateLimitSleeps ?? 0), 0) / runs.length,
    when: (v) => v >= 2,
    propose: (runs, knobs) => [{ knob: "clientRatePerMin", to: knobs.clientRatePerMin.value - 10 }],
  },
  {
    id: "triage-partial",
    tool: "plane-triage",
    minRuns: 10,
    metricName: "partialRuns",
    metric: (runs) => runs.filter((r) => r.triage?.partial === true).length,
    when: (v) => v >= 2,
    propose: (runs, knobs) => [{ knob: "triageGetBudget", to: knobs.triageGetBudget.value + 8 }],
  },
  {
    id: "sync-settle-back",
    tool: "plane-sync",
    minRuns: 20,
    metricName: "quietRunShare",
    // "20 runs" reads as the latest 20, not the whole (possibly larger)
    // window — a single noisy run 19 runs ago should still block settling.
    metric: (runs) =>
      share(runs.slice(-20), (r) => (r.deferred ?? 0) > 0 || (r.rateLimitSleeps ?? 0) > 0),
    when: (v) => v === 0,
    propose: (runs, knobs) => {
      const proposals = [];
      if (knobs.syncMaxWrites.value > DEFAULT_KNOB_VALUES.syncMaxWrites) {
        proposals.push({
          knob: "syncMaxWrites",
          to: Math.max(DEFAULT_KNOB_VALUES.syncMaxWrites, knobs.syncMaxWrites.value - 50),
        });
      }
      if (knobs.clientRatePerMin.value < DEFAULT_KNOB_VALUES.clientRatePerMin) {
        proposals.push({
          knob: "clientRatePerMin",
          to: Math.min(DEFAULT_KNOB_VALUES.clientRatePerMin, knobs.clientRatePerMin.value + 10),
        });
      }
      return proposals;
    },
  },
  {
    id: "stale-started-empty",
    tool: "plane-triage",
    minRuns: 10,
    metricName: "staleStartedEmptyStreak",
    // "10 consecutive briefs" — the latest 10 triage runs in the window,
    // every one reporting zero stale-started items.
    metric: (runs) => {
      const last10 = runs.slice(-10);
      return last10.length === 10 && last10.every((r) => (r.triage?.staleStarted ?? 0) === 0)
        ? 1
        : 0;
    },
    when: (v) => v === 1,
    propose: (runs, knobs) => [{ knob: "staleStartedDays", to: knobs.staleStartedDays.value + 2 }],
  },
  {
    id: "forbidden-hotspot",
    tool: "*",
    minRuns: 10,
    metricName: "forbiddenHitsByPattern",
    lessonOnly: true,
    metric: (runs) => {
      const byPattern = {};
      for (const r of runs) {
        const bp = r.forbidden?.byPattern;
        if (!bp) continue;
        for (const [k, v] of Object.entries(bp)) byPattern[k] = (byPattern[k] ?? 0) + v;
      }
      return byPattern;
    },
    when: (v) => Object.values(v).some((n) => n >= 3),
  },
];

function evaluateRule(rule, runsByTool, allRuns, knobs) {
  const runs = rule.tool === "*" ? allRuns : (runsByTool.get(rule.tool) ?? []);
  if (runs.length < rule.minRuns) {
    return {
      id: rule.id,
      tool: rule.tool,
      runsConsidered: runs.length,
      status: "insufficient evidence",
    };
  }
  const value = rule.metric(runs);
  if (!rule.when(value)) {
    return {
      id: rule.id,
      tool: rule.tool,
      runsConsidered: runs.length,
      status: "no-trigger",
      metric: rule.metricName,
      value: typeof value === "number" ? round2(value) : value,
    };
  }
  if (rule.lessonOnly) {
    return {
      id: rule.id,
      tool: rule.tool,
      runsConsidered: runs.length,
      status: "candidate-lesson",
      metric: rule.metricName,
      value,
    };
  }
  const evidence = {
    runs: runs.length,
    metric: rule.metricName,
    value: typeof value === "number" ? round2(value) : value,
  };
  const proposals = (rule.propose(runs, knobs) ?? []).filter(Boolean).map((p) => ({
    knob: p.knob,
    from: knobs[p.knob]?.value,
    to: p.to,
    rule: rule.id,
    evidence,
  }));
  return {
    id: rule.id,
    tool: rule.tool,
    runsConsidered: runs.length,
    status: proposals.length ? "proposed" : "no-op",
    proposals,
  };
}

function withinWindow(ts, days, now) {
  const t = Date.parse(ts);
  return Number.isFinite(t) && t <= now && now - t <= days * DAY_MS;
}

// clamp -> autoTune -> held-this-window, in that order (spec.md hard line,
// verbatim precedence). With `mutate: true` (only when --apply was passed
// AND the branch gate below clears) a proposal that clears every gate
// actually writes `knobsFile.knobs[knob].value` and pushes a history entry,
// in place; with `mutate: false` (the default/preview run, OR an --apply run
// blocked by the branch gate) NOTHING about `knobsFile` is touched — the run
// only reports what --apply *would* do, so neither a plain `plane-retro`
// invocation nor a branch-blocked `--apply` can ever be the reason a
// concurrent `--apply` run's "moved once per window" check sees a phantom
// history entry.
//
// m5(b) (fix-round ruling): `--apply` on a feature branch must never write
// the shared, tracked knobs file out from under other worktrees/sessions —
// same hazard class as plane-sync.mjs's R14 branch guard (isWriteAllowedBranch/
// --allow-branch). `blockedBranch` (the current branch name, or null when the
// branch is master/main or `--allow-branch` was passed) distinguishes this
// from an ordinary preview: every proposal reports `proposed-only (branch
// <name>)` instead of the generic `proposed-only (preview)`.
function resolveProposals(proposals, knobsFile, days, now, { mutate, blockedBranch = null }) {
  const results = [];
  let applied = 0;
  let proposedOnly = 0;
  for (const p of proposals) {
    const def = knobsFile.knobs[p.knob];
    if (!def) {
      results.push({ ...p, status: "proposed-only (unknown knob)" });
      proposedOnly++;
      continue;
    }
    if (!def.autoTune) {
      results.push({ ...p, status: "proposed-only (manual knob)" });
      proposedOnly++;
      continue;
    }
    const clamped = Math.min(def.max, Math.max(def.min, p.to));
    if (clamped !== p.to) {
      results.push({ ...p, to: clamped, status: "proposed-only (out of bounds)" });
      proposedOnly++;
      continue;
    }
    const heldByHistory = (knobsFile.history ?? []).some(
      (h) => h.knob === p.knob && withinWindow(h.ts, days, now),
    );
    if (heldByHistory) {
      results.push({ ...p, to: clamped, status: "held (moved this window)" });
      proposedOnly++;
      continue;
    }
    if (!mutate) {
      const status = blockedBranch
        ? `proposed-only (branch ${blockedBranch})`
        : "proposed-only (preview)";
      results.push({ ...p, to: clamped, status });
      proposedOnly++;
      continue;
    }
    def.value = clamped;
    knobsFile.history = knobsFile.history ?? [];
    knobsFile.history.push({
      ts: new Date(now).toISOString(),
      knob: p.knob,
      from: p.from,
      to: clamped,
      reason: p.rule,
      evidence: p.evidence,
      by: "plane-retro",
    });
    results.push({ ...p, to: clamped, status: "applied" });
    applied++;
  }
  return { results, applied, proposedOnly };
}

// ── candidate lessons (R4: "never auto-filed") ──────────────────────────
function buildCandidateLessons(ruleResults, dateStr) {
  const lines = [];
  for (const r of ruleResults) {
    if (r.status !== "candidate-lesson") continue;
    for (const [pattern, count] of Object.entries(r.value ?? {})) {
      if (count < 3) continue;
      lines.push(
        `- ${dateStr} · forbidden pattern \`${pattern}\` (${r.id}) · ${count} hits in the window · ` +
          `candidate for .claude/lessons (never auto-filed)`,
      );
    }
  }
  return lines;
}

function appendCandidateLessons(path, lines) {
  if (!lines.length) return;
  mkdirSync(dirname(path), { recursive: true });
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const sep = existing && !existing.endsWith("\n") ? "\n" : "";
  writeFileSync(path, existing + sep + lines.join("\n") + "\n");
}

// ── report rendering ─────────────────────────────────────────────────────
function renderReport(data) {
  const lines = [];
  lines.push(`# Plane retro — ${data.date}`);
  lines.push("");
  lines.push(
    `Window: last ${data.windowDays} day(s) · ${data.runsConsidered} run(s) considered · ` +
      `${data.unparsableLines} unparsable line(s) skipped.`,
  );
  lines.push("");
  lines.push("## Per-tool metrics");
  for (const [tool, m] of Object.entries(data.tools)) {
    lines.push("");
    lines.push(`### ${tool}`);
    lines.push(`- runs: ${m.runs}`);
    lines.push(`- failure rate: ${m.failureRate} (by class: ${JSON.stringify(m.byErrorClass)})`);
    lines.push(`- p50/p95 durationMs: ${m.p50DurationMs} / ${m.p95DurationMs}`);
    lines.push(`- p50/p95 gets: ${m.p50Gets} / ${m.p95Gets}`);
    lines.push(`- deferred rate: ${m.deferredRate}`);
    lines.push(`- forbidden hits by pattern: ${JSON.stringify(m.forbiddenByPattern)}`);
    lines.push(`- rate-limit sleeps per run (mean): ${m.meanRateLimitSleeps}`);
    lines.push(`- drift trend (last 10): ${JSON.stringify(m.driftTrend)}`);
  }
  lines.push("");
  lines.push("## Intake volume");
  lines.push(
    `- listed ${data.intakeVolume.listed}, pending ${data.intakeVolume.pending}, ` +
      `filed ${data.intakeVolume.filed}, relinked ${data.intakeVolume.relinked}`,
  );
  lines.push("");
  lines.push("## Manual-budget usage");
  lines.push(`- max writes/UTC day (tools other than plane-sync): ${data.manualBudgetUsage}`);
  lines.push("");
  lines.push("## Landing without sync");
  if (!data.landingWithoutSync.length) {
    lines.push("- none in window");
  } else {
    for (const c of data.landingWithoutSync) lines.push(`- ${c.sha.slice(0, 8)} at ${c.ts}`);
  }
  lines.push("");
  lines.push("## Rules");
  for (const r of data.rules) {
    const detail =
      r.status === "insufficient evidence"
        ? `insufficient evidence (${r.runsConsidered} run(s))`
        : r.status === "no-trigger"
          ? `no-trigger (${r.metric}=${JSON.stringify(r.value)})`
          : r.status;
    lines.push(`- ${r.id} [${r.tool}]: ${detail}`);
  }
  lines.push("");
  lines.push("## Proposals");
  if (!data.proposals.length) {
    lines.push("- none");
  } else {
    for (const p of data.proposals) {
      lines.push(
        `- ${p.knob} ${p.from} -> ${p.to} (${p.rule}; ${p.status}; evidence: ${JSON.stringify(p.evidence)})`,
      );
    }
  }
  lines.push("");
  lines.push("## Candidate lessons");
  if (!data.candidateLessons.length) {
    lines.push("- none");
  } else {
    lines.push(...data.candidateLessons);
  }
  if (data.applySummary) {
    lines.push("");
    lines.push(
      `applied ${data.applySummary.applied} / proposed-only ${data.applySummary.proposedOnly}`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

// ── CLI ──────────────────────────────────────────────────────────────────
const USAGE =
  "Usage: plane-retro.mjs [--days <n>] [--apply] [--allow-branch] [--json] [--out <dir>] [--help]";
const KNOWN_FLAGS = new Set(["--days", "--apply", "--allow-branch", "--json", "--out", "--help"]);

// Same shape as plane-sync.mjs's isWriteAllowedBranch — replicated rather
// than imported: that file belongs to a different owner in this fix round
// (never touched here), and the check is a one-line literal with nothing to
// share beyond the string constants themselves.
function isWriteAllowedBranch(branch) {
  return branch === "master" || branch === "main";
}

async function main() {
  const argv = process.argv.slice(2);

  // Same discipline as every other plane-*.mjs tool (Landmine 3/R13/T15):
  // --help/-h and an unknown flag are handled before anything else runs —
  // no telemetry write for either exit.
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${USAGE}\n`);
    process.exitCode = 0;
    return;
  }
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === "--days" || tok === "--out") {
      i++;
      continue;
    }
    if (!KNOWN_FLAGS.has(tok)) {
      process.stderr.write(`${USAGE}\n`);
      process.exitCode = 2;
      return;
    }
  }

  const started = Date.now();
  const rec = { tool: "plane-retro", flags: argv, branch: currentBranch() };
  let retro = { proposals: 0, applied: 0 };

  try {
    // R1: loaded before any file activity, same as every other tool — a
    // caller needing "knobs invalid: <name>" sees it before anything else.
    loadKnobs();

    let days = 14;
    const daysIdx = argv.indexOf("--days");
    if (daysIdx !== -1) {
      const raw = Number(argv[daysIdx + 1]);
      if (Number.isFinite(raw) && raw > 0) days = raw;
      else process.stderr.write(`Plane retro warn: ignoring --days "${argv[daysIdx + 1] ?? ""}"\n`);
    }
    const doApply = argv.includes("--apply");
    const allowBranchFlag = argv.includes("--allow-branch");
    const branchAllowed = isWriteAllowedBranch(rec.branch) || allowBranchFlag;
    const mutate = doApply && branchAllowed;
    const blockedBranch = doApply && !branchAllowed ? rec.branch : null;
    const asJson = argv.includes("--json");
    const outFlagGiven = argv.includes("--out");
    const outDir = resolveOutDir(argv);
    const lessonsPath = lessonsCandidatesPath(outDir, outFlagGiven);
    const root = repoRoot();

    const { runs, unparsable } = readRuns(days, started);
    const runsByTool = byTool(runs);

    const tools = {};
    for (const [tool, toolRuns] of runsByTool) tools[tool] = metricsForTool(tool, toolRuns);

    const commits = commitsTouchingStatus(days, started, root);
    const landingWithoutSync = landingWithoutSyncIncidents(
      commits,
      runsByTool.get("plane-sync") ?? [],
    );

    // Rules are evaluated against the CURRENT on-disk knobs (raw copy, kept
    // mutable so resolveProposals() can apply in place before we decide
    // whether to persist it).
    const knobsFile = readKnobsFileRaw();
    const ruleResults = RULES.map((rule) => evaluateRule(rule, runsByTool, runs, knobsFile.knobs));
    const flatProposals = ruleResults.flatMap((r) => r.proposals ?? []);

    const dateStr = new Date(started).toISOString().slice(0, 10);
    // mutate: doApply AND the branch gate clears (m5(b)) — neither a plain
    // (preview) run nor a branch-blocked --apply ever touches knobsFile, so
    // neither can write a phantom history entry or move a value nobody
    // asked to move (from this branch, right now).
    const {
      results: resolvedProposals,
      applied,
      proposedOnly,
    } = resolveProposals(flatProposals, knobsFile, days, started, { mutate, blockedBranch });

    // Only rewrite the tracked file when something actually moved — an
    // --apply run whose every proposal was held/out-of-bounds/manual/
    // branch-blocked must leave the file byte-for-byte unchanged
    // (T4-beyond-max, and m5(b)'s own "file unchanged" oracle).
    if (mutate && applied > 0) {
      writeKnobsFileRaw(knobsFile);
    }

    const candidateLessons = buildCandidateLessons(ruleResults, dateStr);
    appendCandidateLessons(lessonsPath, candidateLessons);

    const reportData = {
      date: dateStr,
      generatedAt: new Date(started).toISOString(),
      windowDays: days,
      runsConsidered: runs.length,
      unparsableLines: unparsable,
      tools,
      intakeVolume: intakeVolume(runs),
      manualBudgetUsage: manualBudgetUsage(runs),
      landingWithoutSync: landingWithoutSync.map((c) => ({ sha: c.sha, ts: c.ts })),
      rules: ruleResults.map(({ proposals: _p, ...r }) => r),
      proposals: resolvedProposals,
      applied,
      proposedOnly,
      candidateLessons,
      ...(doApply ? { applySummary: { applied, proposedOnly } } : {}),
    };

    mkdirSync(outDir, { recursive: true });
    const mdPath = join(outDir, `${dateStr}.md`);
    const jsonPath = join(outDir, `${dateStr}.json`);
    const reportText = renderReport(reportData);
    writeFileSync(mdPath, reportText);
    writeFileSync(jsonPath, `${JSON.stringify(reportData, null, 2)}\n`);

    if (asJson) {
      process.stdout.write(`${JSON.stringify(reportData, null, 2)}\n`);
      if (doApply) process.stdout.write(`applied ${applied} / proposed-only ${proposedOnly}\n`);
    } else {
      // The full report (not just a "wrote <path>" pointer) goes to stdout
      // too — a plain `npm run plane:retro` run should show its findings
      // (including any "insufficient evidence"/"held"/"proposed-only" rule
      // outcome) without a second `cat` of the file it just wrote.
      process.stdout.write(`${reportText}\n`);
      process.stdout.write(`Plane retro: wrote ${mdPath}\n`);
    }
    process.exitCode = 0;
    retro = { proposals: resolvedProposals.length, applied };
  } catch (err) {
    process.exitCode = 1;
    rec.error = `${err?.name ?? "Error"}: ${String(err?.message ?? err).slice(0, 200)}`;
  } finally {
    appendRun({
      ...rec,
      exit: process.exitCode ?? 0,
      durationMs: Date.now() - started,
      retro,
    });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
