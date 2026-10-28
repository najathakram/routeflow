#!/usr/bin/env node
// Frozen eval set for routine changes: a fixed set of past tasks, re-run when a skill, hook, model or routing
// rule changes, graded on end state. `run` comes in R6-b2; `report` (pass^k, pass@1, --vs) and --sample in R6-b3.
//
//   node scripts/factory-eval.mjs select --since <YYYY-MM-DD> [--landings <file>]   (read-only, proposes)
//   node scripts/factory-eval.mjs prepare <id> [--dir <d>]    detached worktree at baseSha + BRIEF.md
//   node scripts/factory-eval.mjs grade <id> --tree <d>       pass | fail | broken; exit 0 only on pass
//   node scripts/factory-eval.mjs cleanup <tree>              unlink every link in it, remove the tree
//   common: --repo <dir> --tasks <dir> --include-example
//
// A task (evals/factory/tasks/<id>.json, schema in its README) is a real past change: the repo at the parent
// of the change (baseSha), the brief an agent gets, and the change's own test files at its merge sha
// (hiddenTests, copied in only at grading time). Tests run through R4's runner table (defaultRun in
// fix-revert-probe.mjs); the size limit for candidates is R3's WARN_AT. `select` prefers R1's landing
// telemetry and falls back to gh; it never prints a live-tenant identifier, only that a candidate was dropped.
// Dark: no gate calls this.
// Exit: 0 ok, 1 a graded tree did not pass, 2 bad usage.
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scrubbedGitEnv } from "./lib/check-git-hooks.mjs";
import { WARN_AT, countLines, rowsFromGhFiles } from "./lib/pr-size.mjs";
import { CLASSES, classifyDiff } from "./lib/risk-paths.mjs";
import { defaultRun, gitIn, nodeModulesDirs, unlink } from "./fix-revert-probe.mjs";
import { isTestFile } from "./test-tamper-check.mjs";

const { isTestTenant } = createRequire(import.meta.url)("./lib/test-tenants.cjs");
const SCRIPT = fileURLToPath(import.meta.url);
const EVALS = path.join(path.dirname(SCRIPT), "..", "evals", "factory");
const TASKS = path.join(EVALS, "tasks");
export const SELECT_MAX_LINES = WARN_AT;
const GH_LIMIT = 200;
const EVAL_LOCK = "rf-eval"; // prepare's own lock reason: cleanup touches no other tree (not R4's rf-probe)
const OWNER_FILE = "rf-eval-owner"; // second ownership factor, in the tree's own per-worktree gitdir
export const RUN_ID = `${randomUUID()}-${process.pid}-${Date.now()}`;
const TOKEN = /^rf-eval-owner v1 run=(\S+) pid=\d+ at=\S+\s*$/;
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const toplevel = (dir) =>
  realpathSync.native(gitIn(dir ?? process.cwd(), ["rev-parse", "--show-toplevel"]).stdout.trim());
const HEX = /^[0-9a-f]{7,40}$/i;
const samePath = (a, b) =>
  process.platform === "win32"
    ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
    : path.resolve(a) === path.resolve(b);
const isHidden = (printed, h, tree) => {
  const p = printed
    .trim()
    .replace(/^file:\/\//, "")
    .replace(/^\/([a-z]:)/i, "$1")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");
  if (path.isAbsolute(p) || /^[a-z]:\//i.test(p)) return samePath(p, path.join(tree, h.path));
  const hp = h.path.replace(/\\/g, "/");
  return p === hp || hp.endsWith(`/${p}`);
};

/** Errors for one task object, each starting with the field name; [] when valid. */
export function validateTask(t) {
  if (!t || typeof t !== "object") return ["task: not an object"];
  const errs = [];
  const bad = (field, why) => errs.push(`${field}: ${why}`);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(t.id ?? "")) bad("id", "required; lower-case, digits, dashes");
  if (!["bug", "feature"].includes(t.kind)) bad("kind", "bug or feature");
  if (!CLASSES.includes(t.risk)) bad("risk", `one of ${CLASSES.join(", ")}`);
  if (!Number.isInteger(t.sourcePr) || t.sourcePr < 1) bad("sourcePr", "required PR number");
  if (!HEX.test(t.baseSha ?? "")) bad("baseSha", "required commit sha");
  if (typeof t.brief !== "string" || !t.brief.trim()) bad("brief", "required text");
  const ht = t.hiddenTests;
  const relative = (p) =>
    typeof p === "string" &&
    !path.isAbsolute(p) &&
    !/^[a-z]:/i.test(p) &&
    p.split(/[\\/]/).every((s) => s && s !== ".." && s !== "node_modules");
  if (!Array.isArray(ht) || !ht.length) bad("hiddenTests", "required; a list of { path, fromSha }");
  else if (!ht.every((h) => relative(h?.path) && HEX.test(h.fromSha ?? "")))
    bad("hiddenTests", "each entry needs a relative path and a fromSha");
  const g = t.grade;
  if (g !== undefined && !(Array.isArray(g) && g.length && g.every((s) => typeof s === "string")))
    bad("grade", "a command as a list of strings");
  return errs;
}

/** { tasks, errors } for every <id>.json in `dir`; the example task is dropped unless includeExample. */
export function loadTasks(dir, { includeExample = false } = {}) {
  const tasks = [];
  const errors = [];
  for (const f of readdirSync(dir)
    .filter((x) => x.endsWith(".json"))
    .sort()) {
    let t;
    try {
      t = JSON.parse(readFileSync(path.join(dir, f), "utf8"));
    } catch (e) {
      errors.push(`${f}: ${e.message}`);
      continue;
    }
    const errs = validateTask(t);
    if (!errs.length && t.id !== f.slice(0, -5)) errs.push("id: must equal the file name");
    errors.push(...errs.map((e) => `${f}: ${e}`));
    if (!errs.length && (includeExample || t.example !== true)) tasks.push(t);
  }
  return { tasks, errors };
}

const PLACEHOLDER = /^(acme(-|$)|string$|null$|undefined$|true$|false$)/;
const SLUG_REFS = [
  /(?:tenant[_-]?slug|\bslug)["']?\s*[:=]\s*["']?([a-z0-9][a-z0-9-]{1,40})/gi,
  /--(?:tenant|slug)[ =]([a-z0-9][a-z0-9-]{1,40})/gi,
];
const TENANT_UUID = /tenant\w*["']?\s*[:=]\s*["']?[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}/gi;

/**
 * How many live-tenant references `text` holds: a slug that is neither an approved test tenant
 * (scripts/lib/test-tenants.cjs) nor an acme placeholder, a tenant UUID, or any `extra` identifier.
 * Callers report the count only, never the match.
 */
export function liveTenantHits(text, extra = []) {
  let n = (text.match(TENANT_UUID) ?? []).length;
  for (const re of SLUG_REFS)
    for (const m of text.matchAll(re)) {
      const s = m[1].toLowerCase();
      if (!isTestTenant(s) && !PLACEHOLDER.test(s)) n += 1;
    }
  return n + extra.filter((x) => x && text.toLowerCase().includes(x.toLowerCase())).length;
}

const REWORK = /\b(rework|revert|supersede[sd]?|follow-?up|hotfix)\b[^\n]{0,40}#\d+|\brework-of\b/i;

/** Whether a merged PR ({ title, body, files, reworkOf }) may be proposed: { keep, reason, kind }. */
export function keepCandidate(pr, extra = []) {
  const files = pr.files ?? [];
  const drop = (reason) => ({ keep: false, reason });
  const kind = /^fix/i.test(pr.title) ? "bug" : /^feat/i.test(pr.title) ? "feature" : null;
  if (pr.reworkOf != null || REWORK.test(`${pr.title}\n${pr.body ?? ""}`))
    return drop("rework of an earlier PR");
  if (!kind) return drop("not a fix or feat PR");
  if (!files.some((f) => isTestFile(f.path) && f.additions > 0)) return drop("no tests added");
  const lines = countLines(rowsFromGhFiles(files)).counted;
  if (lines > SELECT_MAX_LINES) return drop(`over WARN_AT (${lines} counted lines)`);
  const text = [pr.title, pr.body ?? "", ...files.map((f) => f.path)].join("\n");
  if (liveTenantHits(text, extra)) return drop("live-tenant reference");
  return { keep: true, reason: "ok", kind };
}

/** A detached, locked worktree of `repo` at task.baseSha (node_modules linked in) with BRIEF.md written. */
export async function prepare(task, { repo, dir } = {}) {
  const root = toplevel(repo);
  if (gitIn(root, ["cat-file", "-e", `${task.baseSha}^{commit}`]).status !== 0)
    throw new Error(`baseSha ${task.baseSha} is not reachable in this repo`);
  const tmp = dir ? null : realpathSync.native(mkdtempSync(path.join(tmpdir(), "rf-eval-")));
  const tree = dir ? path.resolve(dir) : path.join(tmp, "wt");
  let added = false;
  let held = false;
  const cleanup = () => {
    if (held && !cleanupTree(tree, { repo: root, runId: RUN_ID }))
      throw new Error(`could not remove the eval tree ${tree}; see the message above`);
    if (added && !held) gitIn(root, ["worktree", "remove", "--force", tree]); // unlocked: no links yet
    gitIn(root, ["worktree", "prune"]);
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  };
  try {
    const add = gitIn(root, ["worktree", "add", "--detach", tree, task.baseSha]);
    if (add.status !== 0) throw new Error(`git worktree add failed: ${add.stderr}`);
    added = true;
    const gitDir = gitIn(tree, ["rev-parse", "--path-format=absolute", "--git-dir"]).stdout.trim();
    writeFileSync(
      path.join(gitDir, OWNER_FILE),
      `rf-eval-owner v1 run=${RUN_ID} pid=${process.pid} at=${new Date().toISOString()}
`,
    );
    const locked = gitIn(root, ["worktree", "lock", "--reason", EVAL_LOCK, tree]);
    if (locked.status !== 0) throw new Error(`git worktree lock failed: ${locked.stderr}`);
    held = true;
    for (const d of nodeModulesDirs(root)) {
      const link = path.join(tree, d, "node_modules");
      mkdirSync(path.dirname(link), { recursive: true });
      symlinkSync(path.join(root, d, "node_modules"), link, "junction");
    }
    writeFileSync(path.join(tree, "BRIEF.md"), `# ${task.id}\n\n${task.brief}\n`);
  } catch (e) {
    try {
      cleanup();
    } catch {
      // already reported; the original error matters more
    }
    throw e;
  }
  return { tree, cleanup };
}

export const cleanupCommand = (tree) => `node scripts/factory-eval.mjs cleanup "${tree}"`;

/**
 * Removes a tree prepare() made: unlinks its node_modules links first and proves them gone (a recursive remove
 * must never walk through a junction into the caller's node_modules), then unlocks and removes the worktree.
 * Returns false, leaving the tree, when a link would not go. Throws, touching nothing, for a directory that is no
 * linked worktree, whose worktree does not carry prepare's "rf-eval" lock, or whose own gitdir lacks prepare's
 * owner token (a lane's tree, even one locked "rf-eval"). With `runId` the token must name that run; without it
 * (a later sweep) the token must still parse as an rf-eval token.
 */
export function cleanupTree(tree, { repo, runId } = {}) {
  const dir = path.resolve(tree);
  const rev = (...a) =>
    (gitIn(dir, ["rev-parse", "--path-format=absolute", ...a]).stdout ?? "").trim();
  const common = existsSync(dir) ? rev("--git-common-dir") : "";
  if (!common || rev("--git-dir") === common) throw new Error(`${dir} is not a linked worktree`);
  const root = toplevel(repo ?? path.dirname(common));
  const ours = gitIn(root, ["worktree", "list", "--porcelain"])
    .stdout.split(/\r?\n\r?\n/)
    .some((b) => {
      const at = b.match(/^worktree (.+?)\r?$/m)?.[1];
      const lockedOurs = new RegExp(`^locked ${EVAL_LOCK}\r?$`, "m").test(b);
      return at && samePath(at, realpathSync.native(dir)) && lockedOurs;
    });
  if (!ours)
    throw new Error(`${dir} is not a tree prepare made (no "${EVAL_LOCK}" lock); left in place`);
  const tokenFile = path.join(rev("--git-dir"), OWNER_FILE);
  const tokenRun = existsSync(tokenFile) ? readFileSync(tokenFile, "utf8").match(TOKEN)?.[1] : null;
  if (!tokenRun || (runId && tokenRun !== runId))
    throw new Error(
      `${dir} carries the "${EVAL_LOCK}" lock but no matching owner token (${OWNER_FILE}); left in place`,
    );
  const isLink = (l) => {
    try {
      return lstatSync(l).isSymbolicLink();
    } catch {
      return false;
    }
  };
  const links = nodeModulesDirs(dir)
    .map((d) => path.join(dir, d, "node_modules"))
    .filter(isLink);
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const f = path.join(d, name);
      if (isLink(f)) links.push(f);
      else if (name !== ".git" && lstatSync(f).isDirectory()) walk(f);
    }
  };
  walk(dir);
  if (!links.map(unlink).every(Boolean)) {
    console.error(`factory-eval: could not unlink every link in it; left ${dir} in place.`);
    return false;
  }
  gitIn(root, ["worktree", "unlock", dir]);
  gitIn(root, ["worktree", "remove", "--force", dir]);
  gitIn(root, ["worktree", "prune"]);
  if (existsSync(dir)) {
    console.error(
      `factory-eval: ${dir} is still on disk after the remove (a process holding it?); ` +
        `git no longer tracks it — remove it by hand.`,
    );
    return false;
  }
  if (path.basename(path.dirname(dir)).startsWith("rf-eval-"))
    try {
      rmdirSync(path.dirname(dir)); // prepare's own temp parent, once empty
    } catch {
      // not empty: leave it
    }
  return true;
}

/** Copies the hidden tests into `tree`, runs them (R4's runner), then the extra command: { result, reason }. */
export async function grade(task, tree, { run = defaultRun } = {}) {
  // Only a tree prepare() made: a linked worktree's own toplevel, holding BRIEF.md, at or after baseSha.
  const rev = (...a) => gitIn(tree, ["rev-parse", "--path-format=absolute", ...a]).stdout.trim();
  const ok =
    rev("--git-dir") !== rev("--git-common-dir") &&
    toplevel(tree) === realpathSync.native(tree) &&
    existsSync(path.join(tree, "BRIEF.md")) &&
    gitIn(tree, ["merge-base", "--is-ancestor", task.baseSha, "HEAD"]).status === 0;
  if (!ok) throw new Error(`${tree} is not a prepared eval tree (run prepare first)`);
  for (const h of task.hiddenTests) {
    const r = gitIn(tree, ["show", `${h.fromSha}:${h.path}`]);
    if (r.status !== 0)
      return { result: "broken", reason: `cannot read ${h.path} at ${h.fromSha}` };
    mkdirSync(path.dirname(path.join(tree, h.path)), { recursive: true });
    writeFileSync(path.join(tree, h.path), r.stdout);
  }
  const fails = [];
  for (const h of task.hiddenTests) {
    const o = run(h.path, tree);
    if (o.skip) return { result: "broken", reason: `${h.path}: ${o.skip}` };
    if (o.status === null)
      return { result: "broken", reason: `${h.path}: timed out or could not start` };
    if (o.status === 0) continue;
    // A hidden spec stopped by its own compiler errors before any test ran cannot run: broken. A compiler
    // error in the agent's code (isolatedModules: only syntax errors reach the runner) is the agent's fail.
    const out = (o.output ?? "").replace(ANSI, "");
    const tsAt = [...out.matchAll(/^\s*(\S+?):\d+:\d+ - error TS\d+/gm)].map((m) => m[1]);
    const own = tsAt.length > 0 && tsAt.every((f) => isHidden(f, h, tree));
    if (own && !/^Tests:\s+[1-9]/m.test(out))
      return { result: "broken", reason: `${h.path}: TypeScript diagnostics, no tests ran` };
    // A syntax error located in the hidden test itself means it cannot run; one in the agent's code is a fail.
    const [before, after] = out.split(/SyntaxError/);
    const at = before.split("\n").findLast((l) => /:\d+\s*$/.test(l)) ?? "";
    if (after !== undefined && at && isHidden(at.replace(/:\d+(:\d+)?\s*$/, ""), h, tree))
      return { result: "broken", reason: `${h.path}: SyntaxError${after.split("\n")[0]}` };
    fails.push(`${h.path}: exit ${o.status}`);
  }
  if (fails.length) return { result: "fail", reason: fails.join("; ") };
  if (task.grade) {
    const [bin, ...args] = task.grade;
    const opts = { cwd: tree, env: scrubbedGitEnv(), encoding: "utf8", timeout: 300000 };
    const r = spawnSync(bin === "node" ? process.execPath : bin, args, opts);
    if (r.error) return { result: "broken", reason: `grade command: ${r.error.message}` };
    if (r.status !== 0) return { result: "fail", reason: `grade command exited ${r.status}` };
  }
  return { result: "pass", reason: "hidden tests pass" };
}

// ---- select ----

/** The merged-PR list from gh may be cut at its limit; say so when it is exactly full. */
export const truncationWarning = (count) =>
  count === GH_LIMIT
    ? `gh returned exactly ${GH_LIMIT} PRs, so the list may be truncated; narrow --since`
    : null;

/** R1 landing rows, latest per PR: { rows, malformed }. A bad row is skipped and counted, never echoed. */
export function readLandings(file) {
  const rows = new Map();
  let malformed = 0;
  const lines = existsSync(file) ? readFileSync(file, "utf8").split("\n") : [];
  for (const l of lines.filter((x) => x.trim())) {
    let r = null;
    try {
      r = JSON.parse(l);
    } catch {
      // counted below
    }
    const ok =
      Number.isInteger(r?.pr) && [r?.computedAt, r?.mergedAt].every((x) => typeof x === "string");
    if (!ok) malformed += 1;
    else if (!rows.has(r.pr) || r.computedAt >= rows.get(r.pr).computedAt) rows.set(r.pr, r);
  }
  return { rows, malformed };
}

const gh = (args) =>
  JSON.parse(execFileSync("gh", args, { encoding: "utf8", maxBuffer: 1 << 28, timeout: 120000 }));

const homeOf = (root) =>
  path.dirname(
    gitIn(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).stdout.trim(),
  );

/** Read-only: merged PRs since a date that fit the rules, printed as task skeletons for a human to pick from. */
function select(o, root) {
  const file = o.landings ?? path.join(homeOf(root), "local-assets/telemetry/landings.jsonl");
  const { rows, malformed } = readLandings(file);
  const list = ["pr", "list", "--state", "merged", "--limit", String(GH_LIMIT), "--json", "number"];
  const logged = [...rows.values()].filter((r) => r.mergedAt >= o.since).map((r) => r.pr);
  let numbers = logged;
  if (!logged.length) {
    numbers = gh([...list, "--search", `merged:>=${o.since}`]).map((p) => p.number);
    const warn = truncationWarning(numbers.length);
    if (warn) console.error(`factory-eval select: ${warn}`);
  }
  const denyFile = process.env.EVAL_LIVE_DENYLIST; // machine-local extra identifiers, one per line
  const extra = denyFile && existsSync(denyFile) ? readFileSync(denyFile, "utf8").split("\n") : [];
  const picked = [];
  const dropped = {};
  for (const number of numbers) {
    const pr = gh(["pr", "view", String(number), "--json", "number,title,body,files,mergeCommit"]);
    const v = keepCandidate({ ...pr, reworkOf: rows.get(number)?.reworkOf }, extra);
    const sha = pr.mergeCommit?.oid;
    const base = sha ? gitIn(root, ["rev-parse", `${sha}^`]) : { status: 1 };
    const tests = pr.files.filter((f) => f.additions > 0 && isTestFile(f.path)).map((f) => f.path);
    let why = v.keep ? null : v.reason;
    if (!why && base.status !== 0) why = "merge commit not in this clone";
    if (
      !why &&
      tests.some((p) => liveTenantHits(gitIn(root, ["show", `${sha}:${p}`]).stdout, extra))
    )
      why = "live-tenant reference";
    if (why) {
      const key = why.replace(/ \(.*\)/, "");
      dropped[key] = (dropped[key] ?? 0) + 1;
    } else
      picked.push({
        id: `acme-pr${number}`,
        kind: v.kind,
        risk: classifyDiff(pr.files.map((f) => f.path)).cls,
        sourcePr: number,
        baseSha: base.stdout.trim(),
        brief: "TODO: scrub the issue or spec text to acme-style names",
        hiddenTests: tests.map((p) => ({ path: p, fromSha: sha })),
      });
  }
  console.log(JSON.stringify(picked, null, 2));
  const skipped = malformed ? `; skipped ${malformed} malformed landings rows` : "";
  console.error(
    `factory-eval select: ${picked.length} candidates; dropped ${JSON.stringify(dropped)}${skipped}`,
  );
}

export async function main(argv) {
  const [cmd, ...rest] = argv;
  const o = { _: [] };
  for (let i = 0; i < rest.length; i++) {
    if (!rest[i].startsWith("--")) o._.push(rest[i]);
    else if (rest[i] === "--include-example") o.includeExample = true;
    else o[rest[i].slice(2)] = rest[++i];
  }
  const usage = (m) => (console.error(`factory-eval: ${m}`), 2);
  if (cmd === "cleanup") {
    if (!o._[0] || !existsSync(path.join(o._[0], "BRIEF.md")))
      return usage("cleanup needs the <tree> that prepare printed (it holds BRIEF.md)");
    return cleanupTree(o._[0], { repo: o.repo }) ? 0 : 1;
  }
  const root = toplevel(o.repo);
  if (cmd === "select")
    return o.since ? (select(o, root), 0) : usage("select needs --since <date>");
  if (!["prepare", "grade"].includes(cmd))
    return usage("commands: select | prepare | grade | cleanup");
  const { tasks, errors } = loadTasks(o.tasks ?? TASKS, { includeExample: o.includeExample });
  if (errors.length) return usage(`task files are invalid:\n  ${errors.join("\n  ")}`);
  const byId = (id) => tasks.find((t) => t.id === id);
  const task = byId(o._[0]);
  if (!task) return usage(`no task "${o._[0]}" (the example needs --include-example)`);
  if (cmd === "prepare") {
    const { tree } = await prepare(task, { repo: root, dir: o.dir });
    console.log(tree);
    console.error(`factory-eval: when done, remove it with: ${cleanupCommand(tree)}`);
    return 0;
  }
  if (!o.tree) return usage("grade needs --tree <dir>");
  const g = await grade(task, path.resolve(o.tree));
  console.log(JSON.stringify(g));
  return g.result === "pass" ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`factory-eval: ${e instanceof Error ? e.message : e}`);
      process.exit(2);
    },
  );
}
