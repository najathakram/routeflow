// node --test scripts/local-ci.test.mjs — contract tests for scripts/local-ci.mjs (no network, steps stubbed).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseArgs,
  touchesDbLane,
  planLocalCi,
  runSteps,
  statusPayload,
  resultDirName,
} from "./local-ci.mjs";

const base = {
  pr: 3700,
  mergeSha: "m".repeat(40),
  headSha: "abcdef1234567890abcdef1234567890abcdef12",
  dir: "/w/local-ci-3700",
  from: "/r/main",
  lockdeps: "/out/lockdeps",
  lockChanged: false,
  dbLane: false,
  platform: "win32",
};
const names = (plan) => plan.map((s) => s.name);

test("parseArgs: --pr is required and numeric; flags parse", () => {
  assert.deepEqual(parseArgs(["--pr", "12"]).pr, 12);
  assert.equal(parseArgs(["--pr", "12", "--dry"]).dry, true);
  assert.equal(parseArgs(["--self-test"]).selfTest, true);
  assert.throws(() => parseArgs([]), /--pr/);
  assert.throws(() => parseArgs(["--pr", "x1"]), /--pr/);
  assert.throws(() => parseArgs(["--pr", "1", "--bogus"]), /unknown/);
});

test("plan mirrors ci.yml Verify order: lockdeps, lock-edges, prisma generate, verify, audit, advisories", () => {
  const plan = planLocalCi(base);
  const n = names(plan).filter((x) => !x.startsWith("worktree:"));
  assert.deepEqual(n, [
    "lockdeps",
    "validate-lock-edges",
    "husky",
    "prisma-generate",
    "verify",
    "audit-critical",
    "audit-high-report",
  ]);
});

test("worktree is a detached checkout of the merge ref, never a new branch", () => {
  const plan = planLocalCi(base);
  const add = plan.find((s) => s.cmd[0] === "git" && s.cmd[1] === "worktree");
  assert.ok(add.cmd.includes("--detach"));
  assert.ok(!add.cmd.includes("-b"));
  assert.equal(add.cmd.at(-1), base.mergeSha);
});

test("verify runs with the CI env: VERIFY_EXCLUDE, jest --maxWorkers=2, inside the heavy slot", () => {
  const v = planLocalCi(base).find((s) => s.name === "verify");
  assert.equal(v.env.VERIFY_EXCLUDE, "@routeflow/control");
  assert.equal(v.env.JEST_MAX_WORKERS, "2");
  assert.equal(v.heavy, true);
  assert.deepEqual(v.cmd, ["npm", "run", "verify"]);
});

test("validate-lock-edges gets NODE_PATH from the lockdeps install", () => {
  const s = planLocalCi(base).find((x) => x.name === "validate-lock-edges");
  assert.match(s.env.NODE_PATH.replace(/\\/g, "/"), /out\/lockdeps\/node_modules$/);
});

test("npm ci only when the lockfile differs from the cloned node_modules, always --ignore-scripts", () => {
  assert.ok(!names(planLocalCi(base)).includes("npm-ci"));
  const plan = planLocalCi({ ...base, lockChanged: true });
  const ci = plan.find((s) => s.name === "npm-ci");
  assert.ok(ci.cmd.includes("--ignore-scripts"));
  assert.ok(ci.heavy);
  assert.ok(names(plan).indexOf("npm-ci") < names(plan).indexOf("prisma-generate"));
});

test("husky runs after install: npm ci --ignore-scripts skips `prepare`, and verify's check-git-hooks needs .husky/_", () => {
  const plan = planLocalCi({ ...base, lockChanged: true });
  const n = names(plan);
  assert.ok(n.indexOf("husky") > n.indexOf("npm-ci"));
  assert.deepEqual(plan.find((s) => s.name === "husky").cmd, ["npx", "husky"]);
});

test("db lane steps are added only when the diff touches prisma", () => {
  assert.ok(!names(planLocalCi(base)).includes("db-replay"));
  const plan = planLocalCi({ ...base, dbLane: true });
  const n = names(plan);
  assert.ok(n.includes("lint-migrations"));
  const db = plan.find((s) => s.name === "db-replay");
  assert.equal(db.cmd[0], "node");
  assert.match(db.cmd.join(" "), /local-db-specs\.mjs/);
  assert.ok(db.heavy === false, "local-db-specs takes its own slot");
});

test("touchesDbLane follows db-migrations.yml paths", () => {
  assert.equal(touchesDbLane(["apps/api/prisma/schema/sales.prisma"]), true);
  assert.equal(touchesDbLane(["apps/api/src/foo/x.db.spec.ts"]), true);
  assert.equal(touchesDbLane(["apps/web/app/page.tsx", "README.md"]), false);
});

test("runSteps stops at the first failure and names it; advisory steps never fail the run", async () => {
  const plan = [
    { name: "a", cmd: ["x"] },
    { name: "b", cmd: ["x"] },
    { name: "c", cmd: ["x"] },
    { name: "adv", cmd: ["x"], advisory: true },
  ];
  const calls = [];
  let t = 0;
  const r = await runSteps({
    steps: plan,
    exec: async (s) => {
      calls.push(s.name);
      return { status: s.name === "b" ? 1 : 0 };
    },
    now: () => (t += 1000),
  });
  assert.equal(r.ok, false);
  assert.equal(r.failedStep, "b");
  assert.deepEqual(calls, ["a", "b", "adv"], "advisory still runs after a failure; c is skipped");
  assert.equal(r.steps.find((s) => s.name === "c").status, "skipped");
});

test("runSteps: a failing advisory step leaves the run green", async () => {
  const r = await runSteps({
    steps: [
      { name: "a", cmd: ["x"] },
      { name: "adv", cmd: ["x"], advisory: true },
    ],
    exec: async (s) => ({ status: s.name === "adv" ? 1 : 0 }),
    now: () => 0,
  });
  assert.equal(r.ok, true);
  assert.equal(r.failedStep, null);
});

test("statusPayload: context, state, description within GitHub's 140 chars", () => {
  const ok = statusPayload({ ok: true, durationMs: 754_000, failedStep: null });
  assert.equal(ok.context, "local-ci/verify");
  assert.equal(ok.state, "success");
  assert.match(ok.description, /12m34s/);
  const bad = statusPayload({ ok: false, durationMs: 61_000, failedStep: "x".repeat(300) });
  assert.equal(bad.state, "failure");
  assert.ok(bad.description.length <= 140);
  assert.match(bad.description, /1m01s/);
});

test("resultDirName is <pr>-<short sha>", () => {
  assert.equal(resultDirName(3700, base.headSha), "3700-abcdef123456");
});
