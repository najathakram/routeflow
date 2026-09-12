#!/usr/bin/env node
// session-usage.mjs
//
// True per-model token/cost telemetry for a Claude Code session, read straight
// from the transcript JSONL files under ~/.claude/projects/<enc>/ — the only
// source that actually carries usage{} (Workflow agent() returns none). See
// model-routing/skills plan Part 3 §C2.
//
// No dependencies. Node >= 18. ES module.
//
// Usage:
//   node session-usage.mjs <sessionId | --latest> [--project <abs path>]
//       [--wf <runId> | --wf all] [--agents] [--all]
//       [--idle-gap-ms 600000] [--prices <json>]
//       [--out <file>] [--json] [--claude-home <dir>]
//   node session-usage.mjs selftest
//
// --project        Absolute path of the repo whose session transcripts you
//                   want. This is NOT the ~/.claude/projects/<enc> path --
//                   that is derived from it. When omitted, resolved via
//                   `git -C <cwd> rev-parse --git-common-dir` (its parent is
//                   the MAIN checkout -- from a worktree this is NOT the
//                   worktree's own path, since the session's real transcript
//                   dir lives under the main checkout's encoding), falling
//                   back to process.cwd() only when git is unavailable.
//                   Which resolution fired is logged as a warning.
// --latest         Use the newest-mtime *.jsonl file directly inside the
//                   project's transcript dir (not in subdirectories).
// --wf <runId>     Also aggregate <projectDir>/<sessionId>/subagents/
//                   workflows/wf_<runId>/agent-*.jsonl. --wf all walks every
//                   wf_* directory present.
// --agents         Also aggregate Agent-tool subagent transcripts at
//                   <projectDir>/<sessionId>/subagents/agent-<id>.jsonl (one
//                   level up from the wf_* workflow directories -- these are
//                   Explore/Plan/general-purpose executors used by the light
//                   loop, NOT counted by --wf). Each has a sibling
//                   agent-<id>.meta.json carrying {agentType, description}.
//                   Grouped by agentType in the output's `agents.byType`.
// --all            Alias for `--wf all --agents`.
// --idle-gap-ms    Gaps at or above this are treated as "away from keyboard"
//                   and excluded from activeMs. Default 600000 (10 min).
// --prices <json>  Inline JSON object overriding/extending the price table
//                   parsed from references/MODEL-CARDS.md, keyed by the same
//                   model-id prefixes, e.g.
//                   {"claude-sonnet-5":{"in":2,"out":10,"cacheRead":0.2,
//                     "cacheWrite5m":2.5,"cacheWrite1h":4}}
// --claude-home    Override for the ~/.claude directory root (testing only;
//                   normal use never needs this).
//
// This script only ever reads:
//   - <claudeHome>/projects/<enc>/*.jsonl and .../<sessionId>/subagents/**
//   - skills/model-routing/references/MODEL-CARDS.md (next to this script)
//   - git plumbing (read-only `rev-parse --git-common-dir`), for --project
//     resolution when --project is not given
//   - a temp directory under os.tmpdir() (selftest only)
// and only ever writes:
//   - the --out file, if given
//   - a temp directory under os.tmpdir() (selftest only)

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(__filename);
const MODEL_CARDS_PATH = path.join(SCRIPT_DIR, "..", "references", "MODEL-CARDS.md");

const DEFAULT_IDLE_GAP_MS = 600000; // 10 minutes

class UsageError extends Error {
  constructor(message, code = 2) {
    super(message);
    this.name = "UsageError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function numOrZero(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function fmtMoney(v) {
  return v == null ? "n/a" : `$${v.toFixed(4)}`;
}

function fmtPct(fraction) {
  return fraction == null ? "n/a" : `${(fraction * 100).toFixed(1)}%`;
}

function fmtDuration(ms) {
  if (ms == null || !Number.isFinite(ms)) return "n/a";
  const totalSec = Math.round(Math.abs(ms) / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// Truncates a label list for the text-table "labels" column: full list stays
// in JSON output, but a phase with e.g. 113 unattributed agent ids would
// otherwise print all 113 into one cell.
function truncateLabelsList(labels, max = 5) {
  if (labels.length <= max) return labels.join(", ");
  return labels.slice(0, max).join(", ") + ` (+${labels.length - max} more)`;
}

function truncateText(text, max = 60) {
  if (typeof text !== "string" || text.length <= max) return text ?? "";
  return text.slice(0, max - 1) + "…";
}

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

// Project-dir encoding, verified against the real directories under
// ~/.claude/projects/ (e.g. C:\ClaudeCode\routeflow -> C--ClaudeCode-routeflow).
function encodeProjectDir(absPath) {
  return absPath.replace(/[^a-zA-Z0-9]/g, "-");
}

function claudeHomeDir(flags) {
  return typeof flags["claude-home"] === "string"
    ? path.resolve(flags["claude-home"])
    : path.join(os.homedir(), ".claude");
}

// P2(a) 2026-09-11: resolves the MAIN checkout root via git plumbing -- the
// parent of `git rev-parse --git-common-dir` run at <cwd>. git-common-dir
// always points at the one real .git directory shared by every worktree, so
// from a worktree this resolves to the main checkout, not the worktree's own
// path -- which is what carries the real ~/.claude/projects/<enc> transcript
// dir (the session ran there, not in the worktree). Returns null (never
// throws) when git is unavailable or <cwd> is not inside a git repo.
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

// `cwdOverride` exists purely for selftest -- normal use always resolves
// against the real process.cwd().
function projectTranscriptDir(flags, cwdOverride) {
  let projectAbs;
  let resolutionNote;
  if (typeof flags.project === "string") {
    projectAbs = path.resolve(flags.project);
    resolutionNote = `project: resolved via --project -> ${projectAbs}`;
  } else {
    const cwd = cwdOverride || process.cwd();
    const viaGit = resolveProjectViaGit(cwd);
    if (viaGit) {
      projectAbs = viaGit;
      resolutionNote = `project: resolved via git-common-dir -> ${projectAbs}`;
    } else {
      projectAbs = path.resolve(cwd);
      resolutionNote = `project: resolved via cwd, git unavailable -> ${projectAbs}`;
    }
  }
  const enc = encodeProjectDir(projectAbs);
  return { projectAbs, dir: path.join(claudeHomeDir(flags), "projects", enc), resolutionNote };
}

function findLatestSessionFile(transcriptDir) {
  let entries;
  try {
    entries = fs.readdirSync(transcriptDir, { withFileTypes: true });
  } catch (err) {
    throw new UsageError(
      `--latest: cannot read transcript dir '${transcriptDir}': ${err.message}`
    );
  }
  const jsonlFiles = entries
    .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
    .map((e) => {
      const full = path.join(transcriptDir, e.name);
      return { full, name: e.name, mtimeMs: fs.statSync(full).mtimeMs };
    });
  if (jsonlFiles.length === 0) {
    throw new UsageError(`--latest: no *.jsonl files directly in '${transcriptDir}'.`);
  }
  jsonlFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const chosen = jsonlFiles[0];
  return { sessionId: chosen.name.slice(0, -".jsonl".length), filePath: chosen.full };
}

// ---------------------------------------------------------------------------
// price table (parsed from MODEL-CARDS.md; see references/MODEL-CARDS.md)
// ---------------------------------------------------------------------------

// name (as it appears in the table) -> prefix used to match model ids by
// startsWith. Longest/most-specific prefixes are fine here since the ids
// themselves don't collide (sonnet-5 vs sonnet-4-6 vs fable-5 vs opus-5 vs
// haiku-4-5 all diverge at the first differing segment).
const NAME_TO_PREFIX = [
  { test: (name) => /\bFable\b/.test(name), prefix: "claude-fable-5" },
  { test: (name) => name === "Claude Opus 5", prefix: "claude-opus-5" },
  { test: (name) => name === "Claude Sonnet 5", prefix: "claude-sonnet-5" },
  { test: (name) => name === "Claude Sonnet 4.6", prefix: "claude-sonnet-4-6" },
  { test: (name) => name === "Claude Haiku 4.5", prefix: "claude-haiku-4-5" },
];

function parseModelCards(mdText) {
  const asOfMatch = mdText.match(/cached\s+(\d{4}-\d{2}-\d{2})/);
  const pricesAsOf = asOfMatch ? asOfMatch[1] : null;

  const table = {};
  const lines = mdText.split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim().startsWith("| Claude")) continue;
    const cells = line
      .split("|")
      .map((c) => c.trim())
      .filter((c, i, arr) => !(c === "" && (i === 0 || i === arr.length - 1)));
    // cells: [Name, id, ctx/maxout, $in/out per MTok, cache read]
    if (cells.length < 5) continue;
    const [name, idCell, , priceCell, cacheReadCell] = cells;
    const idMatch = idCell.match(/`([^`]+)`/);
    if (!idMatch) continue;
    const priceMatch = priceCell.match(/([\d.]+)\s*\/\s*([\d.]+)/);
    if (!priceMatch) continue;
    const inPrice = Number(priceMatch[1]);
    const outPrice = Number(priceMatch[2]);

    const mapping = NAME_TO_PREFIX.find((m) => m.test(name));
    if (!mapping) continue;

    let cacheRead;
    const plainNum = cacheReadCell.match(/^([\d.]+)$/);
    if (plainNum) {
      cacheRead = Number(plainNum[1]);
    } else {
      // "~10% of input" (or similar) -- spec: cache read = 10% of input
      // unless a literal number is stated.
      cacheRead = inPrice * 0.1;
    }

    table[mapping.prefix] = {
      in: inPrice,
      out: outPrice,
      cacheRead,
      cacheWrite5m: inPrice * 1.25,
      cacheWrite1h: inPrice * 2,
    };
  }
  return { table, pricesAsOf };
}

function loadPriceTable(flags) {
  const warnings = [];
  let table = {};
  let pricesAsOf = null;
  try {
    const md = fs.readFileSync(MODEL_CARDS_PATH, "utf8");
    const parsed = parseModelCards(md);
    table = parsed.table;
    pricesAsOf = parsed.pricesAsOf;
  } catch (err) {
    warnings.push(`could not read/parse MODEL-CARDS.md at '${MODEL_CARDS_PATH}': ${err.message}`);
  }

  if (typeof flags.prices === "string") {
    let override;
    try {
      override = JSON.parse(flags.prices);
    } catch (err) {
      throw new UsageError(`--prices is not valid JSON: ${err.message}`);
    }
    for (const [prefix, rates] of Object.entries(override)) {
      table[prefix] = { in: 0, out: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, ...rates };
    }
    pricesAsOf = "override at " + new Date().toISOString();
  }

  return { table, pricesAsOf, warnings };
}

function ratesForModel(modelId, priceTable) {
  if (!modelId) return null;
  // Longest prefix first so a more specific id (e.g. claude-sonnet-4-6) is
  // never shadowed by a shorter one (claude-sonnet-5 does not collide with
  // it today, but sort defensively in case new ids are added).
  const prefixes = Object.keys(priceTable).sort((a, b) => b.length - a.length);
  for (const prefix of prefixes) {
    if (modelId.startsWith(prefix)) return priceTable[prefix];
  }
  return null;
}

// ---------------------------------------------------------------------------
// usage extraction
// ---------------------------------------------------------------------------

// Pulls the four token buckets out of one Anthropic `usage` object per the
// verified real-transcript shape: usage.cache_creation.{ephemeral_5m,1h}_input_tokens
// when usage.cache_creation is present, else the legacy top-level
// cache_creation_input_tokens as the 5m bucket (1h has no legacy fallback).
function extractBuckets(usage) {
  const input = numOrZero(usage.input_tokens);
  const output = numOrZero(usage.output_tokens);
  const cacheRead = numOrZero(usage.cache_read_input_tokens);
  let cacheWrite5m;
  let cacheWrite1h;
  if (usage.cache_creation && typeof usage.cache_creation === "object") {
    cacheWrite5m = numOrZero(usage.cache_creation.ephemeral_5m_input_tokens);
    cacheWrite1h = numOrZero(usage.cache_creation.ephemeral_1h_input_tokens);
  } else {
    cacheWrite5m = numOrZero(usage.cache_creation_input_tokens);
    cacheWrite1h = 0;
  }
  return { input, cacheWrite5m, cacheWrite1h, cacheRead, output };
}

function emptyBucket() {
  return { input: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0, messages: 0 };
}

function addBucket(dst, src) {
  dst.input += src.input;
  dst.cacheWrite5m += src.cacheWrite5m;
  dst.cacheWrite1h += src.cacheWrite1h;
  dst.cacheRead += src.cacheRead;
  dst.output += src.output;
}

function bucketTokens(b) {
  return b.input + b.cacheWrite5m + b.cacheWrite1h + b.cacheRead + b.output;
}

function bucketCost(b, rates) {
  if (!rates) return null;
  return (
    (b.input * rates.in +
      b.cacheWrite5m * rates.cacheWrite5m +
      b.cacheWrite1h * rates.cacheWrite1h +
      b.cacheRead * rates.cacheRead +
      b.output * rates.out) /
    1e6
  );
}

function cacheHitRatio(b) {
  const denom = b.cacheRead + b.cacheWrite5m + b.cacheWrite1h + b.input;
  return denom > 0 ? b.cacheRead / denom : null;
}

// Reads one transcript JSONL file and yields { model, usage, timestamp,
// isSidechain } records that (a) carry both usage and a model id and (b) are
// the first occurrence of their message id in this file -- a single API
// call's usage is repeated on every streamed content-block line sharing the
// same message.id (verified: 112 usage-bearing lines / 54 unique ids in one
// real session transcript), so counting every line would inflate sums ~2x.
function* readUsageRecords(filePath, warnings) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    throw new UsageError(`cannot read transcript '${filePath}': ${err.message}`);
  }
  const lines = raw.split(/\r?\n/);
  const seenIds = new Set();
  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    if (line.trim().length === 0) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch (err) {
      warnings.push(`${path.basename(filePath)}:${idx + 1}: skipped malformed JSON line`);
      continue;
    }
    const usage = obj?.message?.usage ?? obj?.usage;
    const model = obj?.message?.model ?? obj?.model;
    if (!usage || !model) continue;
    const id = obj?.message?.id ?? null;
    if (id !== null) {
      if (seenIds.has(id)) continue;
      seenIds.add(id);
    }
    yield {
      model,
      usage,
      timestamp: obj.timestamp ?? null,
      isSidechain: obj.isSidechain === true,
    };
  }
}

// ---------------------------------------------------------------------------
// aggregation
// ---------------------------------------------------------------------------

// Folds a list of { model, usage, timestamp } records into
// { byModel, total, messages, firstAt, lastAt, activeMs, cacheHitRatio }.
function aggregate(records, priceTable, idleGapMs, warnings) {
  const byModel = {};
  const times = [];
  const unknownModels = new Set();

  for (const rec of records) {
    const b = byModel[rec.model] ?? (byModel[rec.model] = emptyBucket());
    addBucket(b, extractBuckets(rec.usage));
    b.messages += 1;
    if (rec.timestamp) {
      const ms = Date.parse(rec.timestamp);
      if (Number.isFinite(ms)) times.push(ms);
    }
    if (!ratesForModel(rec.model, priceTable)) unknownModels.add(rec.model);
  }

  for (const id of unknownModels) {
    warnings.push(`unknown model id '${id}' -- cost set to null for its usage`);
  }

  const byModelOut = {};
  const total = emptyBucket();
  let knownCostTotal = 0;
  let anyKnownCost = false;
  for (const [model, b] of Object.entries(byModel)) {
    const rates = ratesForModel(model, priceTable);
    const costUsd = bucketCost(b, rates);
    byModelOut[model] = { ...b, tokens: bucketTokens(b), costUsd };
    addBucket(total, b);
    total.messages += b.messages;
    if (costUsd != null) {
      knownCostTotal += costUsd;
      anyKnownCost = true;
    }
  }

  times.sort((a, b) => a - b);
  let activeMs = 0;
  for (let i = 1; i < times.length; i++) {
    const gap = times[i] - times[i - 1];
    if (gap > 0 && gap < idleGapMs) activeMs += gap;
  }

  return {
    byModel: byModelOut,
    total: { ...total, tokens: bucketTokens(total), costUsd: anyKnownCost ? knownCostTotal : null },
    messages: total.messages,
    firstAt: times.length ? new Date(times[0]).toISOString() : null,
    lastAt: times.length ? new Date(times[times.length - 1]).toISOString() : null,
    activeMs,
    cacheHitRatio: cacheHitRatio(total),
  };
}

// ---------------------------------------------------------------------------
// workflow attribution
// ---------------------------------------------------------------------------

const PHASE_LABEL_RX = /^PHASE:\s*(.+?)\s*\u00b7\s*LABEL:\s*(.+?)\s*$/m;

// Per-agent wall-clock span: last usage-bearing message timestamp minus the
// first, from the SAME aggregate() an agent's tokens/cost are already computed
// from (owner ruling 2026-09-10, session-usage.mjs durations). 0 when there
// are fewer than two distinct timestamps to span.
function agentDurationMs(agentAgg) {
  if (!agentAgg.firstAt || !agentAgg.lastAt) return 0;
  const d = Date.parse(agentAgg.lastAt) - Date.parse(agentAgg.firstAt);
  return Number.isFinite(d) && d > 0 ? d : 0;
}

function agentFileId(fileName) {
  return fileName.replace(/^agent-/, "").replace(/\.jsonl$/, "");
}

function firstUserText(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj?.type !== "user" && obj?.message?.role !== "user") continue;
    const content = obj.message?.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      const texts = content.filter((b) => b?.type === "text").map((b) => b.text);
      if (texts.length) return texts.join("\n");
    }
    return null;
  }
  return null;
}

function attributionFor(filePath, fileName) {
  const text = firstUserText(filePath);
  if (text) {
    const m = text.match(PHASE_LABEL_RX);
    if (m) return { phase: m[1].trim(), label: m[2].trim() };
  }
  return { phase: "unattributed", label: agentFileId(fileName) };
}

function listWorkflowRunDirs(subagentsWorkflowsDir, wfArg) {
  let entries;
  try {
    entries = fs.readdirSync(subagentsWorkflowsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const wfDirs = entries.filter((e) => e.isDirectory() && e.name.startsWith("wf_")).map((e) => e.name);
  if (wfArg === "all") return wfDirs;
  const wanted = wfArg.startsWith("wf_") ? wfArg : `wf_${wfArg}`;
  return wfDirs.filter((d) => d === wanted);
}

function computeWorkflow(runDir, priceTable, idleGapMs, warnings) {
  let entries;
  try {
    entries = fs.readdirSync(runDir, { withFileTypes: true });
  } catch (err) {
    warnings.push(`cannot read workflow run dir '${runDir}': ${err.message}`);
    return null;
  }
  const agentFiles = entries
    .filter((e) => e.isFile() && e.name.startsWith("agent-") && e.name.endsWith(".jsonl"))
    .map((e) => e.name)
    .sort();

  const byPhase = {};
  const byLabel = {};
  const allRecords = [];

  for (const fileName of agentFiles) {
    const full = path.join(runDir, fileName);
    const { phase, label } = attributionFor(full, fileName);
    // Every record inside an agent-*.jsonl subagent transcript is itself
    // tagged isSidechain:true (verified against real data) -- that flag
    // means "this line belongs to a sidechain" from the *parent* session's
    // point of view, not "double-counted here". Only the top-level session
    // file's own inline-sidechain lines are excluded (see runMain).
    const records = [...readUsageRecords(full, warnings)];
    allRecords.push(...records);
    const agentAgg = aggregate(records, priceTable, idleGapMs, warnings);
    const durMs = agentDurationMs(agentAgg);

    const phaseBucket =
      byPhase[phase] ?? (byPhase[phase] = { total: emptyBucket(), byModel: {}, agents: 0, labels: [], durationMs: 0 });
    const labelBucket =
      byLabel[label] ?? (byLabel[label] = { total: emptyBucket(), byModel: {}, agents: 0, labels: [label], durationMs: 0 });

    for (const bucket of [phaseBucket, labelBucket]) {
      addBucket(bucket.total, agentAgg.total);
      bucket.agents += 1;
      bucket.durationMs += durMs;
      for (const [model, b] of Object.entries(agentAgg.byModel)) {
        const mb = bucket.byModel[model] ?? (bucket.byModel[model] = emptyBucket());
        addBucket(mb, b);
      }
    }
    if (!phaseBucket.labels.includes(label)) phaseBucket.labels.push(label);
  }

  // finalize costUsd/tokens on the nested byModel/total buckets built above
  const finalize = (obj) => {
    for (const key of Object.keys(obj)) {
      const entry = obj[key];
      const byModelOut = {};
      for (const [model, b] of Object.entries(entry.byModel)) {
        byModelOut[model] = { ...b, tokens: bucketTokens(b), costUsd: bucketCost(b, ratesForModel(model, priceTable)) };
      }
      entry.byModel = byModelOut;
      const knownCosts = Object.values(byModelOut)
        .map((b) => b.costUsd)
        .filter((v) => v != null);
      entry.total = {
        ...entry.total,
        tokens: bucketTokens(entry.total),
        costUsd: knownCosts.length ? knownCosts.reduce((a, b) => a + b, 0) : null,
      };
    }
  };
  finalize(byPhase);
  finalize(byLabel);

  const overall = aggregate(allRecords, priceTable, idleGapMs, warnings);
  return {
    byPhase,
    byLabel,
    byModel: overall.byModel,
    total: overall.total,
    agents: agentFiles.length,
    cacheHitRatio: overall.cacheHitRatio,
    // Whole-run span: earliest-to-latest usage timestamp across every agent
    // transcript in this workflow run (not a sum of the per-phase/per-label
    // durations, which overlap when agents ran concurrently).
    durationMs: agentDurationMs(overall),
  };
}

// ---------------------------------------------------------------------------
// Agent-tool subagent attribution (--agents / --all)
// ---------------------------------------------------------------------------

// Agent-tool subagents (Explore/Plan/general-purpose executors used by the
// light loop) live directly under <sid>/subagents/agent-<id>.jsonl, one level
// above the wf_* Workflow-tool run directories in
// <sid>/subagents/workflows/wf_*/agent-*.jsonl -- a sibling, not a superset,
// of what --wf walks. Each transcript has a sibling agent-<id>.meta.json:
// {"agentType":"...", "description":"...", "toolUseId":"...", ...} (verified
// against real transcripts). Filtering by e.isFile() naturally excludes the
// "workflows" subdirectory entry itself, so no explicit exclusion is needed.
function listAgentToolFiles(subagentsDir) {
  let entries;
  try {
    entries = fs.readdirSync(subagentsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && /^agent-.+\.jsonl$/.test(e.name))
    .map((e) => e.name)
    .sort();
}

function readAgentMeta(jsonlFilePath) {
  const metaPath = jsonlFilePath.replace(/\.jsonl$/, ".meta.json");
  try {
    const raw = fs.readFileSync(metaPath, "utf8");
    const obj = JSON.parse(raw);
    return {
      agentType: typeof obj.agentType === "string" && obj.agentType ? obj.agentType : "unknown",
      description: typeof obj.description === "string" ? obj.description : "",
    };
  } catch {
    return { agentType: "unknown", description: "" };
  }
}

// Sums every agent-*.jsonl directly under <sid>/subagents/ (NOT the wf_*
// workflow runs under subagents/workflows/ -- see --wf), grouped by
// agentType, using the same per-model/cost/cache-hit/dedupe logic as
// computeWorkflow. Records are used as-is (not isSidechain-filtered): every
// line inside one of these subagent transcripts is itself tagged
// isSidechain:true from the parent session's point of view (same as the
// wf_* agent files -- see computeWorkflow's comment), so filtering on that
// flag here would drop the subagent's own usage entirely.
function computeAgentsSummary(subagentsDir, priceTable, idleGapMs, warnings) {
  const files = listAgentToolFiles(subagentsDir);
  const byType = {};
  const list = [];
  const allRecords = [];

  for (const fileName of files) {
    const full = path.join(subagentsDir, fileName);
    const meta = readAgentMeta(full);
    const records = [...readUsageRecords(full, warnings)];
    allRecords.push(...records);
    const agentAgg = aggregate(records, priceTable, idleGapMs, warnings);
    const durMs = agentDurationMs(agentAgg);

    const typeBucket =
      byType[meta.agentType] ?? (byType[meta.agentType] = { total: emptyBucket(), byModel: {}, agents: 0, durationMs: 0 });
    addBucket(typeBucket.total, agentAgg.total);
    typeBucket.agents += 1;
    typeBucket.durationMs += durMs;
    for (const [model, b] of Object.entries(agentAgg.byModel)) {
      const mb = typeBucket.byModel[model] ?? (typeBucket.byModel[model] = emptyBucket());
      addBucket(mb, b);
    }

    list.push({
      id: agentFileId(fileName),
      agentType: meta.agentType,
      description: truncateText(meta.description, 60),
      tokens: agentAgg.total.tokens,
      costUsd: agentAgg.total.costUsd,
      cacheHitRatio: agentAgg.cacheHitRatio,
      durationMs: durMs,
    });
  }

  // finalize costUsd/tokens on the byType buckets built above (same pattern
  // as computeWorkflow's `finalize`).
  for (const key of Object.keys(byType)) {
    const entry = byType[key];
    const byModelOut = {};
    for (const [model, b] of Object.entries(entry.byModel)) {
      byModelOut[model] = { ...b, tokens: bucketTokens(b), costUsd: bucketCost(b, ratesForModel(model, priceTable)) };
    }
    entry.byModel = byModelOut;
    const knownCosts = Object.values(byModelOut)
      .map((b) => b.costUsd)
      .filter((v) => v != null);
    entry.total = {
      ...entry.total,
      tokens: bucketTokens(entry.total),
      costUsd: knownCosts.length ? knownCosts.reduce((a, b) => a + b, 0) : null,
    };
  }

  const overall = aggregate(allRecords, priceTable, idleGapMs, warnings);
  return {
    byType,
    list,
    total: overall.total,
    cacheHitRatio: overall.cacheHitRatio,
  };
}

// ---------------------------------------------------------------------------
// main command
// ---------------------------------------------------------------------------

function printHelp() {
  console.log(`session-usage.mjs - true per-model token/cost telemetry from session transcripts

Usage:
  node session-usage.mjs <sessionId | --latest> [--project <abs path>]
      [--wf <runId> | --wf all] [--agents] [--all]
      [--idle-gap-ms 600000] [--prices <json>]
      [--out <file>] [--json] [--claude-home <dir>]

  node session-usage.mjs selftest

See the file header for flag semantics. Prices default to
skills/model-routing/references/MODEL-CARDS.md, overridden/extended by
--prices.`);
}

function runMain(argv) {
  const { positional, flags } = parseFlags(argv);
  if (!positional[0] && !flags.latest) {
    throw new UsageError("missing <sessionId> (or pass --latest). See --help.");
  }

  const idleGapMs = typeof flags["idle-gap-ms"] === "string" ? Number(flags["idle-gap-ms"]) : DEFAULT_IDLE_GAP_MS;
  const { table: priceTable, pricesAsOf, warnings } = loadPriceTable(flags);
  const { projectAbs, dir: transcriptDir, resolutionNote } = projectTranscriptDir(flags);
  warnings.push(resolutionNote);

  let sessionId;
  let sessionFile;
  if (flags.latest) {
    const latest = findLatestSessionFile(transcriptDir);
    sessionId = latest.sessionId;
    sessionFile = latest.filePath;
  } else {
    sessionId = positional[0];
    sessionFile = path.join(transcriptDir, `${sessionId}.jsonl`);
    if (!fs.existsSync(sessionFile)) {
      throw new UsageError(`session transcript not found: '${sessionFile}'`);
    }
  }

  const sessionRecords = [...readUsageRecords(sessionFile, warnings)];
  const sidechainCount = sessionRecords.filter((r) => r.isSidechain).length;
  if (sidechainCount > 0) {
    warnings.push(`excluded ${sidechainCount} isSidechain usage record(s) from session totals`);
  }
  const session = aggregate(
    sessionRecords.filter((r) => !r.isSidechain),
    priceTable,
    idleGapMs,
    warnings
  );

  // --all is an alias for `--wf all --agents`; an explicit --wf still wins
  // over the alias's default of "all".
  const wfArg = typeof flags.wf === "string" ? flags.wf : flags.all ? "all" : undefined;
  const agentsWanted = flags.agents === true || flags.all === true;

  const workflows = {};
  if (wfArg !== undefined) {
    const subagentsWorkflowsDir = path.join(transcriptDir, sessionId, "subagents", "workflows");
    const runDirs = listWorkflowRunDirs(subagentsWorkflowsDir, wfArg);
    if (runDirs.length === 0) {
      warnings.push(`--wf ${wfArg}: no matching wf_* directory under '${subagentsWorkflowsDir}'`);
    }
    for (const dirName of runDirs) {
      const runId = dirName.slice("wf_".length);
      const wf = computeWorkflow(path.join(subagentsWorkflowsDir, dirName), priceTable, idleGapMs, warnings);
      if (wf) workflows[runId] = wf;
    }
  }

  let agents = null;
  if (agentsWanted) {
    const subagentsDir = path.join(transcriptDir, sessionId, "subagents");
    agents = computeAgentsSummary(subagentsDir, priceTable, idleGapMs, warnings);
  }

  const output = {
    v: 1,
    sessionId,
    project: projectAbs,
    pricesAsOf,
    session,
    workflows,
    agents,
    warnings,
  };

  if (typeof flags.out === "string") {
    fs.mkdirSync(path.dirname(path.resolve(flags.out)), { recursive: true });
    fs.writeFileSync(path.resolve(flags.out), JSON.stringify(output, null, 2), "utf8");
  }

  if (flags.json) {
    console.log(JSON.stringify(output, null, 2));
  } else {
    printHumanSummary(output);
  }
  return output;
}

function printHumanSummary(output) {
  console.log(`session ${output.sessionId}  (project: ${output.project})`);
  console.log(`prices as of: ${output.pricesAsOf ?? "n/a"}`);
  console.log(
    `messages: ${output.session.messages}   active: ${fmtDuration(output.session.activeMs)}   ` +
      `cache-hit: ${fmtPct(output.session.cacheHitRatio)}`
  );
  console.log(`span: ${output.session.firstAt ?? "n/a"} -> ${output.session.lastAt ?? "n/a"}`);

  console.log("\n=== Session by model ===");
  const rows = Object.entries(output.session.byModel).map(([model, b]) => [
    model,
    b.input.toLocaleString(),
    b.cacheWrite5m.toLocaleString(),
    b.cacheWrite1h.toLocaleString(),
    b.cacheRead.toLocaleString(),
    b.output.toLocaleString(),
    b.tokens.toLocaleString(),
    fmtMoney(b.costUsd),
  ]);
  printTable(["model", "input", "cacheW5m", "cacheW1h", "cacheRead", "output", "tokens", "cost"], rows);
  console.log(`TOTAL tokens: ${output.session.total.tokens.toLocaleString()}   cost: ${fmtMoney(output.session.total.costUsd)}`);

  const wfEntries = Object.entries(output.workflows);
  if (wfEntries.length) {
    console.log("\n=== Workflows ===");
    for (const [runId, wf] of wfEntries) {
      console.log(
        `\nwf_${runId}: agents=${wf.agents}  tokens=${wf.total.tokens.toLocaleString()}  ` +
          `cost=${fmtMoney(wf.total.costUsd)}  cache-hit=${fmtPct(wf.cacheHitRatio)}  ` +
          `duration=${fmtDuration(wf.durationMs)}`
      );
      const phaseRows = Object.entries(wf.byPhase).map(([phase, p]) => [
        phase,
        String(p.agents),
        p.total.tokens.toLocaleString(),
        fmtMoney(p.total.costUsd),
        fmtDuration(p.durationMs),
        truncateLabelsList(p.labels),
      ]);
      printTable(["phase", "agents", "tokens", "cost", "duration", "labels"], phaseRows);
    }
  }

  if (output.agents) {
    const a = output.agents;
    console.log("\n=== Agent-tool subagents (--agents) ===");
    console.log(
      `agents=${a.list.length}  tokens=${a.total.tokens.toLocaleString()}  ` +
        `cost=${fmtMoney(a.total.costUsd)}  cache-hit=${fmtPct(a.cacheHitRatio)}`
    );
    const typeRows = Object.entries(a.byType).map(([agentType, t]) => [
      agentType,
      String(t.agents),
      t.total.tokens.toLocaleString(),
      fmtMoney(t.total.costUsd),
      fmtDuration(t.durationMs),
    ]);
    printTable(["agentType", "count", "tokens", "cost", "duration"], typeRows);

    if (a.list.length) {
      console.log("\n--- by agent ---");
      const listRows = a.list.map((ag) => [
        ag.agentType,
        ag.id,
        ag.tokens.toLocaleString(),
        fmtMoney(ag.costUsd),
        ag.description,
      ]);
      printTable(["agentType", "id", "tokens", "cost", "description"], listRows);
    }
  }

  if (output.warnings.length) {
    console.log("\n=== Warnings ===");
    for (const w of output.warnings) console.log(`- ${w}`);
  }
}

// ---------------------------------------------------------------------------
// selftest
// ---------------------------------------------------------------------------

function writeJsonl(filePath, records) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
}

function runSelftest() {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "session-usage-selftest-"));
  let ok = true;
  try {
    const claudeHome = path.join(tmpBase, "fakehome", ".claude");
    const fakeRepo = path.join(tmpBase, "fakerepo"); // never touched on disk; only its string is encoded
    const enc = encodeProjectDir(path.resolve(fakeRepo));
    const transcriptDir = path.join(claudeHome, "projects", enc);
    const sessionId = "sess-test";
    const sessionFile = path.join(transcriptDir, `${sessionId}.jsonl`);

    // --- session fixture: 3 usage records on 2 models, one duplicated line
    // (same message.id) to prove dedup, a 2-min gap (counted) then a 20-min
    // gap (excluded at the default 10-min idle threshold), and both the
    // nested cache_creation split and the legacy top-level fallback path.
    const t0 = Date.parse("2026-01-01T00:00:00.000Z");
    const t1 = t0 + 2 * 60 * 1000; // +2 min
    const t2 = t1 + 20 * 60 * 1000; // +20 min

    const rec1 = {
      type: "assistant",
      timestamp: new Date(t0).toISOString(),
      message: {
        id: "msg1",
        role: "assistant",
        model: "claude-sonnet-5",
        usage: {
          input_tokens: 1000,
          cache_creation: { ephemeral_5m_input_tokens: 500, ephemeral_1h_input_tokens: 0 },
          cache_read_input_tokens: 200,
          output_tokens: 300,
        },
      },
    };
    const rec2 = {
      type: "assistant",
      timestamp: new Date(t1).toISOString(),
      message: {
        id: "msg2",
        role: "assistant",
        model: "claude-sonnet-5",
        usage: {
          input_tokens: 1000,
          cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 800 },
          cache_read_input_tokens: 100,
          output_tokens: 250,
        },
      },
    };
    const rec3 = {
      type: "assistant",
      timestamp: new Date(t2).toISOString(),
      message: {
        id: "msg3",
        role: "assistant",
        model: "claude-haiku-4-5",
        usage: {
          input_tokens: 500,
          // no cache_creation object -> legacy top-level fallback path
          cache_creation_input_tokens: 150,
          cache_read_input_tokens: 50,
          output_tokens: 100,
        },
      },
    };
    writeJsonl(sessionFile, [rec1, rec1, rec2, rec3]); // rec1 duplicated on purpose

    // --- workflow fixture: one agent transcript with a PHASE/LABEL tag.
    const wfDir = path.join(transcriptDir, sessionId, "subagents", "workflows", "wf_test01");
    const agentFile = path.join(wfDir, "agent-x.jsonl");
    const userMsg = {
      type: "user",
      timestamp: new Date(t0).toISOString(),
      message: { role: "user", content: "PHASE: Verify \u00b7 LABEL: refute1:src/a.ts\n\nDo the thing." },
    };
    const agentAssistant = {
      type: "assistant",
      // Real agent-*.jsonl subagent transcripts tag every line
      // isSidechain:true (verified against real data) -- that must NOT
      // cause computeWorkflow to drop the record (regression pinned here).
      isSidechain: true,
      timestamp: new Date(t0 + 1000).toISOString(),
      message: {
        id: "amsg1",
        role: "assistant",
        model: "claude-opus-5",
        usage: {
          input_tokens: 100,
          cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 0 },
          cache_read_input_tokens: 5,
          output_tokens: 20,
        },
      },
    };
    writeJsonl(agentFile, [userMsg, agentAssistant]);

    // --- Agent-tool subagent fixture: lives directly under
    // <sid>/subagents/ (a sibling of subagents/workflows/, NOT inside it) --
    // proves --agents counts it and --wf does not.
    const agentToolDir = path.join(transcriptDir, sessionId, "subagents");
    const agentToolFile = path.join(agentToolDir, "agent-tool01.jsonl");
    const agentToolMeta = path.join(agentToolDir, "agent-tool01.meta.json");
    const agentToolAssistant = {
      type: "assistant",
      isSidechain: true, // same real-data quirk as the wf_* agent files
      timestamp: new Date(t0 + 2000).toISOString(),
      message: {
        id: "atmsg1",
        role: "assistant",
        model: "claude-haiku-4-5",
        usage: {
          input_tokens: 60,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: 15,
        },
      },
    };
    writeJsonl(agentToolFile, [agentToolAssistant]);
    fs.mkdirSync(agentToolDir, { recursive: true });
    fs.writeFileSync(
      agentToolMeta,
      JSON.stringify({
        agentType: "Explore",
        description:
          "Explore RouteFlow session load and hooks in exhaustive detail well past the sixty character truncation limit",
        toolUseId: "toolu_fake",
      }),
      "utf8"
    );

    // Deterministic prices matching MODEL-CARDS.md's own derivation rules
    // (in/out list price; cacheRead = 10% of in; cacheWrite5m = 1.25x in;
    // cacheWrite1h = 2x in) so the arithmetic below is exact.
    const prices = {
      "claude-sonnet-5": { in: 2, out: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 },
      "claude-haiku-4-5": { in: 1, out: 5, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2 },
      "claude-opus-5": { in: 5, out: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
    };

    const out = runMain([
      sessionId,
      "--project",
      fakeRepo,
      "--claude-home",
      claudeHome,
      "--wf",
      "all",
      "--agents",
      "--prices",
      JSON.stringify(prices),
      "--json",
    ]);

    // --- assertions: per-model sums (post-dedup) ---
    const sonnet = out.session.byModel["claude-sonnet-5"];
    assert(sonnet, "missing claude-sonnet-5 bucket");
    assert(sonnet.messages === 2, `expected 2 sonnet-5 messages (dedup), got ${sonnet.messages}`);
    assert(sonnet.input === 2000, `expected sonnet-5 input 2000, got ${sonnet.input}`);
    assert(sonnet.cacheWrite5m === 500, `expected sonnet-5 cacheWrite5m 500, got ${sonnet.cacheWrite5m}`);
    assert(sonnet.cacheWrite1h === 800, `expected sonnet-5 cacheWrite1h 800, got ${sonnet.cacheWrite1h}`);
    assert(sonnet.cacheRead === 300, `expected sonnet-5 cacheRead 300, got ${sonnet.cacheRead}`);
    assert(sonnet.output === 550, `expected sonnet-5 output 550, got ${sonnet.output}`);

    const haiku = out.session.byModel["claude-haiku-4-5"];
    assert(haiku, "missing claude-haiku-4-5 bucket");
    assert(haiku.messages === 1, `expected 1 haiku message, got ${haiku.messages}`);
    assert(haiku.cacheWrite5m === 150, `expected haiku legacy-fallback cacheWrite5m 150, got ${haiku.cacheWrite5m}`);
    assert(haiku.cacheWrite1h === 0, `expected haiku cacheWrite1h 0, got ${haiku.cacheWrite1h}`);

    // --- activeMs excludes the 20-min gap, includes the 2-min gap ---
    assert(out.session.activeMs === 2 * 60 * 1000, `expected activeMs 120000, got ${out.session.activeMs}`);

    // --- cacheHitRatio ---
    const expectedRatio = 350 / (350 + 650 + 800 + 2500);
    assert(
      Math.abs(out.session.cacheHitRatio - expectedRatio) < 1e-9,
      `expected cacheHitRatio ${expectedRatio}, got ${out.session.cacheHitRatio}`
    );

    // --- cost arithmetic ---
    const expectedSonnetCost = (2000 * 2 + 500 * 2.5 + 800 * 4 + 300 * 0.2 + 550 * 10) / 1e6;
    assert(
      Math.abs(sonnet.costUsd - expectedSonnetCost) < 1e-9,
      `expected sonnet-5 cost ${expectedSonnetCost}, got ${sonnet.costUsd}`
    );
    const expectedHaikuCost = (500 * 1 + 150 * 1.25 + 0 * 2 + 50 * 0.1 + 100 * 5) / 1e6;
    assert(
      Math.abs(haiku.costUsd - expectedHaikuCost) < 1e-9,
      `expected haiku cost ${expectedHaikuCost}, got ${haiku.costUsd}`
    );
    assert(
      Math.abs(out.session.total.costUsd - (expectedSonnetCost + expectedHaikuCost)) < 1e-9,
      "session total cost does not equal sum of per-model costs"
    );

    // --- workflow attribution ---
    const wf = out.workflows["test01"];
    assert(wf, "missing workflows.test01");
    assert(wf.agents === 1, `expected 1 agent in wf_test01, got ${wf.agents}`);
    assert(Object.keys(wf.byPhase).includes("Verify"), "expected byPhase.Verify from PHASE/LABEL tag");
    assert(
      wf.byPhase.Verify.labels.includes("refute1:src/a.ts"),
      "expected label 'refute1:src/a.ts' under phase Verify"
    );
    assert(Object.keys(wf.byLabel).includes("refute1:src/a.ts"), "expected byLabel entry for the tagged label");
    const expectedOpusCost = (100 * 5 + 10 * 6.25 + 0 * 10 + 5 * 0.5 + 20 * 25) / 1e6;
    assert(
      Math.abs(wf.byModel["claude-opus-5"].costUsd - expectedOpusCost) < 1e-9,
      `expected opus-5 cost ${expectedOpusCost}, got ${wf.byModel["claude-opus-5"]?.costUsd}`
    );
    // The Agent-tool fixture's model (haiku) must NOT leak into the
    // Workflow-tool aggregation -- it lives in a sibling directory, not
    // inside wf_test01/.
    assert(wf.agents === 1, `expected wf_test01 to still see only 1 agent, got ${wf.agents}`);
    assert(
      !("claude-haiku-4-5" in wf.byModel),
      "Agent-tool fixture's haiku usage leaked into --wf aggregation"
    );

    // --- --agents: Agent-tool subagent aggregation ---
    assert(out.agents, "missing top-level `agents` summary (expected with --agents)");
    assert(out.agents.list.length === 1, `expected 1 agent-tool subagent, got ${out.agents.list.length}`);
    const agentEntry = out.agents.list[0];
    assert(agentEntry.id === "tool01", `expected agent id 'tool01', got '${agentEntry.id}'`);
    assert(agentEntry.agentType === "Explore", `expected agentType 'Explore', got '${agentEntry.agentType}'`);
    assert(
      agentEntry.description.length <= 60,
      `expected description truncated to <=60 chars, got ${agentEntry.description.length}`
    );
    assert(out.agents.byType.Explore, "expected agents.byType.Explore bucket");
    assert(
      out.agents.byType.Explore.agents === 1,
      `expected agents.byType.Explore.agents === 1, got ${out.agents.byType.Explore.agents}`
    );
    const expectedAgentToolCost = (60 * 1 + 0 * 1.25 + 0 * 2 + 0 * 0.1 + 15 * 5) / 1e6;
    assert(
      Math.abs(agentEntry.costUsd - expectedAgentToolCost) < 1e-9,
      `expected agent-tool cost ${expectedAgentToolCost}, got ${agentEntry.costUsd}`
    );
    assert(
      Math.abs(out.agents.byType.Explore.total.costUsd - expectedAgentToolCost) < 1e-9,
      `expected agents.byType.Explore.total.costUsd ${expectedAgentToolCost}, got ${out.agents.byType.Explore.total.costUsd}`
    );
    assert(
      Math.abs(out.agents.total.costUsd - expectedAgentToolCost) < 1e-9,
      "agents.total.costUsd does not equal sum of per-agent costs"
    );

    // --- P2(a) 2026-09-11: project resolution via git-common-dir ---------
    // A real git worktree, checked out from a real main repo -- proves
    // resolveProjectViaGit (and therefore projectTranscriptDir's default,
    // no-flags path) resolves to the MAIN checkout, not the worktree's own
    // path (the exact 2026-09-11 bug: a worktree's own path encodes to a
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

    const viaGitFromWorktree = resolveProjectViaGit(gitWorktreeDir);
    assert(
      viaGitFromWorktree === gitMainRepo,
      `expected resolveProjectViaGit(worktree) to return the main checkout '${gitMainRepo}', got '${viaGitFromWorktree}'`
    );
    const viaGitFromMain = resolveProjectViaGit(gitMainRepo);
    assert(
      viaGitFromMain === gitMainRepo,
      `expected resolveProjectViaGit(main checkout) to return itself '${gitMainRepo}', got '${viaGitFromMain}'`
    );
    const viaGitNoRepo = resolveProjectViaGit(tmpBase);
    assert(
      viaGitNoRepo !== gitWorktreeDir,
      `expected resolveProjectViaGit(a dir outside the worktree) to never resolve to the worktree itself, got '${viaGitNoRepo}'`
    );

    // projectTranscriptDir with no --project, cwd = the worktree -> resolves
    // to the main checkout's encoding, not the worktree's.
    const { projectAbs: projAbsFromWorktree, resolutionNote: noteFromWorktree } = projectTranscriptDir(
      {},
      gitWorktreeDir
    );
    assert(
      projAbsFromWorktree === gitMainRepo,
      `expected projectTranscriptDir({}, worktreeDir).projectAbs to be the main checkout, got '${projAbsFromWorktree}'`
    );
    assert(
      noteFromWorktree.includes("git-common-dir"),
      `expected a resolutionNote recording git-common-dir, got '${noteFromWorktree}'`
    );
    // Explicit --project always wins over git resolution.
    const { projectAbs: projAbsExplicit, resolutionNote: noteExplicit } = projectTranscriptDir(
      { project: gitWorktreeDir },
      gitMainRepo
    );
    assert(
      projAbsExplicit === path.resolve(gitWorktreeDir),
      `expected an explicit --project to win over git resolution, got '${projAbsExplicit}'`
    );
    assert(noteExplicit.includes("--project"), `expected resolutionNote to record the --project path, got '${noteExplicit}'`);

    console.log("SELFTEST PASSED");
  } catch (err) {
    ok = false;
    console.error("SELFTEST FAILED: " + err.message);
    console.error(err.stack);
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
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
  if (argv[0] === "-h" || argv[0] === "--help") {
    printHelp();
    return;
  }
  try {
    runMain(argv);
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(err.message + "\n");
      process.exitCode = err.code || 2;
      return;
    }
    throw err;
  }
}

main();
