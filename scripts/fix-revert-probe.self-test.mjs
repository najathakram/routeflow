#!/usr/bin/env node
// Self-test for scripts/fix-revert-probe.mjs (R4, dark). Plain node; exit 0 when every check passes.
// Each case plants a throwaway repo with a fix branch and runs the probe in it: it must say repro /
// not-repro / broken / skipped, hold its worktree locked while running, and leave none behind.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scrubbedGitEnv } from "./lib/check-git-hooks.mjs";
import {
  PROBE_MODE,
  classifyChanged,
  isFixBranch,
  jestCommand,
  restoreFix,
  runProbe,
} from "./fix-revert-probe.mjs";

const PROBE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fix-revert-probe.mjs");
let passed = 0;
let failed = 0;
const check = (name, got, want) => {
  const same = JSON.stringify(got) === JSON.stringify(want);
  const detail = same ? "" : ` got ${JSON.stringify(got)} want ${JSON.stringify(want)}`;
  console.log(`${same ? "  ok  " : "  FAIL"} ${name}${detail}`);
  if (same) passed += 1;
  else failed += 1;
};
delete process.env.DATABASE_URL;

const sh = (dir, ...a) => {
  const id = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"];
  const r = spawnSync("git", [...id, "-c", "core.hooksPath=", ...a], {
    cwd: dir,
    encoding: "utf8",
    env: scrubbedGitEnv(),
  });
  if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
/** Throwaway repo on master holding `files`; its own toplevel is proven before the first write. */
function plant(files) {
  const dir = realpathSync.native(mkdtempSync(path.join(tmpdir(), "rf-pst-")));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  const write = (rel, text) => {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  };
  const commit = (msg) => (sh(dir, "add", "."), sh(dir, "commit", "-q", "-m", msg));
  try {
    sh(dir, "init", "-q", "-b", "master");
    if (
      sh(dir, "rev-parse", "--show-toplevel").toLowerCase() !==
      dir.replace(/\\/g, "/").toLowerCase()
    )
      throw new Error(`planted repo is not its own toplevel (GIT_* leaked): ${dir}`);
    for (const [rel, text] of Object.entries(files)) write(rel, text);
    commit("init");
  } catch (e) {
    cleanup();
    throw e;
  }
  return { dir, write, commit, git: (...a) => sh(dir, ...a), cleanup };
}

const mod = (v) => `export const f = () => ${v};\n`;
const test = (cond, mjs = "a") =>
  `import { f } from "./${mjs}.mjs";\nif (!(${cond})) { console.error("red"); process.exit(1); }\n`;
/** master has src/<mjs>.mjs returning 1; branch `branch` returns 2 and adds the test files. */
function plantFix(branch, tests, { mjs = "a", subject = "fix: f returns 2" } = {}) {
  const repo = plant({ [`src/${mjs}.mjs`]: mod(1) });
  repo.git("checkout", "-q", "-b", branch);
  repo.write(`src/${mjs}.mjs`, mod(2));
  for (const [rel, text] of Object.entries(tests)) repo.write(rel, text);
  repo.commit(subject);
  return repo;
}
const T = "src/a.self-test.mjs";
const probe = (repo, opts = {}) => runProbe({ cwd: repo.dir, base: "master", ...opts });
const worktrees = (repo) => repo.git("worktree", "list").split("\n").length;
const node = (file, root) => ({
  status: spawnSync(process.execPath, [file], { cwd: root, env: scrubbedGitEnv() }).status,
});

check("mode is dark", PROBE_MODE, "dark");
check("isFixBranch", ["fix/x", "bug/y", "feat/x", "hotfix/z"].map(isFixBranch), [
  true,
  true,
  false,
  false,
]);
const changed = [
  { status: "M", path: "src/a.mjs" },
  { status: "A", path: T },
  { status: "M", path: "docs/x.md" },
  { status: "D", path: "src/old.spec.ts" },
];
check(
  "classifyChanged: tests vs fix set; docs, green paths, deleted tests dropped",
  [classifyChanged(changed).tests, classifyChanged(changed).fix.map((x) => x.path)],
  [[T], ["src/a.mjs"]],
);

// P1 / P2 / P3: the three verdicts, one fix branch each; the probe leaves no worktree behind.
for (const [cond, want] of [
  ["f() === 2", "repro"],
  ["typeof f() === 'number'", "not-repro"],
  ["f() === 3", "broken"],
]) {
  const repo = plantFix("fix/x", { [T]: test(cond) });
  try {
    check(
      `${want}, no worktree left`,
      [(await probe(repo)).results[0].verdict, worktrees(repo)],
      [want, 1],
    );
  } finally {
    repo.cleanup();
  }
}

// CLI: a fix branch prints a text table (dark exit 0); a feat branch is not probed.
for (const [branch, subject, want] of [
  ["fix/x", "fix: f returns 2", /^repro +src\/a\.self-test\.mjs/m],
  ["feat/x", "feat: f returns 2", /not a fix branch/],
]) {
  const repo = plantFix(branch, { [T]: test("f() === 2") }, { subject });
  try {
    const r = spawnSync(process.execPath, [PROBE, "--base", "master"], {
      cwd: repo.dir,
      encoding: "utf8",
      env: scrubbedGitEnv(),
    });
    check(`CLI ${branch}`, [r.status, want.test(r.stdout)], [0, true]);
  } finally {
    repo.cleanup();
  }
}

// A DB spec without DATABASE_URL is skipped with the reason; a throwing runner still removes the worktree
// and keeps the caller's node_modules.
{
  const repo = plantFix("fix/x", { "apps/api/src/b.db.spec.ts": "it('x', () => {});\n" });
  try {
    const r = (await probe(repo)).results[0];
    check(
      "db spec skipped with reason",
      [r.verdict, /DATABASE_URL/.test(r.reason)],
      ["skipped", true],
    );
    repo.write("node_modules/marker.txt", "keep\n");
    const boom = () => {
      throw new Error("runner boom");
    };
    const threw = await probe(repo, { run: boom }).then(
      () => "",
      (e) => String(e),
    );
    check(
      "throwing runner propagates, leaves no worktree",
      [/runner boom/.test(threw), worktrees(repo)],
      [true, 1],
    );
    check(
      "caller node_modules marker survives",
      existsSync(path.join(repo.dir, "node_modules", "marker.txt")),
      true,
    );
  } finally {
    repo.cleanup();
  }
}

// A non-ASCII, literal-glob fix path restores (name-status -z, literal pathspecs); the worktree is locked
// while tests run; HEAD and revert runs both happen inside the temp worktree.
{
  const repo = plantFix("fix/x", { [T]: test("f() === 2", "[é]") }, { mjs: "[é]" });
  try {
    const seen = [];
    const run = (file, root) => {
      const locked = /locked rf-probe/.test(repo.git("worktree", "list", "--porcelain"));
      seen.push([root !== repo.dir, locked]);
      return node(file, root);
    };
    check(
      "non-ASCII [glob] fix path is restored: repro",
      (await probe(repo, { run })).results[0].verdict,
      "repro",
    );
    check("both runs inside the locked temp worktree", seen, [
      [true, true],
      [true, true],
    ]);
    check("lock released, worktree gone", worktrees(repo), 1);
  } finally {
    repo.cleanup();
  }
}

// A failed restore is skipped with git's stderr, never graded against HEAD; a HEAD timeout is skipped.
{
  const repo = plantFix("fix/x", { [T]: test("f() === 2") });
  try {
    const bad = restoreFix(repo.dir, "0".repeat(40), ["src/a.mjs"]);
    check("restoreFix with a bad ref fails with stderr", [bad.ok, !!bad.stderr], [false, true]);
    const restore = () => ({ ok: false, stderr: "pathspec boom" });
    const r = (await probe(repo, { run: () => ({ status: 0 }), restore })).results[0];
    check(
      "failed restore is skipped with the reason",
      [r.verdict, r.reason],
      ["skipped", "could not restore the fix set: pathspec boom"],
    );
    const t = (await probe(repo, { run: () => ({ status: null }) })).results[0];
    check("HEAD timeout is skipped, not broken", t.verdict, "skipped");
  } finally {
    repo.cleanup();
  }
}

// A fix: commit that arrived through a merge is not this branch's own work.
{
  const repo = plant({ "src/a.mjs": mod(1) });
  try {
    repo.git("checkout", "-q", "-b", "other");
    repo.write("src/o.txt", "o\n");
    repo.commit("fix: someone else");
    repo.git("checkout", "-q", "-b", "feat/x", "master");
    repo.write(T, test("f() === 1"));
    repo.commit("feat: own work");
    repo.git("merge", "-q", "--no-ff", "-m", "merge other", "other");
    check("merged-in fix: commit is not a fix branch", (await probe(repo)).notFix, true);
  } finally {
    repo.cleanup();
  }
}

// Jest command (built, never run): apps/api keeps its package.json config; the new workspaces resolve.
{
  const cmd = (f) => jestCommand(f, { root: "/r", jestBin: "/j/jest/bin/jest" });
  const c = cmd("apps/api/src/x.spec.ts");
  check(
    "jest command for apps/api",
    [c.args.slice(1, 3), c.args.at(-1), c.cwd.replace(/\\/g, "/")],
    [["--config", "package.json"], "src/x.spec.ts", "/r/apps/api"],
  );
  check(
    "packages/returns and packages/scanning have runners; unknown has none",
    ["packages/returns/a.spec.ts", "packages/scanning/a.spec.ts", "tools/x.spec.ts"].map(
      (f) => cmd(f)?.args[2] ?? null,
    ),
    ["jest.config.js", "jest.config.js", null],
  );
}

console.log(`fix-revert-probe self-test: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
