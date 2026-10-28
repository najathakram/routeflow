#!/usr/bin/env node
// Frozen eval set for routine changes (R6-a): a fixed set of past tasks, re-run when a skill, hook, model or
// routing rule changes, graded on end state. This half picks and grades; `run` and `report` come in R6-b.
//
//   node scripts/factory-eval.mjs select --since <YYYY-MM-DD> [--landings <file>]   (read-only, proposes)
//   node scripts/factory-eval.mjs prepare <id> [--dir <d>]    detached worktree at baseSha + BRIEF.md
//   node scripts/factory-eval.mjs grade <id> --tree <d>       pass | fail | broken; exit 0 only on pass
//   common: --repo <dir> --tasks <dir> --include-example
//
// A task (evals/factory/tasks/<id>.json, schema in its README) is a real past change: the repo at the parent
// of the change (baseSha), the brief an agent gets, and the change's own test files at its merge sha
// (hiddenTests, copied in only at grading time). Tests run through R4's runner table (defaultRun in
// fix-revert-probe.mjs); the size limit for candidates is R3's WARN_AT. `select` prefers R1's landing
// telemetry and falls back to gh; it never prints a live-tenant identifier, only that a candidate was dropped.
// Exit: 0 ok, 1 a graded tree did not pass, 2 bad usage.
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scrubbedGitEnv } from "./lib/check-git-hooks.mjs";
import { WARN_AT, countLines, rowsFromGhFiles } from "./lib/pr-size.mjs";
import { CLASSES, classifyDiff } from "./lib/risk-paths.mjs";
import { defaultRun, gitIn, lockWorktree, nodeModulesDirs, unlink } from "./fix-revert-probe.mjs";
import { isTestFile } from "./test-tamper-check.mjs";

const { isTestTenant } = createRequire(import.meta.url)("./lib/test-tenants.cjs");
const SCRIPT = fileURLToPath(import.meta.url);
const TASKS = path.join(path.dirname(SCRIPT), "..", "evals", "factory", "tasks");
export const SELECT_MAX_LINES = WARN_AT;
const toplevel = (dir) =>
  realpathSync.native(gitIn(dir ?? process.cwd(), ["rev-parse", "--show-toplevel"]).stdout.trim());
const HEX = /^[0-9a-f]{7,40}$/i;

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
    typeof p === "string" && p && !path.isAbsolute(p) && !/(^|[\\/])\.\.[\\/]/.test(p);
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
  const links = [];
  let added = false;
  const cleanup = () => {
    // Links first: a recursive remove must never walk through a junction into the caller's node_modules.
    if (!links.map(unlink).every(Boolean))
      return console.error(`factory-eval: could not unlink node_modules; left ${tree} in place.`);
    if (added) {
      gitIn(root, ["worktree", "unlock", tree]);
      gitIn(root, ["worktree", "remove", "--force", tree]);
    }
    gitIn(root, ["worktree", "prune"]);
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  };
  try {
    const add = gitIn(root, ["worktree", "add", "--detach", tree, task.baseSha]);
    if (add.status !== 0) throw new Error(`git worktree add failed: ${add.stderr}`);
    added = true;
    const locked = lockWorktree(root, tree);
    if (locked.status !== 0) throw new Error(`git worktree lock failed: ${locked.stderr}`);
    for (const d of nodeModulesDirs(root)) {
      const link = path.join(tree, d, "node_modules");
      mkdirSync(path.dirname(link), { recursive: true });
      symlinkSync(path.join(root, d, "node_modules"), link, "junction");
      links.push(link);
    }
    writeFileSync(path.join(tree, "BRIEF.md"), `# ${task.id}\n\n${task.brief}\n`);
  } catch (e) {
    cleanup();
    throw e;
  }
  return { tree, cleanup };
}

/** Copies the hidden tests into `tree`, runs them (R4's runner), then the extra command: { result, reason }. */
export async function grade(task, tree, { run = defaultRun } = {}) {
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
    if (o.status === null) return { result: "broken", reason: `${h.path}: timed out` };
    // A syntax error located in the hidden test itself means it cannot run; one in the agent's code is a fail.
    const [before, after] = (o.output ?? "").split(/SyntaxError/);
    const at = before.split("\n").findLast((l) => /:\d+\s*$/.test(l)) ?? "";
    if (after !== undefined && at.includes(path.basename(h.path)))
      return { result: "broken", reason: `${h.path}: SyntaxError${after.split("\n")[0]}` };
    if (o.status !== 0) fails.push(`${h.path}: exit ${o.status}`);
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

const gh = (args) =>
  JSON.parse(execFileSync("gh", args, { encoding: "utf8", maxBuffer: 1 << 28, timeout: 120000 }));

/** Read-only: merged PRs since a date that fit the rules, printed as task skeletons for a human to pick from. */
function select(o, root) {
  const common = gitIn(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).stdout;
  const file =
    o.landings ?? path.join(path.dirname(common.trim()), "local-assets/telemetry/landings.jsonl");
  const rows = new Map(); // R1 landing rows, latest per PR
  if (existsSync(file))
    for (const l of readFileSync(file, "utf8").split("\n").filter(Boolean)) {
      const r = JSON.parse(l);
      if (!rows.has(r.pr) || r.computedAt >= rows.get(r.pr).computedAt) rows.set(r.pr, r);
    }
  const list = ["pr", "list", "--state", "merged", "--limit", "200", "--json", "number"];
  const logged = [...rows.values()].filter((r) => r.mergedAt >= o.since).map((r) => r.pr);
  const numbers = logged.length
    ? logged
    : gh([...list, "--search", `merged:>=${o.since}`]).map((p) => p.number);
  const denyFile = process.env.EVAL_LIVE_DENYLIST; // machine-local extra identifiers, one per line
  const extra = denyFile && existsSync(denyFile) ? readFileSync(denyFile, "utf8").split("\n") : [];
  const picked = [];
  const dropped = {};
  for (const number of numbers) {
    const pr = gh(["pr", "view", String(number), "--json", "number,title,body,files,mergeCommit"]);
    const v = keepCandidate({ ...pr, reworkOf: rows.get(number)?.reworkOf }, extra);
    const sha = pr.mergeCommit?.oid;
    const base = sha ? gitIn(root, ["rev-parse", `${sha}^`]) : { status: 1 };
    const tests = pr.files.map((f) => f.path).filter(isTestFile);
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
  console.error(
    `factory-eval select: ${picked.length} candidates; dropped ${JSON.stringify(dropped)}`,
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
  const root = toplevel(o.repo);
  if (cmd === "select")
    return o.since ? (select(o, root), 0) : usage("select needs --since <date>");
  if (cmd !== "prepare" && cmd !== "grade") return usage("commands: select | prepare | grade");
  const { tasks, errors } = loadTasks(o.tasks ?? TASKS, { includeExample: o.includeExample });
  if (errors.length) return usage(`task files are invalid:\n  ${errors.join("\n  ")}`);
  const task = tasks.find((t) => t.id === o._[0]);
  if (!task) return usage(`no task "${o._[0]}" (the example needs --include-example)`);
  if (cmd === "prepare") {
    console.log((await prepare(task, { repo: root, dir: o.dir })).tree);
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
