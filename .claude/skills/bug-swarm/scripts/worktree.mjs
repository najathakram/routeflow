#!/usr/bin/env node
// Why: each /bug-swarm builder needs its own worktree with node_modules in seconds, not an `npm ci`.
// Run 2026-10-23-bug-swarm-1 cloned node_modules by hand; run 2026-10-23-bug-swarm-2 showed a cloned
// but stale packages/*/dist failed web tsc, so the packages build is ALWAYS part of the plan.
//
//   node worktree.mjs --dir D --branch B [--base origin/master] [--from <worktree>] [--dry-run]
//
// Pure core: planWorktree(...) -> [{ cwd, cmd: string[] }]. Never `npm ci`.
// B642: a copied node_modules never ran husky's `prepare`, so the new tree has no .husky/_ and git would
// silently skip the pre-push verify. The plan runs `npx husky`, then scripts/check-git-hooks.mjs, which
// exits 1 when hooks are still missing; runPlan stops there (exit 1) before the slow packages build.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/** Relative dirs ("" = repo root) under `from` that hold a node_modules folder. */
export function discoverNodeModules(from) {
  const out = [];
  if (existsSync(path.join(from, "node_modules"))) out.push("");
  for (const group of ["apps", "packages"]) {
    const g = path.join(from, group);
    if (!existsSync(g)) continue;
    for (const name of readdirSync(g).sort()) {
      if (existsSync(path.join(g, name, "node_modules"))) out.push(`${group}/${name}`);
    }
  }
  return out;
}

export function planWorktree({
  repo,
  dir,
  branch,
  base = "origin/master",
  from,
  platform,
  nodeModules,
}) {
  const mods = nodeModules ?? discoverNodeModules(from);
  const cp = platform === "darwin" ? ["cp", "-cR"] : ["cp", "-R"];
  const plan = [
    { cwd: repo, cmd: ["git", "fetch", "origin"] },
    { cwd: repo, cmd: ["git", "worktree", "add", "-b", branch, dir, base] },
  ];
  for (const rel of mods) {
    plan.push({
      cwd: dir,
      cmd: [...cp, path.join(from, rel, "node_modules"), path.join(dir, rel, "node_modules")],
    });
  }
  plan.push({ cwd: dir, cmd: ["npx", "husky"] });
  plan.push({ cwd: dir, cmd: ["node", "scripts/check-git-hooks.mjs"] });
  plan.push({ cwd: dir, cmd: ["npx", "turbo", "run", "build", "--filter=./packages/*"] });
  plan.push({ cwd: path.join(dir, "apps/api"), cmd: ["npx", "prisma", "generate"] });
  return plan;
}

/** Error text when the target dir or branch is taken (locally or on origin); null when clear. */
export function preflight({ dir, branch, exists = existsSync, git }) {
  if (exists(dir)) return `target dir ${dir} already exists`;
  if (git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).trim()) {
    return `branch ${branch} already exists locally`;
  }
  if (git(["ls-remote", "--heads", "origin", branch]).trim()) {
    return `branch ${branch} already exists on origin`;
  }
  return null;
}

export function parseArgs(argv) {
  const o = { base: "origin/master", dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") o.dryRun = true;
    else if (["--dir", "--branch", "--base", "--from"].includes(a) && argv[i + 1] !== undefined) {
      o[a.slice(2)] = argv[++i];
    } else throw new Error(`unknown or incomplete argument ${JSON.stringify(a)}`);
  }
  if (!o.dir) throw new Error("--dir is required");
  if (!o.branch) throw new Error("--branch is required");
  return o;
}

export function main(argv = process.argv.slice(2)) {
  let o;
  try {
    o = parseArgs(argv);
  } catch (e) {
    console.error(
      `worktree: ${e.message}\nusage: node worktree.mjs --dir D --branch B [--base origin/master] [--from W] [--dry-run]`,
    );
    return 2;
  }
  const repo = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const dir = path.resolve(o.dir);
  const git = (args) => {
    const r = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    if (r.status !== 0 && args[0] === "ls-remote")
      throw new Error(`git ls-remote failed: ${r.stderr}`);
    return r.stdout ?? "";
  };
  let problem;
  try {
    problem = preflight({ dir, branch: o.branch, git });
  } catch (e) {
    problem = e.message;
  }
  if (problem) {
    console.error(`worktree: refusing: ${problem}`);
    return 2;
  }
  const plan = planWorktree({
    repo,
    dir,
    branch: o.branch,
    base: o.base,
    from: path.resolve(o.from ?? repo),
    platform: process.platform,
  });
  return runPlan(plan, { dryRun: o.dryRun });
}

/** Runs the plan in order; the first failing step stops it and its exit code is returned (1 = hooks missing). */
export function runPlan(
  plan,
  { dryRun = false, env = process.env, log = console.log, onStep = () => {} } = {},
) {
  for (const step of plan) {
    log(`$ (cd ${step.cwd}) ${step.cmd.join(" ")}`);
    if (dryRun) continue;
    onStep(step);
    const r = spawnSync(step.cmd[0], step.cmd.slice(1), { cwd: step.cwd, stdio: "inherit", env });
    if (r.status !== 0) {
      console.error(`worktree: step failed (exit ${r.status}); stopping`);
      return r.status ?? 1;
    }
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
