// node --test scripts/review-test-edits.test.mjs — builds a throwaway git repo and runs the real CLI.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
    { encoding: "utf8" },
  ).trim();
const put = (f, text) => {
  mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
  writeFileSync(path.join(dir, f), text);
};
const run = (base, head, ...extra) =>
  spawnSync("node", [CLI, "--base", base, "--head", head, ...extra], {
    cwd: dir,
    encoding: "utf8",
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
});
