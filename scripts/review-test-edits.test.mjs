// node --test scripts/review-test-edits.test.mjs — builds a throwaway git repo and runs the real CLI.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { testRanges } from "./review-test-edits.mjs";
import { scrubbedGitEnv } from "./lib/check-git-hooks.mjs";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "review-test-edits.mjs");
const dir = realpathSync.native(mkdtempSync(path.join(tmpdir(), "rte-")));
after(() => rmSync(dir, { recursive: true, force: true }));
const git = (...a) =>
  execFileSync(
    "git",
    [
      "-C",
      dir,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=",
      ...a,
    ],
    { encoding: "utf8", env: scrubbedGitEnv() },
  ).trim();
const put = (f, text) => {
  mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
  writeFileSync(path.join(dir, f), text);
};
const run = (base, head, ...extra) =>
  spawnSync("node", [CLI, "--base", base, "--head", head, ...extra], {
    cwd: dir,
    encoding: "utf8",
    env: scrubbedGitEnv(),
  });

const BASE_SPEC = `describe("eligibility", () => {
  it("accepts a deposited check", () => {
    const check = { amount: 100, status: "deposited" };
    expect(isEligible(check)).toBe(true);
  });
  it("rejects a voided check", () => {
    expect(isEligible({ status: "voided" })).toBe(false);
  });
});
`;
const HEAD_SPEC = `describe("eligibility", () => {
  it("accepts a deposited check", () => {
    const check = { amount: 100, status: "deposited" };
    expect(isEligible(check)).toBe(false);
  });
  it("accepts a brand new check", () => {
    expect(isEligible({ status: "created" })).toBe(true);
  });
});
`;

git("init", "-q");
put("apps/api/src/elig.spec.ts", BASE_SPEC);
put("apps/api/src/other.ts", "export const x = 1;\n");
git("add", "-A");
git("commit", "-qm", "base");
const base = git("rev-parse", "HEAD");
put("apps/api/src/elig.spec.ts", HEAD_SPEC);
put("apps/api/src/other.ts", "export const x = 2;\n");
git("add", "-A");
git("commit", "-qm", "head");
const head = git("rev-parse", "HEAD");

test("flags changed expect and deleted test, ignores added test and non-test files", () => {
  const r = run(base, head);
  assert.equal(r.status, 1);
  assert.match(
    r.stdout,
    /elig\.spec\.ts:4 \[assertion\] expect\(isEligible\(check\)\)\.toBe\(true\)/,
  );
  assert.match(r.stdout, /elig\.spec\.ts:6 \[title\] it\("rejects a voided check"/);
  assert.match(r.stdout, /elig\.spec\.ts:7 \[assertion\]/);
  assert.doesNotMatch(r.stdout, /brand new/);
  assert.doesNotMatch(r.stdout, /other\.ts/);
});

test("--json lists findings with file, line, kind", () => {
  const out = JSON.parse(run(base, head, "--json").stdout);
  assert.deepEqual(
    out.findings.map((f) => [f.file, f.line, f.kind]),
    [
      ["apps/api/src/elig.spec.ts", 4, "assertion"],
      ["apps/api/src/elig.spec.ts", 6, "title"],
      ["apps/api/src/elig.spec.ts", 7, "assertion"],
    ],
  );
});

test("fixture literal changed inside a test is flagged", () => {
  put("apps/api/src/elig.spec.ts", BASE_SPEC.replace("amount: 100", "amount: 5"));
  git("commit", "-qam", "fixture");
  const r = run(base, git("rev-parse", "HEAD"));
  assert.equal(r.status, 1);
  assert.match(r.stdout, /elig\.spec\.ts:3 \[fixture\] const check/);
});

test("pure additions exit 0", () => {
  const mid = git("rev-parse", "HEAD");
  put("apps/api/src/new.spec.ts", `it("new", () => {\n  expect(1).toBe(1);\n});\n`);
  put(
    "apps/api/src/elig.spec.ts",
    BASE_SPEC.replace("amount: 100", "amount: 5") +
      `it("extra", () => {\n  expect(2).toBe(2);\n});\n`,
  );
  git("add", "-A");
  git("commit", "-qm", "adds");
  const r = run(mid, git("rev-parse", "HEAD"));
  assert.equal(r.status, 0);
  assert.match(r.stdout, /0 existing test line\(s\) removed or changed/);
});

/** Commit file=a then file=b; returns [baseSha, headSha]. */
const twoCommits = (file, a, b) => {
  put(file, a);
  git("add", file);
  git("commit", "-qm", `base ${file}`);
  const lo = git("rev-parse", "HEAD");
  put(file, b);
  git("add", file);
  git("commit", "-qm", `head ${file}`);
  return [lo, git("rev-parse", "HEAD")];
};

test("R-9 M1: a removed SQL-comment line starting with '-- ' is not a file header", () => {
  const a = 'it("q", () => {\n  const sql = `\n-- reason: x\n`;\n  expect(f(sql)).toBe(3);\n});\n';
  const b = a.replace("-- reason: x\n", "").replace("toBe(3)", "toBe(4)");
  const [lo, hi] = twoCommits("apps/api/src/m1.spec.ts", a, b);
  const r = run(lo, hi);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /m1\.spec\.ts:5 \[assertion\] expect\(f\(sql\)\)\.toBe\(3\)/);
});

test("R-9 M2: describe/it turned into skip/only/xdescribe/fit is flagged", () => {
  const from = 'describe("g", () => {';
  for (const [i, to] of [
    'describe.skip("g", () => {',
    'describe.only("g", () => {',
    'xdescribe("g", () => {',
    'fdescribe("g", () => {',
  ].entries()) {
    const a = `${from}\n  it("a", () => {\n    expect(1).toBe(1);\n  });\n});\n`;
    const [lo, hi] = twoCommits(`apps/api/src/m2-${i}.spec.ts`, a, a.replace(from, to));
    const r = run(lo, hi);
    assert.equal(r.status, 1, `${to}: ${r.stdout}`);
    assert.match(r.stdout, /\[title\] describe\(/, to);
    assert.match(r.stdout, /\[skip\]/, to);
  }
  const b = 'it("a", () => {\n  expect(1).toBe(1);\n});\n';
  const [lo, hi] = twoCommits("apps/api/src/m2-it.spec.ts", b, b.replace('it("a"', 'xit("a"'));
  assert.equal(run(lo, hi).status, 1);
});

test("R-9 M3: describe-level and beforeEach fixture edits are flagged", () => {
  const a = `describe("g", () => {\n  const fx = { status: "deposited" };\n  beforeEach(() => {\n    seed({ amount: 100 });\n  });\n  it("a", () => {\n    expect(f(fx)).toBe(1);\n  });\n});\n`;
  const [lo1, hi1] = twoCommits("apps/api/src/m3a.spec.ts", a, a.replace("deposited", "created"));
  const r1 = run(lo1, hi1);
  assert.equal(r1.status, 1);
  assert.match(r1.stdout, /m3a\.spec\.ts:2 \[setup\] const fx/);
  const [lo2, hi2] = twoCommits(
    "apps/api/src/m3b.spec.ts",
    a,
    a.replace("amount: 100", "amount: 5"),
  );
  const r2 = run(lo2, hi2);
  assert.equal(r2.status, 1);
  assert.match(r2.stdout, /m3b\.spec\.ts:4 \[setup\] seed/);
});

test("R-9 L2: a crash (bad sha) exits 2, not 1", () => {
  const r = run("aaaaaaa", "bbbbbbb");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /error/);
});

test("R-9 L4: an escaped quote and a paren in a title keep one range", () => {
  const src = 'it("a \\" ( b", () => {\n  expect(1).toBe(1);\n});\n';
  assert.deepEqual(testRanges(src), [[1, 3]]);
});
