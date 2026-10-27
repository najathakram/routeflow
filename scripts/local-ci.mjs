#!/usr/bin/env node
// Local mirror of GitHub CI's Verify job, run on the exact tree GitHub tests (refs/pull/N/merge).
//
//   node scripts/local-ci.mjs --pr N [--from <worktree>] [--no-status] [--keep] [--dry] [--head | --fresh]
//   node scripts/local-ci.mjs --self-test
//
// WHY: Actions minutes are scarce and the PC is idle between lanes. This reproduces ci.yml's Verify
// job (and db-migrations.yml's replay when the diff touches the Prisma lane) in a clean detached
// worktree, then posts the verdict as the commit status `local-ci/verify` on the PR head sha.
// Informational only: it is not a required check.
//
// Steps, in ci.yml order (see .github/workflows/ci.yml `verify` job):
//   lockdeps (semver@6.3.1 into a side dir) -> validate-lock-edges (NODE_PATH=lockdeps)
//   -> [npm ci --ignore-scripts, when package-lock.json or ANY package.json differs from the clone]
//   -> husky (`prepare` is skipped by --ignore-scripts) -> prisma generate
//   -> npm run verify (VERIFY_EXCLUDE=@routeflow/control) -> ci-audit-critical
//   -> ci-audit high report (advisory, never fails the run).
// DB lane (only when the diff touches a path listed under pull_request.paths in the merge tree's own
// db-migrations.yml): squawk lint, then scripts/local-db-specs.mjs (fresh rf_dbspec_* DB, migrate
// deploy) running drift + the DB specs.
//
// SAFETY. node_modules is cloned from the main checkout. A copy recreates the workspace links
// (@routeflow/*) as ABSOLUTE links into the main checkout, which would (a) test the main checkout's
// packages/* instead of the PR's and (b) let `git worktree remove` delete THROUGH them into main.
// So the clone is retargeted into the worktree right after the copy, the run aborts if any link
// still leaves the worktree, and removal first deletes every link in the whole tree and refuses to
// continue if one survives. Children get a scrubbed environment (no tokens), run under step
// timeouts, and are killed (own process tree only) on SIGINT/SIGTERM.
//
// DIFFERENCES from CI that cannot be matched on Windows (reported, not hidden):
//   * Node: CI pins NODE_VERSION 24; this runs the host Node (logged, and in result.json).
//   * node_modules is a clone of the main checkout, not a cold `npm ci` (npm ci runs when stale).
//   * OS: win32 vs ubuntu-latest (path separators, symlinks, line endings) can matter.
//   * Heavy steps take the machine-wide heavy slot (RF_HEAVY_SLOTS, heavy-slot's own default) and jest runs
//     with JEST_MAX_WORKERS=2, so wall time differs from CI's budget.
//   * The DB lane uses the compose Postgres (local-db-specs), not postgres:16-alpine in the job.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  discoverNodeModules,
  planWorktree,
} from "../.claude/skills/bug-swarm/scripts/worktree.mjs";
import { withHeavySlot } from "./lib/heavy-slot.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_SLUG = "najathakram/routeflow";
const CI_NODE_MAJOR = 24;
const MIN = 60_000;
export const STATUS_CONTEXT = "local-ci/verify";

// ---------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------

/** The `paths:` list under `pull_request:` of a workflow file (comments and blanks skipped). */
export function parseWorkflowPaths(yamlText) {
  const lines = yamlText.split(/\r?\n/);
  const pr = lines.findIndex((l) => /^\s*pull_request:\s*$/.test(l));
  if (pr < 0) return [];
  const start = lines.findIndex((l, i) => i > pr && /^\s*paths:\s*$/.test(l));
  if (start < 0) return [];
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*(#.*)?$/.test(l)) continue;
    const m = /^\s*-\s*["']?([^"'\s#][^"'#]*?)["']?\s*(#.*)?$/.exec(l);
    if (!m) break;
    out.push(m[1]);
  }
  return out;
}

export function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") {
        re += "(?:.*/)?";
        i += 2;
      } else {
        re += ".*";
        i += 1;
      }
    } else if (c === "*") re += "[^/]*";
    else re += c.replace(/[.+^${}()|[\]\\?]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/** True when any changed file matches one of the workflow's own path globs. */
export function touchesDbLane(files, globs) {
  const res = globs.map(globToRegExp);
  return files.some((f) => res.some((r) => r.test(f)));
}

/** entries: [{ path, merge, local }] blob ids; stale when any differs or the clone lacks the file. */
export function installIsStale(entries) {
  return entries.some((e) => !e.local || e.local !== e.merge);
}

const SECRET_KEY = /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_KEY|CREDENTIAL)/i;
const SECRET_PREFIX = /^(GH_|GITHUB_|RAILWAY_|NPM_CONFIG_)/i;
// The local compose Postgres credentials (throwaways) that scripts/local-db-specs.mjs reads.
const COMPOSE_KEEP = /^POSTGRES_(USER|PASSWORD|DB|HOST|PORT)$/;

/** The environment PR code runs with: the host env minus anything token-shaped, plus CI=true. */
export function buildStepEnv(base, step = {}, extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(base)) {
    if (!COMPOSE_KEEP.test(k) && (SECRET_KEY.test(k) || SECRET_PREFIX.test(k))) continue;
    env[k] = v;
  }
  return { ...env, CI: "true", ...extra, ...(step.env ?? {}) };
}

/** node_modules/@routeflow/* entries that are not a link into `dir` (a copy can inline a junction). */
export function badWorkspaceLinks(dir) {
  const scope = path.join(dir, "node_modules", "@routeflow");
  let names;
  try {
    names = fs.readdirSync(scope);
  } catch {
    return [];
  }
  return names
    .map((n) => path.join(scope, n))
    .filter((p) => {
      try {
        return !fs.lstatSync(p).isSymbolicLink() || !isInside(linkTarget(p), dir);
      } catch {
        return true;
      }
    });
}

const norm = (p) => {
  const n = path.resolve(p.replace(/^\\\\\?\\/, ""));
  return process.platform === "win32" ? n.toLowerCase() : n;
};
const isInside = (child, parent) => {
  const c = norm(child);
  const p = norm(parent);
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
};

/** Every symlink / junction under `root` (not descended into). */
export function findLinks(root) {
  const out = [];
  const walk = (d) => {
    let ents;
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) out.push(p);
      else if (e.isDirectory()) walk(p);
    }
  };
  walk(root);
  return out;
}

function removeLink(p) {
  try {
    fs.rmdirSync(p); // a directory link / junction: removes the link only
  } catch {
    fs.unlinkSync(p);
  }
}

/** Deletes every link under root, then rescans; returns the links that survived. */
export function removeAllLinks(root) {
  for (const l of findLinks(root)) {
    try {
      removeLink(l);
    } catch {
      /* rescan below reports it */
    }
  }
  return findLinks(root);
}

function linkTarget(l) {
  return path.resolve(path.dirname(l), fs.readlinkSync(l).replace(/^\\\\\?\\/, ""));
}

/** Links under `dir` whose target is inside `from`. */
export function linksInto(dir, from) {
  return findLinks(dir).filter((l) => isInside(linkTarget(l), from));
}

/**
 * `fs.cpSync` can inline a workspace junction as a real directory copy. For every @routeflow link in
 * the source checkout's node_modules dirs, make the same entry in `dir` a junction to the same
 * relative path inside `dir` (the worktree's own apps/packages). Returns how many were made.
 */
export function relinkWorkspace(dir, from) {
  const roots = [""];
  for (const top of ["apps", "packages"]) {
    try {
      for (const n of fs.readdirSync(path.join(from, top))) roots.push(path.join(top, n));
    } catch {
      /* none */
    }
  }
  let n = 0;
  for (const r of roots) {
    const scope = path.join(from, r, "node_modules", "@routeflow");
    let names;
    try {
      names = fs.readdirSync(scope);
    } catch {
      continue;
    }
    for (const name of names) {
      const src = path.join(scope, name);
      if (!fs.lstatSync(src).isSymbolicLink()) continue;
      const target = path.join(dir, path.relative(path.resolve(from), linkTarget(src)));
      const dst = path.join(dir, r, "node_modules", "@routeflow", name);
      if (!fs.existsSync(path.dirname(dst))) continue; // that node_modules was not cloned
      let st = null;
      try {
        st = fs.lstatSync(dst);
      } catch {
        /* absent */
      }
      if (st?.isSymbolicLink()) removeLink(dst);
      else if (st) {
        if (removeAllLinks(dst).length) throw new Error(`cannot clear links under ${dst}`);
        fs.rmSync(dst, { recursive: true, force: true });
      }
      fs.symlinkSync(target, dst, "junction");
      n++;
    }
  }
  return n;
}

/**
 * Re-points every link under `dir` that targets `from` at the same relative path inside `dir`
 * (the copy made them absolute links into the main checkout). Returns how many were moved.
 */
export function retargetLinks(dir, from) {
  let n = 0;
  for (const l of linksInto(dir, from)) {
    const target = path.join(dir, path.relative(path.resolve(from), linkTarget(l)));
    removeLink(l);
    fs.symlinkSync(target, l, "junction");
    n++;
  }
  return n;
}

export function parseArgs(argv) {
  const o = {
    pr: null,
    dry: false,
    selfTest: false,
    keep: false,
    noStatus: false,
    from: null,
    tree: "merge",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--head") o.tree = o.tree === "fresh" ? "both" : "head";
    else if (a === "--fresh") o.tree = o.tree === "head" ? "both" : "fresh";
    else if (a === "--dry") o.dry = true;
    else if (a === "--self-test") o.selfTest = true;
    else if (a === "--keep") o.keep = true;
    else if (a === "--no-status") o.noStatus = true;
    else if (a === "--from" && argv[i + 1] !== undefined) o.from = argv[++i];
    else if (a === "--pr" && argv[i + 1] !== undefined) {
      const v = argv[++i];
      if (!/^[0-9]+$/.test(v)) throw new Error(`--pr must be a number, got ${JSON.stringify(v)}`);
      o.pr = Number(v);
    } else throw new Error(`unknown or incomplete argument ${JSON.stringify(a)}`);
  }
  if (o.pr === null && !o.selfTest) throw new Error("--pr N is required");
  if (o.tree === "both") throw new Error("--head and --fresh are mutually exclusive");
  return o;
}

/**
 * Which tree a run tests. Default `merge` = GitHub's refs/pull/N/merge, which is what a
 * pull_request Verify runs, BUT GitHub refreshes it lazily: when origin/master has moved on it can
 * be stale (not contain the master tip), so it is flagged. `fresh` = head merged into the current
 * origin/master locally; `head` = the bare PR head.
 */
export function describeTree({ mode, mergeSha, headSha, masterInMerge }) {
  if (mode === "head") return { sha: headSha, label: "head", stale: false };
  if (mode === "fresh") return { sha: null, label: "fresh-merge", stale: false };
  return { sha: mergeSha, label: "github-merge-ref", stale: !masterInMerge };
}

export function resultDirName(pr, headSha) {
  return `${pr}-${headSha.slice(0, 12)}`;
}

/** Sibling of the repo, unique per pr + head sha + pid so two runs of one PR never share a worktree. */
export function worktreeDirName(repo, pr, headSha, pid) {
  return path.resolve(repo, "..", `rf-lci-${pr}-${headSha.slice(0, 12)}-${pid}`);
}

/**
 * The status lands on the PR head sha, so the tree under test must really be that head merged into
 * master: the merge commit's second parent (`secondParent`, null when it has none) must equal
 * headSha. GitHub's merge ref can lag a push; a green on the older head would be stamped on the new
 * one. `--head` tests the head commit itself, so there is no merge commit to compare.
 */
export function assertMergeTestsHead({ mode, mergeSha, headSha, secondParent }) {
  if (mode === "head") return;
  if (secondParent !== headSha) {
    throw new Error(
      `tested merge ${mergeSha.slice(0, 9)} has second parent ${secondParent ? secondParent.slice(0, 9) : "none"}, not PR head ${headSha.slice(0, 9)} (GitHub's merge ref is stale); refusing to post local-ci/verify`,
    );
  }
}

/**
 * The ordered plan (pure). Each step: { name, cwd, cmd | action, env?, heavy?, advisory?, gate?,
 * timeoutMs?, when? }. `gate` marks a step whose failure is a real CI-gate failure (state
 * `failure`); any other failing step is an infrastructure fault (state `error`). `when` marks a
 * conditional step so `--dry` can show why it may be absent.
 */
export function planLocalCi({ mergeSha, dir, from, lockdeps, installStale, dbLane, platform }) {
  const wt = planWorktree({
    repo: from,
    dir,
    branch: "local-ci-unused",
    base: mergeSha,
    from,
    platform,
    nodeModules: discoverNodeModules(from),
  });
  const plan = [];
  let n = 0;
  for (const s of wt) {
    if (s.cmd[0] === "git" && s.cmd[1] === "fetch") continue; // main() fetches the PR refs itself
    if (s.cmd[0] === "npx" && s.cmd[1] === "prisma") continue; // re-added below in ci.yml order
    if (s.cmd[0] === "npx") {
      // the packages build comes after the clone has been retargeted into the worktree
      plan.push({
        name: "retarget-links",
        cwd: dir,
        action: "retarget-links",
        timeoutMs: 20 * MIN,
      });
    }
    const cmd =
      s.cmd[0] === "git" && s.cmd[1] === "worktree"
        ? ["git", "worktree", "add", "--detach", dir, mergeSha]
        : s.cmd;
    plan.push({
      name: `worktree:${++n}`,
      cwd: s.cwd,
      cmd,
      heavy: cmd[0] === "npx", // the packages build
      timeoutMs: (cmd[0] === "npx" ? 30 : 20) * MIN,
    });
  }
  plan.push(
    {
      name: "lockdeps",
      cwd: dir,
      cmd: [
        "npm",
        "install",
        "--prefix",
        lockdeps,
        "--no-save",
        "--no-audit",
        "--no-fund",
        "--ignore-scripts",
        "semver@6.3.1",
      ],
      timeoutMs: 10 * MIN,
    },
    {
      name: "validate-lock-edges",
      cwd: dir,
      cmd: ["node", "scripts/validate-lock-edges.mjs"],
      env: { NODE_PATH: path.join(lockdeps, "node_modules") },
      gate: true,
      timeoutMs: 10 * MIN,
    },
  );
  if (installStale) {
    plan.push({
      name: "npm-ci",
      cwd: dir,
      cmd: ["npm", "ci", "--ignore-scripts", "--engine-strict=false"],
      heavy: true,
      timeoutMs: 20 * MIN,
      when: "package-lock.json or a package.json differs from the cloned node_modules",
    });
  }
  plan.push(
    // `npm ci --ignore-scripts` skips `prepare` (husky); verify's check-git-hooks needs .husky/_.
    { name: "husky", cwd: dir, cmd: ["npx", "husky"], timeoutMs: 5 * MIN },
    {
      name: "prisma-generate",
      cwd: path.join(dir, "apps/api"),
      cmd: ["npx", "prisma", "generate"],
      timeoutMs: 10 * MIN,
    },
    {
      name: "verify",
      cwd: dir,
      cmd: ["npm", "run", "verify"],
      env: {
        VERIFY_EXCLUDE: "@routeflow/control",
        JEST_MAX_WORKERS: "2",
        VERIFY_CONCURRENCY: "1",
        TURBO_FORCE: "true",
      },
      heavy: true,
      gate: true,
      timeoutMs: 60 * MIN,
    },
    {
      name: "audit-critical",
      cwd: dir,
      cmd: ["node", "scripts/ci-audit-critical.mjs"],
      gate: true,
      timeoutMs: 20 * MIN,
    },
    {
      name: "audit-high-report",
      cwd: dir,
      cmd: ["node", "scripts/ci-audit-critical.mjs", "--level", "high", "--report-only"],
      advisory: true,
      timeoutMs: 20 * MIN,
    },
  );
  if (dbLane) {
    plan.push(
      {
        name: "lint-migrations",
        cwd: dir,
        cmd: ["node", "scripts/lint-migrations.mjs", "--base", "origin/master"],
        gate: true,
        timeoutMs: 10 * MIN,
        when: "diff touches the DB-lane paths",
      },
      {
        name: "db-replay",
        cwd: dir,
        cmd: [
          "node",
          "scripts/local-db-specs.mjs",
          "--",
          "npm run db:drift -w apps/api && npm run test:db -w apps/api",
        ],
        env: { CI: "" }, // local-db-specs takes the heavy slot itself, and CI would bypass it
        heavy: false,
        gate: true,
        timeoutMs: 60 * MIN,
        when: "diff touches the DB-lane paths",
      },
    );
  }
  return plan;
}

/** Runs steps in order; stops at the first non-advisory failure (later non-advisory steps are skipped). */
export async function runSteps({ steps, exec, now = Date.now, log = () => {} }) {
  const t0 = now();
  const out = [];
  let failedStep = null;
  let infra = false;
  for (const step of steps) {
    if (failedStep && !step.advisory) {
      out.push({ name: step.name, status: "skipped", ms: 0, exit: null });
      continue;
    }
    const s0 = now();
    let r;
    try {
      r = await exec(step);
    } catch (e) {
      r = { status: 1, error: e };
    }
    const ok = r.status === 0;
    out.push({
      name: step.name,
      status: ok ? "pass" : "fail",
      ms: now() - s0,
      exit: r.status ?? null,
      ...(r.timedOut ? { timedOut: true } : {}),
    });
    log(
      `local-ci: ${step.name} ${ok ? "ok" : `FAILED (exit ${r.status}${r.timedOut ? ", timed out" : ""})`}${step.advisory && !ok ? " [advisory]" : ""}`,
    );
    if (!ok && !step.advisory) {
      failedStep = step.name;
      infra = !step.gate || Boolean(r.timedOut); // only a real gate failing on its own merits is `failure`
    }
  }
  return { ok: failedStep === null, failedStep, infra, durationMs: now() - t0, steps: out };
}

const fmtDuration = (ms) => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
};

/** GitHub states: success | failure (a gate failed) | error (the harness itself faulted). */
export function statusPayload({ ok, durationMs, failedStep, infra = false }) {
  const d = fmtDuration(durationMs);
  const step = String(failedStep).slice(0, 60);
  const description = ok
    ? `passed in ${d}`
    : infra
      ? `harness error at ${step} after ${d} (not a CI verdict)`
      : `failed at ${step} after ${d}`;
  return {
    context: STATUS_CONTEXT,
    state: ok ? "success" : infra ? "error" : "failure",
    description: description.slice(0, 140),
  };
}

// ---------------------------------------------------------------------------------------------
// Side-effecting orchestration (the dry run and real runs cover it)
// ---------------------------------------------------------------------------------------------

const q = (a) => (/[\s"]/.test(a) ? JSON.stringify(a) : a);

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
}

function gitOrNull(cwd, args) {
  try {
    return git(cwd, args);
  } catch {
    return null;
  }
}

/** Kills one process tree: the child we started, nothing else. */
function killTree(pid) {
  if (!pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* gone */
    }
  }
}

function makeExec({ logStream, ctx, state }) {
  return async (step) => {
    if (state.aborted) return { status: 130 };
    logStream.write(`\n$ (cd ${step.cwd}) ${step.cmd ? step.cmd.map(q).join(" ") : step.action}\n`);
    if (step.action === "retarget-links") {
      const made = relinkWorkspace(ctx.dir, ctx.from);
      logStream.write(`re-created ${made} workspace link(s) inside the worktree\n`);
      const moved = retargetLinks(ctx.dir, ctx.from);
      const left = linksInto(ctx.dir, ctx.from);
      logStream.write(
        `retargeted ${moved} link(s) into the worktree; ${left.length} still leave it\n`,
      );
      const bad = badWorkspaceLinks(ctx.dir);
      if (bad.length) {
        logStream.write(
          `ABORT: ${bad.length} @routeflow entry(ies) are not links into the worktree\n`,
        );
      }
      return { status: left.length === 0 && bad.length === 0 ? 0 : 1 };
    }
    if (step.cmd[0] === "cp") {
      // `cp -R` is not on a plain Windows PATH; copy natively (a real clone; links retargeted next).
      const [src, dst] = step.cmd.slice(-2);
      fs.cpSync(src, dst, { recursive: true });
      return { status: 0 };
    }
    const win = process.platform === "win32";
    const run = () =>
      new Promise((resolve) => {
        const child = spawn(
          step.cmd[0],
          step.cmd.slice(1).map((a) => (win ? q(a) : a)),
          {
            cwd: step.cwd,
            env: buildStepEnv(process.env, step),
            shell: win,
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        state.child = child;
        let timedOut = false;
        const timer = step.timeoutMs
          ? setTimeout(() => {
              timedOut = true;
              killTree(child.pid);
            }, step.timeoutMs)
          : null;
        const tee = (chunk) => {
          logStream.write(chunk);
          process.stdout.write(chunk);
        };
        child.stdout.on("data", tee);
        child.stderr.on("data", tee);
        const done = (r) => {
          clearTimeout(timer);
          state.child = null;
          resolve(r);
        };
        child.on("error", (error) => done({ status: 1, error }));
        child.on("exit", (status) => done({ status: timedOut ? 124 : (status ?? 1), timedOut }));
      });
    if (!step.heavy) return run();
    return withHeavySlot({ label: `local-ci-${ctx.pr}`, branch: "local-ci" }, run);
  };
}

/** Removes the worktree; returns false (and leaves it) if any link survives or git refuses. */
function removeWorktree(repo, dir, log) {
  const left = removeAllLinks(dir);
  if (left.length) {
    log(
      `local-ci: ${left.length} link(s) survived removal under ${dir}; worktree left in place, remove by hand`,
    );
    return false;
  }
  const r = spawnSync("git", ["worktree", "remove", dir], { cwd: repo, encoding: "utf8" });
  if (r.status !== 0) {
    log(`local-ci: worktree left in place (${r.stderr.trim()}); remove ${dir} by hand`);
    return false;
  }
  if (fs.existsSync(dir) && /^rf-lci-[0-9]+$/.test(path.basename(dir))) {
    // git leaves ignored files (the cloned node_modules) behind; every link is already gone.
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return true;
}

/** Blob ids of package-lock.json and every tracked package.json: the merge tree vs the clone source. */
function installEntries(repo, from, mergeSha) {
  const files = git(repo, ["ls-tree", "-r", "--name-only", mergeSha])
    .split("\n")
    .filter((f) => f === "package-lock.json" || /(^|\/)package\.json$/.test(f));
  return files.map((f) => {
    let local = null;
    try {
      local = git(from, ["hash-object", f]);
    } catch {
      /* missing in the clone source */
    }
    return { path: f, merge: git(repo, ["rev-parse", `${mergeSha}:${f}`]), local };
  });
}

export async function main(argv = process.argv.slice(2)) {
  let o;
  try {
    o = parseArgs(argv);
  } catch (e) {
    console.error(
      `local-ci: ${e.message}\nusage: node scripts/local-ci.mjs --pr N [--from W] [--no-status] [--keep] [--dry] [--head | --fresh] | --self-test`,
    );
    return 2;
  }
  if (o.selfTest) {
    return (
      spawnSync(process.execPath, ["--test", path.join(HERE, "local-ci.test.mjs")], {
        stdio: "inherit",
      }).status ?? 1
    );
  }
  const repo = git(process.cwd(), ["rev-parse", "--show-toplevel"]);
  const from = path.resolve(o.from ?? repo);
  let dir = worktreeDirName(repo, o.pr, "<head sha>", process.pid);
  const log = (m) => console.error(m);
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  log(
    `local-ci: host Node ${process.version}, CI pins ${CI_NODE_MAJOR}${nodeMajor === CI_NODE_MAJOR ? "" : " (MISMATCH: results may differ from CI)"}`,
  );

  if (o.dry) {
    const plan = planLocalCi({
      mergeSha: "<refs/pull/N/merge sha>",
      dir,
      from,
      lockdeps: path.join("local-assets", "local-ci", `${o.pr}-<sha>`, "lockdeps"),
      installStale: true,
      dbLane: true,
      platform: process.platform,
    });
    console.log(`local-ci plan for PR #${o.pr}:`);
    for (const s of plan) {
      const tags = [
        s.heavy ? "heavy-slot" : null,
        s.advisory ? "advisory" : null,
        s.gate ? "gate" : null,
        s.timeoutMs ? `${s.timeoutMs / MIN}m cap` : null,
        s.when ? `if ${s.when}` : null,
      ]
        .filter(Boolean)
        .join(", ");
      console.log(
        `  ${s.name.padEnd(20)} ${s.cmd ? s.cmd.map(q).join(" ") : s.action}${tags ? `   [${tags}]` : ""}`,
      );
    }
    console.log(
      `  then: gh api repos/${REPO_SLUG}/statuses/<head sha> (context ${STATUS_CONTEXT}: success | failure for a gate | error for the harness), remove worktree`,
    );
    return 0;
  }

  let mergeSha, headSha, plan, outDir, dbLane, installStale, treeInfo;
  try {
    // Fetch the exact tree GitHub CI tests, plus the base.
    git(repo, [
      "fetch",
      "origin",
      "master",
      `+refs/pull/${o.pr}/merge:refs/local-ci/${o.pr}/merge`,
      `+refs/pull/${o.pr}/head:refs/local-ci/${o.pr}/head`,
    ]);
    headSha = git(repo, ["rev-parse", `refs/local-ci/${o.pr}/head`]);
    const masterSha = git(repo, ["rev-parse", "origin/master"]);
    let githubMerge = null;
    try {
      githubMerge = git(repo, ["rev-parse", `refs/local-ci/${o.pr}/merge`]);
    } catch {
      /* no merge ref: conflicting PR */
    }
    if (o.tree === "merge" && !githubMerge) {
      throw new Error(`GitHub has no refs/pull/${o.pr}/merge (conflicts?); failing closed`);
    }
    const masterInMerge =
      githubMerge !== null &&
      spawnSync("git", ["merge-base", "--is-ancestor", masterSha, githubMerge], { cwd: repo })
        .status === 0;
    const tree = describeTree({ mode: o.tree, mergeSha: githubMerge, headSha, masterInMerge });
    if (o.tree === "fresh") {
      const t = spawnSync("git", ["merge-tree", "--write-tree", masterSha, headSha], {
        cwd: repo,
        encoding: "utf8",
      });
      if (t.status !== 0)
        throw new Error(`head does not merge cleanly into origin/master: ${t.stdout}`);
      tree.sha = git(repo, [
        "commit-tree",
        t.stdout.split("\n")[0].trim(),
        "-p",
        masterSha,
        "-p",
        headSha,
        "-m",
        `local-ci fresh merge of ${headSha.slice(0, 9)} into ${masterSha.slice(0, 9)}`,
      ]);
    }
    mergeSha = tree.sha;
    assertMergeTestsHead({
      mode: o.tree,
      mergeSha,
      headSha,
      secondParent: o.tree === "head" ? null : gitOrNull(repo, ["rev-parse", `${mergeSha}^2`]),
    });
    dir = worktreeDirName(repo, o.pr, headSha, process.pid);
    treeInfo = { ...tree, headSha, masterSha, githubMerge };
    log(
      `local-ci: testing ${tree.label} ${mergeSha.slice(0, 9)} (head ${headSha.slice(0, 9)}, origin/master ${masterSha.slice(0, 9)})` +
        (tree.stale
          ? "; WARNING GitHub's merge ref does NOT contain origin/master (stale), rerun with --fresh to test head merged into current master"
          : ""),
    );
    const files = git(repo, ["diff", "--name-only", "origin/master", mergeSha])
      .split("\n")
      .filter(Boolean);
    const wf = git(repo, ["show", `${mergeSha}:.github/workflows/db-migrations.yml`]);
    const dbGlobs = parseWorkflowPaths(wf);
    if (dbGlobs.length === 0) {
      throw new Error(
        "db-migrations.yml yielded no pull_request.paths (refusing to skip the DB lane)",
      );
    }
    dbLane = touchesDbLane(files, dbGlobs);
    installStale = installIsStale(installEntries(repo, from, mergeSha));
    outDir = path.join(
      repo,
      "local-assets",
      "local-ci",
      resultDirName(o.pr, headSha) + (o.tree === "merge" ? "" : `-${o.tree}`),
    );
    fs.mkdirSync(outDir, { recursive: true });
    plan = planLocalCi({
      mergeSha,
      dir,
      from,
      lockdeps: path.join(outDir, "lockdeps"),
      installStale,
      dbLane,
      platform: process.platform,
    });
  } catch (e) {
    log(`local-ci: setup failed before any step ran (no status posted): ${e.message}`);
    return 2;
  }

  const logStream = fs.createWriteStream(path.join(outDir, "local-ci.log"));
  const state = { aborted: null, child: null };
  const onSignal = (sig) => {
    state.aborted = sig;
    killTree(state.child?.pid);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  let result;
  let postFailed = false;
  try {
    result = await runSteps({
      steps: plan,
      exec: makeExec({ logStream, ctx: { dir, from, pr: o.pr }, state }),
      log,
    });
    if (state.aborted) {
      log(`local-ci: aborted by ${state.aborted}; no status posted`);
      return 130;
    }
    const payload = statusPayload(result);
    fs.writeFileSync(
      path.join(outDir, "result.json"),
      JSON.stringify(
        {
          pr: o.pr,
          headSha,
          mergeSha,
          tree: treeInfo,
          node: process.version,
          ciNode: String(CI_NODE_MAJOR),
          platform: process.platform,
          dbLane,
          installStale,
          ...result,
          status: payload,
        },
        null,
        2,
      ),
    );
    if (!o.noStatus) {
      const r = spawnSync(
        "gh",
        [
          "api",
          `repos/${REPO_SLUG}/statuses/${headSha}`,
          "-f",
          `state=${payload.state}`,
          "-f",
          `context=${payload.context}`,
          "-f",
          `description=${payload.description}`,
        ],
        { encoding: "utf8" },
      );
      postFailed = r.status !== 0;
      log(
        postFailed
          ? `local-ci: status post FAILED: ${r.stderr.trim()}`
          : `local-ci: posted ${payload.context} ${payload.state} on ${headSha.slice(0, 9)}`,
      );
    }
    log(`local-ci: PR #${o.pr} ${payload.state} - ${payload.description}; results in ${outDir}`);
    return result.ok ? (postFailed ? 3 : 0) : 1;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    killTree(state.child?.pid);
    logStream.end();
    if (!o.keep && fs.existsSync(dir)) removeWorktree(repo, dir, log);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code));
}
