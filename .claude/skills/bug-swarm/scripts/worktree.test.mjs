// node --test worktree.test.mjs — contract tests for worktree.mjs (runs 2026-10-23-bug-swarm-1/-2).
import { test } from "node:test";
import path from "node:path";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { scrubbedGitEnv } from "../../../../scripts/lib/check-git-hooks.mjs";
import { planWorktree, parseArgs, preflight, runPlan } from "./worktree.mjs";

const norm = (p) => path.normalize(p);
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
  assert.deepEqual(
    plan[1].cmd.map((x, i) => (i === 5 ? norm(x) : x)),
    ["git", "worktree", "add", "-b", "fix/swarm-1-c1", norm("/r/wt"), "origin/master"],
  );
  assert.equal(norm(plan[1].cwd), norm("/r/main"));
  const cps = plan.filter((s) => s.cmd[0] === "cp");
  assert.equal(cps.length, 4);
  for (const s of cps) assert.deepEqual(s.cmd.slice(0, 2), ["cp", "-cR"]);
  assert.deepEqual(
    cps[0].cmd.map((x, i) => (i < 2 ? x : norm(x))),
    ["cp", "-cR", norm("/r/src/node_modules"), norm("/r/wt/node_modules")],
  );
  assert.deepEqual(cps[1].cmd.slice(2).map(norm), [
    norm("/r/src/apps/api/node_modules"),
    norm("/r/wt/apps/api/node_modules"),
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
  assert.equal(norm(plan.at(-2).cwd), norm("/r/wt"));
  assert.equal(norm(plan.at(-1).cwd), norm("/r/wt/apps/api"));
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

// B642 / SA 06:08Z guard: a tree made by worktree.mjs must have git hooks installed, or the script refuses (exit 1).
test("plan installs hooks, then refuses a hookless tree BEFORE the slow build", () => {
  const lines = flat(planWorktree({ ...base, platform: "linux" }));
  const ensure = lines.indexOf("node scripts/ensure-git-hooks.mjs");
  const check = lines.indexOf("node scripts/check-git-hooks.mjs");
  assert.ok(ensure > lines.findIndex((l) => l.startsWith("git worktree add")), "ensure after add");
  assert.ok(check === ensure + 1, "the guard runs right after ensure");
  assert.ok(
    check < lines.indexOf("npx turbo run build --filter=./packages/*"),
    "guard before build",
  );
  const plan = planWorktree({ ...base, platform: "linux" });
  assert.equal(norm(plan[check].cwd), norm("/r/wt"));
});

const noCi = () => {
  const env = { ...process.env };
  delete env.CI;
  return env;
};

function tmpTree({ hooks }) {
  const dir = mkdtempSync(path.join(tmpdir(), "wt-hooks-"));
  const g = (...a) => execFileSync("git", a, { cwd: dir, stdio: "pipe", env: scrubbedGitEnv() });
  g("init", "-q");
  g("config", "core.hooksPath", ".husky/_");
  mkdirSync(path.join(dir, "scripts"), { recursive: true });
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
  cpSync(
    path.join(repoRoot, "scripts/check-git-hooks.mjs"),
    path.join(dir, "scripts/check-git-hooks.mjs"),
  );
  cpSync(path.join(repoRoot, "scripts/lib"), path.join(dir, "scripts/lib"), { recursive: true });
  if (hooks) {
    mkdirSync(path.join(dir, ".husky/_"), { recursive: true });
    const hook = path.join(dir, ".husky/_/pre-push");
    writeFileSync(hook, "#!/bin/sh\n");
    chmodSync(hook, 0o755); // git skips a non-executable hook on POSIX
  }
  return dir;
}

test("runPlan: a tree with no .husky/_ is refused with exit 1 and later steps never run", () => {
  const dir = tmpTree({ hooks: false });
  const ran = [];
  const plan = [
    { cwd: dir, cmd: ["node", "scripts/check-git-hooks.mjs"] },
    { cwd: dir, cmd: ["node", "-e", "process.exit(0)"], after: true },
  ];
  const code = runPlan(plan, { env: noCi(), log: () => {}, onStep: (s) => ran.push(s) });
  assert.equal(code, 1);
  assert.equal(ran.length, 1, "stopped at the guard");
});

test("runPlan: a tree WITH .husky/_/pre-push passes the guard and the plan continues", () => {
  const dir = tmpTree({ hooks: true });
  const plan = [
    { cwd: dir, cmd: ["node", "scripts/check-git-hooks.mjs"] },
    { cwd: dir, cmd: ["node", "-e", "process.exit(0)"] },
  ];
  assert.equal(runPlan(plan, { env: noCi(), log: () => {} }), 0);
});

test("the plan has NO husky step: it would write a per-worktree core.hooksPath", () => {
  const plan = planWorktree({ ...base, platform: "linux" });
  assert.deepEqual(
    plan.filter((s) => s.cmd.some((w) => /husky/.test(w) && !/ensure|check/.test(w))),
    [],
  );
  assert.ok(plan.every((s) => s.keepSharedHooksPath === undefined));
});

// A copied node_modules never ran `prepare`: the plan copies the main checkout's hooks in (no husky, no config write).
test("plan runs ensure-git-hooks after the node_modules copies and before the build", () => {
  const plan = planWorktree({ ...base, platform: "linux" });
  const lines = flat(plan);
  const ensure = lines.indexOf("node scripts/ensure-git-hooks.mjs");
  assert.ok(ensure > lines.map((l) => l.startsWith("cp ")).lastIndexOf(true), "after the copies");
  assert.ok(
    ensure < lines.indexOf("npx turbo run build --filter=./packages/*"),
    "before the build",
  );
  assert.equal(norm(plan[ensure].cwd), norm("/r/wt"));
  assert.notEqual(plan[ensure].keepSharedHooksPath, true);
});
