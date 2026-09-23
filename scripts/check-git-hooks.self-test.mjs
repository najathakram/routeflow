#!/usr/bin/env node
// Self-test for scripts/lib/check-git-hooks.mjs (B642). Real temp git repos, no network, no jest.
// Wired into `npm run verify`. Exit 0 when every check passes, 1 otherwise.
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkGitHooks, hooksDirFor, isCi, scrubbedGitEnv } from "./lib/check-git-hooks.mjs";

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
    r.status === 1 && /NOT INSTALLED/.test(r.message) && /npx husky/.test(r.message),
    JSON.stringify(r),
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
    "T12d the worktree-setup instructions run the check",
    /check-git-hooks\.mjs/.test(dispatch) && /ignore-scripts/.test(dispatch),
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
