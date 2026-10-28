#!/usr/bin/env node
/**
 * SubagentStop hook (R1-a): one row per finished subagent in <repo>/.claude/pipeline/agent-log.jsonl, now with the
 * cost, tokens, duration, model and description that every row of the old global hook left null (the harness payload
 * never carries them).
 *
 * The numbers come from the subagent's own transcript, located in this order (the rule that fired is `src`):
 *   payload    payload.agent_transcript_path
 *   derived    <transcript_path without .jsonl>/subagents/agent-<payload.agent_id>.jsonl
 * With neither, the row is null ("no agent id"): another agent's transcript is never guessed at.
 * and are counted by session-usage.mjs's exported readUsageRecords/aggregate/loadPriceTable/agentDurationMs, the one
 * accounting (message.id dedupe, MODEL-CARDS prices). The sibling agent-<id>.meta.json gives agentType, description and
 * effort. A field that cannot be found stays null with `nullReason`; nothing is guessed.
 *
 * Row v2: {v, ts, sessionId, agentId, agentType, description, model, effort, durationMs, tokens, costUsd, pricesAsOf,
 * src, nullReason}. Rows with v absent are the old global hook's (cost unknown).
 *
 * Never blocks: exit 0 always, prints nothing.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  agentDurationMs,
  aggregate,
  loadPriceTable,
  readUsageRecords,
} from "../skills/model-routing/scripts/session-usage.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Pure: the main checkout named by a worktree's `.git` file text (`gitdir: <main>/.git/worktrees/<name>`), else root.
 * `p` is injectable so the spec proves both path flavours on any OS.
 */
export function mainFromGitdir(root, gitText, p = path) {
  const gitdir = String(gitText ?? "")
    .match(/^gitdir:\s*(.+)$/m)?.[1]
    ?.trim()
    // A gitdir written on Windows may use backslashes; POSIX path.resolve would not split on them.
    ?.replace(/\\/g, "/");
  const m = gitdir && p.resolve(root, gitdir).match(/^(.*)[\\/]\.git[\\/]worktrees[\\/][^\\/]+$/);
  return m ? m[1] : root;
}

/** The MAIN checkout: a worktree's `.git` is a file naming <main>/.git/worktrees/<name>; rows land in one log. */
export function mainRoot(root) {
  try {
    return mainFromGitdir(root, readFileSync(path.join(root, ".git"), "utf8"));
  } catch {
    return root; // .git is a directory: this is the main checkout
  }
}
const REPO = mainRoot(path.resolve(HERE, "..", ".."));
const IDLE_GAP_MS = 600_000;

/** Pure apart from the filesystem: { file, src } or { file: null, src: null }. */
export function locateTranscript(p) {
  if (typeof p.agent_transcript_path === "string" && existsSync(p.agent_transcript_path))
    return { file: p.agent_transcript_path, src: "payload" };
  if (typeof p.transcript_path !== "string") return { file: null, src: null };
  const dir = path.join(p.transcript_path.replace(/\.jsonl$/, ""), "subagents");
  if (typeof p.agent_id !== "string") return { file: null, src: null, noId: true };
  // An id names exactly one file. Another agent's transcript is never borrowed while this one is not yet written.
  const file = path.join(dir, `agent-${p.agent_id}.jsonl`);
  return existsSync(file) ? { file, src: "derived" } : { file: null, src: null };
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
  const { file, src, noId } = locateTranscript(p);
  if (!file) return { ...row, nullReason: noId ? "no agent id" : "no transcript" };
  const meta = readJson(file.replace(/\.jsonl$/, ".meta.json"));
  const warnings = [];
  const { table, pricesAsOf } = loadPriceTable({});
  const agg = aggregate(readUsageRecords(file, warnings), table, IDLE_GAP_MS, warnings);
  const models = Object.entries(agg.byModel).sort((a, b) => b[1].tokens - a[1].tokens);
  // A partial sum would read as the agent's whole cost, so one unpriced model makes the cost null.
  const unpriced = models.filter(([, b]) => b.costUsd == null).map(([id]) => id);
  const span = agg.messages ? agentDurationMs(agg) : 0;
  return {
    ...row,
    agentId: row.agentId ?? path.basename(file).replace(/^agent-|\.jsonl$/g, ""),
    agentType: row.agentType ?? meta.agentType ?? null,
    description: meta.description ?? null,
    model: models[0]?.[0] ?? null,
    effort: meta.effort ?? null,
    durationMs: span > 0 ? span : null, // first to last assistant message; null under two timestamps
    tokens: agg.messages ? agg.total.tokens : null,
    costUsd: unpriced.length ? null : agg.total.costUsd,
    pricesAsOf,
    src,
    nullReason: !agg.messages
      ? "no usage in transcript"
      : unpriced.length
        ? `unpriced model: ${unpriced.join(", ")}`
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

// realpath: run through a junction or symlink, argv[1] is the link while import.meta.url is the target.
const isCli = () => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};
if (process.argv[1] && isCli()) main();
