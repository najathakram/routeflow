#!/usr/bin/env node
// "The new tests fail without the fix" (R4, dark): the repro-first rule of bug-pipeline as a script.
//
//   node scripts/fix-revert-probe.mjs [--base <ref>] [--tests <file>...]
//
// Test set = test files the branch adds or changes (or --tests, last flag); fix set = every other changed
// file minus docs/green paths. A locked temporary `git worktree --detach` at HEAD runs each test on HEAD,
// then gets the fix set restored to the merge-base (paths on stdin, so no command-line limit) and runs
// each test again. Verdict per test file:
//   repro      fails without the fix, passes with it       not-repro  passes without the fix
//   broken     fails on HEAD                                skipped    no runner, missing env, timeout, or the
//                                                                      restore failed (reason given)
// Runners: jest per workspace (node + jest bin, no npx, as size-ratchet-gate.mjs), `node <file>` for
// *.self-test.mjs and *.spec.mjs. Scope: fix/* and bug/* branches or a `fix:` commit on the branch's own
// (first-parent, non-merge) commits; else "not a fix branch", exit 0. The temp worktree's node_modules are
// junctions to the caller's; the links (never their targets) are removed before the worktree is.
// Exit: PROBE_MODE "dark" always 0; "enforced" would exit 1 on a fix branch with no `repro` test.
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scrubbedGitEnv } from "./lib/check-git-hooks.mjs";
import { classifyPath } from "./lib/risk-paths.mjs";
import { isTestFile } from "./test-tamper-check.mjs";

export const PROBE_MODE = "dark";
const TIMEOUT_MS = 300000;

// Runner table: workspace prefix -> jest config (relative to that workspace; apps/api keeps its own in
// package.json; its *.db.spec.ts use jest.db.config.js and need DATABASE_URL).
const JEST = [
  ["apps/api/", "package.json"],
  ["apps/web/", "jest.config.js"],
  ["apps/mobile/", "jest.config.js"],
  ["packages/pricing/", "jest.config.js"],
  ["packages/returns/", "jest.config.js"],
  ["packages/scanning/", "jest.config.js"],
];

export const isFixBranch = (b) => /^(fix|bug)\//.test(b ?? "");

/** Splits changed entries ({ status, path }) into the test files to run and the fix set to revert. */
export function classifyChanged(entries) {
  const live = entries.filter((e) => e.status !== "D" || !isTestFile(e.path));
  return {
    tests: live.filter((e) => isTestFile(e.path)).map((e) => e.path),
    fix: live.filter(
      (e) => !isTestFile(e.path) && !e.path.endsWith(".md") && classifyPath(e.path).cls !== "green",
    ),
  };
}

/** { cmd, args, cwd } running one jest file in its workspace, or null when no workspace owns it. */
export function jestCommand(file, { root, jestBin, db = false }) {
  const hit = JEST.find(([prefix]) => file.startsWith(prefix));
  if (!hit) return null;
  const cwd = path.join(root, hit[0].slice(0, -1));
  const cfg = db && hit[0] === "apps/api/" ? "jest.db.config.js" : hit[1];
  const bin = jestBin ?? createRequire(path.join(cwd, "package.json")).resolve("jest/bin/jest");
  const args = [bin, "--config", cfg, "--ci", "--reporters=default", "--runTestsByPath"];
  return { cmd: process.execPath, args: [...args, file.slice(hit[0].length)], cwd };
}

/** Runs one test file under `root`: { status } (null = timeout/spawn error) or { skip: reason }. */
export function defaultRun(file, root) {
  let c;
  if (/\.db\.spec\.ts$/.test(file)) {
    if (!process.env.DATABASE_URL) return { skip: "DATABASE_URL not set" };
    c = jestCommand(file, { root, db: true });
  } else if (/\.(self-test|spec)\.mjs$/.test(file)) {
    c = { cmd: process.execPath, args: [file], cwd: root };
  } else c = jestCommand(file, { root });
  if (!c) return { skip: "no runner for this path" };
  const r = spawnSync(c.cmd, c.args, {
    cwd: c.cwd,
    env: scrubbedGitEnv(),
    encoding: "utf8",
    timeout: TIMEOUT_MS,
  });
  return { status: r.error ? null : r.status, output: `${r.stdout}${r.stderr}` };
}

export const gitIn = (cwd, args, input) =>
  spawnSync("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=", ...args], {
    cwd,
    encoding: "utf8",
    env: scrubbedGitEnv(),
    input,
  });

/** Restores `paths` in worktree `wt` to their `mb` content: { ok } or { ok: false, stderr }. */
export function restoreFix(wt, mb, paths) {
  if (!paths.length) return { ok: true };
  const args = ["--literal-pathspecs", "checkout", mb, "--pathspec-from-file=-"];
  const r = gitIn(wt, [...args, "--pathspec-file-nul"], paths.join("\0"));
  return r.status === 0 ? { ok: true } : { ok: false, stderr: (r.stderr || `${r.error}`).trim() };
}

/** Dirs (relative to root) whose node_modules exist: the root and each workspace. */
export function nodeModulesDirs(root) {
  const dirs = ["."];
  for (const g of ["apps", "packages"]) {
    if (existsSync(path.join(root, g)))
      dirs.push(...readdirSync(path.join(root, g)).map((d) => `${g}/${d}`));
  }
  return dirs.filter((d) => existsSync(path.join(root, d, "node_modules")));
}

/** Removes a junction/symlink itself (never its target); true when it is gone (only ENOENT counts). */
export function unlink(link) {
  const gone = () => {
    try {
      lstatSync(link);
      return false;
    } catch (e) {
      return e?.code === "ENOENT";
    }
  };
  if (gone()) return true;
  try {
    rmSync(link); // no `recursive`: removes the link, never walks into the target
  } catch {
    if (process.platform === "win32") spawnSync("cmd", ["/c", "rmdir", link], { stdio: "ignore" });
  }
  return gone();
}

/** Probes every test file of the branch; returns { branch, base, notFix?, results: [{ file, verdict, reason }] }. */
export const lockWorktree = (root, wt) =>
  gitIn(root, ["worktree", "lock", "--reason", "rf-probe", wt]);

export async function runProbe({
  cwd,
  base,
  tests,
  run = defaultRun,
  restore = restoreFix,
  lock = lockWorktree,
}) {
  const root = realpathSync.native(gitIn(cwd, ["rev-parse", "--show-toplevel"]).stdout.trim());
  const branch = gitIn(root, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim();
  const mb = gitIn(root, ["merge-base", base, "HEAD"]).stdout.trim() || base;
  const own = ["log", "--no-merges", "--first-parent", "--format=%s", `${mb}..HEAD`];
  if (!isFixBranch(branch) && !/^fix[(:]/m.test(gitIn(root, own).stdout)) {
    return { branch, base, notFix: true, results: [] };
  }

  const parts = gitIn(root, [
    "diff",
    "--name-status",
    "-z",
    "--no-renames",
    mb,
    "HEAD",
  ]).stdout.split("\0");
  const entries = [];
  for (let i = 0; i + 1 < parts.length; i += 2)
    entries.push({ status: parts[i][0], path: parts[i + 1] });
  const set = classifyChanged(entries);
  const files = tests?.length ? tests : set.tests;
  const results = [];
  const tmp = mkdtempSync(path.join(tmpdir(), "rf-probe-"));
  const wt = path.join(tmp, "wt");
  const links = [];
  let added = false;
  try {
    const add = gitIn(root, ["worktree", "add", "--detach", wt, "HEAD"]);
    if (add.status !== 0) throw new Error(`git worktree add failed: ${add.stderr}`);
    added = true;
    // No junction on an unlocked worktree: a crash would leave live links a later remove deletes through.
    const locked = lock(root, wt);
    if (locked.status !== 0) throw new Error(`git worktree lock failed: ${locked.stderr}`);
    for (const d of nodeModulesDirs(root)) {
      const link = path.join(wt, d, "node_modules");
      mkdirSync(path.dirname(link), { recursive: true });
      symlinkSync(path.join(root, d, "node_modules"), link, "junction");
      links.push(link);
    }
    const heads = files.map((file) => run(file, wt)); // HEAD side, before anything is reverted
    for (const e of set.fix.filter((x) => x.status === "A"))
      rmSync(path.join(wt, e.path), { force: true });
    const back = restore(
      wt,
      mb,
      set.fix.filter((e) => e.status !== "A").map((e) => e.path),
    );
    files.forEach((file, i) => {
      const head = heads[i];
      const push = (verdict, reason) => results.push({ file, verdict, reason });
      if (head.skip) return push("skipped", head.skip);
      if (head.status === null) return push("skipped", "timed out on HEAD");
      if (head.status !== 0) return push("broken", "fails on HEAD");
      if (!back.ok) return push("skipped", `could not restore the fix set: ${back.stderr}`);
      const old = run(file, wt);
      if (old.skip) push("skipped", old.skip);
      else if (old.status === null) push("skipped", "timed out without the fix");
      else if (old.status === 0) push("not-repro", "passes without the fix");
      else push("repro", "fails without the fix, passes with it");
    });
  } finally {
    // Links first: a recursive remove must never walk through a junction into the caller's node_modules.
    if (!links.map(unlink).every(Boolean)) {
      console.error(`fix-revert-probe: could not unlink node_modules; left ${wt} in place.`);
    } else {
      if (added) {
        gitIn(root, ["worktree", "unlock", wt]);
        gitIn(root, ["worktree", "remove", "--force", wt]);
      }
      gitIn(root, ["worktree", "prune"]);
      rmSync(tmp, { recursive: true, force: true });
    }
  }
  return { branch, base, results };
}

export async function main(argv) {
  const flagAt = (f) => argv.indexOf(f);
  const base =
    (flagAt("--base") >= 0 ? argv[flagAt("--base") + 1] : null) ??
    ["origin/master", "master", "main"].find(
      (r) => gitIn(process.cwd(), ["rev-parse", "--verify", "-q", `${r}^{commit}`]).status === 0,
    );
  if (!base) {
    console.log("fix-revert-probe: no base ref found.");
    return 0;
  }
  const tests = flagAt("--tests") < 0 ? [] : argv.slice(flagAt("--tests") + 1);
  const out = await runProbe({ cwd: process.cwd(), base, tests });
  if (out.notFix) {
    console.log(
      `fix-revert-probe: ${out.branch} is not a fix branch (fix/*, bug/*, or a fix: commit).`,
    );
    return 0;
  }
  const repro = out.results.filter((r) => r.verdict === "repro").length;
  for (const r of out.results) console.log(`${r.verdict.padEnd(9)} ${r.file}  (${r.reason})`);
  if (!out.results.length) console.log("fix-revert-probe: this branch changed no test files.");
  console.log(
    `fix-revert-probe (${PROBE_MODE}): ${repro} repro of ${out.results.length} test file(s).`,
  );
  return PROBE_MODE === "enforced" && !repro ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`fix-revert-probe: ${e instanceof Error ? e.message : e}`);
      process.exit(PROBE_MODE === "enforced" ? 2 : 0);
    },
  );
}
