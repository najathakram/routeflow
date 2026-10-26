#!/usr/bin/env node
// Why: the /bug-swarm gate was a hand-typed shell chain that broke twice. Run 2026-10-23-bug-swarm-1:
// `(dashboard)` paths were unquoted and `origin/master..HEAD` drifted once master moved. Run
// 2026-10-23-bug-swarm-2: the same chain was re-typed. Steps here are argv arrays (never a shell
// string) and the diff range is always `git merge-base origin/master HEAD`..HEAD.
//
//   node gate.mjs [--needs-db] [--json out.json] [--ids a,b --id-space row|bug] [--dry-run]     (run from a worktree root)
//
// Pure core: planGate(...) -> steps[]; runGate(steps, { exec }) runs every step, never stops early.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { scrubbedGitEnv } from "../../../../scripts/lib/check-git-hooks.mjs";

const PRETTIER_EXT = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".md",
  ".mdx",
  ".css",
  ".scss",
  ".yml",
  ".yaml",
  ".html",
]);
const JEST_EXT = new Set([".ts", ".tsx", ".js", ".jsx"]);

// Repo root of the checkout this gate.mjs lives in (.claude/skills/bug-swarm/scripts -> four levels up).
const JUDGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

export const STEP_TIMEOUT_MS = 15 * 60_000;
export const DB_LANE_TIMEOUT_MS = 30 * 60_000;

// Prints and fails when the branch diff (merge-base..HEAD) touches any avoided file.
const AVOID_SCRIPT = `const {execFileSync}=require("node:child_process");
const [base,...avoid]=process.argv.slice(1);
const out=execFileSync("git",["diff","--name-only",base+"..HEAD","--",...avoid],{encoding:"utf8"}).trim();
if(out){console.error("avoided files touched:\\n"+out);process.exit(1);}`;

// Fails on any uncommitted change (tracked or untracked), except the gate's own output paths.
const CLEAN_SCRIPT = `const {execFileSync}=require("node:child_process");
const ignore=process.argv.slice(1).map((p)=>":(exclude)"+p);
const out=execFileSync("git",["status","--porcelain","--untracked-files=all","--","."].concat(ignore),{encoding:"utf8"}).trim();
if(out){console.error("working tree is not clean (commit or discard first):\\n"+out);process.exit(1);}`;

function lintScriptExists(root, ws) {
  try {
    return Boolean(
      JSON.parse(readFileSync(path.join(root, ws, "package.json"), "utf8")).scripts?.lint,
    );
  } catch {
    return false;
  }
}

// Repo-wide census specs read files BY NAME (run 2026-10-23-bug-swarm-4: #3659 went red on one after a script
// was added). They run when the branch touches ANY file (add, modify, delete, rename, copy: both paths of a move)
// under apps/api/prisma/, apps/api/scripts/ or scripts/.
// Run 2026-10-23-bug-swarm-4 (#3659) went red on a repo-wide census; a hand-listed subset still missed ~25
// scanners (v1.2 review of #3674). So when a trigger dir changes, run the FULL api lanes, not a list.
export const FULL_LANE_TIMEOUT_MS = 30 * 60_000;
const CENSUS_DIRS = ["apps/api/prisma/", "apps/api/scripts/", "scripts/"];
const posix = (f) => f.split("\\").join("/");

// Fails when a commit subject carries a (B###) label that is not one of the ids the run was given
// (run 4 fixed row 668 under the label B668: a row id translated to a bug id).
const ID_LABELS_SCRIPT = `const {execFileSync}=require("node:child_process");
const [base,ids]=process.argv.slice(1);
const allowed=new Set(ids.split(",").filter(Boolean));
const subjects=execFileSync("git",["log","--format=%s",base+"..HEAD"],{encoding:"utf8"}).split("\\n").filter(Boolean);
const bad=[];
for(const s of subjects)for(const m of s.matchAll(/\\b(B\\d+)\\b/g))if(!allowed.has(m[1]))bad.push(m[1]+" in: "+s);
if(bad.length){console.error("commit labels outside the given ids ("+[...allowed].join(", ")+"):\\n"+bad.join("\\n"));process.exit(1);}`;

/**
 * Every path touched in base..HEAD by an add, copy, modify, rename or delete (for a rename or copy BOTH the
 * old and the new path), so editing, deleting or moving a script also counts.
 */
export function touchedSince(git, base) {
  const out = git(["diff", "--name-status", "-z", "--diff-filter=ACMRD", "-M", `${base}..HEAD`]);
  const parts = out.split("\0").filter(Boolean);
  const files = [];
  for (let i = 0; i < parts.length;) {
    const status = parts[i++];
    const n = /^[RC]/.test(status) ? 2 : 1;
    for (let k = 0; k < n && i < parts.length; k++) files.push(parts[i++]);
  }
  return [...new Set(files)];
}

/** { base, files } for the whole branch: merge-base with origin/master, deleted files dropped. */
export function changedSince(git) {
  const base = git(["merge-base", "origin/master", "HEAD"]).trim();
  const out = git(["diff", "--name-only", "-z", "--diff-filter=d", `${base}..HEAD`]);
  return { base, files: out.split("\0").filter(Boolean) };
}

const workspaceOf = (f) => /^(apps|packages)\/[^/]+(?=\/)/.exec(f)?.[0] ?? null;

export function planGate({
  changedFiles,
  touchedFiles = [],
  ids = [],
  idSpace,
  needsDb = false,
  base = "origin/master",
  root = process.cwd(),
  exists = existsSync,
  avoid = [],
  ignore = [],
  hasLint = (ws) => lintScriptExists(root, ws),
}) {
  const steps = [];
  const add = (name, cwd, cmd, timeoutMs = STEP_TIMEOUT_MS) =>
    steps.push({ name, cwd, cmd, timeoutMs });
  add("clean-tree", root, ["node", "-e", CLEAN_SCRIPT, ...ignore]);
  add("packages-build", root, ["npx", "turbo", "run", "build", "--filter=./packages/*"]);
  add("signature-scan", root, ["node", ".claude/skills/bug-hunt/scripts/scan-signatures.mjs"]);
  add("commitlint", root, ["npx", "commitlint", "--from", base, "--to", "HEAD"]);
  // The HIGH guard is the paths the diff touches (scripts/lib/risk-paths.mjs), not a triage label: any red
  // or black path fails the gate, naming each path and its rule. Both paths of a rename count. The judge is
  // run from THIS gate's own checkout (the lead's), never from the worktree it judges: a diff must not be
  // able to edit the code that classifies it. `--repo root` points it at the builder worktree.
  add("risk-class", JUDGE_ROOT, [
    "node",
    path.join(JUDGE_ROOT, "scripts/risk-class.mjs"),
    "--repo",
    root,
    "--base",
    base,
    "--max",
    "amber",
  ]);

  if (ids.length && idSpace)
    add("id-labels", root, ["node", "-e", ID_LABELS_SCRIPT, base, ids.join(",")]);

  if (avoid.length) add("avoid-files", root, ["node", "-e", AVOID_SCRIPT, base, ...avoid]);

  const pretty = changedFiles.filter((f) => PRETTIER_EXT.has(path.extname(f)));
  if (pretty.length) add("prettier", root, ["npx", "prettier", "--check", ...pretty]);

  const byWs = new Map();
  for (const f of changedFiles) {
    const ws = workspaceOf(f);
    if (!ws) continue;
    if (!byWs.has(ws)) byWs.set(ws, []);
    byWs.get(ws).push(f);
  }
  for (const ws of [...byWs.keys()].sort()) {
    const rel = byWs.get(ws).map((f) => path.posix.relative(ws, f));
    const cwd = path.join(root, ws);
    if (ws === "apps/api") add(`tsc:${ws}`, root, ["npm", "run", "check-types", "-w", "apps/api"]);
    else add(`tsc:${ws}`, cwd, ["npx", "tsc", "--noEmit"]);
    // Same lint verify runs (`--max-warnings 0` lives in the script), for every workspace that has one.
    if (hasLint(ws)) add(`lint:${ws}`, root, ["npm", "run", "lint", "-w", ws]);
    const tests = rel.filter((f) => JEST_EXT.has(path.extname(f)));
    if (tests.length)
      add(`jest:${ws}`, cwd, ["npx", "jest", "--passWithNoTests", "--findRelatedTests", ...tests]);
  }

  if (byWs.has("packages/types") || byWs.has("packages/pricing")) {
    // Shared contracts: every consumer must still type-check, and enums must stay in parity.
    for (const ws of ["apps/api", "apps/web", "apps/mobile"]) {
      if (!steps.some((x) => x.name === `tsc:${ws}`))
        add(`tsc:${ws}`, root, ["npm", "run", "check-types", "-w", ws]);
    }
    add("enum-parity", path.join(root, "apps/api"), [
      "npx",
      "jest",
      "src/common/enum-parity.spec.ts",
    ]);
  }

  if (changedFiles.some((f) => f.startsWith("tools/ops-monitor/"))) {
    add("self-test:ops-monitor", root, ["node", "tools/ops-monitor/test/run-all.mjs"]);
  }
  const seen = new Set();
  for (const f of changedFiles) {
    const m = /^scripts\/([^/]+?)(?:\.self-test)?\.mjs$/.exec(f);
    if (!m || seen.has(m[1])) continue;
    seen.add(m[1]);
    const test = `scripts/${m[1]}.self-test.mjs`;
    if (exists(path.join(root, test))) add(`self-test:scripts/${m[1]}`, root, ["node", test]);
  }

  if (touchedFiles.some((f) => CENSUS_DIRS.some((d) => posix(f).startsWith(d)))) {
    const api = path.join(root, "apps/api");
    // `npm test -w apps/api` is the api unit entry (run-unit-tests.mjs): the parallel lane AND the serial
    // `-script.spec.ts` lane that tests the scripts themselves; bare `npx jest` skips the latter.
    add("census:unit", root, ["npm", "test", "-w", "apps/api"], FULL_LANE_TIMEOUT_MS);
    add(
      "census:repo-truth",
      api,
      ["npx", "jest", "-c", "jest.repo-truth.config.js"],
      FULL_LANE_TIMEOUT_MS,
    );
  }
  add("size-ratchet", path.join(root, "apps/api"), [
    "npx",
    "jest",
    "-c",
    "jest.repo-truth.config.js",
    "size-ratchet",
  ]);
  if (needsDb) add("db-lane", root, ["npm", "run", "local:test:db"], DB_LANE_TIMEOUT_MS);
  return steps;
}

function killTreeDefault(pid, platform) {
  if (platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL"); // negative pid = the step's whole process group
  } catch {
    /* ESRCH: already gone */
  }
}

// A step runs in its own process group (detached) so a timeout can kill grandchildren such as a
// hung jest/tsc under npx; the promise resolves from the timer, never waiting on pipe `close`.
export function execStep(step, { platform = process.platform, killTree } = {}) {
  return new Promise((resolve) => {
    const child = spawn(step.cmd[0], step.cmd.slice(1), {
      cwd: step.cwd,
      // Git's repo-scoped env (GIT_DIR ...) must not leak into the inline git scripts of a step.
      env: step.env ?? scrubbedGitEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      detached: platform !== "win32",
    });
    let output = "";
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ output, ...r });
    };
    const timer = step.timeoutMs
      ? setTimeout(() => {
          if (killTree) killTree(child.pid);
          else killTreeDefault(child.pid, platform);
          child.kill("SIGKILL");
          child.stdout.destroy();
          child.stderr.destroy();
          finish({ status: null, timedOut: true });
        }, step.timeoutMs)
      : null;
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    child.on("error", (e) => {
      output += `\n${e.message}`;
      finish({ status: 127 });
    });
    child.on("close", (code) => finish({ status: code ?? 1 }));
  });
}

export async function runGate(steps, { exec = execStep } = {}) {
  const results = [];
  for (const step of steps) {
    const t0 = Date.now();
    const { status, output, timedOut } = await exec(step);
    results.push({
      name: step.name,
      ok: status === 0 && !timedOut,
      ...(timedOut ? { timedOut: true } : {}),
      exit: status,
      ms: Date.now() - t0,
      tail: String(output ?? "")
        .replace(/\n$/, "")
        .split("\n")
        .slice(-20)
        .join("\n"),
    });
  }
  return { ok: results.every((r) => r.ok), steps: results };
}

/** Drop any stale result and leave a "running" marker, so a reader never trusts an old green. */
export function beginJson(file, head) {
  rmSync(file, { force: true });
  writeFileSync(file, `${JSON.stringify({ ok: false, running: true, head })}\n`);
}

export function finishJson(file, result, { head, base }) {
  writeFileSync(
    file,
    `${JSON.stringify({ ok: result.ok, head, base, steps: result.steps }, null, 2)}\n`,
  );
}

// Repo-relative posix path of the gate's own json output when it lives inside the tree.
function ownOutputs(root, jsonOut) {
  if (!jsonOut) return [];
  const rel = path.relative(root, path.resolve(jsonOut));
  return rel.startsWith("..") || path.isAbsolute(rel) ? [] : [rel.split(path.sep).join("/")];
}

const git = (args) =>
  execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: scrubbedGitEnv(),
  });

/**
 * Poll a gate json in Node (agent harnesses block a foreground `sleep`). Prints the json; exit 0 when
 * `running` is not true, 3 when --max-ms (default 540000) elapses first, 2 on bad usage.
 */
export async function waitForJson(file, argv = []) {
  if (!file) {
    console.error("gate: --wait needs a json file path");
    return 2;
  }
  const mi = argv.indexOf("--max-ms");
  const maxMs = mi === -1 ? 540000 : Number(argv[mi + 1]);
  const read = () => {
    try {
      return readFileSync(file, "utf8");
    } catch {
      return null;
    }
  };
  const done = (txt) => {
    if (txt === null) return false;
    try {
      return JSON.parse(txt).running !== true;
    } catch {
      return false; // half-written
    }
  };
  const t0 = Date.now();
  let txt = read();
  while (!done(txt) && Date.now() - t0 < maxMs) {
    const left = Math.max(100, maxMs - (Date.now() - t0));
    await new Promise((r) => setTimeout(r, Math.min(5000, left)));
    txt = read();
  }
  if (txt !== null) console.log(txt.trim());
  return done(txt) ? 0 : 3;
}

/**
 * Record this gate's pid so a later gate agent can stop it, and remove the file on every exit path
 * (normal exit, process.exit, SIGINT/SIGTERM). A SIGKILL cannot clean up, which is why the reader must
 * check that the pid still runs gate.mjs before killing it.
 */
export function holdPidFile(file, proc = process) {
  writeFileSync(file, `${proc.pid}\n`);
  // Only delete the file while it still holds OUR pid: a newer gate may have overwritten it.
  const cleanup = () => {
    try {
      if (readFileSync(file, "utf8").trim() !== String(proc.pid)) return;
    } catch {
      return;
    }
    rmSync(file, { force: true });
  };
  proc.on("exit", cleanup);
  for (const sig of ["SIGINT", "SIGTERM"]) {
    proc.on(sig, () => {
      cleanup();
      proc.exit(128 + (sig === "SIGINT" ? 2 : 15));
    });
  }
  return cleanup;
}

/** Command line of a pid, or "" when it does not exist. ps on posix; PowerShell CIM on win32 (tasklist has no cmdline). */
export function commandLineOf(pid, { platform = process.platform, exec } = {}) {
  const run =
    exec ??
    ((cmd, args) =>
      execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
  try {
    if (platform === "win32") {
      return String(
        run("powershell", [
          "-NoProfile",
          "-Command",
          `(Get-CimInstance Win32_Process -Filter 'ProcessId=${Number(pid)}').CommandLine`,
        ]),
      ).trim();
    }
    return String(run("ps", ["-p", String(pid), "-o", "command="])).trim();
  } catch {
    return "";
  }
}

/**
 * Stop the gate recorded in a pid file: kill its tree ONLY if the pid's command line contains gate.mjs
 * (a reused pid is never killed), then remove the file if it still holds that pid.
 * Returns { stopped, reason }.
 */
export function stopGate(file, { platform = process.platform, exec, killTree } = {}) {
  let pid;
  try {
    pid = Number(readFileSync(file, "utf8").trim());
  } catch {
    return { stopped: false, reason: "no pid file" };
  }
  const cleanup = () => {
    try {
      if (Number(readFileSync(file, "utf8").trim()) === pid) rmSync(file, { force: true });
    } catch {
      /* already gone */
    }
  };
  if (!Number.isInteger(pid) || pid <= 0) {
    cleanup();
    return { stopped: false, reason: "pid file is not a pid" };
  }
  if (!commandLineOf(pid, { platform, exec }).includes("gate.mjs")) {
    cleanup();
    return { stopped: false, reason: "pid is not a gate.mjs process (not killed)" };
  }
  if (killTree) killTree(pid, platform);
  else if (platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    spawnSync("pkill", ["-P", String(pid)], { stdio: "ignore" });
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already exited */
    }
  }
  cleanup();
  return { stopped: true, reason: "killed" };
}

export async function main(argv = process.argv.slice(2)) {
  const si = argv.indexOf("--stop");
  if (si !== -1) {
    if (!argv[si + 1]) {
      console.error("gate: --stop needs a pid file path");
      return 2;
    }
    console.log(JSON.stringify(stopGate(path.resolve(argv[si + 1]))));
    return 0;
  }
  const wi = argv.indexOf("--wait");
  if (wi !== -1) return waitForJson(argv[wi + 1], argv);
  const needsDb = argv.includes("--needs-db");
  const dryRun = argv.includes("--dry-run");
  const ji = argv.indexOf("--json");
  let jsonOut = ji === -1 ? null : argv[ji + 1];
  if (ji !== -1 && !jsonOut) {
    console.error("gate: --json needs a file path");
    return 2;
  }
  if (jsonOut) {
    jsonOut = path.resolve(jsonOut);
    argv = argv.map((a, i) => (i === ji + 1 ? jsonOut : a));
  }
  const pi = argv.indexOf("--pid-file");
  if (pi !== -1 && !argv[pi + 1]) {
    console.error("gate: --pid-file needs a file path");
    return 2;
  }
  if (pi !== -1) argv = argv.map((a, i) => (i === pi + 1 ? path.resolve(a) : a));
  // Only the outer process (the one the agent launched) owns the pid file; the heavy-slot child skips it.
  if (pi !== -1 && process.env.RF_HEAVY_SLOT_HELD !== "1") holdPidFile(argv[pi + 1]);
  const avoid = [];
  argv.forEach((a, i) => {
    if (a === "--avoid" && argv[i + 1]) avoid.push(argv[i + 1]);
  });
  const root = git(["rev-parse", "--show-toplevel"]).trim();
  const head = git(["rev-parse", "HEAD"]).trim();
  if (jsonOut && !dryRun && process.env.RF_HEAVY_SLOT_HELD !== "1") beginJson(jsonOut, head);
  const { base, files } = changedSince(git);
  const touchedFiles = touchedSince(git, base);
  const ii = argv.indexOf("--ids");
  const ids =
    ii === -1
      ? []
      : String(argv[ii + 1] ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
  const si2 = argv.indexOf("--id-space");
  const idSpace = si2 === -1 ? undefined : argv[si2 + 1];
  const steps = planGate({
    changedFiles: files,
    touchedFiles,
    ids,
    idSpace,
    needsDb,
    base,
    root,
    avoid,
    ignore: ownOutputs(root, jsonOut),
  });

  if (dryRun) {
    console.log(
      `gate plan: base ${base}, ${files.length} changed file(s), ${steps.length} step(s)`,
    );
    for (const s of steps) console.log(`- ${s.name}  (cwd ${s.cwd})  ${s.cmd.join(" ")}`);
    return 0;
  }

  if (process.env.RF_HEAVY_SLOT_HELD !== "1") {
    const branch = git(["branch", "--show-current"]).trim();
    const r = spawnSync(
      process.execPath,
      [
        path.join(root, "scripts/heavy-slot.mjs"),
        "run",
        "--label",
        "bug-swarm-gate",
        "--branch",
        branch,
        "--",
        process.execPath,
        fileURLToPath(import.meta.url),
        ...argv,
      ],
      { cwd: root, stdio: "inherit", env: { ...process.env, RF_HEAVY_SLOT_HELD: "1" } },
    );
    return r.status ?? 1;
  }

  if (jsonOut) beginJson(jsonOut, head);
  const result = await runGate(steps);
  for (const s of result.steps)
    console.log(
      `${s.ok ? "ok  " : "FAIL"} ${s.name} (${s.ms} ms, exit ${s.exit}${s.timedOut ? ", TIMED OUT" : ""})`,
    );
  if (jsonOut) finishJson(jsonOut, result, { head, base });
  return result.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((c) => (process.exitCode = c));
}
