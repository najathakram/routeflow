// node --test worktree.test.mjs — contract tests for worktree.mjs (runs 2026-10-23-bug-swarm-1/-2).
import { test } from "node:test";
import path from "node:path";
import assert from "node:assert/strict";
import { planWorktree, parseArgs, preflight } from "./worktree.mjs";

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
  assert.deepEqual(plan[0].cmd, ["git", "fetch", "origin"]);
  assert.deepEqual(plan[1].cmd, [
    "git",
    "worktree",
    "add",
    "-b",
    "fix/swarm-1-c1",
    "/r/wt",
    "origin/master",
  ]);
  assert.equal(plan[1].cwd, path.join("/r/main"));
  const cps = plan.filter((s) => s.cmd[0] === "cp");
  assert.equal(cps.length, 4);
  for (const s of cps) assert.deepEqual(s.cmd.slice(0, 2), ["cp", "-cR"]);
  assert.deepEqual(cps[0].cmd, [
    "cp",
    "-cR",
    path.join("/r/src/node_modules"),
    path.join("/r/wt/node_modules"),
  ]);
  assert.deepEqual(cps[1].cmd.slice(2), [
    path.join("/r/src/apps/api/node_modules"),
    path.join("/r/wt/apps/api/node_modules"),
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
  assert.equal(plan.at(-2).cwd, path.join("/r/wt"));
  assert.equal(plan.at(-1).cwd, path.join("/r/wt/apps/api"));
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

test("preflight refuses an existing dir, a local branch or an origin branch; clean passes", () => {
  const git = (local, remote) => (args) => {
    if (args[0] === "rev-parse") return local ? "abc\n" : "";
    if (args[0] === "ls-remote") return remote ? "abc\trefs/heads/b\n" : "";
    throw new Error("unexpected");
  };
  assert.equal(
    preflight({ dir: "/d", branch: "b", exists: () => false, git: git(false, false) }),
    null,
  );
  assert.match(
    preflight({ dir: "/d", branch: "b", exists: () => true, git: git(false, false) }),
    /exists/,
  );
  assert.match(
    preflight({ dir: "/d", branch: "b", exists: () => false, git: git(true, false) }),
    /local/,
  );
  assert.match(
    preflight({ dir: "/d", branch: "b", exists: () => false, git: git(false, true) }),
    /origin/,
  );
});
