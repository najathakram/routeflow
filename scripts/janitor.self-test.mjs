#!/usr/bin/env node
// Self-test for janitor.mjs's classification logic. Pure fixtures, plus (B800)
// throwaway git repos under the OS temp dir for the merge check — never the
// RouteFlow repo, a real worktree, Docker, or the npm cache; nothing here
// deletes anything real.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  lutimesSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { scrubbedGitEnv } from "./lib/check-git-hooks.mjs";
import { join, resolve, sep } from "node:path";
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
  mergedPrCoversTip,
  cherryAllMatched,
  safeRemoveTree,
  resolveRepoContext,
  deleteRefusal,
  refuseDelete,
  isJestCacheDirName,
  staleJestCacheEntries,
  jestCacheDeleteRefusal,
  planJestCacheActions,
  JEST_CACHE_AGE_DAYS,
  removeWorktreeSafely,
  windowsRemoveTree,
  psLiteral,
  dirtyFromStatus,
  orphanEligible,
  branchTip,
  execute,
  buildPlan,
  CMD_UNSAFE,
  unlinkLinksWithin,
  cmdRmdirArgs,
  pathPresent,
  unlinkLinksWindows,
  WINDOWS_DEPS,
} from "./janitor.mjs";

// Run inside a git hook, GIT_DIR / GIT_INDEX_FILE / GIT_WORK_TREE would point every `git -C <tmp>`
// below at the REAL repo. Scrub them before any git call (the janitor inherits this env).
const cleanGit = scrubbedGitEnv();
for (const k of Object.keys(process.env)) if (!(k in cleanGit)) delete process.env[k];
// ...and ignore the machine's global/system git config, so commit signing, a global hooks path or
// a template-dir commit-msg hook can never make the throwaway-repo commits below fail.
const emptyGitConfig = join(mkdtempSync(join(tmpdir(), "janitor-gitcfg-")), "config");
writeFileSync(emptyGitConfig, "");
process.env.GIT_CONFIG_GLOBAL = emptyGitConfig;
process.env.GIT_CONFIG_NOSYSTEM = "1";
// Every fixture git spawn passes this explicitly: the shared scrub, then the empty-config pins.
const fixtureGitEnv = () => ({
  ...scrubbedGitEnv(),
  GIT_CONFIG_GLOBAL: emptyGitConfig,
  GIT_CONFIG_NOSYSTEM: "1",
});

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

t("deleteRefusal (B815): the containment rules", () => {
  // Platform paths (resolve + sep), so this holds on Windows too (#1326 review).
  const P = (...parts) => resolve(sep, ...parts);
  const m = P("r", "main");
  const allowed = [P("r", "main", ".claude", "worktrees"), P("r", "main", "local-assets")];
  const r = (targetReal, kind = "orphan-dir", worktreeReal = null) =>
    deleteRefusal({ targetReal, mainReal: m, allowedInMainReal: allowed, worktreeReal, kind });
  assert.match(r(m) ?? "", /main checkout/);
  assert.match(r(P("r", "main", "node_modules")) ?? "", /inside the main checkout/);
  assert.equal(r(P("r", "main", ".claude", "worktrees", "old")), null);
  assert.equal(r(P("r", "main", "local-assets", "proofs", "x"), "stale-proof-dir"), null);
  assert.equal(r(P("r", "lane", "node_modules"), "node_modules", P("r", "lane")), null);
  assert.match(
    r(P("r", "other", "node_modules"), "node_modules", P("r", "lane")) ?? "",
    /outside its own worktree/,
  );
  assert.match(
    r(P("r", "main", ".claude", "worktrees", "w", "node_modules"), "node_modules", m) ?? "",
    /main checkout/,
  );
  assert.equal(r(P("r", "mainly", "x")), null); // a sibling whose name merely starts with "main"
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
      env: fixtureGitEnv(),
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

// B748 — squash merges without `gh`. GitHub's "Squash and merge" rewrites the branch's work into
// ONE new commit on master, so the branch tip is never an ancestor and `tipOnMainline` is false:
// every ancestry signal says "not merged". B800 closed the opposite direction (a fresh branch is
// not merged); this closes the squash direction WITHOUT depending on the `gh` CLI, which is absent
// on CI runners and on this cloud container. Evidence is patch-id equality between the branch's
// own combined diff (merge-base..tip) and a commit on master's first-parent chain.
{
  const dir = mkdtempSync(join(tmpdir(), "janitor-b748-"));
  const git = (...args) =>
    execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: fixtureGitEnv(),
    }).trim();
  const commit = (file, body, msg) => {
    writeFileSync(join(dir, file), body);
    git("add", file);
    git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", msg);
  };
  const noGh = () => false; // `gh` unavailable — the whole point of this block
  const merged = (branch) =>
    isMergedIntoMaster(dir, branch, { masterRef: "master", ghLookup: noGh });
  try {
    git("init", "-q", "-b", "master");
    commit("a.txt", "m1", "base");

    // One-commit squash: master gains a NEW commit carrying the same diff.
    git("checkout", "-q", "-b", "sq-one");
    commit("one.txt", "one", "sq-one work");
    git("checkout", "-q", "master");
    git("merge", "-q", "--squash", "sq-one");
    git(
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.com",
      "commit",
      "-q",
      "-m",
      "squash sq-one",
    );

    t("REG-B748: a squash-merged branch IS merged without gh (one commit)", () => {
      assert.equal(merged("sq-one"), true);
    });

    // Multi-commit squash: the collapsed commit matches no INDIVIDUAL branch commit's patch-id,
    // only the branch's COMBINED diff — which is why `git cherry` alone would miss this.
    git("checkout", "-q", "-b", "sq-many");
    commit("m1.txt", "x", "sq-many 1");
    commit("m2.txt", "y", "sq-many 2");
    git("checkout", "-q", "master");
    git("merge", "-q", "--squash", "sq-many");
    git(
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.com",
      "commit",
      "-q",
      "-m",
      "squash sq-many",
    );

    t("REG-B748: a multi-commit squash IS merged (combined diff, not per-commit)", () => {
      assert.equal(merged("sq-many"), true);
    });

    // The safety direction. Deleting live work is the catastrophic error, so each of these must
    // stay false even though the new evidence path now runs for all of them.
    git("branch", "fresh-after"); // zero commits of its own, tip == master
    t("REG-B748 guard: a fresh zero-commit branch is still NOT merged", () => {
      assert.equal(merged("fresh-after"), false);
    });

    git("checkout", "-q", "-b", "live");
    commit("live.txt", "unmerged", "live work");
    t("REG-B748 guard: a branch with its own unmerged work is still NOT merged", () => {
      assert.equal(merged("live"), false);
    });

    // A branch whose diff merely RESEMBLES merged work must not be swept: same file, different
    // content means a different patch-id.
    git("checkout", "-q", "master");
    git("checkout", "-q", "-b", "look-alike");
    commit("one.txt", "DIFFERENT", "look-alike");
    t("REG-B748 guard: a similar-but-different diff is NOT merged", () => {
      assert.equal(merged("look-alike"), false);
    });

    // --- fix-round guards (Opus review of c8f68f3a) --------------------------------------
    // Each of these was RED against the first implementation. They exist because the original
    // five guards all passed against two DELIBERATELY broken versions of the scan, so they were
    // not actually protecting the dangerous direction.

    // REQUIRED-1, the data-loss case. `patch-id --stable` strips whitespace before hashing, so a
    // follow-up that only RE-INDENTS a line the branch's own merged work added produces a
    // combined diff that hashes identically to the squash commit. The branch is NOT merged — it
    // carries an unpushed commit — and sweeping it destroys that work.
    git("checkout", "-q", "master");
    git("checkout", "-q", "-b", "reindent");
    commit("ws.yml", "a: 1\nb:\n  x: 2\n", "reindent work");
    git("checkout", "-q", "master");
    git("merge", "-q", "--squash", "reindent");
    git(
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.com",
      "commit",
      "-q",
      "-m",
      "squash reindent",
    );
    git("checkout", "-q", "reindent");
    commit("ws.yml", "a: 1\nb:\n    x: 2\n", "re-indent only — NOT merged");
    t("REG-B748 guard: a whitespace-only follow-up is NOT merged (patch-id --verbatim)", () => {
      assert.equal(merged("reindent"), false);
    });

    // REQUIRED-2. The branch side used porcelain `git diff` (rename detection + user diff config)
    // while master's side used plumbing `diff-tree`. A squash-merged RENAME therefore never
    // matched, so its worktree was never reclaimed — the bug this whole feature exists to fix.
    git("checkout", "-q", "master");
    commit("ren-old.txt", Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n"), "ren base");
    git("checkout", "-q", "-b", "renamer");
    git("mv", "ren-old.txt", "ren-new.txt");
    commit(
      "ren-new.txt",
      Array.from({ length: 41 }, (_, i) => `line ${i}`).join("\n"),
      "rename+edit",
    );
    git("checkout", "-q", "master");
    git("merge", "-q", "--squash", "renamer");
    git(
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.com",
      "commit",
      "-q",
      "-m",
      "squash renamer",
    );
    t("REG-B748: a squash-merged RENAME IS merged (same plumbing on both sides)", () => {
      assert.equal(merged("renamer"), true);
    });

    // REQUIRED-3. The original fresh-branch guard branched from master's TIP, where the scan has
    // nothing to walk — so it passed even against a version that scanned ALL of master. Branch
    // from BEHIND the tip instead, with a merge commit on master since that base, which is the
    // shape that read as merged under the broken variant.
    git("checkout", "-q", "master");
    const behind = git("rev-parse", "HEAD");
    git("checkout", "-q", "-b", "side-for-merge", behind);
    commit("side.txt", "side", "side work");
    git("checkout", "-q", "master");
    git(
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.com",
      "merge",
      "-q",
      "--no-ff",
      "side-for-merge",
      "-m",
      "merge side",
    );
    git("checkout", "-q", "-b", "fresh-behind", behind);
    t("REG-B748 guard: a zero-commit branch BEHIND the tip is NOT merged", () => {
      assert.equal(merged("fresh-behind"), false);
    });

    // REQUIRED-3, the range guard. A branch whose own diff happens to equal a commit that landed
    // on master BEFORE the branch's merge base is NOT merged — that old commit is not this
    // branch's work. Scanning master's WHOLE history instead of `mergeBase..master` reads it as
    // merged and sweeps live work. The zero-commit guards cannot catch that variant: they return
    // at `mergeBase === tip` before the range is ever built, which is why this one has its own
    // branch WITH a commit.
    git("checkout", "-q", "master");
    commit("dup.txt", "recycled", "master adds dup.txt (ancient)");
    rmSync(join(dir, "dup.txt"), { force: true });
    git("add", "-A");
    git(
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.com",
      "commit",
      "-q",
      "-m",
      "master removes dup.txt",
    );
    commit("unrelated.txt", "later", "master moves on");
    git("checkout", "-q", "-b", "recycler");
    commit("dup.txt", "recycled", "lane re-adds the same file — its OWN unmerged work");
    t("REG-B748 guard: a diff matching a commit OLDER than the merge base is NOT merged", () => {
      assert.equal(merged("recycler"), false);
    });

    // REQUIRED-1, second half. Where `gh` IS available, an OPEN PR at the tip means the branch is
    // live whatever a patch-id says — a lane can re-land an identical diff while its own PR is
    // still in review. The veto applies to the patch-id proof only.
    t("REG-B748 guard: an OPEN PR at the tip vetoes the patch-id proof", () => {
      const openAtTip = (_r, branch) => branch === "sq-one";
      assert.equal(
        isMergedIntoMaster(dir, "sq-one", {
          masterRef: "master",
          ghLookup: noGh,
          ghOpenLookup: openAtTip,
        }),
        false,
      );
      // ...and with no open PR, the same branch is still proven merged.
      assert.equal(
        isMergedIntoMaster(dir, "sq-one", {
          masterRef: "master",
          ghLookup: noGh,
          ghOpenLookup: () => false,
        }),
        true,
      );
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// #1732 — every PR here lands as a squash, so on a machine where the local branch tip is not
// EXACTLY the PR's final head (pushed on from elsewhere, or merged with master after the last
// local commit) the old gh check said "not merged" and the janitor could never reclaim anything.
//   (a) a MERGED PR whose merge commit is on master covers the tip when the tip IS its head or an
//       ANCESTOR of it; a tip AHEAD of the head holds unmerged commits and is never covered;
//   (b) `git cherry` with no '+' line (every commit already on master) is a gh-free proof, gated
//       like the B748 patch-id proof (runs last, open-PR veto).
{
  const dir = mkdtempSync(join(tmpdir(), "janitor-1732-"));
  const git = (...args) =>
    execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: fixtureGitEnv(),
    }).trim();
  const commit = (file, body, msg) => {
    writeFileSync(join(dir, file), body);
    git("add", file);
    git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", msg);
    return git("rev-parse", "HEAD");
  };
  const noGh = () => false;
  const noOpen = () => false;
  try {
    git("init", "-q", "-b", "master");
    commit("base.txt", "base", "base");

    // A PR branch with two commits; the local branch "behind" stopped after the first one, and
    // "ahead" carries one more commit that was never pushed or merged.
    git("checkout", "-q", "-b", "pr");
    const c1 = commit("p1.txt", "p1", "pr 1");
    const head = commit("p2.txt", "p2", "pr 2");
    git("branch", "behind", c1);
    git("checkout", "-q", "-b", "ahead");
    commit("p3.txt", "p3", "ahead-only work");
    // An unrelated side branch whose commit is NOT on master.
    git("checkout", "-q", "-b", "elsewhere", "master");
    const offMaster = commit("x.txt", "x", "not on master");
    // Master squash-merges the PR at `head`.
    git("checkout", "-q", "master");
    git("merge", "-q", "--squash", "pr");
    git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "squash pr");
    const squash = git("rev-parse", "HEAD");
    const prs = [{ headRefOid: head, mergeCommit: { oid: squash } }];
    const tipOf = (b) => git("rev-parse", `refs/heads/${b}`);

    t("#1732 (a): a merged PR covers a local tip EQUAL to its head", () => {
      assert.equal(mergedPrCoversTip(dir, head, prs, "master"), true);
    });
    t("#1732 (a): ...and a local tip BEHIND its head (every local commit went into the PR)", () => {
      assert.equal(mergedPrCoversTip(dir, tipOf("behind"), prs, "master"), true);
    });
    t("#1732 (a) guard: a local tip AHEAD of the PR head is NOT covered", () => {
      assert.equal(mergedPrCoversTip(dir, tipOf("ahead"), prs, "master"), false);
    });
    t("#1732 (a) guard: a PR whose merge commit is NOT on master covers nothing", () => {
      const notMaster = [{ headRefOid: head, mergeCommit: { oid: offMaster } }];
      assert.equal(mergedPrCoversTip(dir, head, notMaster, "master"), false);
    });
    t("#1732 (a) guard: a PR head missing locally, or no merge commit, proves nothing", () => {
      const missing = [{ headRefOid: "f".repeat(40), mergeCommit: { oid: squash } }];
      assert.equal(mergedPrCoversTip(dir, tipOf("behind"), missing, "master"), false);
      assert.equal(mergedPrCoversTip(dir, head, [{ headRefOid: head }], "master"), false);
      assert.equal(mergedPrCoversTip(dir, head, null, "master"), false);
    });
    t(
      "#1732 (a): end to end, the gh lookup marks the behind branch merged and not the ahead one",
      () => {
        const ghLookup = (repo, _branch, tip, masterRef) =>
          mergedPrCoversTip(repo, tip, prs, masterRef);
        const opts = { masterRef: "master", ghLookup, ghOpenLookup: noOpen };
        assert.equal(isMergedIntoMaster(dir, "behind", opts), true);
        assert.equal(isMergedIntoMaster(dir, "ahead", opts), false);
      },
    );
    t("#1732: with gh unavailable, the squash-merged branch still falls back to patch-id", () => {
      assert.equal(
        isMergedIntoMaster(dir, "pr", {
          masterRef: "master",
          ghLookup: noGh,
          ghOpenLookup: noOpen,
        }),
        true,
      );
    });
    t("#1732 guard: with gh unavailable, the ahead branch (unmerged work) is NOT merged", () => {
      assert.equal(
        isMergedIntoMaster(dir, "ahead", {
          masterRef: "master",
          ghLookup: noGh,
          ghOpenLookup: noOpen,
        }),
        false,
      );
    });

    // (b) Commits that reached master ONE BY ONE (cherry-picked, with master moving in between),
    // so no single master commit equals the branch's combined diff: patch-id says no, cherry yes.
    git("checkout", "-q", "-b", "picked", "master");
    const k1 = commit("k1.txt", "k1", "picked 1");
    const k2 = commit("k2.txt", "k2", "picked 2");
    git("checkout", "-q", "master");
    git("-c", "user.name=t", "-c", "user.email=t@example.com", "cherry-pick", k1);
    commit("between.txt", "between", "master moves on");
    git("-c", "user.name=t", "-c", "user.email=t@example.com", "cherry-pick", k2);
    git("branch", "picked-plus", "picked");
    git("checkout", "-q", "picked-plus");
    commit("k3.txt", "k3", "never picked");
    git("checkout", "-q", "master");
    git("branch", "fresh", "master");

    const optsNoGh = { masterRef: "master", ghLookup: noGh, ghOpenLookup: noOpen };
    t("#1732 (b): every commit already on master (cherry all '-') IS merged without gh", () => {
      assert.equal(cherryAllMatched(dir, tipOf("picked"), { masterRef: "master" }), true);
      assert.equal(isMergedIntoMaster(dir, "picked", optsNoGh), true);
    });
    t("#1732 (b) guard: one commit not on master ('+') is NOT merged", () => {
      assert.equal(cherryAllMatched(dir, tipOf("picked-plus"), { masterRef: "master" }), false);
      assert.equal(isMergedIntoMaster(dir, "picked-plus", optsNoGh), false);
    });
    t("#1732 (b) guard: a branch with no commits of its own is NOT merged", () => {
      assert.equal(cherryAllMatched(dir, tipOf("fresh"), { masterRef: "master" }), false);
      assert.equal(isMergedIntoMaster(dir, "fresh", optsNoGh), false);
    });
    t("#1732 (b) guard: an OPEN PR at the tip vetoes the cherry proof too", () => {
      const openAtTip = (_r, branch) => branch === "picked";
      assert.equal(
        isMergedIntoMaster(dir, "picked", { ...optsNoGh, ghOpenLookup: openAtTip }),
        false,
      );
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// B815 — deletes on macOS/Linux: never follow a symlink out of the tree being removed.
if (process.platform !== "win32") {
  const root = mkdtempSync(join(tmpdir(), "janitor-b815-"));
  try {
    // "main checkout" node_modules with a sentinel, and a lane worktree whose node_modules is a
    // SYMLINK into it — exactly the MacBook overlay shape.
    const mainNm = join(root, "main", "node_modules");
    mkdirSync(join(mainNm, "pkg"), { recursive: true });
    writeFileSync(join(mainNm, "pkg", "SENTINEL"), "keep me");
    const lane = join(root, "lane");
    mkdirSync(join(lane, "apps", "api"), { recursive: true });
    symlinkSync(mainNm, join(lane, "apps", "api", "node_modules"));

    t(
      "REG-B815: removing a node_modules SYMLINK unlinks the link only; its target survives",
      () => {
        assert.doesNotThrow(() => safeRemoveTree(join(lane, "apps", "api", "node_modules")));
        assert.equal(existsSync(join(lane, "apps", "api", "node_modules")), false);
        assert.equal(existsSync(join(mainNm, "pkg", "SENTINEL")), true);
      },
    );

    // A real directory tree that CONTAINS symlinks to the outside and a self-loop.
    const nm = join(lane, "node_modules");
    mkdirSync(join(nm, "a", "b"), { recursive: true });
    writeFileSync(join(nm, "a", "b", "file.txt"), "x");
    symlinkSync(mainNm, join(nm, "a", "linked-main"));
    symlinkSync(join(nm, "a"), join(nm, "a", "b", "loop"));
    t(
      "REG-B815: removing a real tree unlinks nested symlinks (and loops) without recursing into them",
      () => {
        assert.doesNotThrow(() => safeRemoveTree(nm));
        assert.equal(existsSync(nm), false);
        assert.equal(existsSync(join(mainNm, "pkg", "SENTINEL")), true);
      },
    );

    // The gap posixRemoveTree cannot see alone: a symlink in a PARENT folder (lane2/apps -> main/apps).
    mkdirSync(join(root, "main", "apps", "api", "node_modules", "p"), { recursive: true });
    writeFileSync(join(root, "main", "apps", "api", "node_modules", "p", "SENTINEL2"), "keep");
    const lane2 = join(root, "lane2");
    mkdirSync(lane2);
    symlinkSync(join(root, "main", "apps"), join(lane2, "apps"));
    const ctx = {
      mainCheckoutPath: join(root, "main"),
      worktreesRoot: join(root, "main", ".claude", "worktrees"),
    };
    t(
      "REG-B815 guard: a target reached through a PARENT symlink into the main checkout is refused",
      () => {
        const why = refuseDelete(join(lane2, "apps", "api", "node_modules"), ctx, {
          kind: "node_modules",
          worktreePath: lane2,
        });
        assert.match(why ?? "", /inside the main checkout/);
        assert.equal(
          existsSync(join(root, "main", "apps", "api", "node_modules", "p", "SENTINEL2")),
          true,
        );
      },
    );
    t("guard: a lane's own real node_modules is allowed; the main checkout itself never is", () => {
      mkdirSync(join(lane2, "node_modules"));
      assert.equal(
        refuseDelete(join(lane2, "node_modules"), ctx, {
          kind: "node_modules",
          worktreePath: lane2,
        }),
        null,
      );
      assert.match(
        refuseDelete(join(root, "main"), ctx, { kind: "worktree" }) ?? "",
        /main checkout/,
      );
    });

    t("removing a path that does not exist is a no-op", () => {
      assert.doesNotThrow(() => safeRemoveTree(join(root, "never-existed")));
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// B816 — run from inside a worktree, the janitor must still act on the MAIN checkout.
{
  const root = mkdtempSync(join(tmpdir(), "janitor-b816-"));
  const main = join(root, "main");
  mkdirSync(main);
  const g = (cwd, ...args) =>
    execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: fixtureGitEnv(),
    }).trim();
  try {
    g(main, "init", "-q", "-b", "master");
    writeFileSync(join(main, "a.txt"), "a");
    g(main, "add", "a.txt");
    g(main, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "m1");
    const wt = join(root, "lane-wt");
    g(main, "worktree", "add", "-q", "-b", "lane", wt);
    const real = (p) => realpathSync(p);

    t(
      "REG-B816: from inside a worktree, the main checkout is the repo's main worktree, not the cwd",
      () => {
        const ctx = resolveRepoContext(wt);
        assert.equal(real(ctx.mainCheckoutPath), real(main));
        assert.equal(real(ctx.repoRoot), real(main));
        assert.equal(ctx.worktreesRoot, join(ctx.mainCheckoutPath, ".claude", "worktrees"));
      },
    );
    t("from the main checkout itself, nothing changes", () => {
      assert.equal(real(resolveRepoContext(main).mainCheckoutPath), real(main));
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// B817 — whole-worktree removal: every link inside is unlinked BEFORE git's recursive delete.
t(
  "REG-B817: links inside a worktree are unlinked before `git worktree remove --force` runs",
  () => {
    const calls = [];
    removeWorktreeSafely("/w/lane", {
      git: (...a) => calls.push(`git ${a.join(" ")}`),
      unlinkLinksWithin: (d) => calls.push(`unlinkLinks ${d}`),
      exists: () => false,
      removeTree: (d) => calls.push(`removeTree ${d}`),
    });
    const unlinkAt = calls.indexOf("unlinkLinks /w/lane");
    const removeAt = calls.findIndex((c) => c.startsWith("git worktree remove --force"));
    assert.ok(unlinkAt >= 0, `links were never unlinked: ${JSON.stringify(calls)}`);
    assert.ok(unlinkAt < removeAt, `git remove ran first: ${JSON.stringify(calls)}`);
  },
);

// B818 — the Windows junction sequence fails CLOSED.
{
  const fakeFs = () => {
    const present = new Set(["C:/w/nm", "C:/w/nm/j1"]);
    const log = [];
    return {
      log,
      deps: (find) => ({
        isLink: () => false,
        findJunctions: find,
        unlinkJunction: (j) => (log.push(`unlink ${j}`), present.delete(j)),
        exists: (p) => present.has(p),
        rmdirS: (d) => log.push(`rmdirS ${d}`),
      }),
      present,
    };
  };
  t(
    "REG-B818: a junction scan that FAILS (null) refuses the delete instead of reading 'no junctions'",
    () => {
      const f = fakeFs();
      assert.throws(() =>
        windowsRemoveTree(
          "C:/w/nm",
          f.deps(() => null),
        ),
      );
      assert.ok(!f.log.some((l) => l.startsWith("rmdirS")), JSON.stringify(f.log));
    },
  );
  t("REG-B818: a junction that survives its unlink refuses the recursive delete", () => {
    const f = fakeFs();
    const deps = f.deps(() => ["C:/w/nm/j1"]);
    deps.unlinkJunction = (j) => f.log.push(`unlink ${j}`); // does not actually go away
    assert.throws(() => windowsRemoveTree("C:/w/nm", deps));
    assert.ok(!f.log.some((l) => l.startsWith("rmdirS")), JSON.stringify(f.log));
  });
  t(
    "REG-B818: the tree is re-scanned after unlinking; a junction found then refuses the delete",
    () => {
      const f = fakeFs();
      let n = 0;
      assert.throws(() =>
        windowsRemoveTree(
          "C:/w/nm",
          f.deps(() => (n++ === 0 ? ["C:/w/nm/j1"] : ["C:/w/nm/j2"])),
        ),
      );
      assert.ok(!f.log.some((l) => l.startsWith("rmdirS")), JSON.stringify(f.log));
    },
  );
  t("B818: the normal case still unlinks every junction, then removes the tree", () => {
    const f = fakeFs();
    let n = 0;
    windowsRemoveTree(
      "C:/w/nm",
      f.deps(() => (n++ === 0 ? ["C:/w/nm/j1"] : [])),
    );
    assert.deepEqual(f.log, ["unlink C:/w/nm/j1", "rmdirS C:/w/nm"]);
  });
  t("REG-B818: a path with a quote stays ONE PowerShell literal", () => {
    assert.equal(psLiteral("C:\\Users\\o'brien\\wt"), "'C:\\Users\\o''brien\\wt'");
  });
}

// B819 — "dirty" fails closed and counts precious ignored files.
t("REG-B819: a FAILED git status is dirty, never clean", () => {
  assert.equal(dirtyFromStatus(null, ""), true);
});
t("REG-B819: an unreadable ignored list is dirty", () => {
  assert.equal(dirtyFromStatus("", null), true);
});
t(
  "REG-B819: an ignored .env or local-assets entry is precious (dirty); build output is not",
  () => {
    assert.equal(dirtyFromStatus("", "!! apps/api/.env\n"), true);
    assert.equal(dirtyFromStatus("", "!! local-assets/proofs/x.png\n"), true);
    assert.equal(
      dirtyFromStatus("", "!! node_modules/\n!! apps/web/.next/\n!! packages/pricing/dist/\n"),
      false,
    );
    assert.equal(dirtyFromStatus("", ""), false);
    assert.equal(dirtyFromStatus(" M a.ts\n", ""), true);
  },
);

// B820 — orphan dirs get the same "is someone still using this" guard.
t("REG-B820: an orphan dir with a .git entry is never deleted", () => {
  const now = Date.parse("2026-09-24T02:00:00Z");
  assert.equal(
    orphanEligible({ hasGitEntry: true, newestMtimeMs: now - 10 * 86400e3, nowMs: now }),
    false,
  );
});
t("REG-B820: an orphan dir touched in the last 24h (or unreadable) is never deleted", () => {
  const now = Date.parse("2026-09-24T02:00:00Z");
  assert.equal(
    orphanEligible({ hasGitEntry: false, newestMtimeMs: now - 3600e3, nowMs: now }),
    false,
  );
  assert.equal(orphanEligible({ hasGitEntry: false, newestMtimeMs: null, nowMs: now }), false);
  assert.equal(
    orphanEligible({ hasGitEntry: false, newestMtimeMs: now - 3 * 86400e3, nowMs: now }),
    true,
  );
});

// LOW — a branch tip is read as refs/heads/<name>, never a same-named tag.
{
  const dir = mkdtempSync(join(tmpdir(), "janitor-tip-"));
  const g = (...args) =>
    execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: fixtureGitEnv(),
    }).trim();
  try {
    g("init", "-q", "-b", "master");
    writeFileSync(join(dir, "a"), "1");
    g("add", "a");
    g("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "c1");
    const first = g("rev-parse", "HEAD");
    g("branch", "lane");
    writeFileSync(join(dir, "a"), "2");
    g("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-am", "c2");
    g("tag", "lane"); // a TAG with the branch's name, on a different commit
    t("REG-LOW: branchTip reads the branch, not a same-named tag", () => {
      assert.equal(branchTip(dir, "lane"), first);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The dispatcher itself: every action kind is wired, and every delete passes the guard first.
{
  const run = (a, refusal = null) => {
    const calls = [];
    const out = execute(a, {
      refuseDelete: (t, o) => (calls.push(`guard ${t} ${o.kind}`), refusal),
      removeTree: (t) => calls.push(`removeTree ${t}`),
      removeWorktree: (t) => calls.push(`removeWorktree ${t}`),
      run: (c, args) => calls.push(`run ${c} ${args.join(" ")}`),
      log: () => {},
    });
    return { out, calls };
  };
  // B748 hardening: node_modules/worktree deletes with a worktreePath re-verify CLEANLINESS at the
  // moment of deletion (TOCTOU: the plan is built once, execute() may run later or be reordered).
  // A dirty check that goes stale between plan and execute must never delete uncommitted work.
  t(
    "execute (B748): a node_modules delete re-checks isDirty NOW and refuses if the worktree went dirty",
    () => {
      const calls = [];
      const out = execute(
        { kind: "node_modules", target: "/w/lane/node_modules", worktreePath: "/w/lane" },
        {
          refuseDelete: () => null,
          isDirty: (p) => (calls.push(`isDirty ${p}`), true), // dirty NOW, even though the plan said clean
          removeTree: (t) => calls.push(`removeTree ${t}`),
          removeWorktree: (t) => calls.push(`removeWorktree ${t}`),
          run: () => {},
          log: (m) => calls.push(`log ${m}`),
        },
      );
      assert.equal(out, "refused");
      assert.deepEqual(calls, [
        "isDirty /w/lane",
        "log    REFUSED, skipped: /w/lane/node_modules (worktree went dirty since the plan was built)",
      ]);
    },
  );
  t(
    "execute (B748): a worktree removal also re-checks isDirty NOW before removeWorktreeSafely",
    () => {
      const calls = [];
      const out = execute(
        { kind: "worktree", target: "/w/lane", worktreePath: "/w/lane" },
        {
          refuseDelete: () => null,
          isDirty: () => true,
          removeTree: () => {},
          removeWorktree: (t) => calls.push(`removeWorktree ${t}`),
          run: () => {},
          log: (m) => calls.push(`log ${m}`),
        },
      );
      assert.equal(out, "refused");
      assert.deepEqual(calls, [
        "log    REFUSED, skipped: /w/lane (worktree went dirty since the plan was built)",
      ]);
    },
  );
  t("execute (B748): clean now -> proceeds as before, isDirty checked but not refused", () => {
    const calls = [];
    execute(
      { kind: "node_modules", target: "/w/lane/node_modules", worktreePath: "/w/lane" },
      {
        refuseDelete: () => null,
        isDirty: () => false,
        removeTree: (t) => calls.push(`removeTree ${t}`),
        removeWorktree: () => {},
        run: () => {},
        log: () => {},
      },
    );
    assert.deepEqual(calls, ["removeTree /w/lane/node_modules"]);
  });
  t("execute (B748): no worktreePath (orphan/stale-proof) -> isDirty is never called", () => {
    const calls = [];
    execute(
      { kind: "orphan-dir", target: "/w/orphan" },
      {
        refuseDelete: () => null,
        isDirty: () => calls.push("isDirty") && true,
        removeTree: (t) => calls.push(`removeTree ${t}`),
        removeWorktree: () => {},
        run: () => {},
        log: () => {},
      },
    );
    assert.deepEqual(calls, ["removeTree /w/orphan"]);
  });
  t("execute: node_modules / orphan / stale-proof deletes pass the guard, then removeTree", () => {
    for (const kind of ["node_modules", "orphan-dir", "stale-proof-dir"]) {
      const r = run({ kind, target: "/w/x" });
      assert.deepEqual(r.calls, [`guard /w/x ${kind}`, "removeTree /w/x"]);
      assert.equal(r.out, "done");
    }
  });
  t("execute (B817 wiring): a whole worktree passes the guard, then removeWorktreeSafely", () => {
    const r = run({ kind: "worktree", target: "/w/lane" });
    assert.deepEqual(r.calls, ["guard /w/lane worktree", "removeWorktree /w/lane"]);
  });
  t("execute: a guard refusal deletes nothing", () => {
    const r = run({ kind: "worktree", target: "/w/main" }, "target is the main checkout");
    assert.equal(r.out, "refused");
    assert.deepEqual(r.calls, ["guard /w/main worktree"]);
  });
  t("execute: docker/npm steps run their one command; an unknown kind throws", () => {
    assert.deepEqual(run({ kind: "docker-build-cache" }).calls, ["run docker builder prune -a -f"]);
    assert.deepEqual(run({ kind: "npm-cache" }).calls, ["run npm cache clean --force"]);
    assert.throws(() => run({ kind: "rm-rf-everything", target: "/" }));
  });
}

// B817 on POSIX: unlinkLinksWithin unlinks every link inside and follows none.
if (process.platform !== "win32") {
  const root = mkdtempSync(join(tmpdir(), "janitor-b817-"));
  try {
    const outside = join(root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "SENTINEL"), "keep");
    const wt = join(root, "wt");
    mkdirSync(join(wt, "apps", "api"), { recursive: true });
    writeFileSync(join(wt, "apps", "api", "keep.ts"), "x");
    symlinkSync(outside, join(wt, "apps", "api", "node_modules"));
    symlinkSync(join(outside, "SENTINEL"), join(wt, "link-to-file"));
    t(
      "B817 (POSIX): every symlink inside the worktree is unlinked; targets and real files survive",
      () => {
        unlinkLinksWithin(wt);
        assert.equal(existsSync(join(wt, "apps", "api", "node_modules")), false);
        assert.equal(existsSync(join(wt, "link-to-file")), false);
        assert.equal(existsSync(join(wt, "apps", "api", "keep.ts")), true);
        assert.equal(existsSync(join(outside, "SENTINEL")), true);
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

t("B818: PowerShell's typographic single quotes are doubled too", () => {
  assert.equal(psLiteral("C:\\a\u2019b"), "'C:\\a\u2019\u2019b'");
  assert.equal(
    psLiteral("C:\\a\u2018b\u201Ac\u201Bd"),
    "'C:\\a\u2018\u2018b\u201A\u201Ac\u201B\u201Bd'",
  );
});

t(
  "B819: regenerable tool output does not make a worktree dirty (else the janitor never acts)",
  () => {
    assert.equal(
      dirtyFromStatus(
        "",
        // Real `git status --porcelain --ignored=matching` lines: husky's folder is listed file by file.
        "!! .campaign/\n!! apps/web/next-env.d.ts\n!! .husky/_/.gitignore\n!! .husky/_/pre-commit\n!! .husky/_/husky.sh\n!! .claude/settings.local.json\n",
      ),
      false,
    );
    assert.equal(dirtyFromStatus("", "!! local-assets/repair-f03-x.jsonl\n"), true);
  },
);

// Smoke: the real CLI runs its report-only path end to end inside a throwaway repo (never --apply).
{
  const dir = mkdtempSync(join(tmpdir(), "janitor-smoke-"));
  const g = (...args) =>
    execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: fixtureGitEnv(),
    }).trim();
  try {
    g("init", "-q", "-b", "master");
    writeFileSync(join(dir, "a"), "1");
    g("add", "a");
    g("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "c1");
    t("the CLI's report-only run completes (no missing function on the plan path)", () => {
      const cli = join(fileURLToPath(new URL(".", import.meta.url)), "janitor.mjs");
      const out = execFileSync(process.execPath, [cli], {
        cwd: dir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      assert.match(out, /Report-only run/);
      assert.match(out, /main checkout/);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// #1326 review (Windows) — (1) HIGH: cmd splits an unquoted path on & | < > ^ ... so a delete
// of `wt\a&b` deleted the SIBLING `wt\a`. Any such path is refused before cmd ever sees it.
{
  const fake = (junctions = []) => {
    const log = [];
    return {
      log,
      deps: {
        isLink: () => false,
        findJunctions: () => junctions,
        unlinkJunction: (j) => log.push(`unlink ${j}`),
        exists: () => true,
        rmdirS: (d) => log.push(`rmdirS ${d}`),
      },
    };
  };
  for (const bad of [
    "C:\\wt\\a&b",
    "C:\\wt\\a|b",
    "C:\\wt\\a^b",
    "C:\\wt\\a%PATH%",
    "C:\\wt\\a(b)",
    'C:\\wt\\a"b',
    "C:\\wt\\a!b",
    "C:\\wt\\a,b",
    "C:\\wt\\a;b",
    "C:\\wt\\a=b",
  ]) {
    t(`REG-1326-1: a Windows delete of ${JSON.stringify(bad)} is refused before cmd runs`, () => {
      const f = fake();
      f.deps.exists = () => false; // an unlink "succeeded" — still must never reach cmd
      assert.throws(() => windowsRemoveTree(bad, f.deps), /refus/i);
      assert.deepEqual(f.log, []);
    });
  }
  t("REG-1326-1: a JUNCTION path with a cmd metacharacter is refused before ANY unlink", () => {
    const f = fake(["C:\\wt\\nm\\ok", "C:\\wt\\nm\\a&b"]);
    f.deps.exists = () => false; // unlinks would "succeed" — only the guard can stop this
    assert.throws(() => windowsRemoveTree("C:\\wt\\nm", f.deps), /metacharacter/);
    assert.deepEqual(f.log, []); // not even the safe junction was unlinked first
  });

  // (2) MED: when the TARGET itself is a junction (a lane's node_modules -> main's), scanning it
  // walks into MAIN; it must be unlinked with a bare rmdir and never scanned or rmdir /s'd.
  t("REG-1326-2: a delete target that IS a junction is unlinked alone, never scanned", () => {
    const log = [];
    let gone = false;
    windowsRemoveTree("C:\\wt\\lane\\node_modules", {
      isLink: () => true,
      findJunctions: (d) => (log.push(`scan ${d}`), []),
      unlinkJunction: (j) => (log.push(`unlink ${j}`), (gone = true)),
      exists: () => !gone,
      rmdirS: (d) => log.push(`rmdirS ${d}`),
    });
    assert.deepEqual(log, ["unlink C:\\wt\\lane\\node_modules"]);
  });
}

// #1326 Windows re-review (REQUIRED): `git worktree list --porcelain` prints forward-slash paths
// (`C:/…`) and cmd reads a `/segment` as a SWITCH, so `rmdir /s /q C:/wt/s/q` could become
// `rd /s /q C:`. Every cmd path argument goes through cmdRmdirArgs: absolute, backslashed, never
// a drive root, metacharacters refused.
t(
  "REG-1326-3: a forward-slash worktree path reaches cmd backslashed (no /segment switches)",
  () => {
    assert.deepEqual(cmdRmdirArgs("C:/ClaudeCode/wt/s/q"), [
      "/c",
      "rmdir",
      "C:\\ClaudeCode\\wt\\s\\q",
    ]);
    const rec = cmdRmdirArgs("C:/ClaudeCode/wt/s/q", { recursive: true });
    assert.deepEqual(rec, ["/c", "rmdir", "/s", "/q", "C:\\ClaudeCode\\wt\\s\\q"]);
    assert.equal(rec.at(-1).includes("/"), false);
  },
);
t("REG-1326-3: a UNC path with a server and a share, and trailing slashes, are accepted", () => {
  assert.equal(cmdRmdirArgs("//server/share/wt/lane").at(-1), "\\\\server\\share\\wt\\lane");
  assert.equal(cmdRmdirArgs("C:/wt//lane/").at(-1), "C:\\wt\\lane");
});
for (const bad of [
  "C:/",
  "C:\\",
  "C:",
  "wt/s/q",
  "\\s\\q",
  "C:/wt/a&b",
  // Opus re-review: roots reached through `..`, bare servers, share roots, device prefixes.
  "C:/a/..",
  "C:/a/../..",
  "//server",
  "\\\\server",
  "//server/",
  "//server/share",
  "\\\\server\\share\\..",
  "\\\\?\\UNC\\server\\share",
  "\\\\?\\C:\\x\\..\\..",
  "\\\\.\\C:\\x",
  // Win32 strips a trailing dot or space, so cmd would act on a different folder than approved.
  "C:/wt/lane/...",
  "C:/wt/lane/node_modules.",
  "C:/wt/lane/node_modules ",
  "C:/wt/./lane",
  "C:/x/link/../lane",
  // Node does not quote a newline and cmd stops reading at one: `rmdir C:\wt\a` would run.
  "C:/wt/a\nb",
]) {
  t(`REG-1326-3: cmdRmdirArgs refuses ${JSON.stringify(bad)} (root, relative or unsafe)`, () => {
    assert.throws(() => cmdRmdirArgs(bad), /refus/i);
    assert.throws(() => cmdRmdirArgs(bad, { recursive: true }), /refus/i);
  });
}
t(
  "REG-1326-3: every process janitor.mjs spawns is a known literal; cmd only via cmdRmdirArgs",
  () => {
    const src = readFileSync(fileURLToPath(new URL("./janitor.mjs", import.meta.url)), "utf8");
    assert.doesNotMatch(src, /shell\s*:\s*true/);
    // No aliased or extra child_process import can dodge the call scan below.
    const cpImports = src.match(/^import[^;]*["']node:child_process["'];?$/gm) ?? [];
    assert.deepEqual(cpImports, ['import { execFileSync } from "node:child_process";']);
    const callRe =
      /(function\s+)?\b(execFileSync|execFile|execSync|spawnSync|spawn|exec|trySh|sh|run)\(\s*([^,)]+),?\s*(\S*)/g;
    const calls = [...src.matchAll(callRe)].filter((m) => !m[1]); // not the sh/trySh definitions
    const exes = new Set(["git", "gh", "powershell", "df", "cmd", "docker", "npm"]);
    let passThroughs = 0;
    let cmdCalls = 0;
    for (const [text, , fn, first, next] of calls) {
      assert.ok(!["execFile", "execSync", "spawnSync", "spawn", "exec"].includes(fn), text);
      const lit = /^"([^"]+)"$/.exec(first.trim());
      if (!lit) {
        assert.equal(first.trim(), "cmd", `a non-literal executable: ${text}`);
        passThroughs++;
        continue;
      }
      assert.ok(exes.has(lit[1]), `unexpected executable ${lit[1]}`);
      if (/^cmd(\.exe)?$/i.test(lit[1])) {
        cmdCalls++;
        assert.match(next, /^cmdRmdirArgs\(/, text);
      }
    }
    assert.equal(passThroughs, 3, "only sh, trySh and EXECUTE_DEPS.run pass an executable through");
    assert.equal(cmdCalls, 2, "exactly the two WINDOWS_DEPS cmd calls");
  },
);
t("REG-1326-3: a late bad junction is refused before ANY junction is unlinked", () => {
  const log = [];
  assert.throws(
    () =>
      windowsRemoveTree("C:\\wt\\nm", {
        isLink: () => false,
        findJunctions: () => ["C:\\wt\\nm\\ok", "C:\\wt\\nm\\trail."],
        unlinkJunction: (j) => log.push(`unlink ${j}`),
        exists: () => false,
        rmdirS: (d) => log.push(`rmdirS ${d}`),
      }),
    /refus/,
  );
  assert.deepEqual(log, []);
});
t("REG-1326-3: the real Windows deps route through cmdRmdirArgs and lstat", () => {
  assert.equal(WINDOWS_DEPS.exists, pathPresent);
  assert.equal(typeof WINDOWS_DEPS.isLink, "function");
});
// Nit: the "did the link go?" check must lstat. existsSync FOLLOWS a link, so a link that survived
// its unlink but points at a missing target reads as gone.
{
  const dir = mkdtempSync(join(tmpdir(), "janitor-dangling-"));
  try {
    const target = join(dir, "gone");
    mkdirSync(target);
    const link = join(dir, "link");
    symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
    rmSync(target, { recursive: true, force: true });
    t("REG-1326-4: pathPresent sees a dangling link that existsSync reports as gone", () => {
      assert.equal(existsSync(link), false); // the trap: existsSync follows the link
      assert.equal(pathPresent(link), true);
      assert.equal(pathPresent(join(dir, "never-existed")), false);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
t("REG-1326-4: unlinkLinksWindows refuses when a link survives its unlink", () => {
  const log = [];
  assert.throws(
    () =>
      unlinkLinksWindows("C:\\wt\\lane", {
        isLink: () => true,
        findJunctions: (d) => (log.push(`scan ${d}`), []),
        unlinkJunction: (j) => log.push(`unlink ${j}`),
        exists: () => true, // lstat still sees the link
      }),
    /survived/,
  );
  assert.deepEqual(log, ["unlink C:\\wt\\lane"]); // never scanned through the link
});
for (const [name, fn] of [
  ["windowsRemoveTree", windowsRemoveTree],
  ["unlinkLinksWindows", unlinkLinksWindows],
]) {
  t(`REG-1326-5: ${name} REQUIRES deps.isLink (never fails open)`, () => {
    const log = [];
    assert.throws(
      () =>
        fn("C:\\wt\\lane", {
          findJunctions: (d) => (log.push(`scan ${d}`), []),
          unlinkJunction: (j) => log.push(`unlink ${j}`),
          exists: () => false,
          rmdirS: (d) => log.push(`rmdirS ${d}`),
        }),
      /needs deps\.isLink/,
    );
    assert.deepEqual(log, []);
  });
}

// LOWs from the same review.
t("REG-1326-L1: on Windows the guard compares paths case-insensitively and without \\\\?\\", () => {
  const why = deleteRefusal({
    targetReal: "\\\\?\\C:\\R\\Main",
    mainReal: "c:\\r\\main",
    allowedInMainReal: [],
    kind: "orphan-dir",
    caseInsensitive: true,
  });
  assert.match(why ?? "", /main checkout/);
});
t("REG-1326-L2: a LOCKED worktree is never touched", () => {
  const v = classifyWorktree({
    name: "rf-locked",
    branch: "fix/shipped",
    isMainCheckout: false,
    isMerged: true,
    isDirty: false,
    isRecent: false,
    hasUnpushed: false,
    isLocked: true,
  });
  assert.equal(v.nodeModules, "skip");
  assert.equal(v.worktree, "skip");
  assert.match(v.reason, /locked/);
});
t("REG-1326-L3: outside a git repo the context THROWS (never guesses a main checkout)", () => {
  const dir = mkdtempSync(join(tmpdir(), "janitor-norepo-"));
  try {
    assert.throws(() => resolveRepoContext(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
t("REG-1326-L4: build/dist/coverage are disposable only at the top level or a package root", () => {
  assert.equal(
    dirtyFromStatus("", "!! apps/api/dist/\n!! packages/pricing/dist/\n!! coverage/\n"),
    false,
  );
  assert.equal(dirtyFromStatus("", "!! apps/api/src/build/\n"), true); // a source folder named build
  assert.equal(dirtyFromStatus("", "!! apps/web/app/coverage/\n"), true);
});

// A REAL Windows junction (runs only on win32; the PC lane runs this before any merge).
// A %TEMP% holding a cmd metacharacter (e.g. a username with "&" or "(") would make these fail on
// the refusal rather than on a real bug, so they use a cmd-safe base or skip loudly.
const winBase = CMD_UNSAFE.test(tmpdir()) ? join(process.env.SystemDrive || "C:", "\\") : tmpdir();
if (process.platform === "win32" && CMD_UNSAFE.test(winBase)) {
  console.log(`SKIP: no cmd-safe temp base for the Windows junction tests (${winBase})`);
} else if (process.platform === "win32") {
  const root = mkdtempSync(join(winBase, "janitor-junction-"));
  try {
    const target = join(root, "main-nm");
    mkdirSync(join(target, "pkg"), { recursive: true });
    writeFileSync(join(target, "pkg", "SENTINEL"), "keep");
    const lane = join(root, "lane");
    mkdirSync(lane);
    symlinkSync(target, join(lane, "node_modules"), "junction");
    t("WIN: deleting a junction target removes only the junction; its target survives", () => {
      safeRemoveTree(join(lane, "node_modules"));
      assert.equal(existsSync(join(lane, "node_modules")), false);
      assert.equal(existsSync(join(target, "pkg", "SENTINEL")), true);
    });
    const tree = join(root, "tree");
    mkdirSync(join(tree, "a"), { recursive: true });
    writeFileSync(join(tree, "a", "f.txt"), "x");
    symlinkSync(target, join(tree, "a", "linked"), "junction");
    t("WIN: deleting a tree that CONTAINS a junction removes the tree; the target survives", () => {
      safeRemoveTree(tree);
      assert.equal(existsSync(tree), false);
      assert.equal(existsSync(join(target, "pkg", "SENTINEL")), true);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// #1346 — the delete-time dirty re-check (execute()) keys on the action's worktreePath. The
// node_modules action carried it, the WORKTREE-REMOVAL action did not, so the destructive path was
// never re-checked; the unit cases above hand-build a worktree action with the field and could not
// see that. This pin goes through the REAL buildPlan on a real repo: a merged, clean, idle, pushed
// linked worktree must come out as a `worktree` action carrying worktreePath, and execute() on
// THAT action must refuse once the tree is dirty.
{
  const root = realpathSync(mkdtempSync(join(tmpdir(), "janitor-1346-")));
  const main = join(root, "main");
  const origin = join(root, "origin.git");
  const lane = join(root, "wt", "lane");
  const git = (cwd, ...args) =>
    execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: fixtureGitEnv(),
    }).trim();
  const id = ["-c", "user.name=t", "-c", "user.email=t@example.com"];
  try {
    execFileSync("git", ["init", "-q", "--bare", origin], { env: fixtureGitEnv() });
    execFileSync("git", ["init", "-q", "-b", "master", main], { env: fixtureGitEnv() });
    writeFileSync(join(main, "a.txt"), "a");
    git(main, "add", "a.txt");
    git(main, ...id, "commit", "-q", "-m", "base");
    git(main, "remote", "add", "origin", origin);
    // The lane's work reaches master through a real --no-ff merge (merged without gh), and is
    // pushed with an upstream (not "unpushed").
    git(main, "worktree", "add", "-q", "-b", "feat/lane", lane);
    writeFileSync(join(lane, "l.txt"), "lane work");
    git(lane, "add", "l.txt");
    git(lane, ...id, "commit", "-q", "-m", "lane work");
    git(main, ...id, "merge", "-q", "--no-ff", "-m", "merge lane", "feat/lane");
    git(main, "push", "-q", "origin", "master", "feat/lane");
    git(main, "fetch", "-q", "origin");
    git(lane, "branch", "-q", "--set-upstream-to=origin/feat/lane");
    // Idle: backdate the lane's HEAD reflog past RECENT_ACTIVITY_HOURS.
    const laneGitDir = git(lane, "rev-parse", "--absolute-git-dir");
    const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    utimesSync(join(laneGitDir, "logs", "HEAD"), old, old);

    const { actions } = buildPlan(main, main, join(root, "wt"));
    const removal = actions.find((a) => a.kind === "worktree");

    t("#1346: buildPlan's worktree-REMOVAL action carries worktreePath", () => {
      assert.ok(
        removal,
        `no worktree action planned: ${JSON.stringify(actions.map((a) => a.kind))}`,
      );
      assert.equal(realpathSync(removal.worktreePath), realpathSync(lane));
    });

    t(
      "#1346: execute() on that planned action refuses when the tree went dirty since the plan",
      () => {
        const calls = [];
        const deps = {
          refuseDelete: () => null,
          isDirty: (p) => (calls.push(`isDirty ${p}`), true),
          removeTree: () => calls.push("removeTree"),
          removeWorktree: (t) => calls.push(`removeWorktree ${t}`),
          run: () => {},
          log: () => {},
        };
        assert.equal(execute(removal, deps), "refused");
        assert.ok(!calls.some((c) => c.startsWith("removeWorktree")), JSON.stringify(calls));
        assert.ok(
          calls.some((c) => c.startsWith("isDirty")),
          "the re-check must have run",
        );
      },
    );

    t("#1346: ...and still removes it when the tree is clean at delete time", () => {
      const calls = [];
      execute(removal, {
        refuseDelete: () => null,
        isDirty: () => false,
        removeTree: () => {},
        removeWorktree: (t) => calls.push(`removeWorktree ${t}`),
        run: () => {},
        log: () => {},
      });
      assert.deepEqual(calls, [`removeWorktree ${removal.target}`]);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// #2671: Jest caches (the legacy shared OS-temp cache and each worktree's .jest-cache).
{
  t("#2671 isJestCacheDirName: Jest's default names only", () => {
    for (const ok of ["jest_dx", "jest_0", "JEST_AB12", "jest"])
      assert.equal(isJestCacheDirName(ok), true, ok);
    for (const no of ["jest_", "jest-dx", "jestdx", "my_jest_dx", "jest_dx/", ".jest-cache", "npm"])
      assert.equal(isJestCacheDirName(no), false, no);
  });
  t("#2671 staleJestCacheEntries: only entries untouched longer than the age limit", () => {
    const now = 10 * 86_400_000;
    const day = 86_400_000;
    const entries = [
      { path: "/t/jest_dx/haste-old", mtimeMs: now - (JEST_CACHE_AGE_DAYS + 1) * day },
      { path: "/t/jest_dx/haste-new", mtimeMs: now - day },
      { path: "/t/jest_dx/edge", mtimeMs: now - JEST_CACHE_AGE_DAYS * day },
    ];
    assert.deepEqual(staleJestCacheEntries(entries, now), ["/t/jest_dx/haste-old"]);
  });
  t("#2671 jestCacheDeleteRefusal: a DIRECT child of a planned Jest cache root only", () => {
    const roots = ["/t/jest_dx", "/w/lane/apps/api/.jest-cache"];
    assert.equal(jestCacheDeleteRefusal("/t/jest_dx/haste-map-1", roots), null);
    assert.equal(
      jestCacheDeleteRefusal("/w/lane/apps/api/.jest-cache/jest-transform-cache-x", roots),
      null,
    );
    assert.match(jestCacheDeleteRefusal("/t/jest_dx/a/b", roots), /direct child/);
    assert.match(jestCacheDeleteRefusal("/t/jest_dx", roots), /direct child/);
    assert.match(jestCacheDeleteRefusal("/etc/passwd", roots), /direct child/);
    assert.match(jestCacheDeleteRefusal("/t/npm/x", ["/t/npm"]), /not named like a Jest cache/);
    assert.equal(
      jestCacheDeleteRefusal("/T/JEST_DX/x", ["/t/jest_dx"], { caseInsensitive: true }),
      null,
    );
  });
  t(
    "#2671 execute: a jest-cache action passes ITS guard, then removes; a refusal removes nothing",
    () => {
      const calls = [];
      const deps = (refusal) => ({
        refuseDelete: () => (calls.push("WRONG GUARD"), null),
        refuseJestCacheDelete: (tg, root) => (calls.push(`jguard ${tg} ${root}`), refusal),
        isDirty: () => false,
        removeTree: (tg) => calls.push(`removeTree ${tg}`),
        removeWorktree: () => {},
        run: () => {},
        log: (m) => calls.push(`log ${m}`),
      });
      const a = { kind: "jest-cache", target: "/t/jest_dx/haste-1", root: "/t/jest_dx" };
      assert.equal(execute(a, deps(null)), "done");
      assert.deepEqual(calls.splice(0), [
        "jguard /t/jest_dx/haste-1 /t/jest_dx",
        "removeTree /t/jest_dx/haste-1",
      ]);
      assert.equal(execute(a, deps("nope")), "refused");
      assert.deepEqual(calls.splice(0), [
        "jguard /t/jest_dx/haste-1 /t/jest_dx",
        "log    REFUSED, skipped: /t/jest_dx/haste-1 (nope)",
      ]);
    },
  );
}

// A directory link: a "dir" symlink needs a privilege a normal Windows user lacks (EPERM); a junction
// does not (the same pattern as the win32 junction case above).
const DIR_LINK_TYPE = process.platform === "win32" ? "junction" : "dir";

// #2671 (the lead's condition on #2672): a symlink inside a Jest cache root (a `.jest-cache` and a
// `jest_*` one) is never followed for age and never swept, and its target survives an apply. The
// whole thing runs in a tmp SANDBOX (mkdtemp); no real cache or worktree is ever touched.
{
  const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "janitor-2671-")));
  try {
    const DAY = 86_400_000;
    const old = new Date(Date.now() - (JEST_CACHE_AGE_DAYS + 5) * DAY);
    const outside = join(sandbox, "outside-target");
    mkdirSync(outside);
    writeFileSync(join(outside, "keep.txt"), "must survive");
    const roots = [
      join(sandbox, "wt", "apps", "api", ".jest-cache"),
      join(sandbox, "tmp", "jest_dx"),
    ];
    for (const root of roots) {
      mkdirSync(root, { recursive: true });
      // (a) a stale symlink ENTRY pointing outside the cache
      const link = join(root, "linked-entry");
      symlinkSync(outside, link, DIR_LINK_TYPE);
      lutimesSync(link, old, old);
      // (b) a stale REAL entry that contains a symlink pointing outside
      const real = join(root, "haste-map-old");
      mkdirSync(real);
      writeFileSync(join(real, "data"), "x");
      symlinkSync(outside, join(real, "inner-link"), DIR_LINK_TYPE);
      lutimesSync(join(real, "inner-link"), old, old);
      utimesSync(join(real, "data"), old, old);
      utimesSync(real, old, old);
      // (c) a FRESH real entry that must stay
      mkdirSync(join(root, "haste-map-new"));
    }
    // The target is stale too, so EITHER bug (following the link for its age, or not skipping the
    // link at all) would plan it and the assertions below would catch it.
    utimesSync(join(outside, "keep.txt"), old, old);
    utimesSync(outside, old, old);

    const actions = planJestCacheActions(roots, Date.now());
    t(
      "#2671 sandbox: a symlink entry is never planned (neither followed for age nor swept)",
      () => {
        for (const root of roots) {
          const targets = actions.filter((a) => a.root === root).map((a) => a.target);
          assert.deepEqual(targets, [join(root, "haste-map-old")], root);
        }
      },
    );

    t(
      "#2671 sandbox: --apply removes only the stale real entries; every link target survives",
      () => {
        const deps = {
          refuseDelete: () => "WRONG GUARD",
          refuseJestCacheDelete: (tg, root) =>
            jestCacheDeleteRefusal(realpathSync(tg), [realpathSync(root)]),
          isDirty: () => false,
          removeTree: (tg) => safeRemoveTree(tg),
          removeWorktree: () => {},
          run: () => {},
          log: () => {},
        };
        for (const a of actions) assert.equal(execute(a, deps), "done", a.target);
        for (const root of roots) {
          assert.equal(existsSync(join(root, "haste-map-old")), false, "stale real entry swept");
          assert.equal(
            lstatSync(join(root, "linked-entry")).isSymbolicLink(),
            true,
            "link entry kept",
          );
          assert.equal(existsSync(join(root, "haste-map-new")), true, "fresh entry kept");
        }
        assert.equal(readFileSync(join(outside, "keep.txt"), "utf8"), "must survive");
      },
    );
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

console.log(`janitor self-test: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error(`  FAIL ${f}`);
  process.exit(1);
}
