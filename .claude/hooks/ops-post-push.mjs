#!/usr/bin/env node
/**
 * PostToolUse (matcher: Bash) recorder for the ops monitor. When the Bash command that just
 * ran was a REAL `git push` or `gh pr create|ready|merge|close|edit` against
 * najathakram/routeflow, it (1) appends the action to this session's turn-actions file (the
 * Stop gate, ops-stop.mjs, reads it) and (2) spawns `rf event push|pr` DETACHED so the event
 * is written without slowing the tool call.
 *
 * Truth, not output text: a push counts only when the local tracking ref
 * (refs/remotes/<remote>/<branch>) equals the commit that was pushed, which git updates only on
 * a successful push. A gh merge/create counts only when its own success line / URL is in the
 * output. Background calls (run_in_background) are ignored: their output says nothing.
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
const PR_VERBS = ["create", "ready", "merge", "close", "edit"];
const MERGED_RE = /(?:Squashed and merged|Merged|Rebased and merged) pull request #?(\d+)/i;
const PR_URL_RE = /github\.com\/najathakram\/routeflow\/pull\/(\d+)/;
const PR_ERROR_RE = /^(GraphQL|HTTP \d{3}|error|failed|no pull requests? found)/im;

// ════════════════════════════════════════════════════════════════════════
// PURE
// ════════════════════════════════════════════════════════════════════════

/** Removes heredoc bodies (`<<[-~]?'WORD'` ... line equal to WORD); the opener line stays. */
function stripHeredocs(cmd) {
  const out = [];
  const pending = [];
  for (const line of String(cmd ?? "").split("\n")) {
    if (pending.length) {
      const cur = pending[0];
      if ((cur.dash ? line.trim() : line.replace(/\r$/, "")) === cur.word) pending.shift();
      continue;
    }
    out.push(line);
    for (const m of line.matchAll(/(?<!<)<<(?!<)([-~]?)\s*(?:'([^']*)'|"([^"]*)"|(\w+))/g)) {
      pending.push({ dash: m[1] !== "", word: m[2] ?? m[3] ?? m[4] });
    }
  }
  return out.join("\n");
}

/** Index just past the `)` closing the `$(` whose `(` is at i (parens counted; else the end). */
function skipSubstitution(s, i) {
  let depth = 0;
  for (let j = i + 1; j < s.length; j++) {
    if (s[j] === "(") depth++;
    else if (s[j] === ")" && --depth === 0) return j + 1;
  }
  return s.length;
}

/**
 * Command segments: heredoc bodies removed; split on `&& || ; | &` and newlines only OUTSIDE
 * quotes; `$(...)` and backtick spans dropped entirely (they run, but are not the command).
 */
export function splitCommand(cmd) {
  const s = stripHeredocs(cmd);
  const segs = [];
  let cur = "";
  let q = null;
  const cut = () => {
    segs.push(cur);
    cur = "";
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q === "'") {
      cur += c;
      if (c === "'") q = null;
      continue;
    }
    if (c === "\\") {
      cur += s[i + 1] === "\n" ? " " : c + (s[i + 1] ?? "");
      i++;
      continue;
    }
    if (c === "`") {
      const end = s.indexOf("`", i + 1);
      i = end < 0 ? s.length : end;
      continue;
    }
    if (c === "$" && s[i + 1] === "(") {
      i = skipSubstitution(s, i + 1) - 1;
      continue;
    }
    if (q === '"') {
      cur += c;
      if (c === '"') q = null;
      continue;
    }
    if (c === "'" || c === '"') {
      q = c;
      cur += c;
    } else if (c === ";" || c === "\n") cut();
    else if (c === "|") {
      if (s[i + 1] === "|") i++;
      cut();
    } else if (c === "&" && s[i + 1] === "&") {
      i++;
      cut();
    } else if (c === "&" && s[i + 1] !== ">" && s[i - 1] !== ">" && s[i - 1] !== "<") cut();
    else cur += c;
  }
  cut();
  return segs.filter((x) => x.trim() !== "");
}

/** Words of one segment, quotes resolved; each is { text, quoted }. */
function lex(segment) {
  const out = [];
  let tok = null;
  let q = null;
  const open = () => (tok ??= { text: "", quoted: false });
  const s = String(segment);
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q) q = null;
      else if (c === "\\" && q === '"' && /["\\$`]/.test(s[i + 1] ?? "")) tok.text += s[++i];
      else tok.text += c;
    } else if (c === "'" || c === '"') {
      open().quoted = true;
      q = c;
    } else if (c === "\\") {
      if (i + 1 < s.length && s[i + 1] !== "\n") open().text += s[i + 1];
      i++;
    } else if (/\s/.test(c)) {
      if (tok) out.push(tok);
      tok = null;
    } else open().text += c;
  }
  if (tok) out.push(tok);
  return out;
}

/**
 * Words of a segment: quotes resolved (`VAR="a b"` is one word), leading `NAME=value` words
 * and unquoted redirections (`2>&1`, `>f`, `> f`, `<f`, `&>f`) dropped.
 */
export function tokenize(segment) {
  const toks = lex(segment);
  const words = [];
  let leading = true;
  for (let i = 0; i < toks.length; i++) {
    const { text, quoted } = toks[i];
    if (leading && /^[A-Za-z_][A-Za-z0-9_]*=/.test(text)) continue;
    leading = false;
    const r = quoted ? null : /^(?:\d*|&)(?:>>|>\||>|<)(.*)$/.exec(text);
    if (r) {
      if (r[1] === "") i++; // `> file`: the file word goes too
      continue;
    }
    words.push(text);
  }
  return words;
}

/** Strips `git -C <dir>` and `git -c k=v`; null when the words are not a git command. */
function normalizeGit(tokens) {
  if (tokens[0] !== "git") return null;
  let i = 1;
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

/** The PR number a gh call really acted on, or null when its output does not show success. */
function prNumber(verb, args, stdout, text) {
  const fromArg = () => {
    for (const a of args) {
      if (/^\d+$/.test(a)) return Number(a);
      const u = /\/pull\/(\d+)/.exec(a);
      if (u) return Number(u[1]);
    }
    return null;
  };
  if (verb === "merge") {
    const m = MERGED_RE.exec(text);
    return m ? Number(m[1]) : null;
  }
  if (verb === "create") {
    const m = PR_URL_RE.exec(stdout);
    return m ? Number(m[1]) : null;
  }
  // ready / close / edit: a PR reference in the output and no error line.
  if (PR_ERROR_RE.test(text)) return null;
  const ref = /#(\d+)/.exec(text) ?? PR_URL_RE.exec(text);
  if (!ref) return null;
  return fromArg() ?? Number(ref[1]);
}

function prAction(tokens, stdout, text) {
  const i = tokens.indexOf("pr");
  const verb = tokens[i + 1];
  if (!PR_VERBS.includes(verb)) return null;
  const args = tokens.slice(i + 2);
  for (let k = 0; k < args.length; k++) {
    let repo = null;
    if (args[k] === "--repo" || args[k] === "-R") repo = args[k + 1];
    else if (args[k].startsWith("--repo=")) repo = args[k].slice(7);
    if (repo && !/najathakram\/routeflow$/i.test(repo)) return null;
  }
  const number = prNumber(verb, args, stdout, text);
  return number === null ? null : { kind: "pr", action: verb, number };
}

/**
 * Candidate actions in one Bash command (pushes still need the tracking-ref check in IO).
 * response = { stdout, stderr, interrupted }. Background calls are filtered by the caller.
 */
export function detectOpsActions(command, response = {}) {
  if (response?.interrupted) return [];
  const stdout = String(response?.stdout ?? "");
  const text = `${stdout}\n${String(response?.stderr ?? "")}`;
  const out = [];
  for (const raw of splitCommand(command)) {
    const tokens = tokenize(raw);
    const g = normalizeGit(tokens);
    if (g && g.rest[0] === "push") {
      const a = pushAction(g.rest.slice(1), g.dir);
      if (a) out.push(a);
    } else if (tokens[0] === "gh" && tokens[1] === "pr") {
      const a = prAction(tokens.slice(1), stdout, text);
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

/** Source ref of a push refspec (`+src:dst` -> src); HEAD when none. */
export function sourceFromRefspec(refspec) {
  const src = refspec ? refspec.replace(/^\+/, "").split(":")[0] : "";
  return src || "HEAD";
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

/**
 * { branch, sha } when the tracking ref equals the commit that was pushed, else null. One
 * rev-parse when the refspec names the destination; one extra call to learn the current branch
 * otherwise (`--abbrev-ref` cannot share a call: it abbreviates every later argument).
 */
function verifiedPush(cwd, remote, refspec) {
  let branch = branchFromRefspec(refspec);
  if (!branch) {
    const head = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
    if (!head || head === "HEAD") return null;
    branch = head;
  }
  const [pushed, tracked] = git(cwd, [
    "rev-parse",
    sourceFromRefspec(refspec),
    `refs/remotes/${remote}/${branch}`,
  ]).split(/\r?\n/);
  if (!/^[0-9a-f]{40}$/.test(pushed ?? "") || pushed !== tracked) return null;
  return { branch, sha: pushed };
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
  if (payload?.tool_input?.run_in_background === true) return;
  const command = payload?.tool_input?.command;
  if (typeof command !== "string" || !/\bgit\b|\bgh\b/.test(command)) return;
  if (!existsSync(join(ROOT, "tools", "ops-monitor", "bin", "rf.mjs"))) return;

  const actions = detectOpsActions(command, payload.tool_response ?? {});
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
    if (!REPO_URL_RE.test(git(cwd, ["config", "--get", `remote.${remote}.url`]))) continue;
    const ts = Date.now();
    if (a.kind === "push") {
      const v = verifiedPush(cwd, remote, a.refspec);
      if (!v) continue;
      appendAction(file, { ts, kind: "push", branch: v.branch, sha: v.sha });
      const args = ["event", "push", "--branch", v.branch, "--sha", v.sha];
      spawnRecorder([...args, "--repo", "najathakram/routeflow", "--quiet"], env);
    } else {
      // After a merge the checkout may already be back on master; that names no PR branch.
      const head = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
      const branch = head && !["HEAD", "master", "main"].includes(head) ? head : null;
      appendAction(file, { ts, kind: "pr", action: a.action, number: a.number, branch });
      const args = ["event", "pr", "--number", String(a.number), "--action", a.action];
      if (branch) args.push("--branch", branch);
      spawnRecorder([...args, "--quiet"], env);
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
