// node --test worktree.test.mjs — contract tests for worktree.mjs (runs 2026-10-23-bug-swarm-1/-2).
import { test } from "node:test";
import assert from "node:assert/strict";
import { planWorktree, parseArgs } from "./worktree.mjs";

const base = {
  repo: "/r/main",
  dir: "/r/wt",
  branch: "fix/swarm-1-c1",
  base: "origin/master",
  from: "/r/src",
  nodeModules: ["", "apps/api", "apps/web", "packages/pricing"],
};
const flat = (plan) => plan.map((s) => s.cmd.join(" "));

test("darwin clones node_modules with cp -cR (APFS), after git worktree add", () => {
  const plan = planWorktree({ ...base, platform: "darwin" });
  assert.deepEqual(plan[0].cmd, [
    "git",
    "worktree",
    "add",
    "-b",
    "fix/swarm-1-c1",
    "/r/wt",
    "origin/master",
  ]);
  assert.equal(plan[0].cwd, "/r/main");
  const cps = plan.filter((s) => s.cmd[0] === "cp");
  assert.equal(cps.length, 4);
  for (const s of cps) assert.deepEqual(s.cmd.slice(0, 2), ["cp", "-cR"]);
  assert.deepEqual(cps[0].cmd, ["cp", "-cR", "/r/src/node_modules", "/r/wt/node_modules"]);
  assert.deepEqual(cps[1].cmd.slice(2), [
    "/r/src/apps/api/node_modules",
    "/r/wt/apps/api/node_modules",
  ]);
});

test("linux uses plain cp -R", () => {
  const plan = planWorktree({ ...base, platform: "linux" });
  for (const s of plan.filter((x) => x.cmd[0] === "cp"))
    assert.deepEqual(s.cmd.slice(0, 2), ["cp", "-R"]);
});

test("packages build and prisma generate are always present, last, in order", () => {
  for (const platform of ["darwin", "linux"]) {
    const lines = flat(planWorktree({ ...base, platform, nodeModules: [] }));
    assert.deepEqual(lines.slice(-2), [
      "npx turbo run build --filter=./packages/*",
      "npx prisma generate",
    ]);
  }
  const plan = planWorktree({ ...base, platform: "darwin" });
  assert.equal(plan.at(-2).cwd, "/r/wt");
  assert.equal(plan.at(-1).cwd, "/r/wt/apps/api");
});

test("never runs npm ci or npm install", () => {
  const all = flat(planWorktree({ ...base, platform: "darwin" })).join("\n");
  assert.doesNotMatch(all, /npm (ci|install|i)\b/);
});

test("parseArgs applies defaults and rejects a missing --dir/--branch", () => {
  const a = parseArgs(["--dir", "/d", "--branch", "b", "--dry-run"]);
  assert.equal(a.base, "origin/master");
  assert.equal(a.dryRun, true);
  assert.throws(() => parseArgs(["--dir", "/d"]), /--branch/);
  assert.throws(() => parseArgs(["--branch", "b"]), /--dir/);
});
