#!/usr/bin/env node
// Self-test for scripts/skills-drift.mjs (R7-b). Plain node: `node scripts/skills-drift.self-test.mjs`.
// Every case builds a temp "repo" skills dir and a temp "global" one; nothing under ~/.claude is read or written.
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { IGNORE, diffSkill, driftReport, pairedSkills, syncSkills } from "./skills-drift.mjs";
import { scrubbedGitEnv } from "./lib/check-git-hooks.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "skills-drift.mjs");
let failures = 0;
let passed = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) passed++;
  else failures++;
  console.log(
    `${ok ? "  ok  " : "  FAIL"} ${name}${ok ? "" : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`,
  );
};

const TMP = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "skills-drift-")));
const norm = (p) => p.split(path.sep).join("/").replace(/\/+$/, "").toLowerCase();

/** Scratch-repo git: hook-inherited GIT_* scrubbed, no signing, no hooks, and a failure throws here. */
const git = (cwd, args) => {
  const r = spawnSync(
    "git",
    [
      ...["-c", "commit.gpgsign=false", "-c", "core.hooksPath="],
      ...["-c", "user.name=t", "-c", "user.email=t@t"],
      ...args,
    ],
    { cwd, encoding: "utf8", env: scrubbedGitEnv() },
  );
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} in ${cwd}: ${r.stderr}`);
  return r.stdout;
};
/** A committed scratch checkout; the toplevel guard proves no GIT_* leak points git at the outer repo. */
const initRepo = (dir) => {
  git(dir, ["init", "-q"]);
  const top = git(dir, ["rev-parse", "--show-toplevel"]).trim();
  if (norm(top) !== norm(dir)) throw new Error(`scratch repo resolved to ${top}, not ${dir}`);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "base"]);
};
const put = (file, text) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};
/** A fresh pair of skills dirs: repo has `a` (SKILL.md, scripts/x.mjs) and `only-repo`; global has `a` and `other`. */
const fresh = (name) => {
  const root = path.join(TMP, name);
  const repo = path.join(root, "repo");
  const glob = path.join(root, "global");
  for (const base of [repo, glob]) {
    put(path.join(base, "a", "SKILL.md"), "# a\n");
    put(path.join(base, "a", "scripts", "x.mjs"), "export {};\n");
  }
  put(path.join(repo, "only-repo", "SKILL.md"), "# r\n");
  put(path.join(glob, "other", "SKILL.md"), "# o\n");
  return { repo, glob };
};
const run = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });

{
  const { repo, glob } = fresh("d2");
  check("D2 identical trees: no drift", driftReport(repo, glob).drift, []);
  check("pairedSkills: only names on both sides", pairedSkills(repo, glob), ["a"]);
  check("D2 CLI exits 0", run(["--check", "--repo", repo, "--global", glob]).status, 0);
}
{
  const { repo, glob } = fresh("d1");
  put(path.join(glob, "a", "SKILL.md"), "# a, edited in the second copy\n");
  put(path.join(repo, "a", "references", "new.md"), "new\n");
  check(
    "D1 a differing file and a repo file missing globally are drift, by name",
    driftReport(repo, glob).drift,
    [
      { skill: "a", file: "SKILL.md", kind: "differs" },
      { skill: "a", file: "references/new.md", kind: "missing-global" },
    ],
  );
  const r = run(["--check", "--repo", repo, "--global", glob]);
  check(
    "D1 CLI exits 1 and names each file",
    [r.status, /a\/SKILL\.md/.test(r.stdout), /a\/references\/new\.md/.test(r.stdout)],
    [1, true, true],
  );
  const w = run(["--check", "--warn", "--repo", repo, "--global", glob]);
  check(
    "--warn prints one line naming the skill and exits 0",
    [w.status, w.stdout.trim().split("\n").length, /2 file\(s\) differ .* in a;/.test(w.stdout)],
    [0, 1, true],
  );
}
{
  const { repo, glob } = fresh("warn-clean");
  check(
    "--warn on clean trees prints nothing",
    run(["--check", "--warn", "--repo", repo, "--global", glob]).stdout,
    "",
  );
}
{
  const { repo, glob } = fresh("extra");
  put(path.join(glob, "a", "references", "old.md"), "old\n");
  put(path.join(glob, "a", "SKILL.md.bak-20261001"), "backup\n");
  put(path.join(glob, "a", "__pycache__", "m.pyc"), "x");
  const rep = driftReport(repo, glob);
  check(
    "a real global-only file is an extra (reported, not drift); ignored junk is neither",
    [rep.drift, rep.extra],
    [[], [{ skill: "a", file: "references/old.md", kind: "global-only" }]],
  );
  check(
    "IGNORE covers backups, caches and graphify output",
    [
      "x.bak-1",
      "a.bak",
      "__pycache__/m.pyc",
      "graphify-out/g.json",
      "node_modules/p/i.js",
      ".DS_Store",
    ].every((f) => IGNORE.some((re) => re.test(f))),
    true,
  );
}
{
  // D3: the global skill dir is a junction (Windows) / dir symlink (POSIX) into a claude-skills checkout.
  const { repo, glob } = fresh("d3");
  const target = path.join(TMP, "d3", "claude-skills", "a");
  put(path.join(target, "SKILL.md"), "# a, older\n");
  put(path.join(target, "scripts", "x.mjs"), "export {};\n");
  rmSync(path.join(glob, "a"), { recursive: true });
  symlinkSync(target, path.join(glob, "a"), "junction");
  check(
    "D3 a junctioned global dir is followed and compared",
    diffSkill(path.join(repo, "a"), path.join(glob, "a")),
    { differs: ["SKILL.md"], missingGlobal: [], globalOnly: [] },
  );
}
{
  // D4: --sync writes the repo copies through the junction, commits nothing, prints the git commands.
  const { repo, glob } = fresh("d4");
  const ck = path.join(TMP, "d4", "claude-skills");
  put(path.join(ck, "a", "SKILL.md"), "# a, older\n");
  put(path.join(ck, "a", "scripts", "x.mjs"), "export {};\n");
  initRepo(ck);
  rmSync(path.join(glob, "a"), { recursive: true });
  symlinkSync(path.join(ck, "a"), path.join(glob, "a"), "junction");
  put(path.join(repo, "a", "references", "new.md"), "new\n");
  const res = syncSkills(repo, glob);
  check(
    "D4 sync copies the differing and missing files into the real target",
    [
      readFileSync(path.join(ck, "a", "SKILL.md"), "utf8"),
      existsSync(path.join(ck, "a", "references", "new.md")),
    ],
    ["# a\n", true],
  );
  check("D4 sync reports what it copied", res.copied, ["a/SKILL.md", "a/references/new.md"]);
  const log = git(ck, ["log", "--oneline"]).trim().split("\n");
  const status = git(ck, ["status", "--short"]);
  check(
    "D4 nothing is committed: one commit, a dirty tree",
    [log.length, status.trim().length > 0],
    [1, true],
  );
  check(
    "D4 the git commands for the owner's repo are printed, never run",
    res.commands.some((c) => c.startsWith(`git -C "${ck.split(path.sep).join("/")}" add `)) &&
      res.commands.some((c) => / commit /.test(c)),
    true,
  );
  check("after sync: no drift", driftReport(repo, glob).drift, []);

  // D6: an uncommitted global edit is the only copy of that text, so sync refuses to overwrite it.
  put(path.join(ck, "a", "SKILL.md"), "# a, edited by hand and not committed\n");
  put(path.join(repo, "a", "references", "two.md"), "two\n");
  const d6 = syncSkills(repo, glob);
  check(
    "D6 an uncommitted global edit is refused and kept; a new file is still written",
    [
      d6.refused.map((r) => [r.file, /uncommitted/.test(r.why)]),
      readFileSync(path.join(ck, "a", "SKILL.md"), "utf8"),
      d6.copied,
    ],
    [[["a/SKILL.md", true]], "# a, edited by hand and not committed\n", ["a/references/two.md"]],
  );
}
{
  // D5: a plain global dir (no git) has no history, so an overwrite is refused unless --force; the CLI exits 1.
  const { repo, glob } = fresh("d5");
  put(path.join(glob, "a", "SKILL.md"), "# a, only copy\n");
  const inGit = spawnSync("git", ["-C", glob, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    env: scrubbedGitEnv(),
  });
  check("D5 precondition: the temp dir is outside any git checkout", inGit.status !== 0, true);
  const r = run(["--sync", "--repo", repo, "--global", glob]);
  check(
    "D5 outside git: refused, exit 1, the global text survives",
    [
      r.status,
      /refused a\/SKILL\.md: not in a git checkout/.test(r.stdout),
      readFileSync(path.join(glob, "a", "SKILL.md"), "utf8"),
    ],
    [1, true, "# a, only copy\n"],
  );
  const f = run(["--sync", "--force", "--repo", repo, "--global", glob]);
  check(
    "D5 --force overwrites",
    [f.status, readFileSync(path.join(glob, "a", "SKILL.md"), "utf8")],
    [0, "# a\n"],
  );
}
{
  const r = run([
    "--check",
    "--repo",
    path.join(TMP, "nope-repo"),
    "--global",
    path.join(TMP, "nope"),
  ]);
  check(
    "no global skills dir (CI): says so and exits 0",
    [r.status, /no global skills dir/.test(r.stdout)],
    [0, true],
  );
}
{
  // D7: a gitignored or untracked global file is not in git's history, so an overwrite would lose it: refused.
  const { repo, glob } = fresh("d7");
  const ck = path.join(TMP, "d7", "claude-skills");
  put(path.join(ck, "a", "SKILL.md"), "# a\n");
  put(path.join(ck, ".gitignore"), "local.md\n");
  initRepo(ck);
  put(path.join(ck, "a", "local.md"), "ignored, only copy\n");
  put(path.join(ck, "a", "loose.md"), "untracked, only copy\n");
  for (const f of ["local.md", "loose.md"]) put(path.join(repo, "a", f), "repo\n");
  rmSync(path.join(glob, "a"), { recursive: true });
  symlinkSync(path.join(ck, "a"), path.join(glob, "a"), "junction");
  const d7 = syncSkills(repo, glob);
  check(
    "D7 ignored and untracked global files are refused and kept",
    [
      d7.refused.map((r) => [r.file, /not tracked/.test(r.why)]),
      readFileSync(path.join(ck, "a", "local.md"), "utf8"),
      readFileSync(path.join(ck, "a", "loose.md"), "utf8"),
    ],
    [
      [
        ["a/local.md", true],
        ["a/loose.md", true],
      ],
      "ignored, only copy\n",
      "untracked, only copy\n",
    ],
  );
}
{
  // D8: logs and ledgers grow per machine; they are never compared, so never synced.
  const { repo, glob } = fresh("d8");
  put(path.join(repo, "a", "references", "RUN-LOG.md"), "repo rows\n");
  put(path.join(glob, "a", "references", "RUN-LOG.md"), "global rows\n");
  put(path.join(repo, "a", "ledger.jsonl"), "{}\n");
  check("D8 RUN-LOG.md and *.jsonl are not drift", driftReport(repo, glob).drift, []);
}
{
  // D9: CRLF vs LF text is equal; a binary file (NUL byte) compares byte for byte.
  const { repo, glob } = fresh("d9");
  put(path.join(glob, "a", "SKILL.md"), "# a\r\n");
  put(path.join(repo, "a", "b.bin"), Buffer.from([0, 13, 10, 1]));
  put(path.join(glob, "a", "b.bin"), Buffer.from([0, 10, 1]));
  check(
    "D9 CRLF text is equal, a CRLF change inside a binary is drift",
    driftReport(repo, glob).drift,
    [{ skill: "a", file: "b.bin", kind: "differs" }],
  );
}
check("usage: no mode exits 2", run([]).status, 2);

rmSync(TMP, { recursive: true, force: true });
console.log(`skills-drift self-test: ${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
