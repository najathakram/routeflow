#!/usr/bin/env node
/**
 * PostToolUse (matcher: Bash) recorder for the ops monitor. When the Bash command that just
 * ran was a successful `git push` or `gh pr create|ready|merge|close|edit` against
 * najathakram/routeflow, it (1) appends the action to this session's turn-actions file (the
 * Stop gate, ops-stop.mjs, reads it) and (2) spawns `rf event push|pr` DETACHED so the event
 * is written without slowing the tool call.
 *
 * Fail-open contract: any exception, missing file, CI environment or RF_OPS_GATE=off -> exit 0
 * and print nothing. This hook runs in every session of the repo, so a false positive costs
 * more than a missed record.
 *
 * Every export above the "── IO" marker is pure and tested directly.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const REPO_URL_RE = /najathakram\/routeflow(\.git)?\/?$/i;
// Spec regex used `\b(...fatal:|error:...)\b`, which can never match (no word boundary after a
// colon); the colon alternatives are anchored on the left only here.
const PUSH_FAIL_RE = /\b(?:rejected|failed to push|Everything up-to-date)\b|\bfatal:|\berror:/i;
const PR_FAIL_RE = /^(GraphQL|HTTP \d{3}|error|failed)/im;
const PR_VERBS = ["create", "ready", "merge", "close", "edit"];

// ════════════════════════════════════════════════════════════════════════
// PURE
// ════════════════════════════════════════════════════════════════════════

/** Whitespace tokenizer that keeps quoted strings together and strips the quotes. */
export function tokenize(segment) {
  const out = [];
  for (const m of String(segment).matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
    out.push(m[1] ?? m[2] ?? m[3]);
  }
  return out;
}

/** Strips leading `VAR=value` words, `git -C <dir>` and `git -c k=v`; null when not git. */
function normalizeGit(tokens) {
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
  if (tokens[i] !== "git") return null;
  i++;
  let dir = null;
  while (i < tokens.length) {
    if (tokens[i] === "-C" && i + 1 < tokens.length) {
      dir = tokens[i + 1];
      i += 2;
    } else if (tokens[i] === "-c" && i + 1 < tokens.length) {
      i += 2;
    } else break;
  }
  return { rest: tokens.slice(i), dir };
}

function pushAction(args, dir) {
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--delete" || a === "-d" || a === "--dry-run" || a === "-n") return null;
    if (a === "-o" || a === "--push-option" || a === "--repo" || a === "--receive-pack") i++;
    else if (!a.startsWith("-")) positional.push(a);
  }
  const refspec = positional[1] ?? null;
  if (refspec && (refspec.startsWith(":") || refspec.includes("refs/tags/"))) return null;
  const action = { kind: "push", remote: positional[0] ?? null, refspec };
  if (dir) action.dir = dir;
  return action;
}

function prAction(tokens, stdout) {
  const i = tokens.indexOf("pr");
  const verb = tokens[i + 1];
  if (!PR_VERBS.includes(verb)) return null;
  const args = tokens.slice(i + 2);
  let number = null;
  for (const a of args) {
    if (/^\d+$/.test(a)) {
      number = Number(a);
      break;
    }
    const u = /\/pull\/(\d+)/.exec(a);
    if (u) {
      number = Number(u[1]);
      break;
    }
  }
  if (number === null) {
    const m = /\/pull\/(\d+)/.exec(stdout);
    if (m) number = Number(m[1]);
  }
  for (let k = 0; k < args.length; k++) {
    let repo = null;
    if (args[k] === "--repo" || args[k] === "-R") repo = args[k + 1];
    else if (args[k].startsWith("--repo=")) repo = args[k].slice(7);
    if (repo && !/najathakram\/routeflow$/i.test(repo)) return null;
  }
  return { kind: "pr", action: verb, number };
}

/**
 * Actions in one Bash command. `commandSegments` (scripts/work/claude-hook.mjs) splits on
 * `&& || ; | \n`, so `echo git push` (leading token echo) is never an action. IO passes the
 * real one in as `segmentsFn`; the default is the same split.
 * response = { stdout, stderr, interrupted }.
 */
export function detectOpsActions(command, response = {}, segmentsFn) {
  if (response?.interrupted) return [];
  const stdout = String(response?.stdout ?? "");
  const text = `${stdout}\n${String(response?.stderr ?? "")}`;
  const segs = segmentsFn ? segmentsFn(command) : String(command ?? "").split(/&&|\|\||;|\||\n/);
  const out = [];
  for (const raw of segs) {
    const tokens = tokenize(String(raw).trim());
    const g = normalizeGit(tokens);
    if (g && g.rest[0] === "push") {
      if (PUSH_FAIL_RE.test(text)) continue;
      const a = pushAction(g.rest.slice(1), g.dir);
      if (a) out.push(a);
    } else if (tokens[0] === "gh" && tokens[1] === "pr") {
      if (PR_FAIL_RE.test(text)) continue;
      const a = prAction(tokens.slice(1), stdout);
      if (a) out.push(a);
    }
  }
  return out;
}

/** Pushed branch name from a refspec; null when it names the current branch (or nothing). */
export function branchFromRefspec(refspec) {
  if (!refspec) return null;
  const dst = refspec.replace(/^\+/, "").split(":").pop();
  if (!dst || dst === "HEAD") return null;
  return dst.replace(/^refs\/heads\//, "");
}

// ════════════════════════════════════════════════════════════════════════
// ── IO ─────────────────────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════════

function git(cwd, args) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      // git can take ~2 s per process on a loaded Windows host (antivirus); 2 s dropped real pushes.
      timeout: 10000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function spawnRecorder(args, env) {
  try {
    const rf = join(ROOT, "tools", "ops-monitor", "bin", "rf.mjs");
    const child = spawn(process.execPath, [rf, ...args], {
      cwd: ROOT,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env,
    });
    child.unref();
  } catch {
    // best effort
  }
}

const lib = (name) => pathToFileURL(join(ROOT, "tools", "ops-monitor", "lib", name)).href;

async function main() {
  let payload;
  try {
    payload = JSON.parse(readFileSync(0, "utf8") || "{}");
  } catch {
    return;
  }
  if (process.env.RF_OPS_GATE === "off" || process.env.CI) return;
  const command = payload?.tool_input?.command;
  if (typeof command !== "string" || !/\bgit\b|\bgh\b/.test(command)) return;
  if (!existsSync(join(ROOT, "tools", "ops-monitor", "bin", "rf.mjs"))) return;

  const hookUrl = pathToFileURL(join(ROOT, "scripts", "work", "claude-hook.mjs")).href;
  const { commandSegments } = await import(hookUrl);
  const actions = detectOpsActions(command, payload.tool_response ?? {}, commandSegments);
  if (actions.length === 0) return;

  const { opsHome } = await import(lib("config.mjs"));
  const { actionsFile, appendAction } = await import(lib("turn-actions.mjs"));
  const session = String(payload.session_id ?? "");
  const file = actionsFile(opsHome(), session);
  const env = { ...process.env, RF_ACTOR: `hook:${session.slice(0, 8) || "unknown"}` };

  for (const a of actions) {
    const base = payload.cwd ?? process.cwd();
    const cwd = a.dir ? resolve(base, a.dir) : base;
    const remote = a.kind === "push" ? (a.remote ?? "origin") : "origin";
    // Only the product repo; routeflow-specs (or any other remote) never counts.
    if (!REPO_URL_RE.test(git(cwd, ["remote", "get-url", remote]))) continue;
    const head = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const current = head && head !== "HEAD" ? head : null;
    const ts = Date.now();
    if (a.kind === "push") {
      const branch = branchFromRefspec(a.refspec) ?? current;
      const src = a.refspec ? a.refspec.replace(/^\+/, "").split(":")[0] : "HEAD";
      const sha = git(cwd, ["rev-parse", src || "HEAD"]) || git(cwd, ["rev-parse", "HEAD"]);
      if (!branch || !/^[0-9a-f]{7,40}$/.test(sha)) continue;
      appendAction(file, { ts, kind: "push", branch, sha });
      const args = ["event", "push", "--branch", branch, "--sha", sha];
      spawnRecorder([...args, "--repo", "najathakram/routeflow", "--quiet"], env);
    } else {
      // After a merge the checkout may already be back on master; that names no PR branch.
      const branch = current && !["master", "main"].includes(current) ? current : null;
      appendAction(file, { ts, kind: "pr", action: a.action, number: a.number, branch });
      if (a.number) {
        const args = ["event", "pr", "--number", String(a.number), "--action", a.action];
        if (branch) args.push("--branch", branch);
        spawnRecorder([...args, "--quiet"], env);
      }
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    await main();
  } catch {
    // swallow everything: exit 0, silently.
  }
  process.exit(0);
}
