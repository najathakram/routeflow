#!/usr/bin/env node
// trigger.mjs — debounced "refresh the work board now".
//
// claim.mjs calls this (detached) right after a successful claim or release
// so the board doesn't sit stale until the next 5-minute poll. If a
// reconcile was already triggered within the last 60s, this is a silent
// no-op — that in-flight (or just-finished) run already covers the change.
// Otherwise it spawns a fully DETACHED `node reconcile.mjs --apply --quiet` and
// returns immediately: the caller never blocks on the board actually
// refreshing.
//
// This is a separate, lighter-weight path than scripts/work/run.mjs's
// 5-minute poll — it does not take run.mjs's run.lock, does not touch the
// runner worktree, and never checks out a different ref. It only debounces
// against ITSELF via trigger-state.json, so an unlucky overlap with a
// poller run already in flight is possible; reconcile.mjs's own
// change-detection (diffFieldValues) makes a second, redundant run cheap
// and safe (it writes nothing when nothing changed).
//
// Usage: node scripts/work/trigger.mjs
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const WORK_DIR = join(ROOT, "local-assets", "work");
const STATE_FILE = join(WORK_DIR, "trigger-state.json");
const RECONCILE_PATH = join(ROOT, "scripts", "work", "reconcile.mjs");

// ════════════════════════════════════════════════════════════════════════
// PURE
// ════════════════════════════════════════════════════════════════════════

export const DEBOUNCE_WINDOW_MS = 60_000;

/**
 * lastTriggeredAt: ISO string or null/undefined. now: Date.
 * true = a reconcile was triggered inside the debounce window -> skip.
 * A lastTriggeredAt in the future (clock skew / corrupt state) never
 * debounces — we'd rather trigger an extra run than silently swallow one.
 */
export function shouldSkipTrigger(lastTriggeredAt, now = new Date()) {
  if (!lastTriggeredAt) return false;
  const elapsed = now.getTime() - new Date(lastTriggeredAt).getTime();
  return elapsed >= 0 && elapsed < DEBOUNCE_WINDOW_MS;
}

// ════════════════════════════════════════════════════════════════════════
// ── IO ─────────────────────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════════

function loadState() {
  if (!existsSync(STATE_FILE)) return {};
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveState(state) {
  mkdirSync(WORK_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n", "utf8");
}

function main() {
  const now = new Date();
  const state = loadState();
  if (shouldSkipTrigger(state.lastTriggeredAt, now)) {
    const ageS = Math.round((now.getTime() - new Date(state.lastTriggeredAt).getTime()) / 1000);
    console.log(`work trigger: debounced — a reconcile started ${ageS}s ago`);
    return;
  }
  const child = spawn(process.execPath, [RECONCILE_PATH, "--apply", "--quiet"], {
    cwd: ROOT,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  saveState({ ...state, lastTriggeredAt: now.toISOString() });
  console.log(`work trigger: spawned reconcile.mjs --apply --quiet (pid ${child.pid})`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
