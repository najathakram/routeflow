#!/usr/bin/env node
// Self-test for scripts/leak-check.mjs, scripts/lib/leak-patterns.mjs and the leak-guard block of
// .husky/pre-push. Plain node (repo convention for root scripts); exit 0 when every check passes.
// Uses ONLY the neutral fixture pattern below and throwaway git repos in the OS temp dir.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
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
import { scrubbedGitEnv } from "./lib/check-git-hooks.mjs";
import { scanRevs } from "./leak-check.mjs";
import { loadPatterns, matches } from "./lib/leak-patterns.mjs";
import { symlinkSync } from "node:fs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const CLI = path.join(HERE, "leak-check.mjs");
const LIB = path.join(HERE, "lib", "leak-patterns.mjs");
const HOOK = path.join(ROOT, ".husky", "pre-push");
const FIXTURE = "zzfixture|qqsecret";
const WORDS = ["zzfixture", "qqsecret"];
// --fast: library and simulated-stdin cases only (no real `git push`); default and --full run everything.
const FULL = !process.argv.includes("--fast");
const ZERO = "0".repeat(40);

let passed = 0;
let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${ok ? "" : ` ${detail}`}`);
  if (ok) passed++;
  else failed++;
}
const leaks = (s) => WORDS.some((w) => s.toLowerCase().includes(w));

const tmpRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "leak-check-")));
let n = 0;
function env(extra = {}) {
  const e = { ...scrubbedGitEnv(), ...extra };
  delete e.CI;
  delete e.GITHUB_ACTIONS;
  if (extra.CI !== undefined) e.CI = extra.CI;
  if (extra.GITHUB_ACTIONS !== undefined) e.GITHUB_ACTIONS = extra.GITHUB_ACTIONS;
  return e;
}
function git(repo, args, extra) {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd: repo,
    env: env(extra),
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}
function installScripts(repo) {
  mkdirSync(path.join(repo, "scripts", "lib"), { recursive: true });
  try {
    cpSync(CLI, path.join(repo, "scripts", "leak-check.mjs"));
    cpSync(LIB, path.join(repo, "scripts", "lib", "leak-patterns.mjs"));
  } catch {
    // red phase: the modules do not exist yet; the checks below fail for that reason
  }
}
function makeRepo({ patterns = FIXTURE } = {}) {
  const repo = path.join(tmpRoot, `r${n++}`);
  mkdirSync(repo);
  git(repo, ["init", "-q", "-b", "master"]);
  installScripts(repo);
  if (patterns !== null) {
    mkdirSync(path.join(repo, ".git", "info"), { recursive: true });
    writeFileSync(path.join(repo, ".git", "info", "leak-patterns"), patterns);
  }
  return repo;
}
function commit(repo, files, msg = "chore: x") {
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
    writeFileSync(path.join(repo, f), c);
  }
  git(repo, ["add", "-f", "--", ...Object.keys(files)]);
  git(repo, ["commit", "-q", "-m", msg]);
  return git(repo, ["rev-parse", "HEAD"]);
}
function cli(repo, args, extra, input) {
  const r = spawnSync("node", [path.join(repo, "scripts", "leak-check.mjs"), ...args], {
    cwd: repo,
    env: env(extra),
    encoding: "utf8",
    input,
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}
function baseRepo() {
  const repo = makeRepo();
  const base = commit(repo, { "a.txt": "hello\n" }, "chore: base");
  return { repo, base };
}
function hookBlock() {
  const t = readFileSync(HOOK, "utf8");
  const a = t.indexOf("# >>> leak-guard");
  const b = t.indexOf("# <<< leak-guard");
  return a >= 0 && b > a ? t.slice(a, b) : null;
}
// Runs the REAL leak-guard block of .husky/pre-push (extracted between its markers) in a temp repo.
function hook(repo, refsLine, extra) {
  const block = hookBlock();
  if (block === null) return { code: 99, out: "hook has no leak-guard block" };
  const stub = path.join(repo, "stub-pre-push");
  writeFileSync(stub, `refs="$(cat)"\n${block}\nexit 0\n`);
  const r = spawnSync("sh", [stub], {
    cwd: repo,
    env: env(extra),
    encoding: "utf8",
    input: `${refsLine}\n`,
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

try {
  if (FULL) {
    // 1. clean range passes
    {
      const { repo, base } = baseRepo();
      const head = commit(repo, { "b.txt": "fine\n" });
      const r = cli(repo, ["--range", `${base}..${head}`]);
      check("clean range exits 0", r.code === 0, JSON.stringify(r));
    }
    // 2. added line
    {
      const { repo, base } = baseRepo();
      const head = commit(repo, { "b.txt": "x ZZFixture y\n" });
      const r = cli(repo, ["--range", `${base}..${head}`]);
      check("added line with pattern exits 1", r.code === 1, JSON.stringify(r));
      check("added-line hit names the commit", r.out.includes(head.slice(0, 8)), r.out);
      check("added-line hit never echoes matched text", !leaks(r.out), r.out);
    }
    // 3. new file name + rename
    {
      const { repo, base } = baseRepo();
      const head = commit(repo, { "qqsecret-notes.txt": "innocent\n" });
      const r = cli(repo, ["--range", `${base}..${head}`]);
      check(
        "new file whose NAME matches exits 1",
        r.code === 1 && !leaks(r.out),
        JSON.stringify(r),
      );
    }
    {
      const { repo, base } = baseRepo();
      git(repo, ["mv", "a.txt", "zzfixture.txt"]);
      git(repo, ["commit", "-q", "-m", "chore: rename"]);
      const head = git(repo, ["rev-parse", "HEAD"]);
      const r = cli(repo, ["--range", `${base}..${head}`]);
      check("renamed-to matching name exits 1", r.code === 1 && !leaks(r.out), JSON.stringify(r));
    }
    // 4. commit message
    {
      const { repo, base } = baseRepo();
      const head = commit(repo, { "b.txt": "fine\n" }, "feat: add qqSecret thing");
      const r = cli(repo, ["--range", `${base}..${head}`]);
      check("commit message match exits 1", r.code === 1 && !leaks(r.out), JSON.stringify(r));
    }
    // 5. ref name
    {
      const { repo, base } = baseRepo();
      const head = commit(repo, { "b.txt": "fine\n" });
      const r = cli(repo, ["--range", `${base}..${head}`, "--ref", "feat/zzfixture-x"]);
      check("ref name match exits 1", r.code === 1 && !leaks(r.out), JSON.stringify(r));
      const ok = cli(repo, ["--range", `${base}..${head}`, "--ref", "feat/clean"]);
      check("clean ref name exits 0", ok.code === 0, JSON.stringify(ok));
    }
    // 6. hook: rebrand/* refusal
    {
      const { repo } = baseRepo();
      const head = commit(repo, { "b.txt": "fine\n" });
      git(repo, ["update-ref", "refs/remotes/origin/master", git(repo, ["rev-parse", "HEAD~1"])]);
      const line = `refs/heads/rebrand/x ${head} refs/heads/rebrand/x ${ZERO}`;
      const r = hook(repo, line);
      check("rebrand/x push refused without env", r.code === 1 && !leaks(r.out), JSON.stringify(r));
      const ok = hook(repo, line, { RF_REBRAND_PUSH: "launch" });
      check(
        "rebrand/x push allowed with RF_REBRAND_PUSH=launch",
        ok.code === 0,
        JSON.stringify(ok),
      );
      const other = hook(repo, line, { RF_REBRAND_PUSH: "1" });
      check("rebrand/x refused for a wrong env value", other.code === 1, JSON.stringify(other));
      const lref = hook(repo, `refs/heads/rebrand/x ${head} refs/heads/feat/y ${ZERO}`);
      check("rebrand/* LOCAL ref name refused too", lref.code === 1, JSON.stringify(lref));
      const clean = hook(repo, `refs/heads/feat/x ${head} refs/heads/feat/x ${ZERO}`);
      check("hook passes a clean new-branch push", clean.code === 0, JSON.stringify(clean));
    }
    // 7. hook: leaking range, SKIP_VERIFY does not bypass
    {
      const { repo } = baseRepo();
      git(repo, ["update-ref", "refs/remotes/origin/master", git(repo, ["rev-parse", "HEAD"])]);
      const head = commit(repo, { "b.txt": "has zzfixture\n" });
      const line = `refs/heads/feat/x ${head} refs/heads/feat/x ${ZERO}`;
      const r = hook(repo, line);
      check(
        "hook refuses a leaking new-branch push",
        r.code === 1 && !leaks(r.out),
        JSON.stringify(r),
      );
      const s = hook(repo, line, { SKIP_VERIFY: "1", SKIP_VERIFY_REASON: "x" });
      check("SKIP_VERIFY does not bypass the guard", s.code === 1, JSON.stringify(s));
      const upd = commit(repo, { "c.txt": "fine\n" });
      const u = hook(repo, `refs/heads/feat/x ${upd} refs/heads/feat/x ${head}`);
      check("update push scans only remote..local", u.code === 0, JSON.stringify(u));
    }
    // 8. missing / empty patterns
    {
      const repo = makeRepo({ patterns: null });
      const head = commit(repo, { "b.txt": "fine\n" });
      const r = cli(repo, ["--range", `${head}..${head}`]);
      check("missing patterns file fails closed (exit 2)", r.code === 2, JSON.stringify(r));
      check("missing-file message says how to create it", /leak-patterns/.test(r.out), r.out);
      const ci = cli(repo, ["--range", `${head}..${head}`], { CI: "true" });
      check("missing patterns file skipped under CI", ci.code === 0, JSON.stringify(ci));
      const gh = cli(repo, ["--range", `${head}..${head}`], { GITHUB_ACTIONS: "true" });
      check(
        "missing patterns file skipped under GITHUB_ACTIONS",
        gh.code === 0,
        JSON.stringify(gh),
      );
      const line = `refs/heads/feat/x ${head} refs/heads/feat/x ${head}`;
      const h = hook(repo, line);
      check("hook refuses locally when patterns file missing", h.code === 1, JSON.stringify(h));
      const hc = hook(repo, line, { CI: "true" });
      check(
        "hook does NOT skip under CI (CI never pushes via the hook)",
        hc.code === 1,
        JSON.stringify(hc),
      );
    }
    {
      const repo = makeRepo({ patterns: "# only a comment\n\n" });
      const r = cli(repo, ["--stdin"], {}, "hi");
      check("empty (comments-only) patterns file fails closed", r.code === 2, JSON.stringify(r));
    }
    // 9. text + tree
    {
      const { repo } = baseRepo();
      const bad = cli(repo, ["--stdin"], {}, "PR title ZZFIXTURE\n");
      check(
        "stdin text hit exits 1 without echo",
        bad.code === 1 && !leaks(bad.out),
        JSON.stringify(bad),
      );
      const good = cli(repo, ["--stdin"], {}, "PR title ok\n");
      check("stdin clean text exits 0", good.code === 0, JSON.stringify(good));
      writeFileSync(path.join(repo, "body.md"), "body qqsecret\n");
      const f = cli(repo, ["--text-file", "body.md"]);
      check(
        "--text-file hit exits 1 without echo",
        f.code === 1 && !leaks(f.out),
        JSON.stringify(f),
      );
      commit(repo, { ".claude/lessons/L.md": "fine\n", "other/z.md": "zzfixture ok here\n" });
      const t0 = cli(repo, ["--tree"]);
      check("tree: out-of-scope file with pattern is ignored", t0.code === 0, JSON.stringify(t0));
      commit(repo, { ".claude/pipeline/cost-ledger.jsonl": '{"a":"qqSecret"}\n' });
      const t1 = cli(repo, ["--tree"]);
      check(
        "tree: ledger hit exits 1 without echo",
        t1.code === 1 && !leaks(t1.out),
        JSON.stringify(t1),
      );
      check("tree: hit names the path", t1.out.includes("cost-ledger.jsonl"), t1.out);
    }
    {
      const { repo } = baseRepo();
      commit(repo, { ".claude/skills/s/references/RUN-LOG.md": "zzfixture\n" });
      check("tree: RUN-LOG hit exits 1", cli(repo, ["--tree"]).code === 1);
    }
    {
      const { repo } = baseRepo();
      commit(repo, { ".claude/campaign/bugs/B1.md": "zzfixture\n" });
      check("tree: campaign/** hit exits 1", cli(repo, ["--tree"]).code === 1);
    }
    // 10. usage + worktree
    {
      const { repo } = baseRepo();
      check("no mode is a usage error (exit 2)", cli(repo, []).code === 2);
      const wt = path.join(tmpRoot, "wt-extra");
      git(repo, ["worktree", "add", "-q", wt, "-b", "side"]);
      installScripts(wt);
      const r = cli(wt, ["--stdin"], {}, "zzfixture");
      check("linked worktree shares the common-dir patterns file", r.code === 1, JSON.stringify(r));
    }
    // 11. review round: merges (B1)
    for (const [label, file, body] of [
      ["content", "m-new.txt", "evil zzfixture\n"],
      ["file name", "qqsecret-merge.txt", "innocent\n"],
    ]) {
      const { repo } = baseRepo();
      git(repo, ["checkout", "-q", "-b", "side"]);
      commit(repo, { "side.txt": "clean\n" });
      git(repo, ["checkout", "-q", "master"]);
      const tip = commit(repo, { "m.txt": "clean\n" });
      git(repo, ["merge", "--no-commit", "--no-ff", "side"]);
      writeFileSync(path.join(repo, file), body);
      git(repo, ["add", "-f", file]);
      git(repo, ["commit", "-q", "-m", "chore: merge side"]);
      const r = cli(repo, ["--range", `${tip}..HEAD`]);
      check(
        `merge commit ${label} hit exits 1 without echo`,
        r.code === 1 && !leaks(r.out),
        JSON.stringify(r),
      );
    }
    // B2: unreadable / non-UTF-8 patterns files refuse
    {
      const variants = {
        "UTF-16 BOM": Buffer.concat([
          Buffer.from([0xff, 0xfe]),
          Buffer.from("zzfixture\n", "utf16le"),
        ]),
        "NUL bytes": Buffer.from("zz\0fixture\n"),
        "invalid UTF-8": Buffer.from([0x7a, 0x7a, 0x80, 0x0a]),
      };
      for (const [label, buf] of Object.entries(variants)) {
        const repo = makeRepo({ patterns: null });
        mkdirSync(path.join(repo, ".git", "info"), { recursive: true });
        writeFileSync(path.join(repo, ".git", "info", "leak-patterns"), buf);
        const r = cli(repo, ["--stdin"], {}, "zzfixture");
        check(
          `patterns file (${label}) refused with exit 2`,
          r.code === 2 && /encoding|UTF-8/i.test(r.out),
          JSON.stringify(r),
        );
      }
    }
    // B3: any failed git call fails closed
    {
      const { repo, base } = baseRepo();
      const head = commit(repo, { "b.txt": "fine\n" });
      const real = (cwd, args) => {
        const r = spawnSync("git", args, { cwd, env: env(), encoding: "utf8" });
        return { ok: r.status === 0, out: r.stdout ?? "" };
      };
      for (const sub of ["log", "diff-tree", "diff", "show"]) {
        const fake = (cwd, args) => (args[0] === sub ? { ok: false, out: "" } : real(cwd, args));
        let res;
        try {
          // `show` is only used for root commits, so that case scans the whole history.
          const revs = sub === "show" ? [head] : [`${base}..${head}`];
          res = scanRevs(repo, [/zzfixture/i], revs, [], fake);
        } catch {
          res = "threw";
        }
        check(`failed git ${sub} call makes scanRevs return false`, res === false, String(res));
      }
    }
    // S1: RF_REBRAND_PUSH=launch lifts the refusal AND the scan for rebrand refs
    {
      const { repo } = baseRepo();
      git(repo, ["update-ref", "refs/remotes/origin/master", git(repo, ["rev-parse", "HEAD"])]);
      const head = commit(repo, { "b.txt": "has zzfixture\n" });
      const line = `refs/heads/rebrand/x ${head} refs/heads/rebrand/x ${ZERO}`;
      check(
        "launch push of a rebrand ref skips the content scan",
        hook(repo, line, { RF_REBRAND_PUSH: "launch" }).code === 0,
      );
      check("non-launch rebrand push still refused", hook(repo, line).code === 1);
      const nf = `refs/heads/feat/x ${head} refs/heads/feat/x ${ZERO}`;
      check(
        "launch env does not unscan a non-rebrand ref",
        hook(repo, nf, { RF_REBRAND_PUSH: "launch" }).code === 1,
      );
      const repo2 = makeRepo({ patterns: null });
      const h2 = commit(repo2, { "b.txt": "fine\n" });
      const l2 = `refs/heads/rebrand/x ${h2} refs/heads/rebrand/x ${ZERO}`;
      check(
        "launch rebrand push needs no patterns file",
        hook(repo2, l2, { RF_REBRAND_PUSH: "launch" }).code === 0,
      );
      check(
        "non-launch push still fails closed without patterns",
        hook(repo2, `refs/heads/feat/x ${h2} refs/heads/feat/x ${ZERO}`).code === 1,
      );
      const clean = baseRepo().repo;
      const ch = commit(clean, { "b.txt": "fine\n" });
      const upper = `refs/heads/REBRAND/x ${ch} refs/heads/REBRAND/x ${ZERO}`;
      const ur = hook(clean, upper);
      check(
        "REBRAND/x (case) refused even when clean",
        ur.code === 1 && /rebrand/i.test(ur.out),
        ur.out,
      );
    }
    // S3: guard sits before the delete-only exit and the SKIP_VERIFY exit
    {
      const t = readFileSync(HOOK, "utf8");
      const g = t.indexOf("# >>> leak-guard");
      const d = t.indexOf("branch delete only");
      const s = t.indexOf('if [ "$SKIP_VERIFY" = "1" ]');
      check(
        "leak-guard block precedes delete-only exit and SKIP_VERIFY exit",
        g >= 0 && d > g && s > g,
        `${g} ${d} ${s}`,
      );
    }
    // S4: annotated tag message scanned
    {
      const { repo } = baseRepo();
      git(repo, ["update-ref", "refs/remotes/origin/master", git(repo, ["rev-parse", "HEAD"])]);
      const head = commit(repo, { "b.txt": "fine\n" });
      git(repo, ["tag", "-a", "v1", "-m", "release qqsecret notes"]);
      const tagsha = git(repo, ["rev-parse", "v1"]);
      const r = hook(repo, `refs/tags/v1 ${tagsha} refs/tags/v1 ${ZERO}`);
      check(
        "annotated tag message hit refused without echo",
        r.code === 1 && !leaks(r.out),
        JSON.stringify(r),
      );
      git(repo, ["tag", "-a", "v2", "-m", "fine notes", head]);
      const t2 = git(repo, ["rev-parse", "v2"]);
      check(
        "clean annotated tag passes",
        hook(repo, `refs/tags/v2 ${t2} refs/tags/v2 ${ZERO}`).code === 0,
      );
    }
    // N2: removed `-- a` then added `++ x` must not be dropped
    {
      const { repo } = baseRepo();
      const b1 = commit(repo, { "p.txt": "-- a\n" });
      const head = commit(repo, { "p.txt": "++ zzfixture\n" });
      const r = cli(repo, ["--range", `${b1}..${head}`]);
      check(
        "added '++ x' line after removed '-- a' is still scanned",
        r.code === 1 && !leaks(r.out),
        JSON.stringify(r),
      );
    }
    // ---- round 3 ----
    // UTF-16 content (PowerShell 5.1 `echo x > f` writes FF FE + NULs)
    {
      const le = Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from("has zzfixture\r\n", "utf16le"),
      ]);
      const be = Buffer.from("qqsecret\n", "utf16le").swap16();
      const { repo } = baseRepo();
      git(repo, ["update-ref", "refs/remotes/origin/master", git(repo, ["rev-parse", "HEAD"])]);
      const base = git(repo, ["rev-parse", "HEAD"]);
      const head = commit(repo, { "u16.txt": le });
      const r = cli(repo, ["--range", `${base}..${head}`]);
      check(
        "UTF-16LE+BOM committed file is caught by --range",
        r.code === 1 && !leaks(r.out),
        JSON.stringify(r),
      );
      const h = hook(repo, `refs/heads/feat/u ${head} refs/heads/feat/u ${ZERO}`);
      check(
        "UTF-16LE+BOM committed file is refused by the hook",
        h.code === 1 && !leaks(h.out),
        JSON.stringify(h),
      );
      const t = cli(repo, ["--stdin"], {}, le);
      check("UTF-16LE+BOM stdin text is caught", t.code === 1 && !leaks(t.out), JSON.stringify(t));
      writeFileSync(path.join(repo, "body.txt"), le);
      const tf = cli(repo, ["--text-file", "body.txt"]);
      check(
        "UTF-16LE+BOM --text-file is caught",
        tf.code === 1 && !leaks(tf.out),
        JSON.stringify(tf),
      );
      const h2 = commit(repo, { "u16be.txt": be });
      const rb = cli(repo, ["--range", `${head}..${h2}`]);
      check("UTF-16BE (no BOM) committed file is caught", rb.code === 1, JSON.stringify(rb));
      const clean16 = Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from("all fine\r\n", "utf16le"),
      ]);
      const h3 = commit(repo, { "ok16.txt": clean16 });
      check("clean UTF-16 file passes", cli(repo, ["--range", `${h2}..${h3}`]).code === 0);
      const c16 = cli(repo, ["--text-file", "body.txt"], { CI: "true" });
      check(
        "(sanity) text-file hit under CI still scans when patterns exist",
        c16.code === 1,
        JSON.stringify(c16),
      );
    }
    // CI=true on the hook: rebrand refusal and content scan both still apply
    {
      const { repo } = baseRepo();
      git(repo, ["update-ref", "refs/remotes/origin/master", git(repo, ["rev-parse", "HEAD"])]);
      const head = commit(repo, { "b.txt": "has zzfixture\n" });
      const rb = `refs/heads/rebrand/x ${head} refs/heads/rebrand/x ${ZERO}`;
      check("CI=true: rebrand/* still refused", hook(repo, rb, { CI: "true" }).code === 1);
      check(
        "CI=true + launch: rebrand allowed",
        hook(repo, rb, { CI: "true", RF_REBRAND_PUSH: "launch" }).code === 0,
      );
      const nf = `refs/heads/feat/x ${head} refs/heads/feat/x ${ZERO}`;
      check("CI=true: hook content scan still runs", hook(repo, nf, { CI: "true" }).code === 1);
    }
    // performance: commits already on origin/master are not rescanned
    {
      const { repo, base } = baseRepo();
      const leak = commit(repo, { "l.txt": "zzfixture\n" });
      git(repo, ["update-ref", "refs/remotes/origin/master", leak]);
      const clean = commit(repo, { "c.txt": "fine\n" });
      const line = `refs/heads/feat/x ${clean} refs/heads/feat/x ${base}`;
      check("commit already on origin/master is not rescanned", hook(repo, line).code === 0, "");
      const bad = commit(repo, { "d.txt": "zzfixture again\n" });
      check(
        "a new commit above origin/master is still scanned",
        hook(repo, `refs/heads/feat/x ${bad} refs/heads/feat/x ${base}`).code === 1,
      );
      const r = cli(repo, ["--range", `${base}..${clean}`]);
      check("--range also skips what origin/master carries", r.code === 0, JSON.stringify(r));
    }
    // junction / symlink invocation must still run the guard
    {
      const { repo } = baseRepo();
      const link = path.join(tmpRoot, "scripts-link");
      let made = true;
      try {
        symlinkSync(path.join(repo, "scripts"), link, "junction");
      } catch {
        made = false;
      }
      if (made) {
        const r = spawnSync("node", [path.join(link, "leak-check.mjs"), "--stdin"], {
          cwd: repo,
          env: env(),
          encoding: "utf8",
          input: "zzfixture",
        });
        check(
          "guard runs when invoked through a junction path",
          r.status === 1,
          `${r.status} ${r.stdout}${r.stderr}`,
        );
      } else {
        console.log("  skip junction test (cannot create junction here)");
      }
    }
    // pushed objects that are not commits, nested tags
    {
      const { repo } = baseRepo();
      git(repo, ["update-ref", "refs/remotes/origin/master", git(repo, ["rev-parse", "HEAD"])]);
      const head = commit(repo, { "b.txt": "fine\n" });
      const blob = git(repo, ["rev-parse", `${head}:b.txt`]);
      const tree = git(repo, ["rev-parse", `${head}^{tree}`]);
      const rb = hook(repo, `refs/heads/odd ${blob} refs/heads/odd ${ZERO}`);
      check(
        "ref pointing at a blob is refused",
        rb.code === 1 && !leaks(rb.out),
        JSON.stringify(rb),
      );
      const rt = hook(repo, `refs/heads/odd ${tree} refs/heads/odd ${ZERO}`);
      check("ref pointing at a tree is refused", rt.code === 1, JSON.stringify(rt));
      git(repo, ["tag", "-a", "inner", "-m", "innocent", head]);
      git(repo, ["tag", "-a", "outer", "-m", "also innocent", "inner"]);
      const outer = git(repo, ["rev-parse", "outer"]);
      check(
        "clean nested tag chain ending at a commit passes",
        hook(repo, `refs/tags/outer ${outer} refs/tags/outer ${ZERO}`).code === 0,
      );
      git(repo, ["tag", "-a", "inner2", "-m", "notes zzfixture", head]);
      git(repo, ["tag", "-a", "outer2", "-m", "clean outer", "inner2"]);
      const o2 = git(repo, ["rev-parse", "outer2"]);
      const rn = hook(repo, `refs/tags/outer2 ${o2} refs/tags/outer2 ${ZERO}`);
      check(
        "hit in the INNER tag of a nested chain is refused",
        rn.code === 1 && !leaks(rn.out),
        JSON.stringify(rn),
      );
    }
    // author / committer identity
    for (const [label, extra] of [
      ["author name", { GIT_AUTHOR_NAME: "qqSecret Person" }],
      ["author email", { GIT_AUTHOR_EMAIL: "x@zzfixture.example" }],
      ["committer name", { GIT_COMMITTER_NAME: "zzFixture Co" }],
      ["committer email", { GIT_COMMITTER_EMAIL: "a@qqsecret.example" }],
    ]) {
      const { repo, base } = baseRepo();
      writeFileSync(path.join(repo, "i.txt"), "fine\n");
      git(repo, ["add", "i.txt"]);
      git(repo, ["commit", "-q", "-m", "chore: id"], extra);
      const head = git(repo, ["rev-parse", "HEAD"]);
      const r = cli(repo, ["--range", `${base}..${head}`]);
      check(
        `${label} match exits 1 without echo`,
        r.code === 1 && !leaks(r.out),
        JSON.stringify(r),
      );
    }
  }
  // ---- round 4 (fast cases: no real pushes) ----
  // pattern-file parsing, in process (one throwaway repo, the file rewritten per case)
  {
    const repo = makeRepo();
    const pf = path.join(repo, ".git", "info", "leak-patterns");
    const load = (text) => {
      writeFileSync(pf, text);
      return loadPatterns(repo);
    };
    const noRegex = load(`commit:${"b".repeat(40)}\npath:zzkit/\n`);
    check(
      "patterns file without any regex fails closed, saying a regex is required",
      !noRegex.ok && /at least one regex/.test(noRegex.message),
      JSON.stringify(noRegex),
    );
    for (const [label, line] of [
      ["abbreviated sha", "commit:abc1234"],
      ["empty commit value", "commit:"],
      ["non-hex commit value", `commit:${"g".repeat(40)}`],
      ["empty path prefix", "path:"],
    ]) {
      const r = load(`${FIXTURE}\n${line}\n`);
      check(
        `malformed ${label} line refuses to load, naming the line`,
        !r.ok && /line 2/.test(r.message),
        JSON.stringify(r),
      );
    }
    for (const v of ["./", "/", ".", "\\"]) {
      const r = load(`${FIXTURE}\npath:${v}\n`);
      check(
        `path: value that is empty once normalised (${JSON.stringify(v)}) refuses to load`,
        !r.ok && /line 2/.test(r.message),
        JSON.stringify(r),
      );
    }
    // the older fail-closed loading rules, none of which needs a push
    rmSync(pf);
    const missing = loadPatterns(repo);
    check("missing patterns file fails closed", !missing.ok && missing.reason === "missing");
    const empty = load("# only a comment\n\n");
    check("comments-only patterns file fails closed", !empty.ok && empty.reason === "empty");
    const bad = load(`(${FIXTURE}\n`);
    check(
      "invalid regex refuses to load, naming the line",
      !bad.ok && bad.reason === "invalid" && /line 1/.test(bad.message),
      JSON.stringify(bad),
    );
    const encodings = {
      "UTF-16 BOM": Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from("zzfixture\n", "utf16le"),
      ]),
      "NUL bytes": Buffer.from("zz\0fixture\n"),
      "invalid UTF-8": Buffer.from([0x7a, 0x7a, 0x80, 0x0a]),
    };
    for (const [label, buf] of Object.entries(encodings)) {
      const r = load(buf);
      check(
        `patterns file (${label}) refuses to load`,
        !r.ok && r.reason === "encoding",
        JSON.stringify(r),
      );
    }
    const good = load(`${FIXTURE}\ncommit:${"d".repeat(40)}\npath:./ZZKit\\sub\n`);
    check(
      "well-formed commit: and path: lines load beside a regex",
      good.ok && good.sentinels.length === 1 && good.paths[0] === "zzkit/sub",
      JSON.stringify(good),
    );
    const rx = load(FIXTURE).regexes;
    check("zero-width variant matches in process", matches(rx, "zz\u200Bfix\u2060ture"));
    check("full-width variant matches in process", matches(rx, "\uFF5A\uFF5A\uFF46ixture"));
    check("an unrelated word does not match", !matches(rx, "harmless text"));
  }
  // a sentinel already on origin/master is called out by name
  {
    const { repo } = baseRepo();
    const sentinel = commit(repo, { "s.txt": "fine\n" });
    git(repo, ["update-ref", "refs/remotes/origin/master", sentinel]);
    const head = commit(repo, { "t.txt": "fine\n" });
    writeFileSync(
      path.join(repo, ".git", "info", "leak-patterns"),
      `${FIXTURE}\ncommit:${sentinel}\n`,
    );
    const h = hook(repo, `refs/heads/feat/x ${head} refs/heads/feat/x ${ZERO}`);
    check(
      "sentinel already on origin/master is named with a remove-this-line hint",
      h.code === 1 &&
        h.out.includes(sentinel.slice(0, 10)) &&
        /already on origin\/master/.test(h.out),
      JSON.stringify(h),
    );
  }
  // empty stdin is "nothing to push", not "delete only"
  {
    const repo = makeRepo({ patterns: null });
    const h = hook(repo, "");
    check(
      "empty stdin push is not described as delete-only",
      h.code === 0 && !/delete/i.test(h.out),
      JSON.stringify(h),
    );
  }
  // path: prefixes refuse an added or modified file under them (binary images included), simulated stdin
  {
    const { repo } = baseRepo();
    git(repo, ["update-ref", "refs/remotes/origin/master", git(repo, ["rev-parse", "HEAD"])]);
    writeFileSync(path.join(repo, ".git", "info", "leak-patterns"), `${FIXTURE}\npath:zzkit/\n`);
    const bin = Buffer.from([0, 1, 2, 255, 0]);
    const inside = commit(repo, { "zzkit/logo.bin": bin }, "chore: asset");
    const line = (sha) => `refs/heads/feat/x ${sha} refs/heads/feat/x ${ZERO}`;
    const h = hook(repo, line(inside));
    check("path: added binary under a listed prefix is refused", h.code === 1, JSON.stringify(h));
    check("path: refusal does not print the path", !h.out.includes("zzkit"), h.out);
    check(
      "path: RF_REBRAND_PUSH=launch lifts it",
      hook(repo, line(inside), { RF_REBRAND_PUSH: "launch" }).code === 0,
    );
    git(repo, ["reset", "-q", "--hard", "refs/remotes/origin/master"]);
    const outside = commit(repo, { "other/logo.bin": bin }, "chore: asset");
    check(
      "path: the same file outside the prefix is allowed",
      hook(repo, line(outside)).code === 0,
    );
    const del = commit(repo, { "zzkit/b.txt": "x\n" }, "chore: add");
    git(repo, ["update-ref", "refs/remotes/origin/master", del]);
    git(repo, ["rm", "-q", "zzkit/b.txt"]);
    git(repo, ["commit", "-q", "-m", "chore: drop"]);
    const dropped = git(repo, ["rev-parse", "HEAD"]);
    check(
      "path: deleting a file under the prefix is allowed",
      hook(repo, line(dropped)).code === 0,
    );
  }
  // ---- fix round: real pushes against a throwaway bare repo (the hook is wired as a real pre-push) ----
  if (FULL) {
    const realRepo = () => {
      const bare = path.join(tmpRoot, `bare${n++}.git`);
      mkdirSync(bare);
      git(bare, ["init", "-q", "--bare"]);
      const { repo } = baseRepo();
      git(repo, ["remote", "add", "origin", bare]);
      git(repo, ["push", "-q", "origin", "master"]); // no hook yet; also creates refs/remotes/origin/master
      const hookFile = path.join(repo, ".git", "hooks", "pre-push");
      mkdirSync(path.dirname(hookFile), { recursive: true });
      writeFileSync(hookFile, "#!/bin/sh\nnode scripts/leak-check.mjs --hook\n");
      chmodSync(hookFile, 0o755);
      return repo;
    };
    const push = (repo, args, extra) => {
      const r = spawnSync("git", ["push", ...args], {
        cwd: repo,
        env: env(extra),
        encoding: "utf8",
      });
      return { code: r.status, out: `${r.stdout}${r.stderr}` };
    };
    const branchWith = (repo, name, files) => {
      git(repo, ["checkout", "-q", "-b", name, "master"]);
      return commit(repo, files, "chore: work");
    };

    let repo = realRepo();
    branchWith(repo, "feat/leaky", { "b.txt": "x zzfixture y\n" });
    let r = push(repo, ["origin", "feat/leaky"]);
    check("real push: plain leak refused", r.code !== 0 && !leaks(r.out), JSON.stringify(r));

    repo = realRepo();
    // a binary kit image on a private rebrand branch: invisible to the content scan
    const priv = branchWith(repo, "rebrand/x", { "kit.bin": Buffer.from([0, 1, 2, 3, 255]) });
    r = push(repo, ["origin", "HEAD:refs/heads/foo"]);
    check("real push: HEAD:refs/heads/foo from a rebrand branch refused", r.code !== 0, r.out);
    r = push(repo, ["origin", `${priv}:refs/heads/bar`]);
    check("real push: sha refspec of a rebrand commit refused", r.code !== 0, r.out);
    git(repo, ["branch", "copied", "rebrand/x"]);
    r = push(repo, ["origin", "copied"]);
    check("real push: branch copied from a rebrand branch refused", r.code !== 0, r.out);
    git(repo, ["checkout", "-q", "master"]);
    git(repo, ["checkout", "-q", "-b", "feat/clean"]);
    commit(repo, { "c.txt": "fine\n" });
    r = push(repo, ["origin", "feat/clean"]);
    check("real push: clean branch allowed beside a local rebrand branch", r.code === 0, r.out);

    const noMaster = realRepo();
    branchWith(noMaster, "rebrand/y", { "k.bin": Buffer.from([9, 0, 9]) });
    git(noMaster, ["update-ref", "-d", "refs/remotes/origin/master"]);
    r = push(noMaster, ["origin", "HEAD:refs/heads/foo"]);
    check(
      "real push: rebrand overlap with origin/master missing fails closed",
      r.code !== 0,
      r.out,
    );

    // delete-only and missing patterns file
    r = push(repo, ["origin", "--delete", "feat/clean"]);
    check("real push: delete with patterns file present allowed", r.code === 0, r.out);
    git(repo, ["checkout", "-q", "-b", "feat/del", "master"]);
    commit(repo, { "d.txt": "fine\n" });
    r = push(repo, ["origin", "feat/del"]);
    check("real push: setup branch for the delete case pushed", r.code === 0, r.out);
    git(repo, ["checkout", "-q", "feat/clean"]);
    rmSync(path.join(repo, ".git", "info", "leak-patterns"));
    r = push(repo, ["origin", "feat/clean"]);
    check("real push: missing patterns file refuses a content push", r.code !== 0, r.out);
    r = push(repo, ["origin", "feat/clean"], { CI: "true" });
    check("real push: CI=true on a dev machine does not skip the scan", r.code !== 0, r.out);
    git(repo, ["checkout", "-q", "master"]);
    r = push(repo, ["origin", "--delete", "feat/del"]);
    check("real push: delete-only allowed with the patterns file missing", r.code === 0, r.out);
    // sentinel-only patterns file: the content scan must not silently turn off
    {
      const sr = realRepo();
      writeFileSync(path.join(sr, ".git", "info", "leak-patterns"), `commit:${"c".repeat(40)}\n`);
      branchWith(sr, "feat/leaky2", { "b.txt": "x zzfixture y\n" });
      const q = push(sr, ["origin", "feat/leaky2"]);
      check("real push: sentinel-only patterns file refuses the push", q.code !== 0, q.out);
    }
    // path: prefixes, real pushes
    {
      const sr = realRepo();
      writeFileSync(path.join(sr, ".git", "info", "leak-patterns"), `${FIXTURE}\npath:zzkit/\n`);
      const bin = Buffer.from([0, 1, 2, 255, 0]);
      branchWith(sr, "feat/img", { "zzkit/logo.bin": bin });
      let q = push(sr, ["origin", "feat/img"]);
      check("real push: added binary under a listed path refused", q.code !== 0, q.out);
      q = push(sr, ["origin", "feat/img"], { RF_REBRAND_PUSH: "launch" });
      check("real push: path launch escape allows", q.code === 0, q.out);
      branchWith(sr, "feat/img2", { "other/logo.bin": bin });
      q = push(sr, ["origin", "feat/img2"]);
      check("real push: the same file outside the listed path allowed", q.code === 0, q.out);
    }
    // private sentinel commits: `commit:<sha>` lines in the patterns file hold whatever the branch is called
    {
      const sr = realRepo();
      const sentinel = branchWith(sr, "work", { "kit.bin": Buffer.from([7, 0, 7]) });
      commit(sr, { "more.txt": "fine\n" });
      git(sr, ["branch", "-m", "work", "innocuous"]); // a rename: no local rebrand/* ref remains
      const pf = path.join(sr, ".git", "info", "leak-patterns");
      writeFileSync(pf, `${FIXTURE}\ncommit:${sentinel}\n`);
      let q = push(sr, ["origin", "innocuous"]);
      check("sentinel: renamed branch holding a sentinel ancestor refused", q.code !== 0, q.out);
      q = push(sr, ["origin", "innocuous"], { RF_REBRAND_PUSH: "launch" });
      check("sentinel: RF_REBRAND_PUSH=launch lifts it", q.code === 0, q.out);
      git(sr, ["push", "-q", "origin", "--delete", "innocuous"]);
      git(sr, ["checkout", "-q", "-b", "feat/other", "master"]);
      commit(sr, { "o.txt": "fine\n" });
      q = push(sr, ["origin", "feat/other"]);
      check("sentinel: unrelated branch allowed", q.code === 0, q.out);
      writeFileSync(pf, `${FIXTURE}\ncommit:${"a".repeat(40)}\n`);
      commit(sr, { "p.txt": "fine\n" });
      q = push(sr, ["origin", "feat/other"]);
      check(
        "sentinel: unknown sentinel ignored with a notice",
        q.code === 0 && /sentinel/.test(q.out),
        q.out,
      );
    }
  }
  if (FULL) {
    // textconv cannot hide a hit
    {
      const { repo, base } = baseRepo();
      git(repo, ["config", "diff.zz.textconv", "echo harmless"]);
      const attrs = commit(repo, { ".gitattributes": "*.dat diff=zz\n" }, "chore: attrs");
      const head = commit(repo, { "x.dat": "zzfixture inside\n" });
      const r = cli(repo, ["--range", `${attrs}..${head}`]);
      check("textconv does not hide an added line", r.code === 1, JSON.stringify(r));
    }
    // zero-width and full-width variants
    {
      const { repo, base } = baseRepo();
      const zw = commit(repo, { "zw.txt": "zz​fix⁠ture\n" });
      check("zero-width variant is caught", cli(repo, ["--range", `${base}..${zw}`]).code === 1);
      const fw = commit(repo, { "fw.txt": "ｚｚＦＩＸＴＵＲＥ\n" });
      check("full-width variant is caught", cli(repo, ["--range", `${zw}..${fw}`]).code === 1);
      const st = cli(repo, ["--stdin"], {}, "qq‍secret");
      check("zero-width variant in --stdin text is caught", st.code === 1, JSON.stringify(st));
    }
    // delete-only push needs no patterns file
    {
      const repo = makeRepo({ patterns: null });
      const del = hook(repo, `(delete) ${ZERO} refs/heads/feat/x ${"1".repeat(40)}`);
      check(
        "hook: delete-only push passes with no patterns file",
        del.code === 0,
        JSON.stringify(del),
      );
    }
  }
} finally {
  rmSync(tmpRoot, { recursive: true, force: true });
}
console.log(`\nleak-check self-test: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
