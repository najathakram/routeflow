#!/usr/bin/env node
/**
 * PostToolUse recorder for plan changes and assignments (session -> monitor). It only LOGS a
 * turn action (same per-session file as ops-post-push.mjs); the Stop gate (ops-stop.mjs) then
 * blocks the turn until an `rf` event records the change on the monitor.
 *
 *   { kind: "plan-change", path }  a Write/Edit/MultiEdit of a plan file in a routeflow-specs
 *                                  checkout: decisions/ releases/ priorities/ briefs/ register/
 *                                  roadmap/ specs/ or DASHBOARD.md (never events/ handoff/ log/ ops/)
 *   { kind: "assign", to }         a SendMessage from the LEAD lane whose text reads like a job
 *                                  assignment. Lanes reporting to the lead never trigger it.
 *
 * Never blocks, never prints. FAIL OPEN: any error, CI or RF_OPS_GATE=off -> exit 0.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const PLAN_DIRS = new Set([
  "decisions",
  "releases",
  "priorities",
  "briefs",
  "register",
  "roadmap",
  "specs",
]);
const EXCLUDED_DIRS = new Set(["events", "handoff", "log", "ops"]);
const HUMAN_MODE_RECORD_FILES = new Set(["register/work-register.md", "priorities/owner-queue.md"]);
const SPECS_MARKERS = ["/rf-specs-handoff/", "/routeflow-specs/"];
const ASSIGN_RE = /\b(job|task|take|assign|start|build|fix|next|priority|queue)\b/i;
const WORK_REF_RE = /\b(B\d{2,5}|R[1-9]|rows?\s+#?\d{2,4}|item\s+#?\d{2,4})\b/i;

// ════════════════════════════════════════════════════════════════════════
// PURE
// ════════════════════════════════════════════════════════════════════════

const slash = (p) => String(p).replace(/\\/g, "/");

/**
 * The path inside a routeflow-specs checkout (`decisions/D-1.md`), or null when `file` is not in
 * one: the path has a /rf-specs-handoff/ or /routeflow-specs/ segment, or is under `specsRoot`.
 */
export function specsRelative(file, specsRoot = null) {
  const f = slash(file);
  const lower = f.toLowerCase();
  for (const m of SPECS_MARKERS) {
    const i = lower.lastIndexOf(m);
    if (i >= 0) return f.slice(i + m.length);
  }
  if (specsRoot) {
    const root = slash(specsRoot).replace(/\/+$/, "");
    if (lower.startsWith(`${root.toLowerCase()}/`)) return f.slice(root.length + 1);
  }
  return null;
}

/**
 * True when `file` is a plan file (see the header). The two register files are plan files only
 * in generated mode: in human mode a hand edit of them IS the record (the register sync turns it
 * into events), so `registerMode` other than "generated" (or unknown) excludes them.
 */
export function isPlanPath(file, specsRoot = null, registerMode = null) {
  if (typeof file !== "string" || !file) return false;
  const rel = specsRelative(file, specsRoot);
  if (!rel) return false;
  if (registerMode !== "generated" && HUMAN_MODE_RECORD_FILES.has(rel.toLowerCase())) return false;
  if (rel.toLowerCase() === "dashboard.md") return true;
  const top = rel.split("/")[0].toLowerCase();
  if (EXCLUDED_DIRS.has(top)) return false;
  return PLAN_DIRS.has(top) && rel.includes("/");
}

/** The text of a SendMessage input (string forms only; structured protocol messages are not asks). */
export function messageText(input) {
  for (const k of ["message", "content", "text", "summary"]) {
    if (typeof input?.[k] === "string") return input[k];
  }
  return "";
}

/**
 * Turn actions for one PostToolUse payload. `lane` is the calling session's lane (or null);
 * `specsRoot` the ops clone. Pure.
 */
export function planActions(
  payload,
  { lane = null, specsRoot = null, now = Date.now(), registerMode = null } = {},
) {
  const tool = payload?.tool_name;
  const input = payload?.tool_input ?? {};
  if (tool === "Write" || tool === "Edit" || tool === "MultiEdit") {
    const raw = input.file_path;
    if (typeof raw !== "string" || !raw) return [];
    const base = payload.cwd ?? process.cwd();
    const file = isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw) ? raw : resolve(base, raw);
    return isPlanPath(file, specsRoot, registerMode)
      ? [{ ts: now, kind: "plan-change", path: slash(file) }]
      : [];
  }
  if (tool === "SendMessage") {
    if (lane !== "lead") return [];
    // An assignment names WORK (an item, bug or release) as well as using an assignment word;
    // a status ping like "fix pushed?" or "next window at 18:00" must not trip the gate.
    const text = messageText(input);
    if (!ASSIGN_RE.test(text) || !WORK_REF_RE.test(text)) return [];
    const to = String(input.to ?? input.recipient ?? "").slice(0, 80);
    return [{ ts: now, kind: "assign", to: to || "a lane" }];
  }
  return [];
}

// ════════════════════════════════════════════════════════════════════════
// ── IO ─────────────────────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════════

const lib = (name) => pathToFileURL(join(ROOT, "tools", "ops-monitor", "lib", name)).href;

/** specs ops/config.json registerMode; null on any failure (fail open = exclude the register files). */
function readRegisterMode(dir) {
  try {
    const raw = JSON.parse(readFileSync(join(dir, "ops", "config.json"), "utf8"));
    return typeof raw?.registerMode === "string" ? raw.registerMode : null;
  } catch {
    return null;
  }
}

/**
 * Cheap pre-filter run BEFORE any dynamic import: a Write/Edit/MultiEdit must touch a path inside a
 * specs checkout (marker segment, or under the configured specs dir), a SendMessage must read like
 * an assignment (the lead-lane check itself needs lanes-local, loaded only after this passes).
 */
export function cheapCandidate(payload, env = process.env) {
  const tool = payload?.tool_name;
  const input = payload?.tool_input ?? {};
  if (tool === "SendMessage") {
    const text = messageText(input);
    return ASSIGN_RE.test(text) && WORK_REF_RE.test(text);
  }
  const raw = input.file_path;
  if (typeof raw !== "string" || !raw) return false;
  const base = payload.cwd ?? process.cwd();
  const file = isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw) ? raw : resolve(base, raw);
  // Same default as lib/config.mjs specsDir(), without importing it.
  const home = env.RF_OPS_HOME ? resolve(env.RF_OPS_HOME) : join(homedir(), ".routeflow", "ops");
  const root = env.RF_SPECS_DIR ? resolve(env.RF_SPECS_DIR) : join(home, "routeflow-specs");
  return specsRelative(file, root) !== null;
}

async function main() {
  if (process.env.RF_OPS_GATE === "off" || process.env.CI) return;
  let payload;
  try {
    payload = JSON.parse(readFileSync(0, "utf8") || "{}");
  } catch {
    return;
  }
  if (!payload || typeof payload !== "object" || !payload.session_id) return;
  if (!["Write", "Edit", "MultiEdit", "SendMessage"].includes(payload.tool_name)) return;
  if (!cheapCandidate(payload)) return; // most Write/Edit calls end here, before any import
  if (!existsSync(join(ROOT, "tools", "ops-monitor", "bin", "rf.mjs"))) return;

  const { opsHome, specsDir } = await import(lib("config.mjs"));
  const { laneForCwd } = await import(lib("lanes-local.mjs"));
  const { actionsFile, appendAction } = await import(lib("turn-actions.mjs"));
  const home = opsHome();
  const lane =
    payload.tool_name === "SendMessage"
      ? laneForCwd(payload.cwd ?? process.cwd(), process.env, { home })
      : null;
  const root = specsDir();
  const actions = planActions(payload, {
    lane,
    specsRoot: root,
    registerMode: readRegisterMode(root),
  });
  if (actions.length === 0) return;
  const file = actionsFile(home, payload.session_id);
  for (const a of actions) appendAction(file, a);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    await main();
  } catch {
    // swallow everything: exit 0, silently.
  }
  process.exitCode = 0;
}
