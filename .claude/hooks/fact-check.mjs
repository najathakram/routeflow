#!/usr/bin/env node
/**
 * PreToolUse (matcher: SendMessage|mcp__ccd_session_mgmt__send_message) adapter for the R0 fact-check
 * (scripts/fact-check.mjs). Before a message goes out it verifies every PR number, sha, branch, HH:MMZ stamp and
 * "gate-complete/ready" claim in it against gh, git and the clock.
 *
 * WARN MODE (FACT_CHECK_MODE = "warn", this diff): never blocks and never sets permissionDecision (an "allow" would
 * skip the normal permission prompt). On a mismatch it returns `additionalContext` naming each bad token and its truth,
 * so the sender can correct with a follow-up message. The enforcing flip ("deny" + `# factcheck:allow <reason>`
 * override) is a separate diff with the owner's OK.
 *
 * Every checked send appends one row to <main checkout>/local-assets/fact-check/log.jsonl
 * {ts, sessionId, tool, to, ms, tokens, hits, unverified, mode, decision}: the flip review reads hit rates, false
 * positives and latency (p95) from it.
 *
 * Fail-open: empty message, no tokens, any exception -> exit 0, print nothing.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORE = pathToFileURL(path.join(HERE, "..", "..", "scripts", "fact-check.mjs")).href;

/** Pure apart from deps: { core, sources(text) -> sources, append(row), now() -> ms }. Returns hook stdout or "". */
export function runHook(payload, deps) {
  const message = payload?.tool_input?.message;
  if (typeof message !== "string" || !message.trim()) return "";
  const t = deps.core.extractTokens(message);
  const count = t.prs.length + t.shas.length + t.branches.length + t.stamps.length + t.ready.length;
  if (!count) return "";
  const started = deps.now();
  const result = deps.core.checkFacts(message, deps.sources(message));
  const mode = deps.core.FACT_CHECK_MODE;
  deps.append({
    ts: new Date(started).toISOString(),
    sessionId: payload.session_id ?? null,
    tool: payload.tool_name ?? null,
    to: payload.tool_input.to ?? payload.tool_input.session_id ?? null,
    ms: deps.now() - started,
    tokens: count,
    hits: result.hits,
    unverified: result.unverified.length,
    mode,
    decision: result.hits.length ? "warned" : "clean",
  });
  if (!result.hits.length) return "";
  const context =
    `FACT-CHECK (${mode}): this message states ${result.hits.length} fact(s) that do not match their source right now. ` +
    `Send a correction:\n${deps.core.formatReport(result)}`;
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: context },
  });
}

async function main() {
  try {
    const payload = JSON.parse(readFileSync(0, "utf8") || "{}");
    const core = await import(CORE);
    const logDir = path.join(
      core.mainCheckoutRoot(payload.cwd || process.cwd()),
      "local-assets",
      "fact-check",
    );
    const out = runHook(payload, {
      core,
      sources: (text) => core.liveSources(text, payload.cwd || process.cwd()),
      now: () => Date.now(),
      append: (row) => {
        mkdirSync(logDir, { recursive: true });
        appendFileSync(path.join(logDir, "log.jsonl"), JSON.stringify(row) + "\n");
      },
    });
    if (out) process.stdout.write(out);
  } catch {
    /* fail open: a checker fault must never stop a send */
  }
  process.exit(0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
