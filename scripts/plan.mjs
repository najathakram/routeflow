#!/usr/bin/env node
// Checks and reads a work plan: docs/plans/<slug>.plan.json (format: docs/plans/README.md).
// Read-only: it never writes and only makes gh read calls.
//
//   node scripts/plan.mjs <file> [--check | --waves | --status] [--json]   (default --check)
//   node scripts/plan.mjs --check-all     every docs/plans/*.plan.json (what `npm run verify` runs)
//
// Every mode checks first and exits 1 on a problem. --waves prints the topological waves (the landing
// order for stacked PRs); --status prints open / merged / closed / missing / error per slice from gh.
// A size over WARN_AT prints a warning (exit 0); over BLOCK_AT it is a problem (both from lib/pr-size.mjs).
// Exit 0 ok (a missing or empty folder is ok for --check-all), 1 problems found, 2 bad usage.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BLOCK_AT, WARN_AT } from "./lib/pr-size.mjs";

const GH_REPO = "najathakram/routeflow";
const GH_TIMEOUT_MS = 30000;
const PLANS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "docs", "plans");
const USAGE = "usage: plan.mjs <file> [--check|--waves|--status] [--json] | --check-all";

// EARS: ubiquitous, event, state, unwanted, optional (all need "shall"), plus a bare capitalised name.
export const EARS_PATTERNS = [
  /^the\s.+\sshall\s/i,
  /^when\s.+,\s*the\s.+\sshall\s/i,
  /^while\s.+,\s*the\s.+\sshall\s/i,
  /^if\s.+,\s*then\s+the\s.+\sshall\s/i,
  /^where\s.+,\s*the\s.+\sshall\s/i,
  /^(?!(?:When|While|If|Where|The)\s)[A-Z][\w-]*\sshall\s/,
];

export function isEars(s) {
  return typeof s === "string" && EARS_PATTERNS.some((re) => re.test(s.trim()));
}

const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const arr = (v) => (Array.isArray(v) ? v : []);
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const strings = (v) => Array.isArray(v) && v.every((x) => typeof x === "string");

/** Kahn layering. Unknown dependencies are ignored here (check reports them). */
export function computeWaves(plan) {
  const slices = arr(plan.slices);
  const known = new Set(slices.map((s) => s.id));
  const deps = new Map(slices.map((s) => [s.id, arr(s.dependsOn).filter((d) => known.has(d))]));
  const done = new Set();
  const waves = [];
  let rest = [...slices].sort(byId);
  while (rest.length) {
    const wave = rest.filter((s) => deps.get(s.id).every((d) => done.has(d)));
    if (!wave.length) return { waves, cycle: findCycle(rest, deps) };
    wave.forEach((s) => done.add(s.id));
    waves.push(wave);
    rest = rest.filter((s) => !done.has(s.id));
  }
  return { waves, cycle: null };
}

// Every slice left over has a dependency that is also left over, so walking them must revisit one.
function findCycle(rest, deps) {
  const left = new Set(rest.map((s) => s.id));
  const trail = [];
  let cur = rest[0].id;
  while (!trail.includes(cur)) {
    trail.push(cur);
    cur = deps
      .get(cur)
      .filter((d) => left.has(d))
      .sort()[0];
  }
  return [...trail.slice(trail.indexOf(cur)), cur];
}

// Shape of every field the graph checks and the gh calls rely on; nothing past this sees a bad type.
function checkTypes(plan) {
  const out = [];
  if (!isObj(plan)) return ["plan is not an object"];
  for (const key of ["slices", "criteria"]) {
    if (!Array.isArray(plan[key])) {
      out.push(`${key} must be an array`);
      continue;
    }
    plan[key].forEach((e, i) => {
      if (!isObj(e)) return out.push(`${key}[${i}] must be an object`);
      if (typeof e.id !== "string" || !e.id) return out.push(`${key}[${i}] has no id`);
      const need = (field, what) => {
        if (e[field] !== undefined && !strings(e[field]))
          out.push(`${e.id}.${field} must be an array of ${what}`);
      };
      need("testIds", "test ids");
      if (key === "criteria") return;
      need("dependsOn", "slice ids");
      need("files", "strings");
      const n = e.estLines;
      if (n !== undefined && !(Number.isInteger(n) && n >= 0))
        out.push(`${e.id}.estLines must be a non-negative integer`);
      if (e.pr != null && !(Number.isInteger(e.pr) && e.pr > 0))
        out.push(`${e.id}.pr must be null or a positive integer`);
      // the branch goes to `gh pr list --head`: a leading "-" would be read as an option
      if (e.branch != null && !(typeof e.branch === "string" && !e.branch.startsWith("-")))
        out.push(`${e.id}.branch must be a string not starting with "-"`);
    });
  }
  return out;
}

/** Returns { problems, warnings } (problems empty = valid). */
export function checkPlan(plan) {
  const warnings = [];
  const out = checkTypes(plan);
  if (out.length) return { problems: out, warnings };
  if (!plan.slug) out.push("missing slug");
  const { slices, criteria } = plan;
  if (!slices.length) out.push("no slices");
  const seen = new Set();
  for (const s of [...slices, ...criteria]) {
    if (seen.has(s.id)) out.push(`duplicate id ${s.id}`);
    seen.add(s.id);
  }
  const ids = new Set(slices.map((s) => s.id));
  let depsOk = true;
  for (const s of slices)
    for (const d of arr(s.dependsOn))
      if (!ids.has(d)) {
        out.push(`${s.id} depends on unknown ${d}`);
        depsOk = false;
      }
  if (depsOk) {
    const { cycle } = computeWaves(plan);
    if (cycle) out.push(`cycle ${cycle.join(" → ")}`);
    else out.push(...fileClashes(slices));
  }
  const owned = new Set(slices.flatMap((s) => arr(s.testIds)));
  for (const c of criteria) {
    if (!arr(c.testIds).length) out.push(`${c.id} has no test`);
    for (const t of arr(c.testIds))
      if (!owned.has(t)) out.push(`${c.id} test ${t} is owned by no slice`);
    if (!isEars(c.ears)) out.push(`${c.id} is not EARS`);
  }
  for (const s of slices) {
    if (s.estLines > BLOCK_AT) out.push(`${s.id} estLines ${s.estLines} over BLOCK_AT ${BLOCK_AT}`);
    else if (s.estLines > WARN_AT)
      warnings.push(`${s.id} estLines ${s.estLines} over WARN_AT ${WARN_AT}`);
  }
  return { problems: out, warnings };
}

// Two slices that own the same file must be ordered by a dependsOn chain, in either direction.
function fileClashes(slices) {
  const deps = new Map(slices.map((s) => [s.id, arr(s.dependsOn)]));
  const reaches = (from, to, seen = new Set()) =>
    deps.get(from).some((d) => d === to || (!seen.has(d) && seen.add(d) && reaches(d, to, seen)));
  const owners = new Map();
  for (const s of [...slices].sort(byId))
    for (const f of new Set(arr(s.files))) owners.set(f, [...(owners.get(f) ?? []), s.id]);
  const out = [];
  for (const [f, who] of owners)
    for (let i = 0; i < who.length; i++)
      for (const b of who.slice(i + 1))
        if (!reaches(who[i], b) && !reaches(b, who[i]))
          out.push(`${f} owned by ${who[i]} and ${b} with no dependsOn chain`);
  return out;
}

function ghRun(args) {
  return execFileSync("gh", args, { encoding: "utf8", timeout: GH_TIMEOUT_MS });
}

function sliceStatus(s, gh) {
  const norm = (st) => String(st).toLowerCase();
  try {
    if (s.pr != null) {
      const o = JSON.parse(gh(["pr", "view", String(s.pr), "--repo", GH_REPO, "--json", "state"]));
      return { id: s.id, state: norm(o.state), pr: s.pr };
    }
    if (s.branch) {
      const list = ["pr", "list", "--repo", GH_REPO, "--head", s.branch];
      const rows = JSON.parse(gh([...list, "--state", "all", "--json", "number,state"]));
      if (rows.length) return { id: s.id, state: norm(rows[0].state), pr: rows[0].number };
    }
    return { id: s.id, state: "missing", pr: null };
  } catch (e) {
    return { id: s.id, state: "error", pr: s.pr ?? null, error: String(e.message).split("\n")[0] };
  }
}

// Read, parse (a UTF-8 BOM is stripped) and check one file; the message never repeats the file name.
function loadChecked(file) {
  let plan;
  try {
    plan = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch (e) {
    return { problems: [e.message], warnings: [] };
  }
  return { plan, ...checkPlan(plan) };
}

/** Checks every *.plan.json in dir; prints `<file>: <problem>`; returns the exit code. */
export function checkAll(dir = PLANS_DIR, log = console.log) {
  const files = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith(".plan.json"))
        .sort()
    : [];
  let bad = 0;
  for (const f of files) {
    let r;
    try {
      r = loadChecked(path.join(dir, f));
    } catch (e) {
      r = { problems: [e.message], warnings: [] };
    }
    r.warnings.forEach((w) => log(`${f}: warning: ${w}`));
    r.problems.forEach((p) => log(`${f}: ${p}`));
    if (r.problems.length) bad += 1;
  }
  log(`plan check-all: ${files.length} plan(s), ${bad} with problems`);
  return bad ? 1 : 0;
}

export async function main(argv, { gh = ghRun, log = console.log } = {}) {
  let mode = "check";
  let json = false;
  let all = false;
  let file = null;
  for (const a of argv) {
    if (a === "--check" || a === "--waves" || a === "--status") mode = a.slice(2);
    else if (a === "--json") json = true;
    else if (a === "--check-all") all = true;
    else if (!a.startsWith("--") && !file) file = a;
    else {
      log(`${USAGE}\nunknown argument ${a}`);
      return 2;
    }
  }
  if (all) return checkAll(PLANS_DIR, log);
  if (!file) {
    log(USAGE);
    return 2;
  }
  const { plan, problems, warnings } = loadChecked(file);
  if (problems.length) {
    log(
      json
        ? JSON.stringify({ ok: false, problems })
        : problems.map((p) => `${file}: ${p}`).join("\n"),
    );
    return 1;
  }
  if (!json) warnings.forEach((w) => log(`warning: ${w}`));
  if (mode === "check") {
    log(json ? JSON.stringify({ ok: true, problems, warnings }) : "plan ok");
  } else if (mode === "waves") {
    const { waves } = computeWaves(plan);
    if (json) log(JSON.stringify({ waves }));
    else {
      const row = (s) => `${s.id} [${arr(s.files).join(", ")}]`;
      waves.forEach((w, i) => log(`wave ${i + 1}: ${w.map(row).join("; ")}`));
    }
  } else {
    const status = plan.slices.map((s) => sliceStatus(s, gh));
    if (json) log(JSON.stringify({ status }));
    else {
      for (const s of status)
        log(
          `${s.id}  ${s.state}${s.pr != null ? `  #${s.pr}` : ""}${s.error ? `  ${s.error}` : ""}`,
        );
      if (status.length && status.every((s) => s.state === "error"))
        log(`gh failed for every slice (${status[0].error}): not logged in, offline or no access?`);
    }
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((c) => process.exit(c));
}
