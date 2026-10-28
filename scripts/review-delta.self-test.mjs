#!/usr/bin/env node
// Self-test for scripts/review-delta.mjs (D1-D7 and M1-M4 of the R5 spec). Plain node; exit 1 on failure.
// Each case plants a throwaway repo in the OS temp dir and runs the real CLI against it.
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scrubbedGitEnv } from "./lib/check-git-hooks.mjs";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "review-delta.mjs");
let passed = 0;
let failed = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(
    `${ok ? "  ok  " : "  FAIL"} ${name}${ok ? "" : ` got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`,
  );
  if (ok) passed++;
  else failed++;
}

const dir = realpathSync.native(mkdtempSync(path.join(tmpdir(), "review-delta-")));
const git = (...a) => {
  const r = spawnSync(
    "git",
    [
      ...["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t"],
      ...["-c", "commit.gpgsign=false", "-c", "core.hooksPath="],
      ...a,
    ],
    { encoding: "utf8", env: scrubbedGitEnv(), timeout: 30000 },
  );
  if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
const put = (f, text) => {
  writeFileSync(path.join(dir, f), text);
  git("add", f);
};
const commit = (m) => git("commit", "-q", "-m", m);
const body = (n, line5 = "five") =>
  Array.from({ length: n }, (_, i) => (i === 4 ? line5 : `line ${i + 1}`)).join("\n") + "\n";
const delta = (a, b, base = "master") => {
  const r = spawnSync(process.execPath, [CLI, a, b, "--repo", dir, "--base", base], {
    encoding: "utf8",
    env: scrubbedGitEnv(),
    timeout: 60000,
  });
  return { code: r.status, out: r.stdout.trim() };
};

try {
  git("init", "-q", "-b", "master");
  // A leaked GIT_DIR would resolve to the outer repo: stop before any write touches it.
  const norm = (p) => p.split(path.sep).join("/").replace(/\/+$/, "").toLowerCase();
  if (norm(git("rev-parse", "--show-toplevel")) !== norm(dir))
    throw new Error(`planted repo resolved to ${git("rev-parse", "--show-toplevel")}, not ${dir}`);
  put("app.js", body(12));
  commit("chore: base");
  git("checkout", "-q", "-b", "feat");
  put("app.js", body(12, "pr five"));
  commit("feat: pr change");
  const v = git("rev-parse", "HEAD");
  git("checkout", "-q", "master");
  put("other.txt", "master moved\n");
  commit("chore: master moves");

  // D1: same tree, new message
  git("checkout", "-q", "-B", "d1", v);
  git("commit", "-q", "--amend", "-m", "feat: reworded");
  const d1 = delta(v, git("rev-parse", "HEAD"));
  check("D1 same tree carries", [d1.code, /carries: same-delta/.test(d1.out)], [0, true]);

  // D2: master merged into the branch
  git("checkout", "-q", "-B", "d2", v);
  git("merge", "-q", "--no-edit", "master");
  const d2 = delta(v, git("rev-parse", "HEAD"));
  check("D2 update-branch carries", [d2.code, /carries: same-delta/.test(d2.out)], [0, true]);

  // D3: rebased onto the newer master
  git("checkout", "-q", "-B", "d3", v);
  git("rebase", "-q", "master");
  const d3 = delta(v, git("rev-parse", "HEAD"));
  check("D3 clean rebase carries", [d3.code, /carries: same-delta/.test(d3.out)], [0, true]);

  // D4 (M1): a whitespace-only change is a hint for the lead, never a carry
  git("checkout", "-q", "-B", "d4", v);
  put("app.js", body(12, "  pr   five  "));
  commit("style: prettier");
  const d4 = delta(v, git("rev-parse", "HEAD"));
  check(
    "D4 whitespace-only is changed, not carried",
    [d4.code, /changed \(whitespace-only\)/.test(d4.out), /carries/.test(d4.out)],
    [1, true, false],
  );

  // M1: whitespace that changes meaning, from a fresh verdict commit on master
  const meaning = (name, file, before, after) => {
    git("checkout", "-q", "-B", name, "master");
    put(file, before);
    commit(`chore: ${name}`);
    const from = git("rev-parse", "HEAD");
    put(file, after);
    commit("style: whitespace");
    const r = delta(from, git("rev-parse", "HEAD"));
    check(
      `M1 ${name} is changed`,
      [r.code, /changed \(whitespace-only\)/.test(r.out), /carries/.test(r.out)],
      [1, true, false],
    );
  };
  meaning(
    "yaml-reindent",
    "ci.yml",
    "jobs:\n  build:\n    run: x\n  deploy:\n    run: y\n",
    "jobs:\n  build:\n    run: x\n    deploy:\n      run: y\n",
  );
  meaning(
    "python-dedent",
    "tool.py",
    "if ok:\n    first()\n    second()\n",
    "if ok:\n    first()\nsecond()\n",
  );
  meaning("string-literal", "str.js", 'const s = " ";\n', 'const s = "";\n');

  // M2: a re-indent plus a rebase onto a newer master (patch-id must not strip whitespace)
  git("checkout", "-q", "-B", "m2", v);
  git("rebase", "-q", "master");
  put("app.js", body(12, "  pr five"));
  commit("style: indent");
  const m2 = delta(v, git("rev-parse", "HEAD"));
  check("M2 re-indent plus rebase is changed", [m2.code, /carries/.test(m2.out)], [1, false]);

  // M3: update-branch resolved with "ours" has v's tree but reverts master's change
  git("checkout", "-q", "-B", "m3", v);
  git("merge", "-q", "-s", "ours", "--no-edit", "master");
  const m3 = delta(v, git("rev-parse", "HEAD"));
  check("M3 ours-resolved update-branch is changed", [m3.code, /carries/.test(m3.out)], [1, false]);

  // D5: one changed token
  git("checkout", "-q", "-B", "d5", v);
  put("app.js", body(12, "pr six"));
  commit("fix: token");
  const d5 = delta(v, git("rev-parse", "HEAD"));
  check(
    "D5 changed token exits 1 and lists the file",
    [d5.code, /changed/.test(d5.out), d5.out.includes("app.js")],
    [1, true, true],
  );

  // D6: rebase onto a master that touched the same line, conflict resolved inside the PR's lines
  git("checkout", "-q", "master");
  put("app.js", body(12, "master five"));
  commit("chore: master edits line five");
  git("checkout", "-q", "-B", "d6", "master");
  put("app.js", body(12, "merged five"));
  commit("feat: pr change, conflict resolved");
  const d6 = delta(v, git("rev-parse", "HEAD"));
  check("D6 resolved conflict is changed", [d6.code, /changed/.test(d6.out)], [1, true]);

  // D7: unknown sha
  const d7 = delta(v, "0".repeat(40));
  check("D7 unknown sha exits 2, claims nothing", [d7.code, /carries/.test(d7.out)], [2, false]);
  check("usage error exits 2", spawnSync(process.execPath, [CLI], { encoding: "utf8" }).status, 2);

  // M4: an empty PR delta never carries (nothing was compared)
  git("checkout", "-q", "master");
  put("m1.txt", "one\n");
  commit("chore: m1");
  const m1 = git("rev-parse", "HEAD");
  put("m2.txt", "two\n");
  commit("chore: m2");
  const both = delta(m1, git("rev-parse", "HEAD"));
  check("M4 two commits on master is changed", [both.code, /carries/.test(both.out)], [1, false]);
  const inBase = delta(v, git("rev-parse", "d5"), "d5");
  check(
    "M4 --base containing both is changed",
    [inBase.code, /carries/.test(inBase.out)],
    [1, false],
  );

  // M4: a local color.ui=always must not change what is compared
  git("config", "color.ui", "always");
  git("checkout", "-q", "-B", "m4c", "master");
  put("c.js", "a\nb\nc\n");
  commit("feat: c");
  const c0 = git("rev-parse", "HEAD");
  git("checkout", "-q", "master");
  put("m3.txt", "three\n");
  commit("chore: m3");
  git("checkout", "-q", "-B", "m4d", c0);
  git("rebase", "-q", "master");
  put("c.js", "a\nB\nc\n");
  commit("fix: real change");
  const color = delta(c0, git("rev-parse", "HEAD"));
  check(
    "M4 color.ui=always still sees a real change",
    [color.code, /carries/.test(color.out)],
    [1, false],
  );
  git("config", "--unset", "color.ui");

  // N1: patch-id ignores hunk positions, so the same edit in a twin block must not carry
  // identical 3-line context around each `cont`, so both edits hash to the same patch-id
  const step = (cont) =>
    `    s1: x\n    s2: x\n    s3: x\n    cont: ${cont}\n    s4: x\n    s5: x\n    s6: x\n`;
  const twin = `jobs:\n  test:\n${step(false)}  deploy:\n${step(false)}`;
  const inTest = `jobs:\n  test:\n${step(true)}  deploy:\n${step(false)}`;
  const inDeploy = `jobs:\n  test:\n${step(false)}  deploy:\n${step(true)}`;
  git("checkout", "-q", "-B", "n1base", "master");
  put("ci.yml", twin);
  commit("chore: twin steps");
  git("checkout", "-q", "-B", "n1v", "n1base");
  put("ci.yml", inTest);
  commit("ci: continue the test step");
  const n1v = git("rev-parse", "HEAD");
  const moved = (name, prep) => {
    git("checkout", "-q", "-B", name, "n1base");
    put("ci.yml", inDeploy);
    commit("ci: continue the deploy step");
    prep?.();
    const r = delta(n1v, git("rev-parse", "HEAD"), "n1base");
    check(`N1 ${name} is changed`, [r.code, /carries/.test(r.out)], [1, false]);
  };
  moved("relocated");
  moved("relocated-merge", () => {
    git("checkout", "-q", "n1base");
    put("other2.txt", "base moves\n");
    commit("chore: base moves");
    git("checkout", "-q", "relocated-merge");
    git("merge", "-q", "--no-edit", "n1base");
  });
  // the base moved under a PR file (no conflict): the re-read must cover it, so it never carries
  git("checkout", "-q", "-B", "n1same", n1v);
  git("checkout", "-q", "n1base");
  put("ci.yml", twin + "  lint:\n    run: npm run lint\n");
  commit("chore: base edits ci.yml elsewhere");
  git("checkout", "-q", "n1same");
  git("rebase", "-q", "n1base");
  const n1s = delta(n1v, git("rev-parse", "HEAD"), "n1base");
  check(
    "N1 base moved under a PR file is changed (base-moved), listing it",
    [n1s.code, /changed \(base-moved\)/.test(n1s.out), n1s.out.includes("ci.yml")],
    [1, true, true],
  );

  // SHOULD: the ours-resolved update-branch names why and what to re-read
  check(
    "M3 kind is base-moved and lists master's file",
    [/changed \(base-moved\)/.test(m3.out), m3.out.includes("other.txt")],
    [true, true],
  );

  // N2: a diff textconv in the repo's config must not change what is compared
  git("checkout", "-q", "-B", "n2base", "master");
  put("t.js", "x\n");
  commit("chore: t");
  git("checkout", "-q", "-B", "n2v", "n2base");
  put("t.js", "y\n");
  commit("feat: x to y");
  const n2v = git("rev-parse", "HEAD");
  git("checkout", "-q", "n2base");
  put("o.txt", "o\n");
  commit("chore: base moves");
  git("checkout", "-q", "-B", "n2h", "n2base");
  put("t.js", "EVIL\n");
  commit("feat: x to EVIL");
  writeFileSync(path.join(dir, ".git", "info", "attributes"), "*.js diff=k\n");
  git("config", "diff.k.textconv", "sh -c 'sed s/EVIL/y/ \"$1\"' --");
  const n2 = delta(n2v, git("rev-parse", "HEAD"), "n2base");
  check("N2 textconv cannot hide a real change", [n2.code, /carries/.test(n2.out)], [1, false]);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(`review-delta self-test: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
