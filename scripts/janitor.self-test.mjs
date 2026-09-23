#!/usr/bin/env node
// Self-test for janitor.mjs's classification logic. Pure fixtures, plus (B800)
// throwaway git repos under the OS temp dir for the merge check — never the
// RouteFlow repo, a real worktree, Docker, or the npm cache; nothing here
// deletes anything real.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isProtectedWorktreeName,
  isProtectedBranch,
  classifyWorktree,
  isStaleByAge,
  meetsThreshold,
  findOrphanWorktreeDirs,
  findStaleBranches,
  isMergedEvidence,
  isRecentlyActive,
  isMergedIntoMaster,
} from "./janitor.mjs";

// Run inside a git hook, GIT_DIR / GIT_INDEX_FILE / GIT_WORK_TREE would point every `git -C <tmp>`
// below at the REAL repo. Scrub them before any git call (the janitor inherits this env).
for (const k of Object.keys(process.env)) if (k.startsWith("GIT_")) delete process.env[k];

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
    isRecent: false,
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
    isRecent: false,
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
    isRecent: false,
    hasUnpushed: false,
  });
  assert.equal(v.nodeModules, "skip");
  assert.equal(v.worktree, "skip");
  assert.match(v.reason, /not merged/);
});

t("classifyWorktree (B800): merged + dirty is never touched, not even node_modules", () => {
  const v = classifyWorktree({
    name: "rf-old",
    branch: "fix/landed",
    isMainCheckout: false,
    isMerged: true,
    isDirty: true,
    isRecent: false,
    hasUnpushed: false,
  });
  assert.equal(v.nodeModules, "skip");
  assert.equal(v.worktree, "skip");
  assert.match(v.reason, /uncommitted/);
});

t("classifyWorktree (B800): merged + clean but recently active is never touched", () => {
  const v = classifyWorktree({
    name: "rf-busy",
    branch: "fix/landed",
    isMainCheckout: false,
    isMerged: true,
    isDirty: false,
    isRecent: true,
    hasUnpushed: false,
  });
  assert.equal(v.nodeModules, "skip");
  assert.equal(v.worktree, "skip");
  assert.match(v.reason, /never touched/);
});

t("isRecentlyActive (B800): inside the window is recent, outside is not, unknown is recent", () => {
  const now = Date.parse("2026-09-23T12:00:00Z");
  const h = 60 * 60 * 1000;
  assert.equal(isRecentlyActive(now - 23 * h, now, 24), true);
  assert.equal(isRecentlyActive(now - 25 * h, now, 24), false);
  assert.equal(isRecentlyActive(null, now, 24), true);
  assert.equal(isRecentlyActive(Number.NaN, now, 24), true);
});

t("isMergedEvidence (B800): ancestry alone is not proof; a mainline tip is a fresh branch", () => {
  assert.equal(
    isMergedEvidence({ tipIsAncestor: true, tipOnMainline: true, prMergedAtTip: false }),
    false,
  );
  assert.equal(
    isMergedEvidence({ tipIsAncestor: true, tipOnMainline: false, prMergedAtTip: false }),
    true,
  );
  assert.equal(
    isMergedEvidence({ tipIsAncestor: false, tipOnMainline: false, prMergedAtTip: false }),
    false,
  );
  assert.equal(
    isMergedEvidence({ tipIsAncestor: false, tipOnMainline: false, prMergedAtTip: true }),
    true,
  );
});

// B800 — real merge scenarios in a throwaway repo (master is the "origin/master" ref here).
{
  const dir = mkdtempSync(join(tmpdir(), "janitor-b800-"));
  const git = (...args) =>
    execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  const commit = (file, msg) => {
    writeFileSync(join(dir, file), msg);
    git("add", file);
    git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", msg);
  };
  const noGh = () => false;
  const merged = (branch, ghLookup = noGh) =>
    isMergedIntoMaster(dir, branch, { masterRef: "master", ghLookup });
  try {
    git("init", "-q", "-b", "master");
    commit("a.txt", "m1");
    git("branch", "fresh"); // a lane branch just created from master: ZERO commits of its own
    commit("b.txt", "m2"); // master moves on; `fresh` is now a plain ancestor of master

    t(
      "REG-B800: a fresh zero-commit branch is NOT merged even though it is an ancestor of master",
      () => {
        assert.equal(merged("fresh"), false);
      },
    );

    git("checkout", "-q", "-b", "work");
    commit("c.txt", "w1");
    t("a branch with its own unmerged commit is not merged", () => {
      assert.equal(merged("work"), false);
    });

    git("checkout", "-q", "master");
    git(
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.com",
      "merge",
      "-q",
      "--no-ff",
      "work",
      "-m",
      "merge work",
    );
    t("a branch whose own commit arrived through a merge IS merged", () => {
      assert.equal(merged("work"), true);
    });

    git("checkout", "-q", "-b", "ff");
    commit("d.txt", "f1");
    git("checkout", "-q", "master");
    git("merge", "-q", "--ff-only", "ff");
    t(
      "a fast-forwarded branch looks exactly like a fresh one: left alone (safe false negative)",
      () => {
        assert.equal(merged("ff"), false);
      },
    );

    git("checkout", "-q", "-b", "squashed");
    commit("e.txt", "s1");
    const tip = git("rev-parse", "squashed");
    git("checkout", "-q", "master");
    t(
      "a squash-merged branch counts only when GitHub reports its PR MERGED at exactly this tip",
      () => {
        assert.equal(merged("squashed"), false);
        assert.equal(
          merged("squashed", (_r, _b, t2) => t2 === tip),
          true,
        );
        assert.equal(
          merged("squashed", () => false),
          false,
        );
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

t("classifyWorktree: merged + unpushed commits clears node_modules but keeps the worktree", () => {
  const v = classifyWorktree({
    name: "rf-old2",
    branch: "fix/landed2",
    isMainCheckout: false,
    isMerged: true,
    isDirty: false,
    isRecent: false,
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
    isRecent: false,
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

t(
  "findStaleBranches (B800): a fresh branch whose tip is on master's mainline is never reported",
  () => {
    const remote = ["feature/a", "fix/fresh-lane"];
    const merged = new Set(["feature/a", "fix/fresh-lane"]); // `git branch --merged` counts both
    const stale = findStaleBranches(remote, merged, undefined, new Set(["fix/fresh-lane"]));
    assert.deepEqual(stale, ["feature/a"]);
  },
);

console.log(`janitor self-test: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error(`  FAIL ${f}`);
  process.exit(1);
}
