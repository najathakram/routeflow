#!/usr/bin/env node
// Self-test for janitor.mjs's classification logic. Pure fixtures, plus (B800)
// throwaway git repos under the OS temp dir for the merge check — never the
// RouteFlow repo, a real worktree, Docker, or the npm cache; nothing here
// deletes anything real.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  renameSync,
  lstatSync,
  lutimesSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { scrubbedGitEnv } from "./lib/check-git-hooks.mjs";
import { basename, dirname, join, resolve, sep } from "node:path";
import {
  isProtectedWorktreeName,
  isProtectedBranch,
  classifyWorktree,
  linkedIntoBy,
  scanLinkTargets,
  samePathOrInside,
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
  parseAllowList,
  classifyIgnoredForAllowList,
  samePath,
  salvageIgnored,
  allowListVerdict,
  CMD_UNSAFE,
  unlinkLinksWithin,
  cmdRmdirArgs,
  pathPresent,
  unlinkLinksWindows,
  WINDOWS_DEPS,
  applyActions,
  scopePlan,
  removeWorktreePlain,
  resolveListedPaths,
  findJunctions,
  RECENT_ACTIVITY_HOURS,
  modulesOnlyRefusal,
  mentionsTree,
  findModulesDirs,
  planModulesOnlyTree,
  removeModulesOnlyTree,
  runModulesOnly,
  PROBE_SUFFIX,
  probeNameFor,
  probeTreeInUse,
  ProbeStuckError,
  leftoverProbes,
  processUseRefusal,
  EXECUTE_DEPS,
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
    const exes = new Set(["git", "gh", "powershell", "df", "lsof", "cmd", "docker", "npm"]);
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

// Bug: a stray FILE under .claude/worktrees/ (a .log, a .patch, a jest summary json) is not a
// worktree candidate at all — findOrphanWorktreeDirs only diffs names against `git worktree
// list`, so buildPlan's orphan step used to push it as kind "orphan-dir" like a real directory,
// and the apply-mode executor then ran a directory `rmdir` on a plain file and threw. A stray
// file must come out of buildPlan as its own "stray-file" kind, never "orphan-dir".
{
  const root = mkdtempSync(join(tmpdir(), "janitor-strayfile-"));
  const main = join(root, "main");
  const worktreesRoot = join(root, "worktrees");
  try {
    execFileSync("git", ["init", "-q", "-b", "master", main], { env: fixtureGitEnv() });
    writeFileSync(join(main, "a.txt"), "a");
    execFileSync("git", ["-C", main, "add", "a.txt"], { env: fixtureGitEnv() });
    execFileSync(
      "git",
      [
        "-C",
        main,
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.com",
        "commit",
        "-q",
        "-m",
        "base",
      ],
      { env: fixtureGitEnv() },
    );

    mkdirSync(worktreesRoot, { recursive: true });
    const strayFile = join(worktreesRoot, "bugs-selftest.log");
    writeFileSync(strayFile, "log output");
    const orphanDir = join(worktreesRoot, "old-orphan");
    mkdirSync(orphanDir);
    writeFileSync(join(orphanDir, "note.txt"), "stuff");

    // Both old enough to clear the orphanEligible recent-activity check.
    const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    utimesSync(strayFile, old, old);
    utimesSync(orphanDir, old, old);
    utimesSync(join(orphanDir, "note.txt"), old, old);

    t("buildPlan: a stray file under worktrees/ is kind stray-file, never orphan-dir", () => {
      const { actions } = buildPlan(main, main, worktreesRoot);
      const forFile = actions.find((a) => a.target === strayFile);
      const forDir = actions.find((a) => a.target === orphanDir);
      assert.ok(forFile, `expected an action for the stray file: ${JSON.stringify(actions)}`);
      assert.equal(forFile.kind, "stray-file");
      assert.ok(forDir, `expected an action for the orphan dir: ${JSON.stringify(actions)}`);
      assert.equal(forDir.kind, "orphan-dir");
    });

    t("buildPlan: a RECENT stray file is skipped, not planned for deletion", () => {
      const recent = join(worktreesRoot, "fresh.log");
      writeFileSync(recent, "being written");
      const { actions, skipped } = buildPlan(main, main, worktreesRoot);
      assert.ok(
        !actions.some((x) => x.target === recent),
        "recent stray file must not be an action",
      );
      assert.ok(
        skipped.some((x) => x.worktree === "fresh.log"),
        "recent stray file is reported",
      );
    });

    t("execute: a failing unlink of a stray file is a reported skip, not a throw", () => {
      const logs = [];
      const res = execute(
        { kind: "stray-file", target: strayFile },
        {
          refuseDelete: () => null,
          isDirty: () => false,
          removeFile: () => {
            throw new Error("EBUSY");
          },
          log: (m) => logs.push(m),
        },
      );
      assert.equal(res, "skipped");
      assert.ok(logs.some((m) => m.includes("SKIPPED") && m.includes("EBUSY")));
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Bug (cont'd): the apply loop used to let one action's thrown error kill the whole run, so a
// stray-file rmdir failure on action 1 meant docker prune / npm cache clean / stale-proof cleanup
// (later actions) never ran at all. applyActions must isolate each action: a throw is caught,
// logged, and recorded, and the loop still reaches every later action.
t("applyActions: a throwing action does not stop the loop; the failure is recorded", () => {
  const calls = [];
  const logs = [];
  const actions = [
    { kind: "orphan-dir", target: "/w/bugs-selftest.log" },
    { kind: "docker-build-cache" },
    { kind: "npm-cache" },
  ];
  const result = applyActions(actions, 10, {
    getFreeSpaceGb: () => 0, // always below target: never stop early
    execute: (a) => {
      calls.push(a.kind);
      if (a.kind === "orphan-dir") {
        throw new Error("Command failed: cmd /c rmdir /s /q C:\\wt\\bugs-selftest.log");
      }
      return "done";
    },
    log: (m) => logs.push(m),
  });
  assert.deepEqual(
    calls,
    ["orphan-dir", "docker-build-cache", "npm-cache"],
    "every action must be attempted even though the first one threw",
  );
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].action.kind, "orphan-dir");
  assert.ok(
    logs.some((l) => l.includes("FAILED orphan-dir") && l.includes("/w/bugs-selftest.log")),
    `expected a FAILED log line: ${JSON.stringify(logs)}`,
  );
});

const dirLink = (target, path) => symlinkSync(target, path, DIR_LINK_TYPE);
t(
  "row 719: other trees' node_modules symlinks into a candidate are found; clean trees are not",
  () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "janitor-xlink-")));
    try {
      const cand = join(root, "cand");
      const other = join(root, "other");
      const clean = join(root, "clean");
      for (const d of [cand, other, clean])
        mkdirSync(join(d, "node_modules", "@s"), { recursive: true });
      mkdirSync(join(cand, "node_modules", "pkg"), { recursive: true });
      mkdirSync(join(clean, "node_modules", "mine"), { recursive: true });
      dirLink(join(cand, "node_modules", "pkg"), join(other, "node_modules", "pkg"));
      dirLink(join(cand, "node_modules", "pkg"), join(other, "node_modules", "@s", "scoped"));
      dirLink(join(clean, "node_modules", "mine"), join(clean, "node_modules", "self"));
      const hits = linkedIntoBy(cand, [other, clean, cand]);
      assert.equal(hits.length, 2);
      assert.ok(hits.every((h) => h.startsWith(other)));
      assert.deepEqual(linkedIntoBy(clean, [other, cand]), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
t("row 719: classifyWorktree skips (reports) a merged tree that other trees link into", () => {
  const v = classifyWorktree({
    name: "rf-linked",
    branch: "fix/shipped",
    isMainCheckout: false,
    isMerged: true,
    isDirty: false,
    isRecent: false,
    hasUnpushed: false,
    linkedFrom: ["/w/other/node_modules/pkg"],
  });
  assert.equal(v.nodeModules, "skip");
  assert.equal(v.worktree, "skip");
  assert.match(v.reason, /other trees link into it/);
});

t(
  "row 719 (A): a link inside another tree's apps/*/node_modules into the candidate is found",
  () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "janitor-xlink-a-")));
    try {
      const cand = join(root, "cand");
      const other = join(root, "other");
      mkdirSync(join(cand, "apps", "mobile", "node_modules", "react-native"), { recursive: true });
      mkdirSync(join(other, "apps", "mobile", "node_modules"), { recursive: true });
      mkdirSync(join(other, "packages", "ui", "node_modules"), { recursive: true });
      dirLink(
        join(cand, "apps", "mobile", "node_modules", "react-native"),
        join(other, "apps", "mobile", "node_modules", "react-native"),
      );
      const hits = linkedIntoBy(cand, [other, cand]);
      assert.equal(hits.length, 1);
      assert.match(hits[0], /apps.mobile.node_modules.react-native$/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
t("row 719 (B): another tree whose node_modules IS a symlink into the candidate is found", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "janitor-xlink-b-")));
  try {
    const cand = join(root, "cand");
    const other = join(root, "other");
    mkdirSync(join(cand, "node_modules", "pkg"), { recursive: true });
    mkdirSync(other, { recursive: true });
    dirLink(join(cand, "node_modules"), join(other, "node_modules"));
    const hits = linkedIntoBy(cand, [other, cand]);
    assert.equal(hits.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
t("row 719 (fail closed): a readdir error makes the scan unknown, and the tree is skipped", () => {
  const eio = (code) => () => {
    throw Object.assign(new Error(code), { code });
  };
  const root = realpathSync(mkdtempSync(join(tmpdir(), "janitor-xlink-c-")));
  try {
    const cand = join(root, "cand");
    const other = join(root, "other");
    mkdirSync(cand, { recursive: true });
    mkdirSync(join(other, "node_modules"), { recursive: true });
    const scan = scanLinkTargets([other], { readdir: eio("EACCES") });
    assert.ok(scan.unknown[other], "the unreadable dir must be recorded as unknown");
    assert.equal(linkedIntoBy(cand, [other, cand], scan), null);
    const scan2 = scanLinkTargets([other], { lstat: eio("EPERM") });
    assert.ok(scan2.unknown[other], "an lstat EPERM must be recorded as unknown");
    const v = classifyWorktree({
      name: "rf-unk",
      branch: "fix/shipped",
      isMainCheckout: false,
      isMerged: true,
      isDirty: false,
      isRecent: false,
      hasUnpushed: false,
      linkedFrom: null,
    });
    assert.equal(v.nodeModules, "skip");
    assert.equal(v.worktree, "skip");
    assert.match(v.reason, /link scan/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
t("row 719: an lstat EPERM on an entry inside node_modules is unknown, never 'not a link'", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "janitor-xlink-e-")));
  try {
    const other = join(root, "other");
    mkdirSync(join(other, "node_modules", "pkg"), { recursive: true });
    const pkg = join(other, "node_modules", "pkg");
    const lstat = (p) => {
      if (p === pkg) throw Object.assign(new Error("EPERM"), { code: "EPERM" });
      return lstatSync(p);
    };
    const scan = scanLinkTargets([other], { lstat });
    assert.ok(scan.unknown[other]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
t(
  "row 719: samePathOrInside folds case on win32/darwin, not linux, and respects boundaries",
  () => {
    assert.equal(samePathOrInside("c:\\wt\\u6\\node_modules", "C:\\WT\\U6", "win32"), true);
    assert.equal(samePathOrInside("\\\\?\\C:\\wt\\u6", "C:\\wt\\u6", "win32"), true);
    assert.equal(samePathOrInside("C:\\wt\\u60", "C:\\wt\\u6", "win32"), false);
    assert.equal(samePathOrInside("/Users/x/WT/U6/a", "/users/x/wt/u6", "darwin"), true);
    assert.equal(samePathOrInside("/Users/x/wt/u60", "/Users/x/wt/u6", "darwin"), false);
    assert.equal(samePathOrInside("/Users/x/WT/U6/a", "/users/x/wt/u6", "linux"), false);
    assert.equal(samePathOrInside("/w/u6", "/w/u6", "linux"), true);
  },
);
t("row 719: a precomputed scan map is reused across candidates", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "janitor-xlink-d-")));
  try {
    const a = join(root, "a");
    const b = join(root, "b");
    mkdirSync(join(a, "node_modules", "p"), { recursive: true });
    mkdirSync(join(b, "node_modules"), { recursive: true });
    dirLink(join(a, "node_modules", "p"), join(b, "node_modules", "p"));
    const scan = scanLinkTargets([a, b]);
    assert.equal(linkedIntoBy(a, [a, b], scan).length, 1);
    assert.deepEqual(linkedIntoBy(b, [a, b], scan), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- --allow-list: per-worktree qualifier (red-first cases) ---
const AL_NOW = Date.parse("2026-10-26T16:00:00Z");
const AL_OLD = AL_NOW - 48 * 3600 * 1000;
const alOk = {
  name: "wt-x",
  isMainCheckout: false,
  isLocked: false,
  isDirty: false,
  onOrigin: true,
  headMs: AL_OLD,
  indexMs: AL_OLD,
  nowMs: AL_NOW,
  linkedFrom: [],
};
t("allow-list: a clean, on-origin, idle, detached worktree qualifies", () => {
  assert.equal(allowListVerdict(alOk).ok, true);
});
t("allow-list: dirty is refused", () => {
  assert.equal(allowListVerdict({ ...alOk, isDirty: true }).ok, false);
});
t("allow-list: HEAD not on any origin ref is refused", () => {
  assert.equal(allowListVerdict({ ...alOk, onOrigin: false }).ok, false);
});
t("allow-list: HEAD or index idle under 24h (or unknown) is refused", () => {
  assert.equal(allowListVerdict({ ...alOk, headMs: AL_NOW - 3600e3 }).ok, false);
  assert.equal(allowListVerdict({ ...alOk, indexMs: AL_NOW - 3600e3 }).ok, false);
  assert.equal(allowListVerdict({ ...alOk, indexMs: null }).ok, false);
});
t("allow-list: main checkout, protected name and locked are refused", () => {
  assert.equal(allowListVerdict({ ...alOk, isMainCheckout: true }).ok, false);
  assert.equal(allowListVerdict({ ...alOk, name: "rf-migrate" }).ok, false);
  assert.equal(allowListVerdict({ ...alOk, isLocked: true }).ok, false);
});
t("allow-list: a sibling tree linking into it (or an unreadable scan) is refused", () => {
  assert.equal(allowListVerdict({ ...alOk, linkedFrom: ["/w/sib"] }).ok, false);
  assert.equal(allowListVerdict({ ...alOk, linkedFrom: null }).ok, false);
});
t("allow-list: file parsing takes column 1, skips comments and blanks", () => {
  const text = ["# c", "", "C:/a|b|1|origin", "C:/b\tx", "  C:/c  ", ""].join("\n");
  assert.deepEqual(parseAllowList(text), ["C:/a", "C:/b", "C:/c"]);
});
t("allow-list: removal never follows a junction inside the worktree into a sibling", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "janitor-al-")));
  try {
    const wt = join(root, "wt");
    const sib = join(root, "sib");
    mkdirSync(join(wt, "node_modules"), { recursive: true });
    mkdirSync(sib);
    writeFileSync(join(sib, "keep.txt"), "x");
    dirLink(sib, join(wt, "node_modules", "pkg"));
    removeWorktreeSafely(wt, {
      git: () => {},
      unlinkLinksWithin,
      exists: (p) => existsSync(p),
      removeTree: (p) => safeRemoveTree(p),
    });
    assert.equal(existsSync(wt), false);
    assert.equal(readFileSync(join(sib, "keep.txt"), "utf8"), "x");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- --allow-list: ignored-path classes (cache passes / local-assets salvaged / unknown blocks) ---
const ign = (...p) => p.map((x) => "!! " + x).join("\n");
t("allow-list: regenerable cache dirs are not blockers", () => {
  const r = classifyIgnoredForAllowList(
    "",
    ign(
      "apps/api/.jest-cache/",
      ".turbo/",
      "apps/web/.next/",
      "apps/web/test-results/",
      "apps/web/playwright-report/",
      "apps/api/dist/",
      "node_modules/",
      "coverage/",
      ".expo/",
      "packages/x/build/",
    ),
  );
  assert.deepEqual(r, { dirty: false, salvage: [], blockers: [] });
});
t(
  "allow-list: a nested src/build/ (source folder) is refused, anchored build output passes",
  () => {
    const r = classifyIgnoredForAllowList(
      "",
      ign("apps/api/src/build/", "apps/api/dist/", "build/", "apps/web/src/coverage/"),
    );
    assert.deepEqual(r.blockers, ["apps/api/src/build/", "apps/web/src/coverage/"]);
  },
);
t("allow-list: samePath is case-insensitive only when asked (Windows main checkout)", () => {
  assert.equal(samePath("C:/ClaudeCode/Routeflow", "c:/claudecode/routeflow", true), true);
  assert.equal(samePath("/a/Routeflow", "/a/routeflow", false), false);
});
t("allow-list: local-assets is salvage, not a blocker", () => {
  const r = classifyIgnoredForAllowList("", ign("local-assets/", "local-assets/proofs/x.png"));
  assert.equal(r.blockers.length, 0);
  assert.equal(r.salvage.length, 2);
});
t("allow-list: an unknown ignored file blocks and is named", () => {
  const r = classifyIgnoredForAllowList("", ign("apps/api/.env", ".jest-cache/"));
  assert.deepEqual(r.blockers, ["apps/api/.env"]);
  const v = allowListVerdict({ ...alOk, isDirty: true, blockers: r.blockers });
  assert.equal(v.ok, false);
  assert.match(v.reason, /apps\/api\/\.env/);
});
t("allow-list: tracked changes or an unreadable status stay dirty", () => {
  assert.equal(classifyIgnoredForAllowList(" M a.ts", "").dirty, true);
  assert.equal(classifyIgnoredForAllowList(null, "").dirty, true);
});
t("allow-list: local-assets is moved to the salvage root, then the worktree is removed", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "janitor-al2-")));
  try {
    const wt = join(root, "wt");
    const salvageRoot = join(root, "main", "local-assets", "worktree-salvage");
    mkdirSync(join(wt, "local-assets", "proofs"), { recursive: true });
    writeFileSync(join(wt, "local-assets", "proofs", "x.png"), "img");
    const log = [];
    const a = {
      kind: "worktree",
      target: wt,
      worktree: "wt",
      worktreePath: wt,
      allowListed: true,
      salvage: ["local-assets/"],
      salvageRoot,
    };
    const out = execute(a, {
      refuseDelete: () => null,
      isDirty: () => true,
      isDirtyAllowList: () => false,
      salvage: (x) => salvageIgnored(x.worktreePath, x.worktree, x.salvage, x.salvageRoot),
      removeWorktree: (t) =>
        removeWorktreeSafely(t, {
          git: () => {},
          unlinkLinksWithin,
          exists: (p) => existsSync(p),
          removeTree: (p) => safeRemoveTree(p),
        }),
      log: (m) => log.push(m),
    });
    assert.equal(out, "done");
    assert.equal(existsSync(wt), false);
    assert.equal(
      readFileSync(join(salvageRoot, "wt", "local-assets", "proofs", "x.png"), "utf8"),
      "img",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
t("allow-list: a failed or colliding salvage skips the worktree and keeps it", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "janitor-al3-")));
  try {
    const wt = join(root, "wt");
    const salvageRoot = join(root, "salvage");
    mkdirSync(join(wt, "local-assets"), { recursive: true });
    mkdirSync(join(salvageRoot, "wt", "local-assets"), { recursive: true });
    let removed = false;
    const a = {
      kind: "worktree",
      target: wt,
      worktree: "wt",
      worktreePath: wt,
      allowListed: true,
      salvage: ["local-assets/"],
      salvageRoot,
    };
    const out = execute(a, {
      refuseDelete: () => null,
      isDirty: () => false,
      isDirtyAllowList: () => false,
      salvage: (x) => salvageIgnored(x.worktreePath, x.worktree, x.salvage, x.salvageRoot),
      removeWorktree: () => {
        removed = true;
      },
      log: () => {},
    });
    assert.equal(out, "skipped");
    assert.equal(removed, false);
    assert.equal(existsSync(join(wt, "local-assets")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- --worktrees-only / --paths / detached-HEAD proof / broken index (2026-10-29) ---
const wtAct = (step, kind, worktreePath, extra = {}) => ({
  step,
  kind,
  target: kind === "node_modules" ? join(worktreePath, "node_modules") : worktreePath,
  worktree: worktreePath.split(/[\\/]/).pop(),
  worktreePath,
  ...extra,
});
const fullPlan = () => [
  wtAct(1, "node_modules", "/w/a"),
  wtAct(2, "worktree", "/w/a"),
  wtAct(1, "node_modules", "/w/b"),
  wtAct(2, "worktree", "/w/b"),
  { step: 3, kind: "orphan-dir", target: "/w/orphan" },
  { step: 4, kind: "docker-build-cache" },
  { step: 5, kind: "npm-cache" },
  { step: 6, kind: "stale-proof-dir", target: "/m/local-assets/proofs/old" },
  { step: 7, kind: "jest-cache", target: "/tmp/jest_x", root: "/tmp" },
];
t("worktrees-only: keeps steps 1-3 and never plans docker, npm cache, proofs or Jest", () => {
  const { actions } = scopePlan(fullPlan(), { worktreesOnly: true });
  assert.deepEqual(
    actions.map((a) => a.step),
    [1, 2, 1, 2, 3],
  );
  assert.ok(!actions.some((a) => ["docker-build-cache", "npm-cache"].includes(a.kind)));
});
t("paths: acts only on listed trees; every other action is report-only", () => {
  const { actions, reported } = scopePlan(fullPlan(), { paths: ["/w/a"] });
  assert.deepEqual(
    actions.map((a) => `${a.kind} ${a.target}`),
    ["worktree /w/a"],
  );
  assert.ok(reported.some((r) => r.worktree === "b" && /report-only/.test(r.reason)));
  assert.ok(reported.some((r) => /docker/.test(r.reason)));
  assert.ok(reported.some((r) => /orphan/.test(r.reason)));
});
t("paths: a listed tree's removal is PLAIN (never --force); its node_modules step folds in", () => {
  const { actions } = scopePlan(fullPlan(), { paths: ["/w/a", "/w/b"] });
  assert.ok(actions.every((a) => a.kind === "worktree" && a.plain === true));
  assert.equal(actions.length, 2);
});
t("paths: a listed tree with only a node_modules clear (unpushed) keeps that clear", () => {
  const { actions } = scopePlan([wtAct(1, "node_modules", "/w/c")], { paths: ["/w/c"] });
  assert.deepEqual(
    actions.map((a) => a.kind),
    ["node_modules"],
  );
});
t("paths: matching is case-insensitive when asked (Windows paths)", () => {
  const { actions } = scopePlan([wtAct(2, "worktree", "C:/WT/Lane")], {
    paths: ["c:/wt/lane"],
    caseInsensitive: true,
  });
  assert.equal(actions.length, 1);
});
t("removeWorktreePlain: links first, then a plain `git worktree remove`, never --force", () => {
  const calls = [];
  removeWorktreePlain("/w/lane", {
    git: (...args) => (calls.push(`git ${args.join(" ")}`), { ok: true }),
    unlinkLinksWithin: (d) => calls.push(`unlink ${d}`),
    exists: () => false,
  });
  assert.deepEqual(calls, ["unlink /w/lane", "git worktree remove /w/lane", "git worktree prune"]);
  assert.ok(!calls.some((c) => c.includes("--force")));
});
t("removeWorktreePlain: a tree git refuses stays and the refusal is thrown, never forced", () => {
  const calls = [];
  assert.throws(
    () =>
      removeWorktreePlain("/w/lane", {
        git: (...args) => (calls.push(args.join(" ")), { ok: false, stderr: "index.lock exists" }),
        unlinkLinksWithin: () => {},
        exists: () => true,
      }),
    /index\.lock exists/,
  );
  assert.deepEqual(calls, ["worktree remove /w/lane"]);
});
t(
  "removeWorktreePlain: a junction-nested node_modules is unlinked before git; target survives",
  () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "janitor-plain-")));
    try {
      const wt = join(root, "wt");
      const sib = join(root, "sib");
      mkdirSync(join(wt, "apps", "api", "node_modules"), { recursive: true });
      mkdirSync(join(sib, "pkg"), { recursive: true });
      writeFileSync(join(sib, "pkg", "keep.txt"), "x");
      dirLink(sib, join(wt, "node_modules"));
      dirLink(join(sib, "pkg"), join(wt, "apps", "api", "node_modules", "pkg"));
      let linksAtGit = null;
      removeWorktreePlain(wt, {
        git: (...args) => {
          if (args[1] === "remove") {
            linksAtGit = [
              join(wt, "node_modules"),
              join(wt, "apps", "api", "node_modules", "pkg"),
            ].filter((p) => pathPresent(p));
            rmSync(wt, { recursive: true, force: true }); // stands in for git, AFTER the unlink
          }
          return { ok: true };
        },
        unlinkLinksWithin,
        exists: (p) => existsSync(p),
      });
      assert.deepEqual(linksAtGit, []);
      assert.equal(readFileSync(join(sib, "pkg", "keep.txt"), "utf8"), "x");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
t("execute: a plain action goes through removeWorktreePlain, never removeWorktree", () => {
  const calls = [];
  const out = execute(wtAct(2, "worktree", "/w/a", { plain: true }), {
    refuseDelete: () => null,
    isDirty: () => false,
    removeWorktree: () => calls.push("force"),
    removeWorktreePlain: (p) => calls.push(`plain ${p}`),
    log: () => {},
  });
  assert.equal(out, "done");
  assert.deepEqual(calls, ["plain /w/a"]);
});
t("execute: a strict-ignored (detached) removal re-checks with the ignored-path-aware test", () => {
  const calls = [];
  const out = execute(wtAct(2, "worktree", "/w/a", { plain: true, strictIgnored: true }), {
    refuseDelete: () => null,
    isDirty: () => false,
    isDirtyAllowList: () => true,
    removeWorktreePlain: () => calls.push("plain"),
    log: () => {},
  });
  assert.equal(out, "refused");
  assert.deepEqual(calls, []);
});
t("execute: a broken-index removal skips the status re-check but refuses if HEAD moved", () => {
  const a = wtAct(2, "worktree", "/w/a", { plain: true, brokenIndex: "missing", head: "abc" });
  const calls = [];
  const deps = (head) => ({
    refuseDelete: () => null,
    isDirty: () => true, // an unreadable status reads dirty; a broken index never asks it
    isDirtyAllowList: () => true,
    headOf: () => head,
    removeWorktreePlain: () => calls.push("plain"),
    log: () => {},
  });
  assert.equal(execute(a, deps("def")), "refused");
  assert.deepEqual(calls, []);
  assert.equal(execute(a, deps("abc")), "done");
  assert.deepEqual(calls, ["plain"]);
});
// Review fold (#3974, Opus FAIL): stale lock, plain everywhere, relative paths, orphans.
t(
  "execute: a stale-lock removal re-checks clean + ignored state at delete time, not only HEAD",
  () => {
    const a = wtAct(2, "worktree", "/w/a", {
      plain: true,
      brokenIndex: "stale-lock",
      head: "abc",
      strictIgnored: true,
    });
    const calls = [];
    const out = execute(a, {
      refuseDelete: () => null,
      isDirty: () => false,
      isDirtyAllowList: () => true, // an ignored .env appeared
      headOf: () => "abc",
      removeWorktreePlain: () => calls.push("plain"),
      log: () => {},
    });
    assert.equal(out, "refused");
    assert.deepEqual(calls, []);
  },
);
t("worktrees-only: every whole-tree removal is plain, with or without --paths", () => {
  const wts = scopePlan(fullPlan(), { worktreesOnly: true }).actions.filter(
    (a) => a.kind === "worktree",
  );
  assert.equal(wts.length, 2);
  assert.ok(wts.every((a) => a.plain === true));
});
t("paths: a relative --paths entry resolves against the repo root, not the cwd", () => {
  const root = resolve("/repo-root");
  const abs = resolve("/abs/c");
  assert.deepEqual(resolveListedPaths(["wt/a", "../wt/b", abs], root), [
    join(root, "wt", "a"),
    resolve(root, "../wt/b"),
    abs,
  ]);
});
t("paths: a listed orphan dir or stray file is reported, never removed", () => {
  const { actions, reported } = scopePlan(
    [
      { step: 3, kind: "orphan-dir", target: "/w/orphan" },
      { step: 3, kind: "stray-file", target: "/w/x.log" },
    ],
    { paths: ["/w/orphan", "/w/x.log"] },
  );
  assert.deepEqual(actions, []);
  assert.equal(reported.length, 2);
  assert.ok(reported.every((r) => /never removes/.test(r.reason)));
});

// Real repos: a detached merged tree, its proofs, and the broken-index rule (all under --paths).
{
  const root = realpathSync(mkdtempSync(join(tmpdir(), "janitor-detached-")));
  const main = join(root, "main");
  const origin = join(root, "origin.git");
  const wtRoot = join(root, "wt");
  const git = (cwd, ...args) =>
    execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: fixtureGitEnv(),
    }).trim();
  const id = ["-c", "user.name=t", "-c", "user.email=t@example.com"];
  const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  const idle = (wt) => {
    const gd = git(wt, "rev-parse", "--absolute-git-dir");
    utimesSync(join(gd, "logs", "HEAD"), old, old);
    return gd;
  };
  const plan = (paths, prs = []) => buildPlan(main, main, wtRoot, { paths, prs });
  const removalFor = (r, wt) =>
    r.actions.find((a) => a.kind === "worktree" && samePath(a.worktreePath, wt, true));
  try {
    execFileSync("git", ["init", "-q", "--bare", origin], { env: fixtureGitEnv() });
    execFileSync("git", ["init", "-q", "-b", "master", main], { env: fixtureGitEnv() });
    writeFileSync(join(main, ".gitignore"), "node_modules/\n*.local\n.env\n");
    writeFileSync(join(main, "a.txt"), "a");
    git(main, "add", ".gitignore", "a.txt");
    git(main, ...id, "commit", "-q", "-m", "base");
    git(main, "remote", "add", "origin", origin);
    git(main, "checkout", "-q", "-b", "feat/x");
    writeFileSync(join(main, "x.txt"), "x");
    git(main, "add", "x.txt");
    git(main, ...id, "commit", "-q", "-m", "x work");
    const xSha = git(main, "rev-parse", "HEAD");
    git(main, "checkout", "-q", "master");
    git(main, ...id, "merge", "-q", "--no-ff", "-m", "merge x", "feat/x");
    git(main, "push", "-q", "origin", "master");
    git(main, "fetch", "-q", "origin");

    const merged = join(wtRoot, "merged");
    git(main, "worktree", "add", "-q", "--detach", merged, xSha);
    mkdirSync(join(merged, "node_modules", "p"), { recursive: true });
    idle(merged);

    const unmerged = join(wtRoot, "unmerged");
    git(main, "worktree", "add", "-q", "--detach", unmerged, xSha);
    writeFileSync(join(unmerged, "u.txt"), "u");
    git(unmerged, "add", "u.txt");
    git(unmerged, ...id, "commit", "-q", "-m", "never merged");
    idle(unmerged);

    t("detached: a merged, clean, idle detached tree is NOT planned without --paths", () => {
      const r = plan(null);
      assert.equal(removalFor(r, merged), undefined);
      assert.ok(r.skipped.some((s) => s.worktree === "merged" && /--paths/.test(s.reason)));
    });
    t("detached: listed in --paths, HEAD in origin/master proves it; removal planned", () => {
      const a = removalFor(plan([merged]), merged);
      assert.ok(a, "expected a worktree action for the listed detached merged tree");
      assert.match(a.detachedProof, /origin\/master/);
      assert.equal(a.strictIgnored, true);
    });
    t("detached: a listed tree whose HEAD is not merged anywhere is refused", () => {
      const r = plan([unmerged]);
      assert.equal(removalFor(r, unmerged), undefined);
      assert.ok(r.skipped.some((s) => s.worktree === "unmerged" && /not merged/.test(s.reason)));
    });
    t("detached: a tree byte-equal (same tree) to a merged PR head is proven", () => {
      const tree = git(unmerged, "rev-parse", "HEAD^{tree}");
      const twin = git(main, ...id, "commit-tree", tree, "-p", xSha, "-m", "pr head twin");
      const masterSha = git(main, "rev-parse", "origin/master");
      const prs = [{ number: 7, headRefOid: twin, mergeCommit: { oid: masterSha } }];
      const a = removalFor(plan([unmerged], prs), unmerged);
      assert.ok(a, "expected the tree-equal proof to plan the removal");
      assert.match(a.detachedProof, /#7/);
    });
    t("detached: a non-regenerable ignored file blocks it; node_modules does not", () => {
      writeFileSync(join(merged, "notes.local"), "mine");
      try {
        assert.equal(removalFor(plan([merged]), merged), undefined);
      } finally {
        rmSync(join(merged, "notes.local"));
      }
      assert.ok(removalFor(plan([merged]), merged));
    });
    t("detached: a HEAD that moved within RECENT_ACTIVITY_HOURS is refused", () => {
      const gd = git(merged, "rev-parse", "--absolute-git-dir");
      const now = new Date();
      utimesSync(join(gd, "logs", "HEAD"), now, now);
      try {
        assert.equal(removalFor(plan([merged]), merged), undefined);
      } finally {
        utimesSync(join(gd, "logs", "HEAD"), old, old);
      }
    });

    const broken = join(wtRoot, "broken");
    git(main, "worktree", "add", "-q", "--detach", broken, xSha);
    const brokenGd = idle(broken);
    rmSync(join(brokenGd, "index"));
    t(
      "broken index: a listed tree with a missing index and HEAD in master is planned, plain",
      () => {
        const a = removalFor(plan([broken]), broken);
        assert.ok(a, "expected a removal for the listed broken-index tree");
        assert.equal(a.brokenIndex, "missing");
        assert.equal(a.plain, true);
        assert.equal(a.head, xSha);
      },
    );
    t("broken index: the same tree NOT listed is never planned", () => {
      assert.equal(removalFor(plan(null), broken), undefined);
      assert.equal(removalFor(plan([merged]), broken), undefined);
    });
    const locked = join(wtRoot, "lockd");
    git(main, "worktree", "add", "-q", "--detach", locked, xSha);
    const lockGd = idle(locked);
    writeFileSync(join(lockGd, "index.lock"), "");
    t("broken index: a FRESH index.lock (a live git command) is refused even when listed", () => {
      assert.equal(removalFor(plan([locked]), locked), undefined);
    });
    t("broken index: a STALE index.lock on a listed tree in master is planned", () => {
      utimesSync(join(lockGd, "index.lock"), old, old);
      const a = removalFor(plan([locked]), locked);
      assert.ok(a, "expected a removal for the stale-lock tree");
      assert.equal(a.brokenIndex, "stale-lock");
      assert.equal(
        a.strictIgnored,
        true,
        "a stale-lock removal must re-check status at delete time",
      );
    });
    t("broken index: a stale-lock tree holding a non-regenerable ignored file is refused", () => {
      writeFileSync(join(locked, ".env"), "SECRET=1");
      try {
        const r = plan([locked]);
        assert.equal(removalFor(r, locked), undefined);
        assert.ok(r.skipped.some((x) => x.worktree === "lockd" && /ignored/.test(x.reason)));
      } finally {
        rmSync(join(locked, ".env"));
      }
    });
    t("broken index: a stale-lock tree with an uncommitted change is refused", () => {
      writeFileSync(join(locked, "a.txt"), "changed");
      try {
        assert.equal(removalFor(plan([locked]), locked), undefined);
      } finally {
        writeFileSync(join(locked, "a.txt"), "a");
      }
    });
    t("paths: a listed path that is not a registered worktree is reported", () => {
      const r = plan([join(root, "nowhere")]);
      assert.ok(r.skipped.some((s) => /not a registered worktree/.test(s.reason)));
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Fast junction scan: a Node walk over readdir Dirents that never descends into a link (the old
// PowerShell Get-ChildItem -Recurse walked INTO every junction target and took 15+ minutes a tree).
{
  // Fake Windows paths are written with "/" and turned into "\" here, so no literal needs escaping.
  const p = (s) => s.replace(/\//g, "\\");
  const dirent = (name, kind) => ({
    name,
    isFile: () => kind === "file",
    isDirectory: () => kind === "dir",
    isSymbolicLink: () => kind === "link",
  });
  // A fake tree: { "C:/w": [[name, kind], ...] } (keys are p()-converted). An Error value is thrown by readdir.
  const fakeFs = (tree, calls = []) => {
    const byPath = new Map(Object.entries(tree).map(([k, v]) => [p(k), v]));
    return {
      platform: "win32",
      exists: () => true,
      readdir: (d) => {
        calls.push(d);
        const v = byPath.get(d);
        if (v instanceof Error) throw v;
        if (!v) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return v.map(([n, k]) => dirent(n, k));
      },
      lstat: () => {
        throw new Error("lstat not expected");
      },
    };
  };

  t("FJ1: a junction or symlink is found, a plain file and folder are not", () => {
    const tree = {
      "C:/w": [
        ["a", "dir"],
        ["j", "link"],
        ["f", "file"],
      ],
      "C:/w/a": [["s", "link"]],
    };
    assert.deepEqual(findJunctions(p("C:/w"), fakeFs(tree)).sort(), [p("C:/w/a/s"), p("C:/w/j")]);
  });
  t("FJ2: a junction nested several folders down is found", () => {
    const tree = {
      "C:/w": [["a", "dir"]],
      "C:/w/a": [["b", "dir"]],
      "C:/w/a/b": [["c", "dir"]],
      "C:/w/a/b/c": [["deep", "link"]],
    };
    assert.deepEqual(findJunctions(p("C:/w"), fakeFs(tree)), [p("C:/w/a/b/c/deep")]);
  });
  t("FJ3: a link is never descended into (its target's own links are not listed)", () => {
    const calls = [];
    const tree = {
      "C:/w": [["nm", "link"]],
      // Only a walker that follows the link would ever read this folder.
      "C:/w/nm": [
        ["inner", "link"],
        ["x", "dir"],
      ],
    };
    assert.deepEqual(findJunctions(p("C:/w"), fakeFs(tree, calls)), [p("C:/w/nm")]);
    assert.deepEqual(calls, [p("C:/w")], `descended: ${JSON.stringify(calls)}`);
  });
  t(
    "FJ4 (B818): ONE unreadable subtree fails the whole scan closed (null, never a partial list)",
    () => {
      const tree = {
        "C:/w": [
          ["ok", "dir"],
          ["denied", "dir"],
          ["j", "link"],
        ],
        "C:/w/ok": [["k", "link"]],
        "C:/w/denied": Object.assign(new Error("EPERM"), { code: "EPERM" }),
      };
      assert.equal(findJunctions(p("C:/w"), fakeFs(tree)), null);
    },
  );
  t("FJ5 (B818): an unreadable ROOT fails closed too", () => {
    const tree = { "C:/w": Object.assign(new Error("EACCES"), { code: "EACCES" }) };
    assert.equal(findJunctions(p("C:/w"), fakeFs(tree)), null);
  });
  t(
    "FJ6: an entry of unknown type is lstat'ed, a link there is found, a failed lstat fails closed",
    () => {
      const tree = {
        "C:/w": [
          ["u", "unknown"],
          ["f", "file"],
        ],
      };
      const withLstat = (isLink) => ({
        ...fakeFs(tree),
        lstat: () => ({ isSymbolicLink: () => isLink, isDirectory: () => false }),
      });
      assert.deepEqual(findJunctions(p("C:/w"), withLstat(true)), [p("C:/w/u")]);
      assert.deepEqual(findJunctions(p("C:/w"), withLstat(false)), []);
      const broken = {
        ...fakeFs(tree),
        lstat: () => {
          throw new Error("EIO");
        },
      };
      assert.equal(findJunctions(p("C:/w"), broken), null);
    },
  );
  t("FJ7: a missing folder has no junctions; off Windows nothing is scanned", () => {
    assert.deepEqual(findJunctions(p("C:/gone"), { ...fakeFs({}), exists: () => false }), []);
    const calls = [];
    const linux = { ...fakeFs({ "/w": [["j", "link"]] }, calls), platform: "linux" };
    assert.deepEqual(findJunctions("/w", linux), []);
    assert.deepEqual(calls, []);
  });
  t("FJ8: a very deep tree does not overflow the stack (the walk is iterative)", () => {
    const tree = {};
    let d = "C:/w";
    for (let i = 0; i < 6000; i++) {
      tree[d] = [["n", "dir"]];
      d += "/n";
    }
    tree[d] = [["end", "link"]];
    assert.deepEqual(findJunctions(p("C:/w"), fakeFs(tree)), [p(d + "/end")]);
  });

  // Remove ONE link without following it (a directory junction goes with rmdir, never into its target).
  const dropLink = (path) => {
    try {
      unlinkSync(path);
    } catch {
      rmdirSync(path);
    }
  };
  if (process.platform === "win32") {
    // The real thing: does Node's readdir Dirent report a real junction as a link on this Windows?
    const root = mkdtempSync(join(tmpdir(), "janitor-fj-"));
    try {
      const outside = join(root, "outside");
      mkdirSync(join(outside, "inner"), { recursive: true });
      symlinkSync(join(outside, "inner"), join(outside, "innerlink"), "junction"); // lives in the TARGET
      const tree = join(root, "tree");
      mkdirSync(join(tree, "a", "b"), { recursive: true });
      writeFileSync(join(tree, "a", "file.txt"), "x");
      symlinkSync(outside, join(tree, "top"), "junction");
      symlinkSync(outside, join(tree, "a", "b", "nested"), "junction");
      t(
        "FJ9: REAL junctions (top level and nested) are found; the target's own junction is not",
        () => {
          assert.deepEqual(
            findJunctions(tree).sort(),
            [join(tree, "a", "b", "nested"), join(tree, "top")].sort(),
          );
        },
      );
      t("FJ10: REAL file and dir symlinks are found when this account may create them", () => {
        const fileLink = join(tree, "flink");
        const dirLink = join(tree, "dlink");
        try {
          symlinkSync(join(tree, "a", "file.txt"), fileLink, "file");
          symlinkSync(join(tree, "a"), dirLink, "dir");
        } catch (e) {
          if (e?.code === "EPERM") return; // no symlink privilege here: the junction rows are the case that matters
          throw e;
        }
        const found = findJunctions(tree);
        assert.ok(found.includes(fileLink) && found.includes(dirLink), JSON.stringify(found));
        dropLink(fileLink);
        dropLink(dirLink);
      });
      // A path far past MAX_PATH (260): Node namespaces it, so the walk must still reach the bottom.
      let deep = join(root, "long");
      while (deep.length < 400) deep = join(deep, "segment-" + "x".repeat(30));
      mkdirSync(deep, { recursive: true });
      symlinkSync(outside, join(deep, "bottom"), "junction");
      t("FJ11: a junction under a path longer than 260 characters is found", () => {
        assert.deepEqual(findJunctions(join(root, "long")), [join(deep, "bottom")]);
      });
      t(
        "FJ12: after the junctions are unlinked the rescan finds none, and the target survives",
        () => {
          for (const l of findJunctions(tree)) dropLink(l);
          assert.deepEqual(findJunctions(tree), []);
          assert.ok(
            existsSync(join(outside, "inner")),
            "the junction target must survive the unlink",
          );
        },
      );
    } finally {
      // Links first, so the recursive rm below can never follow one into `outside`.
      for (const link of findJunctions(root) ?? []) {
        try {
          dropLink(link);
        } catch {
          /* best effort */
        }
      }
      rmSync(root, { recursive: true, force: true });
    }
  }
}

// --modules-only: clears ONLY real node_modules of listed trees; every refusal fails closed.
{
  const HOUR = 60 * 60 * 1000;
  const NOW = Date.UTC(2026, 9, 31, 12, 0, 0);
  const idle = { headMs: NOW - 100 * HOUR, indexMs: NOW - 100 * HOUR, nowMs: NOW };
  const okInfo = {
    name: "lane-a",
    isMainCheckout: false,
    isLocked: false,
    linkedFrom: [],
    inUseBy: [],
    ...idle,
  };
  const ci = process.platform === "win32";

  t(
    "MO1: an idle, unlinked, unlocked, unused tree is cleared even though its git state is dirty",
    () => {
      assert.equal(modulesOnlyRefusal(okInfo), null);
    },
  );
  t("MO2: a tree another tree links into is refused, and so is an unknown link scan", () => {
    assert.match(modulesOnlyRefusal({ ...okInfo, linkedFrom: ["C:/wt/b/node_modules/x"] }), /link/);
    assert.match(modulesOnlyRefusal({ ...okInfo, linkedFrom: null }), /link scan failed/);
  });
  t(
    "MO3: a tree whose HEAD or index moved in the last 24h is refused; unknown counts as recent",
    () => {
      // One idle number for the whole janitor: modules-only reuses RECENT_ACTIVITY_HOURS (the Lead's
      // ruling under the owner's "delete old worktrees as long as their work is taken in").
      assert.equal(RECENT_ACTIVITY_HOURS, 24);
      const src = readFileSync(fileURLToPath(new URL("./janitor.mjs", import.meta.url)), "utf8");
      assert.doesNotMatch(src, /MODULES_ONLY_IDLE_HOURS/, "a second idle constant crept back in");
      const recent = (over) => modulesOnlyRefusal({ ...okInfo, ...over });
      assert.match(recent({ headMs: NOW - 23 * HOUR }), /24h/);
      assert.match(recent({ indexMs: NOW - 23 * HOUR }), /24h/);
      assert.match(recent({ headMs: null }), /24h/);
      assert.match(recent({ indexMs: null }), /24h/);
      assert.equal(recent({ headMs: NOW - 25 * HOUR, indexMs: NOW - 25 * HOUR }), null);
      assert.equal(recent({ headMs: NOW - 30 * HOUR, indexMs: NOW - 47 * HOUR }), null);
    },
  );
  t(
    "MO4: main checkout, protected name, locked tree, unreadable or hit process list are refused",
    () => {
      assert.match(modulesOnlyRefusal({ ...okInfo, isMainCheckout: true }), /main checkout/);
      assert.match(modulesOnlyRefusal({ ...okInfo, name: "rf-migrate" }), /protected/);
      assert.match(modulesOnlyRefusal({ ...okInfo, isLocked: true }), /locked/);
      assert.match(modulesOnlyRefusal({ ...okInfo, inUseBy: null }), /process scan failed/);
      assert.match(modulesOnlyRefusal({ ...okInfo, inUseBy: ["node dev.js"] }), /running process/);
    },
  );
  t("MO5: a process is matched by a path at a boundary, not by a longer sibling name", () => {
    assert.ok(mentionsTree("C:\\wt\\u6\\node_modules\\.bin\\next dev", "C:\\wt\\u6"));
    assert.ok(mentionsTree("node C:/WT/U6/scripts/a.mjs", "C:\\wt\\u6"));
    assert.ok(mentionsTree("C:\\wt\\u6", "C:\\wt\\u6"));
    assert.ok(!mentionsTree("C:\\wt\\u60\\x", "C:\\wt\\u6"));
    assert.ok(!mentionsTree("C:\\wt\\u6-old\\x", "C:\\wt\\u6"));
    assert.ok(!mentionsTree("C:\\other", "C:\\wt\\u6"));
  });

  const mk = () => {
    const root = mkdtempSync(join(tmpdir(), "janitor-mo-"));
    return {
      root,
      rm: () => {
        // links first, so the recursive rm can never follow one out of the fixture
        for (const l of findJunctions(root) ?? []) {
          try {
            unlinkSync(l);
          } catch {
            try {
              rmdirSync(l);
            } catch {
              /* best effort */
            }
          }
        }
        rmSync(root, { recursive: true, force: true });
      },
    };
  };
  const put = (file, text = "x") => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  };
  // The B815 guard as execute() applies it, with the main checkout out of the picture.
  const guard = (target, { worktreePath }) =>
    deleteRefusal({
      targetReal: join(realpathSync(dirname(target)), basename(target)),
      mainReal: join(tmpdir(), "janitor-mo-no-such-main"),
      worktreeReal: realpathSync(worktreePath),
      kind: "node_modules",
      caseInsensitive: ci,
    });
  const realOps = {
    refuseDelete: guard,
    removeTree: (d) => safeRemoveTree(d),
    exists: pathPresent,
  };

  t("MO6: findModulesDirs splits real dirs from links and reports unreadable paths", () => {
    const f = mk();
    try {
      put(join(f.root, "node_modules", "a", "i.js"));
      put(join(f.root, "apps", "web", "node_modules", "b.js"));
      put(join(f.root, "elsewhere", "c.js"));
      mkdirSync(join(f.root, "packages", "ui"), { recursive: true });
      symlinkSync(
        join(f.root, "elsewhere"),
        join(f.root, "packages", "ui", "node_modules"),
        "junction",
      );
      const r = findModulesDirs(f.root);
      assert.deepEqual(
        r.dirs.sort(),
        [join(f.root, "apps", "web", "node_modules"), join(f.root, "node_modules")].sort(),
      );
      assert.deepEqual(r.links, [join(f.root, "packages", "ui", "node_modules")]);
      assert.deepEqual(r.unknown, []);
      const bad = findModulesDirs(f.root, {
        lstat: () => {
          throw Object.assign(new Error("EPERM"), { code: "EPERM" });
        },
      });
      assert.ok(bad.unknown.length > 0);
    } finally {
      f.rm();
    }
  });

  t(
    "MO7: a link inside node_modules is unlinked, never followed: its target keeps every file",
    () => {
      const f = mk();
      try {
        const tree = join(f.root, "lane");
        const outside = join(f.root, "outside");
        put(join(outside, "keep.txt"), "do not delete");
        put(join(outside, "deep", "keep2.txt"), "nor this");
        put(join(tree, "node_modules", "real", "i.js"));
        symlinkSync(outside, join(tree, "node_modules", "linked"), "junction");
        put(join(tree, "apps", "web", "node_modules", "z", "i.js"));
        symlinkSync(outside, join(tree, "apps", "web", "node_modules", "z", "back"), "junction");
        const dirs = findModulesDirs(tree).dirs;
        assert.equal(removeModulesOnlyTree({ path: tree, dirs }, realOps), 2);
        assert.ok(!existsSync(join(tree, "node_modules")));
        assert.ok(!existsSync(join(tree, "apps", "web", "node_modules")));
        assert.equal(readFileSync(join(outside, "keep.txt"), "utf8"), "do not delete");
        assert.equal(readFileSync(join(outside, "deep", "keep2.txt"), "utf8"), "nor this");
      } finally {
        f.rm();
      }
    },
  );

  t(
    "MO8: a dirty tree keeps every source, uncommitted and local-assets file, byte for byte",
    () => {
      const f = mk();
      try {
        const tree = join(f.root, "dirty-lane");
        const keep = {
          [join(tree, "src", "tracked.ts")]: "export const a = 1;\n",
          [join(tree, "src", "uncommitted.ts")]: "// work in progress\n",
          [join(tree, "local-assets", "proofs", "shot.txt")]: "proof",
          [join(tree, ".env")]: "SECRET=1\n",
          [join(tree, "apps", "web", "page.tsx")]: "page",
          [join(tree, ".git")]: "gitdir: elsewhere\n",
        };
        for (const [p, text] of Object.entries(keep)) put(p, text);
        put(join(tree, "node_modules", "p", "index.js"));
        put(join(tree, "apps", "web", "node_modules", "q", "index.js"));
        put(join(tree, "packages", "ui", "node_modules", "r.js"));
        mkdirSync(join(tree, "packages", "ui", "src"), { recursive: true });
        const log = [];
        const summary = runModulesOnly(
          [tree],
          { repoRoot: f.root, mainCheckoutPath: join(f.root, "main") },
          {
            apply: true,
            io: {
              log: (m) => log.push(m),
              listWorktrees: () => [{ path: tree, branch: "lane", locked: false }],
              scanLinkTargets: (trees) => scanLinkTargets(trees),
              listProcessPaths: () => [],
              headMs: () => NOW - 100 * HOUR,
              indexMs: () => NOW - 100 * HOUR,
              now: () => NOW,
              freeGb: () => 5,
              removeTree: (planned) => removeModulesOnlyTree(planned, realOps),
            },
          },
        );
        assert.equal(summary.failed.length, 0, JSON.stringify(log));
        assert.equal(summary.trees, 1);
        for (const [p, text] of Object.entries(keep))
          assert.equal(readFileSync(p, "utf8"), text, p);
        assert.ok(existsSync(join(tree, "packages", "ui", "src")));
        assert.deepEqual(findModulesDirs(tree).dirs, []);
      } finally {
        f.rm();
      }
    },
  );

  t("MO9: a node_modules that is itself a link is left alone, with its target intact", () => {
    const f = mk();
    try {
      const tree = join(f.root, "lane");
      const target = join(f.root, "main-modules");
      put(join(target, "pkg", "i.js"), "shared");
      mkdirSync(tree, { recursive: true });
      symlinkSync(target, join(tree, "node_modules"), "junction");
      const found = findModulesDirs(tree);
      assert.deepEqual(found.dirs, []);
      assert.equal(found.links.length, 1);
      const log = [];
      const summary = runModulesOnly(
        [tree],
        { repoRoot: f.root, mainCheckoutPath: join(f.root, "main") },
        {
          apply: true,
          io: {
            log: (m) => log.push(m),
            listWorktrees: () => [{ path: tree, branch: "lane", locked: false }],
            scanLinkTargets: (trees) => scanLinkTargets(trees),
            listProcessPaths: () => [],
            headMs: () => NOW - 100 * HOUR,
            indexMs: () => NOW - 100 * HOUR,
            now: () => NOW,
            freeGb: () => 5,
            removeTree: () => assert.fail("nothing real to remove"),
          },
        },
      );
      assert.equal(summary.trees, 0);
      assert.ok(
        log.some((l) => /no real node_modules/.test(l)),
        JSON.stringify(log),
      );
      assert.equal(readFileSync(join(target, "pkg", "i.js"), "utf8"), "shared");
      assert.ok(lstatSync(join(tree, "node_modules")).isSymbolicLink());
    } finally {
      f.rm();
    }
  });

  t(
    "MO10: a tree that another tree's node_modules links into is refused, the linking tree is not",
    () => {
      const f = mk();
      try {
        const a = join(f.root, "a");
        const b = join(f.root, "b");
        put(join(a, "node_modules", "pkg", "i.js"));
        put(join(a, "packages", "shared", "index.ts"));
        put(join(b, "node_modules", "real", "i.js"));
        mkdirSync(join(b, "node_modules", "@routeflow"), { recursive: true });
        symlinkSync(
          join(a, "packages", "shared"),
          join(b, "node_modules", "@routeflow", "shared"),
          "junction",
        );
        const worktrees = [
          { path: a, locked: false },
          { path: b, locked: false },
        ];
        const ops = {
          worktrees,
          linkScan: scanLinkTargets([a, b]),
          procPaths: [],
          headMs: () => NOW - 100 * HOUR,
          indexMs: () => NOW - 100 * HOUR,
          findDirs: (tree) => findModulesDirs(tree),
          nowMs: NOW,
        };
        const main = join(f.root, "main");
        assert.match(planModulesOnlyTree(a, main, ops, ci).refused, /link\(s\) from other trees/);
        assert.ok(
          planModulesOnlyTree(b, main, ops, ci).tree,
          "the linking tree itself may be cleared",
        );
      } finally {
        f.rm();
      }
    },
  );

  t(
    "MO11: a recent tree, a tree a process names, and an unlisted path are refused with their reasons",
    () => {
      const worktrees = [
        { path: "C:/wt/recent", locked: false },
        { path: "C:/wt/busy", locked: false },
        { path: "C:/wt/ok", locked: false },
      ];
      const base = {
        worktrees,
        linkScan: { links: [], unknown: {} },
        procPaths: ["node C:\\wt\\busy\\node_modules\\.bin\\next dev"],
        headMs: (p) => (/recent/.test(p) ? NOW - HOUR : NOW - 100 * HOUR),
        indexMs: () => NOW - 100 * HOUR,
        findDirs: () => ({ dirs: ["x"], links: [], unknown: [] }),
        nowMs: NOW,
      };
      const plan = (p, ops = base) => planModulesOnlyTree(p, "C:/wt/main", ops, true);
      assert.match(plan("C:/wt/recent").refused, /24h/);
      assert.match(plan("C:/wt/busy").refused, /running process/);
      assert.match(plan("C:/wt/nowhere").refused, /not a registered worktree/);
      assert.ok(plan("C:/wt/ok").tree);
      assert.match(plan("C:/wt/ok", { ...base, procPaths: null }).refused, /process scan failed/);
      assert.match(
        plan("C:/wt/ok", {
          ...base,
          findDirs: () => ({ dirs: [], links: [], unknown: ["x: EPERM"] }),
        }).refused,
        /could not read/,
      );
    },
  );

  t(
    "MO12: report-only counts files (GB with sizes) and removes nothing; one failed tree does not stop the next",
    () => {
      const f = mk();
      try {
        const a = join(f.root, "a");
        const b = join(f.root, "b");
        put(join(a, "node_modules", "p", "i.js"), "x".repeat(1000));
        put(join(a, "node_modules", "p", "j.js"), "y".repeat(2000));
        put(join(b, "node_modules", "p", "i.js"), "z");
        const io = (log, extra = {}) => ({
          log: (m) => log.push(m),
          listWorktrees: () => [
            { path: a, locked: false },
            { path: b, locked: false },
          ],
          scanLinkTargets: (trees) => scanLinkTargets(trees),
          listProcessPaths: () => [],
          headMs: () => NOW - 100 * HOUR,
          indexMs: () => NOW - 100 * HOUR,
          now: () => NOW,
          freeGb: () => 5,
          ...extra,
        });
        const ctx = { repoRoot: f.root, mainCheckoutPath: join(f.root, "main") };
        const log = [];
        const report = runModulesOnly([a, b], ctx, { io: io(log) });
        assert.equal(report.trees, 2);
        assert.equal(report.files, 3, "the default report counts files, it does not stat them");
        assert.equal(report.bytes, 0);
        assert.ok(existsSync(join(a, "node_modules")) && existsSync(join(b, "node_modules")));
        assert.ok(
          log.some((l) => /would clear 1 node_modules dir\(s\), 2 files \(/.test(l)),
          JSON.stringify(log),
        );
        assert.ok(log.some((l) => /Report-only run/.test(l)));
        const logSized = [];
        const sized = runModulesOnly([a, b], ctx, { sizes: true, io: io(logSized) });
        assert.equal(sized.bytes, 3001);
        assert.ok(
          logSized.some((l) =>
            /would clear 1 node_modules dir\(s\), 2 files, \d+\.\d\d GB/.test(l),
          ),
          JSON.stringify(logSized),
        );
        const log2 = [];
        const applied = runModulesOnly([a, b], ctx, {
          apply: true,
          io: io(log2, {
            removeTree: (planned) => {
              if (planned.path === a) throw new Error("file in use");
              return removeModulesOnlyTree(planned, realOps);
            },
          }),
        });
        assert.equal(applied.failed.length, 1);
        assert.equal(applied.trees, 1);
        assert.ok(existsSync(join(a, "node_modules")), "the failed tree is left whole");
        assert.ok(!existsSync(join(b, "node_modules")), "the next tree was still cleared");
        assert.ok(
          log2.some((l) => /FAILED a: file in use/.test(l)),
          JSON.stringify(log2),
        );
      } finally {
        f.rm();
      }
    },
  );

  t(
    "MO13: a node_modules reached through a linked apps/ folder is refused by the containment guard",
    () => {
      const f = mk();
      try {
        const tree = join(f.root, "lane");
        const outside = join(f.root, "outside-apps");
        put(join(outside, "web", "node_modules", "keep.js"), "not yours");
        mkdirSync(tree, { recursive: true });
        symlinkSync(outside, join(tree, "apps"), "junction");
        const dirs = findModulesDirs(tree).dirs;
        assert.equal(dirs.length, 1);
        assert.throws(
          () => removeModulesOnlyTree({ path: tree, dirs }, realOps),
          /outside its own worktree/,
        );
        assert.equal(
          readFileSync(join(outside, "web", "node_modules", "keep.js"), "utf8"),
          "not yours",
        );
      } finally {
        f.rm();
      }
    },
  );

  // ---- review-a MEDIUM on #4049: the command-line match misses live trees; the rename probe closes it.
  t("MO14: a process is matched in Git Bash /c/... form, quoted or not, at a boundary", () => {
    const tree = "C:\\ClaudeCode\\wt\\u6";
    assert.ok(mentionsTree('bash -c "cd /c/ClaudeCode/wt/u6 && ls"', tree));
    assert.ok(mentionsTree("bash -c 'cd /c/claudecode/WT/u6/apps/api && npm test'", tree));
    assert.ok(mentionsTree("node /c/ClaudeCode/wt/u6/dist/main.js", tree));
    assert.ok(mentionsTree("sh /cygdrive/c/ClaudeCode/wt/u6/run.sh", tree));
    assert.ok(mentionsTree("C:/ClaudeCode/wt/u6/x.mjs", tree), "the drive:/ form still works");
    assert.ok(!mentionsTree("cd /c/ClaudeCode/wt/u60 && ls", tree), "a longer sibling name");
    assert.ok(!mentionsTree("cd /c/ClaudeCode/wt/u6-old && ls", tree));
    assert.ok(!mentionsTree("cd /d/ClaudeCode/wt/u6 && ls", tree), "another drive is another tree");
    assert.ok(!mentionsTree("cd /c/Users/admin", tree));
  });

  const rn = () => {
    const calls = [];
    return {
      calls,
      ok: (a, b) => calls.push(`${a} -> ${b}`),
      failBack: (a, b) => {
        calls.push(`${a} -> ${b}`);
        if (calls.length === 2) throw Object.assign(new Error("EPERM back"), { code: "EPERM" });
      },
      busy: (a, b) => {
        calls.push(`${a} -> ${b}`);
        throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
      },
    };
  };
  t("MO15: the rename probe renames beside the tree and back; EBUSY means in use", () => {
    const tree = resolve("C:/wt/lane-x");
    const probe = tree + PROBE_SUFFIX;
    assert.equal(PROBE_SUFFIX, ".janitor-probe", "a fixed, greppable name");
    assert.equal(probeNameFor(tree), probe);
    const free = rn();
    assert.equal(probeTreeInUse(tree, { rename: free.ok, exists: () => false }), null);
    assert.deepEqual(free.calls, [`${tree} -> ${probe}`, `${probe} -> ${tree}`]);
    const busy = rn();
    const why = probeTreeInUse(tree, { rename: busy.busy, exists: () => false });
    assert.match(why, /in use.*EBUSY/);
    assert.deepEqual(busy.calls, [`${tree} -> ${probe}`], "nothing moved, so nothing to move back");
    const left = rn();
    assert.match(probeTreeInUse(tree, { rename: left.ok, exists: () => true }), /leftover probe/);
    assert.deepEqual(left.calls, [], "an existing probe name is never renamed over");
  });
  t("MO16: a rename that cannot be moved back is a ProbeStuckError naming both paths", () => {
    const tree = resolve("C:/wt/lane-y");
    const r = rn();
    assert.throws(
      () => probeTreeInUse(tree, { rename: r.failBack, exists: () => false }),
      (e) =>
        e instanceof ProbeStuckError &&
        e.message.includes(tree) &&
        e.message.includes(tree + PROBE_SUFFIX) &&
        /EPERM/.test(e.message),
    );
  });
  t("MO17: leftover probe names are found beside listed and registered trees", () => {
    const f = mk();
    try {
      const a = join(f.root, "a");
      const b = join(f.root, "b");
      mkdirSync(a);
      mkdirSync(b + PROBE_SUFFIX);
      assert.deepEqual(leftoverProbes([a, b]), [b + PROBE_SUFFIX]);
      assert.deepEqual(leftoverProbes([a]), []);
    } finally {
      f.rm();
    }
  });
  t("MO18: a REAL free tree comes back whole under its own name, with no probe left", () => {
    const f = mk();
    try {
      const tree = join(f.root, "lane");
      put(join(tree, "node_modules", "p", "i.js"), "keep");
      put(join(tree, "src", "a.ts"), "src");
      assert.equal(probeTreeInUse(tree), null);
      assert.equal(readFileSync(join(tree, "node_modules", "p", "i.js"), "utf8"), "keep");
      assert.equal(readFileSync(join(tree, "src", "a.ts"), "utf8"), "src");
      assert.ok(!existsSync(tree + PROBE_SUFFIX));
    } finally {
      f.rm();
    }
  });
  // Real processes whose command line names nothing in the tree: only their cwd holds it. Windows
  // refuses the rename (EBUSY); POSIX lets it through (lsof covers cwds there), so these rows are
  // Windows-only and return early elsewhere.
  const holdsTree = (name, spawnIt) =>
    t(name, () => {
      if (process.platform !== "win32") return;
      const f = mk();
      let child;
      try {
        const tree = join(f.root, "lane");
        put(join(tree, "node_modules", "p", "i.js"), "keep");
        child = spawnIt(tree);
        // A child sets its cwd during its own start-up, after spawn returns. Probing inside that
        // window renames the folder out from under it (it then lands elsewhere), so let it settle
        // first: this row is about a process that has been running, not one still starting.
        Atomics.wait(sleeper, 0, 0, 1500);
        const why = probeTreeInUse(tree);
        assert.match(
          String(why),
          /in use/,
          `a process with its cwd in the tree must read as in use, got ${why}`,
        );
        assert.ok(existsSync(join(tree, "node_modules", "p", "i.js")), "tree still where it was");
        assert.ok(!existsSync(tree + PROBE_SUFFIX));
        child.kill();
        let freed = null;
        for (let i = 0; i < 100; i++) {
          freed = probeTreeInUse(tree);
          if (freed === null) break;
          Atomics.wait(sleeper, 0, 0, 50);
        }
        assert.equal(freed, null, "once the process is gone the tree is free again");
      } finally {
        try {
          child?.kill();
        } catch {
          /* already gone */
        }
        for (let i = 0; i < 100; i++) {
          try {
            f.rm();
            break;
          } catch {
            Atomics.wait(sleeper, 0, 0, 50);
          }
        }
      }
    });
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  holdsTree("MO19: a node process whose only tie is its cwd in the tree reads as in use", (tree) =>
    spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd: tree, stdio: "ignore" }),
  );
  holdsTree("MO20: an idle cmd whose cwd is in the tree reads as in use", (tree) =>
    spawn("cmd.exe", ["/k"], { cwd: tree, stdio: ["pipe", "ignore", "ignore"] }),
  );

  const runIo = (a, b, c, log, extra = {}) => ({
    log: (m) => log.push(m),
    listWorktrees: () => [a, b, c].filter(Boolean).map((p) => ({ path: p, locked: false })),
    scanLinkTargets: (trees) => scanLinkTargets(trees),
    listProcessPaths: () => [],
    headMs: () => NOW - 100 * HOUR,
    indexMs: () => NOW - 100 * HOUR,
    now: () => NOW,
    freeGb: () => 5,
    ...extra,
  });
  t("MO21: a tree the probe finds in use is refused untouched and the run moves on", () => {
    const f = mk();
    try {
      const a = join(f.root, "a");
      const b = join(f.root, "b");
      put(join(a, "node_modules", "p", "i.js"));
      put(join(b, "node_modules", "p", "i.js"));
      const log = [];
      const removed = [];
      const summary = runModulesOnly(
        [a, b],
        { repoRoot: f.root, mainCheckoutPath: join(f.root, "main") },
        {
          apply: true,
          io: runIo(a, b, null, log, {
            rename: (from, to) => {
              if (from === a)
                throw Object.assign(new Error("EBUSY: resource busy"), { code: "EBUSY" });
              renameSync(from, to);
            },
            removeTree: (planned) => {
              removed.push(planned.path);
              return removeModulesOnlyTree(planned, realOps);
            },
          }),
        },
      );
      assert.deepEqual(removed, [b], "the busy tree never reached the remover");
      assert.ok(existsSync(join(a, "node_modules", "p", "i.js")));
      assert.ok(!existsSync(join(b, "node_modules")));
      assert.equal(summary.refused.length, 1);
      assert.match(summary.refused[0].reason, /in use/);
      assert.equal(summary.stopped ?? null, null);
      assert.ok(
        log.some((l) => /REFUSED .*a: .*in use/.test(l)),
        JSON.stringify(log),
      );
    } finally {
      f.rm();
    }
  });
  t("MO22: a rename-back failure stops the WHOLE run, loudly, before any later tree", () => {
    const f = mk();
    try {
      const a = join(f.root, "a");
      const b = join(f.root, "b");
      const c = join(f.root, "c");
      for (const p of [a, b, c]) put(join(p, "node_modules", "p", "i.js"));
      const log = [];
      const removed = [];
      let backs = 0;
      const summary = runModulesOnly(
        [a, b, c],
        { repoRoot: f.root, mainCheckoutPath: join(f.root, "main") },
        {
          apply: true,
          io: runIo(a, b, c, log, {
            rename: (from, to) => {
              if (from === b + PROBE_SUFFIX) {
                backs++;
                throw Object.assign(new Error("EPERM: cannot move back"), { code: "EPERM" });
              }
              renameSync(from, to);
            },
            removeTree: (planned) => {
              removed.push(planned.path);
              return removeModulesOnlyTree(planned, realOps);
            },
          }),
        },
      );
      assert.equal(backs, 1);
      assert.deepEqual(removed, [a], "only the tree before the stuck one was cleared");
      assert.ok(existsSync(join(c, "node_modules", "p", "i.js")), "the later tree was not touched");
      assert.match(summary.stopped, /RUN STOPPED/);
      assert.match(summary.stopped, new RegExp(b.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")));
      assert.ok(
        log.some((l) => /RUN STOPPED/.test(l) && l.includes(b + PROBE_SUFFIX)),
        JSON.stringify(log),
      );
    } finally {
      // the stuck tree sits under its probe name in this fixture: put it back so the fixture can go
      try {
        renameSync(join(f.root, "b" + PROBE_SUFFIX), join(f.root, "b"));
      } catch {
        /* already home */
      }
      f.rm();
    }
  });
  t("MO23: a leftover probe name stops an --apply run before it changes anything", () => {
    const f = mk();
    try {
      const a = join(f.root, "a");
      put(join(a, "node_modules", "p", "i.js"));
      mkdirSync(join(f.root, "dead" + PROBE_SUFFIX));
      const log = [];
      const removed = [];
      const io = runIo(a, null, null, log, {
        removeTree: (planned) => (removed.push(planned.path), 1),
      });
      io.listWorktrees = () => [
        { path: a, locked: false },
        { path: join(f.root, "dead"), locked: false },
      ];
      const ctx = { repoRoot: f.root, mainCheckoutPath: join(f.root, "main") };
      const applied = runModulesOnly([a], ctx, { apply: true, io });
      assert.deepEqual(removed, [], "nothing is cleared while a probe name is unexplained");
      assert.match(applied.stopped, /leftover/i);
      assert.ok(
        log.some((l) => /LEFTOVER/.test(l) && l.includes("dead" + PROBE_SUFFIX)),
        JSON.stringify(log),
      );
      const reportLog = [];
      const report = runModulesOnly([a], ctx, {
        io: { ...io, log: (m) => reportLog.push(m) },
      });
      assert.equal(report.trees, 1, "report-only still reports");
      assert.ok(reportLog.some((l) => /LEFTOVER/.test(l)));
    } finally {
      f.rm();
    }
  });
  t(
    "MO24: whole-tree removal probes first: in use is refused, a stuck rename stops applyActions",
    () => {
      const calls = [];
      const deps = (probe) => ({
        refuseDelete: () => null,
        isDirty: () => false,
        removeTree: () => {},
        removeWorktree: (x) => calls.push(`removeWorktree ${x}`),
        removeWorktreePlain: (x) => calls.push(`removeWorktreePlain ${x}`),
        probeTree: probe,
        run: () => {},
        log: (m) => calls.push(`log ${m}`),
      });
      const tree = { kind: "worktree", target: "/w/lane", worktreePath: "/w/lane", plain: true };
      assert.equal(
        execute(
          tree,
          deps(() => "in use (EBUSY)"),
        ),
        "refused",
      );
      assert.ok(!calls.some((c) => c.startsWith("removeWorktree")), JSON.stringify(calls));
      assert.ok(calls.some((c) => /REFUSED.*in use/.test(c)));
      calls.length = 0;
      assert.equal(
        execute(
          tree,
          deps(() => null),
        ),
        "done",
      );
      assert.deepEqual(
        calls.filter((c) => c.startsWith("remove")),
        ["removeWorktreePlain /w/lane"],
      );
      calls.length = 0;
      execute(
        { ...tree, plain: false },
        deps(() => "in use"),
      );
      assert.ok(!calls.some((c) => c.startsWith("removeWorktree")), "the forced path probes too");
      const log = [];
      const ran = [];
      const out = applyActions(
        [tree, { ...tree, target: "/w/two" }, { ...tree, target: "/w/three" }],
        Infinity,
        {
          getFreeSpaceGb: () => 1,
          log: (m) => log.push(m),
          execute: (a) => {
            ran.push(a.target);
            if (a.target === "/w/two")
              throw new ProbeStuckError("tree /w/two is now at /w/two.probe");
            return "done";
          },
        },
      );
      assert.deepEqual(ran, ["/w/lane", "/w/two"], "nothing runs after a stuck rename");
      assert.match(out.stopped, /RUN STOPPED/);
      assert.ok(log.some((l) => /RUN STOPPED/.test(l)));
      assert.equal(out.failed.length, 1);
      assert.equal(typeof EXECUTE_DEPS.probeTree, "function", "the real deps carry the probe");
      const src = readFileSync(fileURLToPath(new URL("./janitor.mjs", import.meta.url)), "utf8");
      const at = (s) => src.indexOf(s);
      const body = src.slice(at("export function execute("));
      const order = [
        "deps.processUse",
        "deps.probeTree",
        "deps.salvage(a)",
        "deps.removeWorktreePlain(a.target)",
      ].map((s) => body.indexOf(s));
      assert.ok(
        order.every((i) => i > 0),
        JSON.stringify(order),
      );
      assert.deepEqual(
        order,
        [...order].sort((x, y) => x - y),
        "execute checks processes, then probes, before it salvages or removes anything",
      );
    },
  );

  // review-a on #4049: plain --paths --apply had no process check; a cwd-held tree was emptied
  // while FAILED printed. The checks now run before ANYTHING under the tree is touched.
  t("MO26: a live process refuses whole-tree removal before salvage, unlink or remove", () => {
    const calls = [];
    const deps = (procs) => ({
      refuseDelete: () => null,
      isDirty: () => false,
      isDirtyAllowList: () => false,
      salvage: () => (calls.push("salvage"), { ok: true }),
      removeTree: () => calls.push("removeTree"),
      removeWorktree: () => calls.push("removeWorktree"),
      removeWorktreePlain: () => calls.push("removeWorktreePlain"),
      processUse: (x) => processUseRefusal(procs, x),
      probeTree: () => (calls.push("probe"), null),
      run: () => {},
      log: (m) => calls.push(`log ${m}`),
    });
    const tree = "C:\\wt\\lane";
    const a = {
      kind: "worktree",
      target: tree,
      worktreePath: tree,
      plain: true,
      allowListed: true,
      salvage: ["local-assets/"],
    };
    assert.equal(execute(a, deps(["node C:\\wt\\lane\\dist\\main.js"])), "refused");
    assert.equal(execute(a, deps(["bash -c 'cd /c/wt/lane && npm test'"])), "refused");
    assert.equal(execute(a, deps(null)), "refused", "an unreadable process list refuses");
    assert.ok(
      !calls.some((c) => /^(salvage|probe|removeTree|removeWorktree)/.test(c)),
      JSON.stringify(calls),
    );
    assert.ok(
      calls.some((c) => /REFUSED.*(process|unreadable)/.test(c)),
      JSON.stringify(calls),
    );
    calls.length = 0;
    assert.equal(execute(a, deps(["node C:\\wt\\lane2\\x.js"])), "done");
    assert.deepEqual(
      calls.filter((c) => !c.startsWith("log")),
      ["probe", "salvage", "removeWorktreePlain"],
    );
  });
  t(
    "MO27: processUseRefusal names the process, refuses on an unreadable list, passes a free tree",
    () => {
      assert.match(processUseRefusal(["node C:/wt/lane/a.mjs"], "C:\\wt\\lane"), /running process/);
      assert.match(processUseRefusal(null, "C:\\wt\\lane"), /process list could not be read/);
      assert.equal(processUseRefusal(["node C:\\wt\\lane-old\\a.mjs", ""], "C:\\wt\\lane"), null);
      assert.equal(processUseRefusal([], "C:\\wt\\lane"), null);
      assert.equal(typeof EXECUTE_DEPS.processUse, "function", "the real deps carry the check");
    },
  );
  t(
    "MO28: a REAL tree held only by a cwd is left COMPLETE by a whole-tree removal (Windows)",
    () => {
      if (process.platform !== "win32") return;
      const f = mk();
      let child;
      try {
        const tree = join(f.root, "lane");
        put(join(tree, "src", "a.ts"), "keep-a");
        put(join(tree, "node_modules", "p", "i.js"), "keep-i");
        child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
          cwd: tree,
          stdio: "ignore",
        });
        Atomics.wait(sleeper, 0, 0, 1500);
        const wipes = [];
        const out = execute(
          { kind: "worktree", target: tree, worktreePath: tree, plain: true },
          {
            refuseDelete: () => null,
            isDirty: () => false,
            processUse: () => null, // the command line names nothing in the tree
            probeTree: (x) => probeTreeInUse(x),
            // what a failing `git worktree remove` does today: empties files, then reports FAILED
            removeWorktreePlain: (x) => {
              wipes.push(x);
              rmSync(join(x, "src"), { recursive: true, force: true });
              rmSync(join(x, "node_modules"), { recursive: true, force: true });
            },
            removeWorktree: () => assert.fail("never forced"),
            removeTree: () => {},
            run: () => {},
            log: () => {},
          },
        );
        assert.equal(out, "refused");
        assert.deepEqual(wipes, [], "nothing was removed");
        assert.equal(readFileSync(join(tree, "src", "a.ts"), "utf8"), "keep-a");
        assert.equal(readFileSync(join(tree, "node_modules", "p", "i.js"), "utf8"), "keep-i");
      } finally {
        try {
          child?.kill();
        } catch {
          /* already gone */
        }
        for (let i = 0; i < 100; i++) {
          try {
            f.rm();
            break;
          } catch {
            Atomics.wait(sleeper, 0, 0, 50);
          }
        }
      }
    },
  );
  t("MO29: a node_modules clear on a listed tree is process-checked and probed too", () => {
    const calls = [];
    const deps = (use, probe) => ({
      refuseDelete: () => null,
      isDirty: () => false,
      removeTree: (x) => calls.push(`removeTree ${x}`),
      processUse: () => use,
      probeTree: () => probe,
      run: () => {},
      log: () => {},
    });
    const a = {
      kind: "node_modules",
      target: "C:\\wt\\lane\\node_modules",
      worktreePath: "C:\\wt\\lane",
    };
    assert.equal(execute(a, deps("a running process uses it", null)), "refused");
    assert.equal(execute(a, deps(null, "in use: it cannot be renamed (EBUSY)")), "refused");
    assert.deepEqual(calls, []);
    assert.equal(execute(a, deps(null, null)), "done");
    assert.deepEqual(calls, ["removeTree C:\\wt\\lane\\node_modules"]);
  });
  t("MO25: the planner refuses the main checkout and a locked tree itself", () => {
    const worktrees = [
      { path: "C:/wt/main", locked: false },
      { path: "C:/wt/held", locked: true },
    ];
    const ops = {
      worktrees,
      linkScan: { links: [], unknown: {} },
      procPaths: [],
      headMs: () => NOW - 100 * HOUR,
      indexMs: () => NOW - 100 * HOUR,
      findDirs: () => ({ dirs: ["x"], links: [], unknown: [] }),
      nowMs: NOW,
    };
    assert.match(
      planModulesOnlyTree("C:/wt/main", "C:/wt/main", ops, true).refused,
      /main checkout/,
    );
    assert.match(planModulesOnlyTree("C:/wt/held", "C:/wt/main", ops, true).refused, /locked/);
  });
}

console.log(`janitor self-test: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error(`  FAIL ${f}`);
  process.exit(1);
}
