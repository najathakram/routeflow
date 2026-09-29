#!/usr/bin/env node
// claude-hook.mjs — PostToolUse hook (matcher: "Bash") that keeps the work
// board fresh right after an action that changes it from outside the
// 5-minute poll: opening/updating/merging/closing a PR or issue, or pushing
// a branch. Registered in .claude/settings.json.
//
// Reads the hook's JSON payload from stdin (Claude Code's PostToolUse
// contract — tool_input.command is the Bash command that just ran). When
// that command contains an actual invocation of one of the trigger
// commands below, it spawns `node scripts/work/trigger.mjs` fully
// DETACHED — trigger.mjs already debounces itself (60s window, see
// trigger.mjs) so firing this hook on every matching command is cheap and
// safe.
//
// Hook contract: this must NEVER slow down or break the tool call it's
// attached to. It always exits 0, writes nothing to stdout/stderr, and
// swallows every error — a missing trigger.mjs (this hook is registered
// repo-wide and runs in any worktree, not just the dedicated runner one)
// is a silent no-op, not a failure.
//
// Paths are resolved from this script's own on-disk location (not cwd), so
// the hook behaves the same whether Claude Code's cwd is the repo root or
// a subdirectory of it.
//
// No npm dependencies — plain Node, ESM.
//
// Usage (invoked by Claude Code itself, never by hand):
//   node scripts/work/claude-hook.mjs   (reads hook JSON from stdin)
//
// Every exported function above the "── IO" marker is pure and is what
// scripts/work/claude-hook.self-test.mjs exercises directly.
import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const TRIGGER_PATH = join(ROOT, "scripts", "work", "trigger.mjs");

// ════════════════════════════════════════════════════════════════════════
// PURE
// ════════════════════════════════════════════════════════════════════════

// Splits on unescaped shell control operators so a trigger command that's
// merely quoted TEXT inside an unrelated command (e.g. `echo gh pr create`
// — one segment, no operator, leading token "echo") never matches, while
// every segment of a chained command (e.g. `git add x && git push`) is
// checked on its own. A lightweight heuristic, not a full shell parser —
// good enough for an opportunistic refresh trigger that the 5-minute poll
// already backstops if it ever misses.
const SEGMENT_SPLIT_RE = /&&|\|\||;|\||\n/;

const GH_TRIGGER_RE =
  /^gh\s+(?:pr\s+(?:create|ready|merge|close|edit)|issue\s+(?:create|close|reopen|edit))\b/;
const GIT_PUSH_RE = /^git\s+push\b/;

/** Splits a shell command string into its chained segments, trimmed. */
export function commandSegments(command) {
  return String(command ?? "")
    .split(SEGMENT_SPLIT_RE)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * true when `command` contains an actual (leading-token) invocation of
 * `gh pr create|ready|merge|close|edit`, `gh issue create|close|reopen|edit`,
 * or `git push` — the actions that change the work board from outside the
 * 5-minute poll. Word-boundary anchored so `git pushd` (a different command
 * that merely starts with the same letters) never matches, and segment-
 * anchored so `echo gh pr create` (the words appear, but not as a real
 * invocation) never matches either.
 */
export function matchesTriggerCommand(command) {
  return commandSegments(command).some((seg) => GH_TRIGGER_RE.test(seg) || GIT_PUSH_RE.test(seg));
}

// ════════════════════════════════════════════════════════════════════════
// ── IO ─────────────────────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════════

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function fireTrigger() {
  if (!existsSync(TRIGGER_PATH)) return; // not every worktree has scripts/work/ wired up
  try {
    const child = spawn(process.execPath, [TRIGGER_PATH], {
      cwd: ROOT,
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } catch {
    // best-effort only — never let this hook fail the tool call it's attached to.
  }
}

function main() {
  let payload = {};
  try {
    payload = JSON.parse(readStdin() || "{}");
  } catch {
    return;
  }
  const command = payload?.tool_input?.command;
  if (matchesTriggerCommand(command)) fireTrigger();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main();
  } catch {
    // swallow everything — this hook must always exit 0, silently.
  }
}
process.exitCode = 0;
