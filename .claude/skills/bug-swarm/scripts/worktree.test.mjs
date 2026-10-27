// node --test worktree.test.mjs — contract tests for worktree.mjs (runs 2026-10-23-bug-swarm-1/-2).
import { test } from "node:test";
import path from "node:path";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  planWorktree,
  parseArgs,
  preflight,
  runPlan,
  readSharedHooksPath,
  runHuskyKeepingSharedConfig,
} from "./worktree.mjs";

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
  const husky = lines.indexOf("npx husky");
  const check = lines.indexOf("node scripts/check-git-hooks.mjs");
  assert.ok(husky > lines.findIndex((l) => l.startsWith("git worktree add")), "husky after add");
  assert.ok(check === husky + 1, "the guard runs right after husky");
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
  const g = (...a) => execFileSync("git", a, { cwd: dir, stdio: "pipe" });
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
    writeFileSync(path.join(dir, ".husky/_/pre-push"), "#!/bin/sh\n");
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

// B642 follow-up: `npx husky` runs a plain `git config core.hooksPath`, which rewrites the SHARED repo config
// every other worktree reads. The wrapper must leave the shared value exactly as it found it.
const gitIn = (cwd, ...a) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
  }).trim();

function mainAndLinked({ worktreeConfig, shared }) {
  const root = mkdtempSync(path.join(tmpdir(), "wt-shared-"));
  const main = path.join(root, "main");
  const linked = path.join(root, "linked");
  mkdirSync(main);
  gitIn(main, "init", "-q");
  gitIn(main, "commit", "-q", "--allow-empty", "-m", "init");
  if (worktreeConfig) gitIn(main, "config", "extensions.worktreeConfig", "true");
  if (shared !== null) gitIn(main, "config", "core.hooksPath", shared);
  gitIn(main, "worktree", "add", "-q", "-b", "t", linked);
  return { main, linked };
}

// stands in for husky's install, which writes core.hooksPath unscoped
const fakeHusky = (cwd) => () => {
  gitIn(cwd, "config", "core.hooksPath", ".husky/_");
  return 0;
};

test("husky step leaves the shared core.hooksPath as it was; this tree gets its own", () => {
  const { main, linked } = mainAndLinked({ worktreeConfig: true, shared: "custom/hooks" });
  assert.equal(runHuskyKeepingSharedConfig(linked, fakeHusky(linked)), 0);
  assert.equal(readSharedHooksPath(main), "custom/hooks", "shared value must not change");
  assert.equal(gitIn(linked, "config", "core.hooksPath"), ".husky/_", "this tree stays hooked");
  assert.equal(gitIn(main, "config", "core.hooksPath"), "custom/hooks", "main tree untouched");
});

test("husky step restores the shared value even without worktreeConfig, and unsets one that was unset", () => {
  const a = mainAndLinked({ worktreeConfig: false, shared: "custom/hooks" });
  runHuskyKeepingSharedConfig(a.linked, fakeHusky(a.linked));
  assert.equal(readSharedHooksPath(a.main), "custom/hooks");
  const b = mainAndLinked({ worktreeConfig: false, shared: null });
  runHuskyKeepingSharedConfig(b.linked, fakeHusky(b.linked));
  assert.equal(readSharedHooksPath(b.main), null);
});

test("sensitivity: an unguarded husky run DOES change the shared value (the test above can go red)", () => {
  const { main, linked } = mainAndLinked({ worktreeConfig: true, shared: "custom/hooks" });
  fakeHusky(linked)();
  assert.equal(readSharedHooksPath(main), ".husky/_");
});

test("the plan's husky step is the guarded one", () => {
  const plan = planWorktree({ ...base, platform: "linux" });
  const step = plan.find((s) => s.cmd.join(" ") === "npx husky");
  assert.equal(step.keepSharedHooksPath, true);
});
