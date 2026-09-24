#!/usr/bin/env node
// Self-test for janitor.mjs's classification logic. Pure fixtures, plus (B800)
// throwaway git repos under the OS temp dir for the merge check — never the
// RouteFlow repo, a real worktree, Docker, or the npm cache; nothing here
// deletes anything real.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
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
  safeRemoveTree,
  resolveRepoContext,
  deleteRefusal,
  refuseDelete,
  removeWorktreeSafely,
  windowsRemoveTree,
  psLiteral,
  dirtyFromStatus,
  orphanEligible,
  branchTip,
  execute,
  CMD_UNSAFE,
  unlinkLinksWithin,
} from "./janitor.mjs";

// Run inside a git hook, GIT_DIR / GIT_INDEX_FILE / GIT_WORK_TREE would point every `git -C <tmp>`
// below at the REAL repo. Scrub them before any git call (the janitor inherits this env).
for (const k of Object.keys(process.env)) if (k.startsWith("GIT_")) delete process.env[k];
// ...and ignore the machine's global/system git config, so commit signing, a global hooks path or
// a template-dir commit-msg hook can never make the throwaway-repo commits below fail.
const emptyGitConfig = join(mkdtempSync(join(tmpdir(), "janitor-gitcfg-")), "config");
writeFileSync(emptyGitConfig, "");
process.env.GIT_CONFIG_GLOBAL = emptyGitConfig;
process.env.GIT_CONFIG_NOSYSTEM = "1";

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

console.log(`janitor self-test: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error(`  FAIL ${f}`);
  process.exit(1);
}
