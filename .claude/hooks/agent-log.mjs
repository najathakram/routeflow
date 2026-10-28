#!/usr/bin/env node
/**
 * SubagentStop hook (R1-a): one row per finished subagent in <repo>/.claude/pipeline/agent-log.jsonl, now with the
 * cost, tokens, duration, model and description that every row of the old global hook left null (the harness payload
 * never carries them).
 *
 * The numbers come from the subagent's own transcript, located in this order (the rule that fired is `src`):
 *   payload    payload.agent_transcript_path
 *   derived    <transcript_path without .jsonl>/subagents/agent-<payload.agent_id>.jsonl
 *   newest     the newest agent-*.jsonl in that directory modified in the last 10 s
 * and are counted by session-usage.mjs's exported readUsageRecords/aggregate/loadPriceTable/agentDurationMs, the one
 * accounting (message.id dedupe, MODEL-CARDS prices). The sibling agent-<id>.meta.json gives agentType, description and
 * effort. A field that cannot be found stays null with `nullReason`; nothing is guessed.
 *
 * Row v2: {v, ts, sessionId, agentId, agentType, description, model, effort, durationMs, tokens, costUsd, pricesAsOf,
 * src, nullReason}. Rows with v absent are the old global hook's (cost unknown).
 *
 * Never blocks: exit 0 always, prints nothing.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  agentDurationMs,
  aggregate,
  loadPriceTable,
  readUsageRecords,
} from "../skills/model-routing/scripts/session-usage.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The MAIN checkout: a worktree's `.git` is a file naming <main>/.git/worktrees/<name>; rows land in one log. */
export function mainRoot(root) {
  try {
    const gitdir = readFileSync(path.join(root, ".git"), "utf8")
      .match(/^gitdir:\s*(.+)$/m)?.[1]
      ?.trim();
    const m =
      gitdir && path.resolve(root, gitdir).match(/^(.*)[\\/]\.git[\\/]worktrees[\\/][^\\/]+$/);
    return m ? m[1] : root;
  } catch {
    return root; // .git is a directory: this is the main checkout
  }
}
const REPO = mainRoot(path.resolve(HERE, "..", ".."));
const NEWEST_WINDOW_MS = 10_000;
const IDLE_GAP_MS = 600_000;

/** Pure apart from the filesystem: { file, src } or { file: null, src: null }. */
export function locateTranscript(p, nowMs = Date.now()) {
  if (typeof p.agent_transcript_path === "string" && existsSync(p.agent_transcript_path))
    return { file: p.agent_transcript_path, src: "payload" };
  if (typeof p.transcript_path !== "string") return { file: null, src: null };
  const dir = path.join(p.transcript_path.replace(/\.jsonl$/, ""), "subagents");
  if (typeof p.agent_id === "string") {
    const file = path.join(dir, `agent-${p.agent_id}.jsonl`);
    if (existsSync(file)) return { file, src: "derived" };
  }
  try {
    const newest = readdirSync(dir)
      .filter((f) => /^agent-.*\.jsonl$/.test(f))
      .map((f) => ({ f: path.join(dir, f), t: statSync(path.join(dir, f)).mtimeMs }))
      .filter((x) => nowMs - x.t <= NEWEST_WINDOW_MS)
      .sort((a, b) => b.t - a.t)[0];
    if (newest) return { file: newest.f, src: "newest" };
  } catch {
    /* no subagents directory */
  }
  return { file: null, src: null };
}

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
};

export function buildRow(p, nowMs = Date.now()) {
  const row = {
    v: 2,
    ts: new Date(nowMs).toISOString(),
    sessionId: p.session_id ?? null,
    agentId: p.agent_id ?? null,
    agentType: p.agent_type ?? null,
    description: null,
    model: null,
    effort: null,
    durationMs: null,
    tokens: null,
    costUsd: null,
    pricesAsOf: null,
    src: null,
    nullReason: null,
  };
  const { file, src } = locateTranscript(p, nowMs);
  if (!file) return { ...row, nullReason: "no transcript" };
  const meta = readJson(file.replace(/\.jsonl$/, ".meta.json"));
  const warnings = [];
  const { table, pricesAsOf } = loadPriceTable({});
  const agg = aggregate(readUsageRecords(file, warnings), table, IDLE_GAP_MS, warnings);
  const models = Object.entries(agg.byModel).sort((a, b) => b[1].tokens - a[1].tokens);
  return {
    ...row,
    agentId: row.agentId ?? path.basename(file).replace(/^agent-|\.jsonl$/g, ""),
    agentType: row.agentType ?? meta.agentType ?? null,
    description: meta.description ?? null,
    model: models[0]?.[0] ?? null,
    effort: meta.effort ?? null,
    durationMs: agg.messages ? agentDurationMs(agg) : null,
    tokens: agg.messages ? agg.total.tokens : null,
    costUsd: agg.total.costUsd,
    pricesAsOf,
    src,
    nullReason: !agg.messages
      ? "no usage in transcript"
      : agg.total.costUsd == null
        ? "unpriced model"
        : null,
  };
}

function main() {
  try {
    const payload = JSON.parse(readFileSync(0, "utf8") || "{}");
    const row = buildRow(payload);
    const dir = path.join(REPO, ".claude", "pipeline");
    mkdirSync(dir, { recursive: true });
    appendFileSync(path.join(dir, "agent-log.jsonl"), JSON.stringify(row) + "\n");
  } catch {
    /* a logging hook never breaks the session */
  }
  process.exit(0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
