#!/usr/bin/env node
// Self-test for scripts/lib/check-git-hooks.mjs (B642). Real temp git repos, no network, no jest.
// Wired into `npm run verify`. Exit 0 when every check passes, 1 otherwise.
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import * as nodeFs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkGitHooks,
  ensureGitHooks,
  hooksDirFor,
  isCi,
  scrubbedGitEnv,
} from "./lib/check-git-hooks.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failed = 0;
const ok = (name, cond, detail = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${name}${cond ? "" : ` ${detail}`}`);
  if (!cond) failed += 1;
};
// HERMETIC: every git call here scrubs GIT_* (a pre-push hook exports GIT_DIR/GIT_WORK_TREE, and
// without this these fixture commands ran against the REAL repository: B420).
const sh = (cwd, ...args) =>
  execFileSync("git", args, { cwd, stdio: "pipe", encoding: "utf8", env: scrubbedGitEnv() });
const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "check-git-hooks-")));
const repo = (name) => {
  const dir = path.join(tmp, name);
  mkdirSync(dir, { recursive: true });
  sh(dir, "init", "-q");
  // canary: refuse to touch anything unless git really is operating on the fixture
  if (!realpathSync(sh(dir, "rev-parse", "--absolute-git-dir").trim()).startsWith(tmp)) {
    throw new Error(`fixture git dir escaped the temp directory: ${dir}`);
  }
  sh(dir, "config", "user.email", "t@example.test");
  sh(dir, "config", "user.name", "t");
  writeFileSync(path.join(dir, "f.txt"), "x");
  sh(dir, "add", ".");
  sh(dir, "commit", "-q", "-m", "init");
  return dir;
};
const withHook = (dir, rel) => {
  mkdirSync(path.join(dir, rel), { recursive: true });
  writeFileSync(path.join(dir, rel, "pre-push"), "#!/bin/sh\nexit 0\n");
  chmodSync(path.join(dir, rel, "pre-push"), 0o755); // git ignores a non-executable hook
};
const run = (cwd, env = {}) => checkGitHooks({ cwd, env });
const check = (cwd) => checkGitHooks({ cwd, env: {} });

try {
  // T1 — the incident: a relative hooksPath whose directory does not exist FAILS.
  const a = repo("missing-dir");
  sh(a, "config", "core.hooksPath", ".husky/_");
  let r = run(a);
  ok(
    "T1 hooksPath -> missing dir FAILS (1)",
    r.status === 1 &&
      /NOT INSTALLED/.test(r.message) &&
      /ensure-git-hooks.mjs/.test(r.message) &&
      !/npx husky/.test(r.message),
    JSON.stringify(r),
  );
  ok(
    "T1b a missing .husky/_ names the likely cause: a branch that predates the tracked hooks",
    /predates the tracked \.husky\/_/.test(r.message) && /merge master/.test(r.message),
    r.message,
  );
  const aOther = repo("missing-other-dir");
  sh(aOther, "config", "core.hooksPath", ".githooks");
  ok(
    "T1c a missing hooks dir that is not .husky/_ gets no older-branch note",
    !/predates/.test(run(aOther).message),
  );

  // T2 — the directory present with a pre-push hook PASSES.
  withHook(a, ".husky/_");
  r = run(a);
  ok(
    "T2 hooksPath -> dir with pre-push PASSES (0)",
    r.status === 0 && !r.skipped,
    JSON.stringify(r),
  );

  // T3 — directory present but no pre-push hook FAILS.
  const b = repo("no-pre-push");
  mkdirSync(path.join(b, ".husky/_"), { recursive: true });
  sh(b, "config", "core.hooksPath", ".husky/_");
  r = run(b);
  ok(
    "T3 dir exists but no pre-push FAILS (1)",
    r.status === 1 && /no pre-push/.test(r.message),
    JSON.stringify(r),
  );

  // T4 — hooksPath unset: the default .git/hooks must hold a pre-push.
  const c = repo("unset");
  r = run(c);
  ok("T4a hooksPath unset, no pre-push in .git/hooks FAILS (1)", r.status === 1, JSON.stringify(r));
  writeFileSync(path.join(c, ".git/hooks/pre-push"), "#!/bin/sh\nexit 0\n");
  chmodSync(path.join(c, ".git/hooks/pre-push"), 0o755);
  r = run(c);
  ok("T4b hooksPath unset, pre-push present PASSES (0)", r.status === 0, JSON.stringify(r));

  // T5 — absolute POSIX hooksPath: missing fails, present passes.
  const d = repo("absolute");
  const abs = path.join(tmp, "elsewhere-hooks");
  sh(d, "config", "core.hooksPath", abs);
  r = run(d);
  ok("T5a absolute hooksPath, missing FAILS (1)", r.status === 1, JSON.stringify(r));
  withHook(tmp, "elsewhere-hooks");
  r = run(d);
  ok("T5b absolute hooksPath, present PASSES (0)", r.status === 0, JSON.stringify(r));

  // T6 — path flavours resolve as git resolves them (pure function, no fs).
  ok(
    "T6a relative resolves against the work-tree top",
    hooksDirFor(".husky/_", "/w/tree", "") === path.resolve("/w/tree", ".husky/_"),
  );
  ok(
    "T6b a Windows drive path is absolute (used as written)",
    hooksDirFor("C:\\hooks\\h", "/w/tree", "") === "C:\\hooks\\h",
  );
  ok(
    "T6c a UNC path is absolute",
    hooksDirFor("\\\\srv\\share\\h", "/w/tree", "") === "\\\\srv\\share\\h",
  );
  ok(
    "T6d ~/ expands to the home directory",
    hooksDirFor("~/h", "/w/tree", "", "/home/u") === path.join("/home/u", "h"),
  );
  ok(
    "T6e unset falls back to git's default hooks path",
    hooksDirFor(undefined, "/w/tree", ".git/hooks") === path.resolve("/w/tree", ".git/hooks"),
  );

  // T7 — the EXACT incident: the main checkout has .husky/_, a linked worktree does not.
  const main = repo("main-checkout");
  sh(main, "config", "core.hooksPath", ".husky/_");
  withHook(main, ".husky/_");
  const wt = path.join(tmp, "linked-worktree");
  sh(main, "worktree", "add", "-q", "-b", "lane", wt);
  ok("T7a the main checkout PASSES (0)", run(main).status === 0);
  r = run(wt);
  ok(
    "T7b a linked worktree missing .husky/_ FAILS (1) while the main checkout passes",
    r.status === 1 && r.message.includes(path.join(wt, ".husky", "_")),
    JSON.stringify(r),
  );

  // T8 — fail CLOSED inside a work tree when git cannot answer.
  const failing = (over) => (_cwd, args) => {
    const key = args.join(" ");
    if (over[key]) return over[key];
    return {
      status: 0,
      stdout: key.includes("is-inside") ? "true" : key.includes("show-toplevel") ? "/w" : "",
    };
  };
  r = checkGitHooks({
    cwd: "/w",
    env: {},
    git: failing({ "config --get core.hooksPath": { status: 128, stdout: "" } }),
  });
  ok(
    "T8a config unreadable (exit 128) inside a work tree exits 2",
    r.status === 2,
    JSON.stringify(r),
  );
  r = checkGitHooks({
    cwd: "/w",
    env: {},
    git: failing({ "rev-parse --show-toplevel": { status: 128, stdout: "" } }),
  });
  ok("T8b toplevel unresolvable inside a work tree exits 2", r.status === 2, JSON.stringify(r));

  // T9 — NOT a work tree (a tarball / Docker context) or git absent: SKIP, never fail.
  const plain = path.join(tmp, "not-a-repo");
  mkdirSync(plain);
  r = run(plain);
  ok(
    "T9a a directory that is not a git work tree is SKIPPED with a note (0)",
    r.status === 0 && r.skipped === true && /skipped/.test(r.message),
    JSON.stringify(r),
  );
  r = checkGitHooks({ cwd: plain, env: {}, git: () => ({ status: -1, stdout: "" }) });
  ok(
    "T9b git not installed is SKIPPED (0), not a failure",
    r.status === 0 && r.skipped === true,
    JSON.stringify(r),
  );

  // T10 — CI is its own authority: passes even with hooks missing, printed.
  const e = repo("ci");
  sh(e, "config", "core.hooksPath", ".husky/_");
  r = run(e, { CI: "true" });
  ok(
    "T10a CI set passes with a note (0)",
    r.status === 0 && /CI is the authority/.test(r.message),
    JSON.stringify(r),
  );
  ok("T10b the same tree FAILS without CI (1)", run(e).status === 1);

  // T11 — the session-start mode (--warn): read-only, NEVER fails, silent when healthy.
  const cli = (cwd, args, env = {}) =>
    spawnSync(process.execPath, [path.join(ROOT, "scripts/check-git-hooks.mjs"), ...args], {
      cwd,
      encoding: "utf8",
      env: { ...scrubbedGitEnv(), CI: "", ...env },
    });
  const silent = (o) => o.status === 0 && o.stdout === "" && o.stderr === "";
  let o = cli(a, ["--warn"]);
  ok("T11a --warn on a healthy tree: exit 0 and completely silent", silent(o), JSON.stringify(o));
  o = cli(wt, ["--warn"]);
  ok(
    "T11b --warn on the hookless worktree: still exit 0, ONE stderr line naming the problem",
    o.status === 0 && /NOT INSTALLED/.test(o.stderr) && o.stderr.trim().split("\n").length === 1,
    JSON.stringify(o),
  );
  o = cli(wt, ["--warn"], { CI: "true" });
  ok("T11c --warn under CI: exit 0 and silent", silent(o), JSON.stringify(o));
  o = cli(plain, ["--warn"]);
  ok("T11d --warn outside a git work tree: exit 0 and silent", silent(o), JSON.stringify(o));
  o = cli(wt, []);
  ok(
    "T11e the plain CLI on the hookless worktree exits 1 (verify would stop)",
    o.status === 1,
    JSON.stringify(o),
  );

  // T10c — CI means TRUE only: "false", "0", "" and friends must NOT switch the guard off.
  for (const v of ["false", "FALSE", "0", "", " ", "no", "off"]) {
    r = run(e, { CI: v });
    ok(
      `T10c CI=${JSON.stringify(v)} is NOT CI: the hookless tree still FAILS (1)`,
      r.status === 1 && !isCi({ CI: v }),
      JSON.stringify(r),
    );
  }
  for (const v of ["1", "true", "TRUE", "True", "yes", "YES", " true "]) {
    ok(
      `T10d CI=${JSON.stringify(v)} IS CI: the guard skips`,
      isCi({ CI: v }) && run(e, { CI: v }).status === 0,
    );
  }
  ok("T10e CI unset is NOT CI", !isCi({}));

  // T13 — a present pre-push that is NOT executable is a hook git will ignore: FAILS on POSIX.
  const f = repo("exec-bit");
  sh(f, "config", "core.hooksPath", ".husky/_");
  withHook(f, ".husky/_");
  chmodSync(path.join(f, ".husky/_/pre-push"), 0o644);
  r = check(f);
  ok(
    "T13a pre-push present but chmod -x FAILS (1) with the distinct 'not executable' message",
    process.platform === "win32" ||
      (r.status === 1 && /NOT RUNNABLE/.test(r.message) && /not executable/.test(r.message)),
    JSON.stringify(r),
  );
  chmodSync(path.join(f, ".husky/_/pre-push"), 0o755);
  ok("T13b the same hook chmod +x PASSES (0)", check(f).status === 0);
  chmodSync(path.join(f, ".husky/_/pre-push"), 0o644);
  r = checkGitHooks({ cwd: f, env: {}, platform: "win32" });
  ok(
    "T13c on win32 the exec-bit half is skipped (0): there is no exec bit to check",
    r.status === 0,
    JSON.stringify(r),
  );
  r = checkGitHooks({ cwd: f, env: {}, platform: "linux" });
  ok(
    "T13d on linux the same non-executable hook FAILS (1)",
    r.status === 1 && /NOT RUNNABLE/.test(r.message),
    JSON.stringify(r),
  );

  // T11f — the pre-push shape (B420): GIT_DIR/GIT_WORK_TREE exported for ANOTHER repo (a throwaway
  // decoy, never a real one) must not hijack the answer about the directory the guard was asked about.
  const decoy = repo("decoy");
  const saved = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE };
  process.env.GIT_DIR = path.join(decoy, ".git");
  process.env.GIT_WORK_TREE = decoy;
  try {
    r = run(wt);
    ok(
      "T11f GIT_DIR/GIT_WORK_TREE exported for another repo do not hijack the answer (the worktree still FAILS)",
      r.status === 1 && r.message.includes(path.join(wt, ".husky", "_")),
      JSON.stringify(r),
    );
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  // T14 — a new worktree of a repo whose main checkout has hooks: ensureGitHooks copies them in,
  // never touches git config, leaves a tree that already has hooks alone, and fails when main has none.
  const ENSURE_CLI = path.join(ROOT, "scripts", "ensure-git-hooks.mjs");
  const cliEnv = { ...scrubbedGitEnv(), CI: "" };
  const mainWithHook = repo("t13-main");
  sh(mainWithHook, "config", "core.hooksPath", ".husky/_");
  withHook(mainWithHook, ".husky/_");
  writeFileSync(path.join(mainWithHook, ".husky/_/husky.sh"), "# helper\n");
  writeFileSync(path.join(mainWithHook, ".husky/_/commit-msg"), "# main commit-msg\n");
  const linked = path.join(tmp, "t13-linked");
  sh(mainWithHook, "worktree", "add", "-q", "-b", "t13", linked);
  ok("T14a the new tree has no hooks: checkGitHooks FAILS", check(linked).status === 1);
  const before = sh(linked, "config", "core.hooksPath").trim();
  let en = ensureGitHooks({ cwd: linked, env: {} });
  ok(
    "T14b ensureGitHooks copies and reports it",
    en.ok === true && en.copied === true,
    JSON.stringify(en),
  );
  ok("T14c checkGitHooks now PASSES in the new tree", check(linked).status === 0);
  ok(
    "T14d pre-push and helper files exist in the new tree",
    existsSync(path.join(linked, ".husky/_/pre-push")) &&
      existsSync(path.join(linked, ".husky/_/husky.sh")),
  );
  ok(
    "T14e git config core.hooksPath is unchanged",
    sh(linked, "config", "core.hooksPath").trim() === before &&
      sh(mainWithHook, "config", "core.hooksPath").trim() === before,
  );
  ok(
    "T14f the copied pre-push is executable (POSIX)",
    process.platform === "win32" ||
      (statSync(path.join(linked, ".husky/_/pre-push")).mode & 0o111) !== 0,
  );
  const prePush = path.join(linked, ".husky/_/pre-push");
  mkdirSync(path.dirname(prePush), { recursive: true });
  writeFileSync(prePush, "#!/bin/sh\n# local edit\nexit 0\n");
  chmodSync(prePush, 0o755);
  const stamp = statSync(prePush).mtimeMs;
  en = ensureGitHooks({ cwd: linked, env: {} });
  ok(
    "T14g a tree that already has hooks: copied false, files untouched",
    en.ok === true &&
      en.copied === false &&
      statSync(prePush).mtimeMs === stamp &&
      /local edit/.test(readFileSync(prePush, "utf8")),
    JSON.stringify(en),
  );

  const mainBare = repo("t13-main-nohook");
  sh(mainBare, "config", "core.hooksPath", ".husky/_");
  const linkedBare = path.join(tmp, "t13-linked-nohook");
  sh(mainBare, "worktree", "add", "-q", "-b", "t13b", linkedBare);
  en = ensureGitHooks({ cwd: linkedBare, env: {} });
  ok(
    "T14h main checkout without pre-push: ok false, nothing copied",
    en.ok === false && en.copied === false && !existsSync(path.join(linkedBare, ".husky/_")),
    JSON.stringify(en),
  );
  const ensureCli = (cwd) =>
    spawnSync(process.execPath, [ENSURE_CLI], { cwd, env: cliEnv, encoding: "utf8" });
  ok("T14i the CLI exits 1 when main has no pre-push", ensureCli(linkedBare).status === 1);
  ok("T14j the CLI exits 0 on a tree that has hooks", ensureCli(linked).status === 0);
  const linked2 = path.join(tmp, "t13-linked-2");
  sh(mainWithHook, "worktree", "add", "-q", "-b", "t13c", linked2);
  ok(
    "T14k the CLI copies the hooks into a hookless tree (exit 0)",
    ensureCli(linked2).status === 0 && check(linked2).status === 0,
  );
  const linked3 = path.join(tmp, "t13-linked-3");
  sh(mainWithHook, "worktree", "add", "-q", "-b", "t13d", linked3);
  en = ensureGitHooks({ cwd: linked3, env: { CI: "true" } });
  ok(
    "T14l CI on a HOOKLESS tree: ok with a note, nothing copied",
    en.ok === true && en.copied === false && !existsSync(path.join(linked3, ".husky/_/pre-push")),
    JSON.stringify(en),
  );
  en = ensureGitHooks({ cwd: tmp, env: {} });
  ok(
    "T14m a non-checkout: ok with a note",
    en.ok === true && en.copied === false,
    JSON.stringify(en),
  );

  // T14n-q — review folds: non-executable pre-push, custom hooks kept, the .git basename guard.
  const nonExec = path.join(tmp, "t14n-linked");
  sh(mainWithHook, "worktree", "add", "-q", "-b", "t14n", nonExec);
  withHook(nonExec, ".husky/_");
  const pp = path.join(nonExec, ".husky/_/pre-push");
  const chmods = [];
  let mode = 0o644;
  const fakeFs = {
    ...nodeFs,
    statSync: (p) => (p === pp ? { mode } : nodeFs.statSync(p)),
    chmodSync: (p, m) => (chmods.push(p), (mode = m)),
  };
  en = ensureGitHooks({ cwd: nonExec, env: {}, fs: fakeFs, platform: "linux" });
  ok(
    "T14n a present but non-executable pre-push (POSIX) is chmod-ed, not reported as already fine",
    en.ok === true && chmods.length === 1 && chmods[0] === pp && mode === 0o755,
    JSON.stringify([en, chmods, mode]),
  );
  mode = 0o644;
  chmods.length = 0;
  en = ensureGitHooks({ cwd: nonExec, env: {}, fs: fakeFs, platform: "win32" });
  ok("T14n2 on win32 there is no exec bit to fix", en.ok === true && chmods.length === 0);
  const posixTree = path.join(tmp, "t14o-linked");
  sh(mainWithHook, "worktree", "add", "-q", "-b", "t14o", posixTree);
  withHook(posixTree, ".husky/_");
  if (process.platform !== "win32") chmodSync(path.join(posixTree, ".husky/_/pre-push"), 0o644);
  ensureGitHooks({ cwd: posixTree, env: {} });
  ok(
    "T14o (POSIX only; passes trivially on win32) ensure leaves a runnable pre-push",
    process.platform === "win32" || check(posixTree).status === 0,
  );
  const custom = path.join(tmp, "t14p-linked");
  sh(mainWithHook, "worktree", "add", "-q", "-b", "t14p", custom);
  mkdirSync(path.join(custom, ".husky/_"), { recursive: true });
  writeFileSync(path.join(custom, ".husky/_/commit-msg"), "# custom commit-msg\n");
  en = ensureGitHooks({ cwd: custom, env: {} });
  ok(
    "T14p a custom commit-msg survives ensure; the missing pre-push is copied in",
    en.ok === true &&
      /custom commit-msg/.test(readFileSync(path.join(custom, ".husky/_/commit-msg"), "utf8")) &&
      existsSync(path.join(custom, ".husky/_/pre-push")),
    JSON.stringify(en),
  );
  const bare = path.join(tmp, "t14q-main.git");
  sh(tmp, "clone", "-q", "--bare", mainWithHook, bare);
  const bareLinked = path.join(tmp, "t14q-linked");
  sh(bare, "worktree", "add", "-q", "-b", "t14q", bareLinked);
  en = ensureGitHooks({ cwd: bareLinked, env: {} });
  ok(
    "T14q a common dir that is not named .git (a bare main): refused, nothing copied",
    en.ok === false && en.copied === false && /cannot locate the main checkout/.test(en.message),
    JSON.stringify(en),
  );

  // T14r-s — review folds: chmod only this tree's own hooks dir; helpers refreshed, hooks never overwritten.
  const shared = repo("t14r-main");
  withHook(shared, "shared/_");
  sh(shared, "config", "core.hooksPath", path.join(shared, "shared/_").replaceAll("\\", "/"));
  const sharedLinked = path.join(tmp, "t14r-linked");
  sh(shared, "worktree", "add", "-q", "-b", "t14r", sharedLinked);
  const sharedPp = path.resolve(shared, "shared/_/pre-push");
  const sharedChmods = [];
  let sharedMode = 0o644;
  const sharedFs = {
    ...nodeFs,
    statSync: (p) => (path.resolve(p) === sharedPp ? { mode: sharedMode } : nodeFs.statSync(p)),
    chmodSync: (p, m) => (sharedChmods.push(p), (sharedMode = m)),
  };
  en = ensureGitHooks({ cwd: sharedLinked, env: {}, fs: sharedFs, platform: "linux" });
  ok(
    "T14r a linked tree on the main checkout's shared hooks dir is refused, nothing chmod-ed",
    en.ok === false && sharedChmods.length === 0 && /main checkout's own hooks/.test(en.message),
    JSON.stringify([en, sharedChmods]),
  );
  sharedMode = 0o644;
  sharedChmods.length = 0;
  en = ensureGitHooks({ cwd: shared, env: {}, fs: sharedFs, platform: "linux" });
  ok(
    "T14r2 the main checkout may chmod its own hooks dir",
    en.ok === true && sharedChmods.length === 1,
  );
  writeFileSync(path.join(mainWithHook, ".husky/_/h"), "# fresh h\n");
  const stale = path.join(tmp, "t14s-linked");
  sh(mainWithHook, "worktree", "add", "-q", "-b", "t14s", stale);
  mkdirSync(path.join(stale, ".husky/_"), { recursive: true });
  writeFileSync(path.join(stale, ".husky/_/h"), "# stale h\n");
  writeFileSync(path.join(stale, ".husky/_/commit-msg"), "# custom commit-msg\n");
  en = ensureGitHooks({ cwd: stale, env: {} });
  const staleRead = (f) => readFileSync(path.join(stale, ".husky/_", f), "utf8");
  ok(
    "T14s a stale husky helper is replaced; a custom commit-msg is kept",
    en.ok === true &&
      staleRead("h") === "# fresh h\n" &&
      /custom commit-msg/.test(staleRead("commit-msg")),
  );

  // T14t-v — review fold 2: ownership compares REAL paths; helpers refresh whenever the dir is ours.
  // Injected fs (platform linux) so the chmod recorder runs on win32 too; the mode lives per real path.
  const realFsFor = (ppPath, chmodLog) => {
    const target = realpathSync(ppPath);
    let m = 0o644;
    return {
      ...nodeFs,
      statSync: (p) => {
        try {
          return realpathSync(p) === target ? { mode: m } : nodeFs.statSync(p);
        } catch {
          return nodeFs.statSync(p);
        }
      },
      chmodSync: (p, mm) => (chmodLog.push(p), (m = mm)),
    };
  };
  const linkMain = repo("t14t-main");
  sh(linkMain, "config", "core.hooksPath", ".husky/_");
  withHook(linkMain, ".husky/_");
  const linkTree = path.join(tmp, "t14t-linked");
  sh(linkMain, "worktree", "add", "-q", "-b", "t14t", linkTree);
  mkdirSync(path.join(linkTree, ".husky"), { recursive: true });
  symlinkSync(path.join(linkMain, ".husky/_"), path.join(linkTree, ".husky/_"), "junction");
  const linkChmods = [];
  const linkFs = realFsFor(path.join(linkMain, ".husky/_/pre-push"), linkChmods);
  en = ensureGitHooks({ cwd: linkTree, env: {}, fs: linkFs, platform: "linux" });
  ok(
    "T14t a linked tree whose .husky/_ is a link to main's is refused, nothing chmod-ed",
    en.ok === false && linkChmods.length === 0,
    JSON.stringify([en, linkChmods]),
  );
  const wtMain = repo("t14u-main");
  sh(wtMain, "config", "extensions.worktreeConfig", "true");
  const outside = path.join(tmp, "t14u-outside");
  withHook(outside, "_");
  const wtTree = path.join(tmp, "t14u-linked");
  sh(wtMain, "worktree", "add", "-q", "-b", "t14u", wtTree);
  sh(
    wtTree,
    "config",
    "--worktree",
    "core.hooksPath",
    path.join(outside, "_").replaceAll("\\", "/"),
  );
  const wtChmods = [];
  const wtFs = realFsFor(path.join(outside, "_/pre-push"), wtChmods);
  en = ensureGitHooks({ cwd: wtTree, env: {}, fs: wtFs, platform: "linux" });
  ok(
    "T14u a per-worktree hooksPath outside this tree is refused, nothing chmod-ed",
    en.ok === false && wtChmods.length === 0,
    JSON.stringify([en, wtChmods]),
  );
  const fresh = path.join(tmp, "t14v-linked");
  sh(mainWithHook, "worktree", "add", "-q", "-b", "t14v", fresh);
  withHook(fresh, ".husky/_");
  writeFileSync(path.join(fresh, ".husky/_/h"), "# stale h\n");
  en = ensureGitHooks({ cwd: fresh, env: {} });
  ok(
    "T14v a tree that already has pre-push still gets its stale helper refreshed",
    en.ok === true && readFileSync(path.join(fresh, ".husky/_/h"), "utf8") === "# fresh h\n",
    JSON.stringify(en),
  );

  // T14w — a per-worktree hooksPath at a SHARED dir that has pre-push and a stale helper: the refresh
  // guard (`owns &&`) must leave it byte-identical. Mutant `!owner.fail &&` overwrote it with main's.
  const guardMain = repo("t14w-main");
  sh(guardMain, "config", "core.hooksPath", ".husky/_");
  sh(guardMain, "config", "extensions.worktreeConfig", "true");
  withHook(guardMain, ".husky/_");
  writeFileSync(path.join(guardMain, ".husky/_/h"), "# main fresh h\n");
  const guardShared = path.join(tmp, "t14w-shared");
  withHook(tmp, "t14w-shared");
  writeFileSync(path.join(guardShared, "h"), "# shared stale h\n");
  const guardTree = path.join(tmp, "t14w-linked");
  sh(guardMain, "worktree", "add", "-q", "-b", "t14w", guardTree);
  sh(guardTree, "config", "--worktree", "core.hooksPath", guardShared.replaceAll("\\", "/"));
  const guardList = () => readdirSync(guardShared).sort().join(",");
  const guardBefore = guardList();
  en = ensureGitHooks({ cwd: guardTree, env: {} });
  ok(
    "T14w a shared hooks dir with pre-push keeps its own helper byte-identical; nothing written",
    readFileSync(path.join(guardShared, "h"), "utf8") === "# shared stale h\n" &&
      guardList() === guardBefore &&
      !existsSync(path.join(guardShared, "husky.sh")),
    JSON.stringify(en),
  );

  // T14x — a dangling link at the hooks dir (target removed): refused with a message, never copied into.
  const dangMain = repo("t14x-main");
  sh(dangMain, "config", "core.hooksPath", ".husky/_");
  withHook(dangMain, ".husky/_");
  const dangTree = path.join(tmp, "t14x-linked");
  sh(dangMain, "worktree", "add", "-q", "-b", "t14x", dangTree);
  const dangTarget = path.join(tmp, "t14x-gone");
  mkdirSync(dangTarget, { recursive: true });
  mkdirSync(path.join(dangTree, ".husky"), { recursive: true });
  symlinkSync(dangTarget, path.join(dangTree, ".husky/_"), "junction");
  rmSync(dangTarget, { recursive: true, force: true });
  en = ensureGitHooks({ cwd: dangTree, env: {} });
  ok(
    "T14x a dangling link at the hooks dir is refused with a clear message",
    en.ok === false && en.copied === false && /dangling/.test(en.message),
    JSON.stringify(en),
  );

  // T12 — structural: the guard is actually wired where it must be.
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const FRESHNESS = "node scripts/campaign-check.mjs --freshness-only && ";
  ok(
    "T12a `npm run verify` runs the hooks check right after the freshness pre-step (which campaign-check-freshness T11 pins as first)",
    pkg.scripts.verify.startsWith(`${FRESHNESS}node scripts/check-git-hooks.mjs && `),
    pkg.scripts.verify.slice(0, 120),
  );
  ok(
    "T12b verify runs this self-test",
    pkg.scripts.verify.includes("node scripts/check-git-hooks.self-test.mjs"),
  );
  ok(
    "T12c `prepare` does NOT reference the guard (Docker builds run prepare with no .git)",
    !/check-git-hooks/.test(pkg.scripts.prepare ?? ""),
    pkg.scripts.prepare,
  );
  const dispatch = readFileSync(path.join(ROOT, ".claude/commands/dispatch.md"), "utf8");
  ok(
    "T12d the worktree-setup instructions: npm ci --ignore-scripts, then ensure, then the check",
    /npm ci --ignore-scripts[\s\S]*ensure-git-hooks\.mjs[\s\S]*check-git-hooks\.mjs/.test(
      dispatch,
    ) && !/never\s+`--ignore-scripts`/.test(dispatch),
  );
  const settings = JSON.parse(readFileSync(path.join(ROOT, ".claude/settings.json"), "utf8"));
  const sessionStart = JSON.stringify(settings.hooks.SessionStart);
  ok(
    "T12e a SessionStart hook runs the check in --warn mode",
    sessionStart.includes("node scripts/check-git-hooks.mjs --warn"),
    sessionStart,
  );
  ok(
    "T12f no lifecycle script references the guard (never on a production build path)",
    !["prepare", "postinstall", "preinstall", "prepublishOnly"].some((k) =>
      /check-git-hooks/.test(pkg.scripts[k] ?? ""),
    ),
  );
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(
  failed === 0
    ? "\ncheck-git-hooks self-test: all checks passed"
    : `\ncheck-git-hooks self-test: ${failed} FAILED`,
);
process.exit(failed === 0 ? 0 : 1);
