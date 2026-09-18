#!/usr/bin/env node
// Self-test for janitor.mjs's classification logic (fixtures only — never
// touches a real git repo, filesystem tree, Docker, or npm cache; nothing
// here deletes anything real).
import assert from "node:assert/strict";
import {
  isProtectedWorktreeName,
  isProtectedBranch,
  classifyWorktree,
  isStaleByAge,
  meetsThreshold,
  findOrphanWorktreeDirs,
  findStaleBranches,
} from "./janitor.mjs";

let pass = 0;
const failures = [];

function t(name, fn) {
  try {
    fn();
    pass++;
  } catch (err) {
    failures.push(`${name}: ${err.message}`);
  }
}

t("protected worktree name is protected", () => {
  assert.equal(isProtectedWorktreeName("rf-migrate"), true);
  assert.equal(isProtectedWorktreeName("rf-crm-cloud"), true);
});
t("ordinary worktree name is not protected", () => {
  assert.equal(isProtectedWorktreeName("rf-scratch"), false);
});
t("master/main are protected branches", () => {
  assert.equal(isProtectedBranch("master"), true);
  assert.equal(isProtectedBranch("main"), true);
  assert.equal(isProtectedBranch("feature/x"), false);
});

t("classifyWorktree: main checkout is never touched", () => {
  const v = classifyWorktree({
    name: "routeflow",
    branch: "master",
    isMainCheckout: true,
    isMerged: true,
    isDirty: false,
    hasUnpushed: false,
  });
  assert.equal(v.nodeModules, "skip");
  assert.equal(v.worktree, "skip");
  assert.equal(v.reason, "main checkout");
});

t("classifyWorktree: protected worktree name is never touched, even if merged/clean", () => {
  const v = classifyWorktree({
    name: "rf-migrate",
    branch: "chore/migrate-batch",
    isMainCheckout: false,
    isMerged: true,
    isDirty: false,
    hasUnpushed: false,
  });
  assert.equal(v.nodeModules, "skip");
  assert.equal(v.worktree, "skip");
});

t("classifyWorktree: unmerged branch is never touched at all", () => {
  const v = classifyWorktree({
    name: "rf-in-progress",
    branch: "fix/still-open",
    isMainCheckout: false,
    isMerged: false,
    isDirty: false,
    hasUnpushed: false,
  });
  assert.equal(v.nodeModules, "skip");
  assert.equal(v.worktree, "skip");
  assert.match(v.reason, /not merged/);
});

t("classifyWorktree: merged + dirty clears node_modules but keeps the worktree", () => {
  const v = classifyWorktree({
    name: "rf-old",
    branch: "fix/landed",
    isMainCheckout: false,
    isMerged: true,
    isDirty: true,
    hasUnpushed: false,
  });
  assert.equal(v.nodeModules, "clear");
  assert.equal(v.worktree, "skip");
  assert.match(v.reason, /uncommitted/);
});

t("classifyWorktree: merged + unpushed commits clears node_modules but keeps the worktree", () => {
  const v = classifyWorktree({
    name: "rf-old2",
    branch: "fix/landed2",
    isMainCheckout: false,
    isMerged: true,
    isDirty: false,
    hasUnpushed: true,
  });
  assert.equal(v.nodeModules, "clear");
  assert.equal(v.worktree, "skip");
  assert.match(v.reason, /unpushed/);
});

t("classifyWorktree: merged + clean + pushed removes the whole worktree", () => {
  const v = classifyWorktree({
    name: "rf-done",
    branch: "fix/shipped",
    isMainCheckout: false,
    isMerged: true,
    isDirty: false,
    hasUnpushed: false,
  });
  assert.equal(v.nodeModules, "clear");
  assert.equal(v.worktree, "remove");
});

t("isStaleByAge: exactly 7 days is NOT stale, 8 days IS", () => {
  const now = Date.parse("2026-09-17T00:00:00Z");
  const dayMs = 24 * 60 * 60 * 1000;
  assert.equal(isStaleByAge(now - 7 * dayMs, now, 7), false);
  assert.equal(isStaleByAge(now - 8 * dayMs, now, 7), true);
});

t("meetsThreshold: >= is a pass, just under is not", () => {
  assert.equal(meetsThreshold(10, 10), true);
  assert.equal(meetsThreshold(9.99, 10), false);
  assert.equal(meetsThreshold(12, 10), true);
});

t("findOrphanWorktreeDirs: a dir git doesn't list is an orphan", () => {
  const listed = ["C:/ClaudeCode/routeflow/.claude/worktrees/rf-a"];
  const dirNames = ["rf-a", "rf-b-orphan"];
  const orphans = findOrphanWorktreeDirs(
    listed,
    dirNames,
    "C:/ClaudeCode/routeflow/.claude/worktrees",
  );
  assert.deepEqual(orphans, ["rf-b-orphan"]);
});

t("findStaleBranches: merged branches still on origin, protected branches excluded", () => {
  const remote = ["feature/a", "feature/b", "master", "fix/open"];
  const merged = new Set(["feature/a", "master"]);
  const stale = findStaleBranches(remote, merged);
  assert.deepEqual(stale, ["feature/a"]);
});

console.log(`janitor self-test: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error(`  FAIL ${f}`);
  process.exit(1);
}
