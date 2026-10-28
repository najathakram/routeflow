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

const TMP = mkdtempSync(path.join(os.tmpdir(), "skills-drift-"));
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
  spawnSync("git", ["init", "-q", ck]);
  spawnSync("git", ["-C", ck, "add", "-A"]);
  spawnSync("git", [
    "-C",
    ck,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "-qm",
    "base",
  ]);
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
  const log = spawnSync("git", ["-C", ck, "log", "--oneline"], { encoding: "utf8" })
    .stdout.trim()
    .split("\n");
  const status = spawnSync("git", ["-C", ck, "status", "--short"], { encoding: "utf8" }).stdout;
  check(
    "D4 nothing is committed: one commit, a dirty tree",
    [log.length, status.trim().length > 0],
    [1, true],
  );
  check(
    "D4 the git commands for the owner's repo are printed, never run",
    res.commands.some((c) =>
      c.startsWith(`git -C "${realpathSync(ck).split(path.sep).join("/")}" add `),
    ) && res.commands.some((c) => / commit /.test(c)),
    true,
  );
  check("after sync: no drift", driftReport(repo, glob).drift, []);
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
check("usage: no mode exits 2", run([]).status, 2);

rmSync(TMP, { recursive: true, force: true });
console.log(`skills-drift self-test: ${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
