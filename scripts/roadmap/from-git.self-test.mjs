#!/usr/bin/env node
// Coverage for scripts/roadmap/from-git.mjs (F-22 WP2, build-plan.md
// 2026-09-24-f22-tracking-engine). Same standalone-script convention as
// render.self-test.mjs / plane-triage.self-test.mjs — no node:test:
// `node scripts/roadmap/from-git.self-test.mjs`, PASS/FAIL lines,
// `process.exit(failures ? 1 : 0)`.
//
// T11-T17, T36 (test-plan.md). Fixture repo G is a throwaway `git init` tree, env scrubbed via
// plane-client.mjs's scrubbedGitEnv() (the worktree-hook trap).
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { scrubbedGitEnv } from "../lib/check-git-hooks.mjs";

const t0 = performance.now();
const SCRIPT_PATH = fileURLToPath(new URL("./from-git.mjs", import.meta.url));
const CLI_BUDGET_MS = Number(process.env.ROADMAP_SELF_TEST_CLI_BUDGET_MS) || 90_000;

const { parseTrailers, gitRootOf, defaultSince, readCommits, buildReport, applyPrs } =
  await import("./from-git.mjs");

const FIXTURE_PREFIX = `from-git-self-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}-`;
const FIXTURE_DIRS = [];
function newFixtureDir() {
  const dir = mkdtempSync(join(tmpdir(), FIXTURE_PREFIX));
  FIXTURE_DIRS.push(dir);
  return dir;
}
function countFixtureTmpDirs() {
  return readdirSync(tmpdir()).filter((n) => n.startsWith(FIXTURE_PREFIX)).length;
}
function cleanupFixtures() {
  const dirs = FIXTURE_DIRS.splice(0);
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // a fixture dir that refuses to go must never turn a passing run red
    }
  }
  return dirs;
}

let failures = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(
    `${ok ? "  ok  " : "  FAIL"} ${name}${ok ? "" : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`,
  );
}
function checkTrue(name, cond, detail) {
  if (!cond) failures++;
  console.log(
    `${cond ? "  ok  " : "  FAIL"} ${name}${cond ? "" : detail ? `\n        ${detail}` : ""}`,
  );
}

// ── T11 fixture table (§2.1) ────────────────────────────────────────────────
const T11_CASES = [
  {
    body: "feat: x\n\nFeature: F-07",
    want: { features: ["F-07"], bugs: [], defers: [], unknown: [] },
  },
  {
    body: "Feature: F-07, F-08\nBug: B661\nDefers: D-09",
    want: { features: ["F-07", "F-08"], bugs: ["B661"], defers: ["D-09"], unknown: [] },
  },
  { body: "Feature: F-42", want: { features: ["F-42"], bugs: [], defers: [], unknown: [] } },
  { body: "Feature: banana", want: { features: [], bugs: [], defers: [], unknown: ["banana"] } },
  {
    body: "Feature: F-07\nFeature: F-07",
    want: { features: ["F-07"], bugs: [], defers: [], unknown: [] },
  },
  {
    body: "Bookkeeping-Follow-Up: pending\nfeature: F-07",
    want: { features: [], bugs: [], defers: [], unknown: [] },
  },
  { body: "Bug: B7 B8", want: { features: [], bugs: ["B7", "B8"], defers: [], unknown: [] } },
  {
    body: "Feature: F-\nBug: B\nDefers: D-",
    want: { features: [], bugs: [], defers: [], unknown: [] },
  },
  { body: "Feature: B7", want: { features: [], bugs: [], defers: [], unknown: ["B7"] } },
  { body: "", want: { features: [], bugs: [], defers: [], unknown: [] } },
];

function t11() {
  for (const [i, c] of T11_CASES.entries()) {
    check(`T11 case ${i}`, parseTrailers(c.body), c.want);
  }
}

// ── fixture repo G ──────────────────────────────────────────────────────────
function gitRun(dir, args) {
  const r = spawnSync("git", ["-C", dir, ...args], { env: scrubbedGitEnv(), encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}
function commitG(dir, subject, trailerLine) {
  appendFileSync(join(dir, "notes.txt"), `${subject}\n`);
  gitRun(dir, ["add", "-A"]);
  const msg = trailerLine ? `${subject}\n\n${trailerLine}` : subject;
  gitRun(dir, ["commit", "-q", "-m", msg]);
  return gitRun(dir, ["rev-parse", "HEAD"]).trim();
}
function writeRegs(regDir, { f01Prs = [101], f02Prs = [] } = {}) {
  mkdirSync(regDir, { recursive: true });
  const features = [
    {
      id: "F-01",
      name: "Alpha",
      description: "d",
      status: "planned",
      percentDone: 0,
      release: "R1",
      targetDate: "2026-01-10",
      area: "roadmap",
      public: true,
      prs: f01Prs,
      dependsOn: [],
    },
    {
      id: "F-02",
      name: "Beta",
      description: "d",
      status: "planned",
      percentDone: 0,
      release: "R1",
      targetDate: "2026-01-11",
      area: "roadmap",
      public: true,
      prs: f02Prs,
      dependsOn: [],
    },
  ];
  // The F-02 line carries a deliberate non-canonical byte (a space after one comma) that
  // JSON.stringify never reproduces on a round-trip — a full re-serialize (rather than a
  // substring-only prs[] patch) would silently normalize it away. Mutation-probe target #4.
  const rawLines = features.map((f) => JSON.stringify(f));
  rawLines[1] = rawLines[1].replace('"description":"d",', '"description":"d", ');
  writeFileSync(join(regDir, "features.jsonl"), rawLines.join("\n") + "\n");
  writeFileSync(join(regDir, "deferred.jsonl"), "");
  writeFileSync(
    join(regDir, "releases.jsonl"),
    JSON.stringify({
      id: "R1",
      name: "Release One",
      shipDate: "2026-01-15",
      status: "in-progress",
      goal: "g",
    }) + "\n",
  );
}

// Builds fixture repo G: c0 seed (README + regs) then c1-c6 per test-plan.md §7.
function buildRepoG(defectFn = null) {
  const dir = newFixtureDir();
  gitRun(dir, ["init", "-q"]);
  gitRun(dir, ["config", "user.name", "t"]);
  gitRun(dir, ["config", "user.email", "t@example.invalid"]);
  const regDir = join(dir, ".claude", "roadmap");
  mkdirSync(regDir, { recursive: true });
  writeFileSync(join(regDir, "README.md"), "# roadmap registers\n");
  writeRegs(regDir);
  if (defectFn) defectFn(regDir);
  gitRun(dir, ["add", "-A"]);
  gitRun(dir, ["commit", "-q", "-m", "docs(roadmap): seed (#100)"]);
  const c0 = gitRun(dir, ["rev-parse", "HEAD"]).trim();
  const c1 = commitG(dir, "feat: one (#101)", "Feature: F-01");
  const c2 = commitG(dir, "feat: two (#102)", "Feature: F-02");
  const c3 = commitG(dir, "fix: three (#103)", "Feature: F-42");
  const c4 = commitG(dir, "fix: four (#104)", "Bug: B7");
  const c5 = commitG(dir, "chore: five (#105)", null);
  const c6 = commitG(dir, "chore: six (#106)", null);
  return { dir, regDir, shas: { c0, c1, c2, c3, c4, c5, c6 } };
}
const sha7 = (s) => s.slice(0, 7);

// Every working-tree file's bytes (outside .git) plus the index, HEAD, refs and status.
function snapshotRepo(dir) {
  const files = {};
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === ".git") continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else files[p.slice(dir.length)] = readFileSync(p, "utf8");
    }
  };
  walk(dir);
  return {
    files,
    index: gitRun(dir, ["ls-files", "-s"]),
    head: gitRun(dir, ["rev-parse", "HEAD"]),
    refs: gitRun(dir, ["for-each-ref"]),
    status: gitRun(dir, ["status", "--porcelain", "--untracked-files=all"]),
  };
}

function runCli(argv, { regDir, env = {} } = {}) {
  return new Promise((resolve) => {
    const childEnv = { ...process.env, ...env };
    if (regDir) ((childEnv.ROADMAP_SELF_TEST = "1"), (childEnv.ROADMAP_REG_DIR = regDir));
    const child = spawn(process.execPath, [SCRIPT_PATH, ...argv], {
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), CLI_BUDGET_MS);
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

// ── T12: report shape over fixture repo G ───────────────────────────────────
async function t12() {
  const { regDir, shas } = buildRepoG();
  const { code, stdout, stderr } = await runCli([], { regDir });
  checkTrue("T12 exit 0", code === 0, `stderr=${stderr}`);
  const expected = [
    "Proposed prs[] appends",
    `  F-02: #102  ${sha7(shas.c2)}  feat: two (#102)`,
    "Unknown ids",
    `  F-42  ${sha7(shas.c3)}  fix: three (#103)`,
    "Bug/Defers trailers seen",
    `  Bug: B7  ${sha7(shas.c4)}  fix: four (#104)`,
    "Coverage",
    `  4 of 6 commits since ${sha7(shas.c0)} carry a roadmap trailer (67%)`,
    "  untagged:",
    `    ${sha7(shas.c5)}  chore: five (#105)`,
    `    ${sha7(shas.c6)}  chore: six (#106)`,
    "",
  ].join("\n");
  check("T12 stdout line-for-line", stdout, expected);
}

// ── T12m: --first-parent drops a true merge's second-parent trailers ────────
async function t12m() {
  const { dir, regDir, shas } = buildRepoG();
  // A side branch off c6 carries its own trailers, then merges back with --no-ff.
  gitRun(dir, ["checkout", "-q", "-b", "side"]);
  const side = commitG(dir, "wip: side (#107)", "Bug: B9\nFeature: F-99");
  gitRun(dir, ["checkout", "-q", "-"]);
  gitRun(dir, ["merge", "-q", "--no-ff", "side", "-m", "Merge side (#108)"]);
  const merge = gitRun(dir, ["rev-parse", "HEAD"]).trim();
  // The fixture really crosses a merge: HEAD has two parents and the side commit is in range.
  check(
    "T12m merge has two parents",
    gitRun(dir, ["rev-list", "--parents", "-n", "1", "HEAD"]).trim().split(" ").length,
    3,
  );
  checkTrue(
    "T12m side commit is reachable in range",
    gitRun(dir, ["rev-list", `${shas.c6}..HEAD`]).includes(side),
  );

  const { code, stdout, stderr } = await runCli(["--since", shas.c6], { regDir });
  checkTrue("T12m exit 0", code === 0, `stderr=${stderr}`);
  checkTrue("T12m second-parent Bug trailer not reported", !stdout.includes("B9"), stdout);
  checkTrue("T12m second-parent Feature trailer not reported", !stdout.includes("F-99"), stdout);
  checkTrue("T12m side commit not listed", !stdout.includes(sha7(side)), stdout);
  checkTrue(
    "T12m only the merge commit is walked",
    stdout.includes(`  0 of 1 commits since ${sha7(shas.c6)} carry a roadmap trailer`) &&
      stdout.includes(`    ${sha7(merge)}  Merge side (#108)`),
    stdout,
  );
}

// ── T13: unusable git → exit 2 ───────────────────────────────────────────────
async function t13() {
  const { regDir } = buildRepoG();
  const a = await runCli(["--since", "no-such-ref"], { regDir });
  checkTrue("T13a exit 2", a.code === 2, `got ${a.code}`);
  checkTrue("T13a stderr starts from-git:", a.stderr.startsWith("from-git:"), a.stderr);
  checkTrue("T13a one stderr line", a.stderr.trim().split("\n").length === 1, a.stderr);

  const nonGit = newFixtureDir();
  const b = await runCli([], { regDir: nonGit });
  checkTrue("T13b exit 2", b.code === 2, `got ${b.code}`);
  checkTrue("T13b stderr starts from-git:", b.stderr.startsWith("from-git:"), b.stderr);
  checkTrue("T13b one stderr line", b.stderr.trim().split("\n").length === 1, b.stderr);
}

// ── T14: --apply lifecycle ───────────────────────────────────────────────────
async function t14() {
  const { dir, regDir } = buildRepoG();
  const before = readFileSync(join(regDir, "features.jsonl"), "utf8");

  // (a) first --apply
  const a = await runCli(["--apply"], { regDir });
  checkTrue("T14a exit 0", a.code === 0, `stderr=${a.stderr}`);
  checkTrue(
    "T14a stdout has git diff --stat",
    / \| /.test(a.stdout) || a.stdout.includes("features.jsonl"),
    a.stdout,
  );
  const cached = gitRun(dir, ["diff", "--cached"]);
  check("T14a git diff --cached empty", cached, "");
  const afterA = readFileSync(join(regDir, "features.jsonl"), "utf8");
  const beforeLines = before.split("\n");
  const afterLines = afterA.split("\n");
  check("T14a same line count", afterLines.length, beforeLines.length);
  let diffLines = [];
  for (let i = 0; i < beforeLines.length; i++)
    if (beforeLines[i] !== afterLines[i]) diffLines.push(i);
  check("T14a exactly one line changed", diffLines, [1]);
  if (diffLines.length === 1) {
    const bLine = beforeLines[diffLines[0]];
    const aLine = afterLines[diffLines[0]];
    check("T14a before line prs substring", /"prs":\[\]/.test(bLine), true);
    check("T14a after line prs substring", /"prs":\[102\]/.test(aLine), true);
    check(
      "T14a rest of line byte-identical (minus prs substring)",
      bLine.replace('"prs":[]', "X"),
      aLine.replace('"prs":[102]', "X"),
    );
  }

  // deferred.jsonl and releases.jsonl untouched
  check("T14a deferred.jsonl unchanged", readFileSync(join(regDir, "deferred.jsonl"), "utf8"), "");

  // commit the apply result, as the brief instructs, before (b)
  gitRun(dir, ["add", "-A"]);
  gitRun(dir, ["commit", "-q", "-m", "chore(roadmap): apply prs[]"]);

  // (b) --apply again: nothing to write
  const b = await runCli(["--apply"], { regDir });
  checkTrue("T14b exit 0", b.code === 0, `stderr=${b.stderr}`);
  checkTrue("T14b nothing-to-write", b.stdout.includes("--apply: nothing to write"), b.stdout);
  checkTrue(
    "T14b tree clean",
    gitRun(dir, ["status", "--porcelain"]).trim() === "",
    "dirty after b",
  );

  // (c) dirty tree
  appendFileSync(join(regDir, "features.jsonl"), "");
  writeFileSync(
    join(regDir, "features.jsonl"),
    readFileSync(join(regDir, "features.jsonl"), "utf8") + " ",
  );
  const beforeC = readFileSync(join(regDir, "features.jsonl"), "utf8");
  const c = await runCli(["--apply"], { regDir });
  checkTrue("T14c exit 1", c.code === 1, `got ${c.code}`);
  check(
    "T14c stderr",
    c.stderr.trim(),
    "from-git: refusing --apply — .claude/roadmap has uncommitted changes",
  );
  check("T14c file unchanged", readFileSync(join(regDir, "features.jsonl"), "utf8"), beforeC);
  gitRun(dir, ["checkout", "--", join(regDir, "features.jsonl")]);

  // (d) defect D1 (duplicate feature id) committed, then --apply
  const feats = readFileSync(join(regDir, "features.jsonl"), "utf8");
  const firstLine = feats.split("\n").filter(Boolean)[0];
  writeFileSync(join(regDir, "features.jsonl"), feats.trimEnd() + "\n" + firstLine + "\n");
  gitRun(dir, ["add", "-A"]);
  gitRun(dir, ["commit", "-q", "-m", "test: inject D1 duplicate"]);
  const beforeD = readFileSync(join(regDir, "features.jsonl"), "utf8");
  const d = await runCli(["--apply"], { regDir });
  checkTrue("T14d exit 1", d.code === 1, `got ${d.code}`);
  check("T14d stderr", d.stderr.trim(), "from-git: refusing --apply — registers fail validation");
  check("T14d file unchanged", readFileSync(join(regDir, "features.jsonl"), "utf8"), beforeD);
}

// ── T15: report never mutates registers; static no-git-write-command check ──
async function t15() {
  const { dir, regDir } = buildRepoG();
  const before = {
    features: readFileSync(join(regDir, "features.jsonl"), "utf8"),
    deferred: readFileSync(join(regDir, "deferred.jsonl"), "utf8"),
    releases: readFileSync(join(regDir, "releases.jsonl"), "utf8"),
  };
  const repoBefore = snapshotRepo(dir);
  const report = await runCli([], { regDir }); // report only, no --apply
  // The fixture has pending appends (T14a writes one), so "zero writes" is meaningful here.
  checkTrue("T15 report run proposes an append", report.stdout.includes("#102"), report.stdout);
  checkTrue(
    "T15 report leaves registers byte-identical",
    readFileSync(join(regDir, "features.jsonl"), "utf8") === before.features &&
      readFileSync(join(regDir, "deferred.jsonl"), "utf8") === before.deferred &&
      readFileSync(join(regDir, "releases.jsonl"), "utf8") === before.releases,
    "a register file changed after a plain report run",
  );
  // Zero writes anywhere: every working-tree file, the index, HEAD, refs and status.
  check(
    "T15 report run makes zero writes (tree, index, HEAD, refs)",
    snapshotRepo(dir),
    repoBefore,
  );

  const roots = ["./from-git.mjs", "./publish.mjs", "./render.mjs"];
  const forbidden = [/git commit/, /git push/, /\bgh\b/];
  let sourcesPresent =
    existsSync(SCRIPT_PATH) && existsSync(new URL("./render.mjs", import.meta.url));
  checkTrue("T15 sourcesPresent (from-git.mjs + render.mjs exist)", sourcesPresent);
  for (const rel of roots) {
    const p = fileURLToPath(new URL(rel, import.meta.url));
    if (!existsSync(p)) continue; // publish.mjs doesn't exist until WP3 — existsSync-guarded
    const src = readFileSync(p, "utf8")
      .split("\n")
      .filter((l) => !/^\s*\/\//.test(l))
      .join("\n");
    const hit = forbidden.find((re) => re.test(src));
    checkTrue(`T15 ${rel} has no forbidden git-write pattern`, !hit, `matched ${hit}`);
  }
}

// ── T16: --status-equivalent (plain report) under a no-network stub ────────
async function t16() {
  const stubDir = newFixtureDir();
  const stubPath = join(stubDir, "no-net.mjs");
  writeFileSync(stubPath, 'globalThis.fetch = () => { throw new Error("network forbidden"); };\n');
  const { regDir } = buildRepoG();
  await new Promise((resolve) => {
    const childEnv = { ...process.env, ROADMAP_SELF_TEST: "1", ROADMAP_REG_DIR: regDir };
    const child = spawn(process.execPath, ["--import", pathToFileURL(stubPath).href, SCRIPT_PATH], {
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), CLI_BUDGET_MS);
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (code) => {
      clearTimeout(timer);
      checkTrue("T16 exit 0", code === 0, `got ${code}, stderr=${stderr}`);
      for (const header of [
        "Proposed prs[] appends",
        "Unknown ids",
        "Bug/Defers trailers seen",
        "Coverage",
      ]) {
        checkTrue(`T16 has "${header}"`, stdout.includes(header), stdout);
      }
      resolve();
    });
  });
}

// ── T17: --help / -h / --bogus ──────────────────────────────────────────────
async function t17() {
  for (const flag of ["--help", "-h"]) {
    const { code, stdout } = await runCli([flag]);
    checkTrue(`T17 ${flag} exit 0`, code === 0, `got ${code}`);
    checkTrue(`T17 ${flag} stdout starts Usage`, stdout.startsWith("Usage: from-git.mjs"), stdout);
  }
  const bogus = await runCli(["--bogus"]);
  checkTrue("T17 --bogus exit 2", bogus.code === 2, `got ${bogus.code}`);
  checkTrue(
    "T17 --bogus stderr starts Usage",
    bogus.stderr.startsWith("Usage: from-git.mjs"),
    bogus.stderr,
  );
}

// ── T17v (#2273): `npm run verify` runs this self-test ────────────────────────
// Unwired, this file protects nothing (the #2271 review found it orphaned), so it pins its own
// place in the root verify chain, the way google-signin-check's T8 does.
function t17v() {
  const pkg = JSON.parse(
    readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"),
  );
  const verify = typeof pkg.scripts?.verify === "string" ? pkg.scripts.verify : "";
  checkTrue(
    "T17v verify chain runs scripts/roadmap/from-git.self-test.mjs",
    verify
      .split("&&")
      .some((step) => step.trim() === "node scripts/roadmap/from-git.self-test.mjs"),
    "not found as its own `&&` step in package.json scripts.verify",
  );
}

async function main() {
  console.log("from-git.self-test");
  t11();
  await t12();
  await t12m();
  await t13();
  await t14();
  await t15();
  await t16();
  await t17();
  t17v();
}

try {
  await main();
} catch (err) {
  failures++;
  console.log(`  FAIL from-git.self-test threw: ${err?.stack ?? err}`);
} finally {
  cleanupFixtures();
  const remaining = countFixtureTmpDirs();
  if (remaining)
    console.log(`  note: ${remaining} fixture tmp dir(s) still present after cleanup (non-fatal)`);
}

const elapsedTotal = performance.now() - t0;
if (process.env.ROADMAP_SELF_TEST_BUDGET_MS) {
  const budgetTotal = Number(process.env.ROADMAP_SELF_TEST_BUDGET_MS);
  checkTrue(
    `T36 wall-clock under budget (${elapsedTotal.toFixed(1)}ms < ${budgetTotal}ms)`,
    elapsedTotal < budgetTotal,
    `elapsed=${elapsedTotal}`,
  );
} else {
  console.log(
    `  info  T36 wall-clock ${elapsedTotal.toFixed(1)}ms (no ROADMAP_SELF_TEST_BUDGET_MS set — advisory only)`,
  );
}

console.log(
  failures
    ? `\nfrom-git.self-test: ${failures} FAILURE(S) (${elapsedTotal.toFixed(0)}ms)`
    : `\nfrom-git.self-test: ok (${elapsedTotal.toFixed(0)}ms)`,
);
process.exit(failures ? 1 : 0);
