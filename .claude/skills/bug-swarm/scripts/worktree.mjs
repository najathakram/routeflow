#!/usr/bin/env node
// Why: each /bug-swarm builder needs its own worktree with node_modules in seconds, not an `npm ci`.
// Run 2026-10-23-bug-swarm-1 cloned node_modules by hand; run 2026-10-23-bug-swarm-2 showed a cloned
// but stale packages/*/dist failed web tsc, so the packages build is ALWAYS part of the plan.
//
//   node worktree.mjs --dir D --branch B [--base origin/master] [--from <worktree>] [--dry-run]
//
// Pure core: planWorktree(...) -> [{ cwd, cmd: string[] }]. Never `npm ci`.
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
  const plan = [{ cwd: repo, cmd: ["git", "worktree", "add", "-b", branch, dir, base] }];
  for (const rel of mods) {
    plan.push({
      cwd: dir,
      cmd: [...cp, path.join(from, rel, "node_modules"), path.join(dir, rel, "node_modules")],
    });
  }
  plan.push({ cwd: dir, cmd: ["npx", "turbo", "run", "build", "--filter=./packages/*"] });
  plan.push({ cwd: path.join(dir, "apps/api"), cmd: ["npx", "prisma", "generate"] });
  return plan;
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
  const plan = planWorktree({
    repo,
    dir: path.resolve(o.dir),
    branch: o.branch,
    base: o.base,
    from: path.resolve(o.from ?? repo),
    platform: process.platform,
  });
  for (const step of plan) {
    console.log(`$ (cd ${step.cwd}) ${step.cmd.join(" ")}`);
    if (o.dryRun) continue;
    const r = spawnSync(step.cmd[0], step.cmd.slice(1), { cwd: step.cwd, stdio: "inherit" });
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
