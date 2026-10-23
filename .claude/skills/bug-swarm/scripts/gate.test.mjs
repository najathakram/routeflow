// node --test gate.test.mjs — contract tests for gate.mjs (runs 2026-10-23-bug-swarm-1/-2).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { changedSince, planGate, runGate } from "./gate.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const opts = { root: "/r", base: "abc123", exists: () => true };
const names = (steps) => steps.map((s) => s.name);
const step = (steps, name) => steps.find((s) => s.name === name);

test("changedSince uses git merge-base origin/master HEAD, then base..HEAD (no origin/master..HEAD)", () => {
  const calls = [];
  const git = (args) => {
    calls.push(args);
    return args[0] === "merge-base" ? "deadbeef\n" : "a.ts\0b/(c)/d.tsx\0";
  };
  const r = changedSince(git);
  assert.deepEqual(calls[0], ["merge-base", "origin/master", "HEAD"]);
  assert.ok(calls[1].includes("deadbeef..HEAD"));
  assert.ok(calls[1].includes("--diff-filter=d"));
  assert.deepEqual(r, { base: "deadbeef", files: ["a.ts", "b/(c)/d.tsx"] });
});

test("paths with parentheses and brackets survive as single argv elements", () => {
  const f = "apps/web/app/(dashboard)/orders/[id]/page.tsx";
  const steps = planGate({
    changedFiles: [f, "apps/mobile/app/(operator)/returns/[id].tsx"],
    ...opts,
  });
  assert.ok(step(steps, "prettier").cmd.includes(f));
  const eslint = step(steps, "eslint:apps/web");
  assert.ok(eslint.cmd.includes("app/(dashboard)/orders/[id]/page.tsx"));
  for (const s of steps)
    assert.ok(Array.isArray(s.cmd) && s.cmd.every((x) => typeof x === "string"));
});

test("prettier skips dotfiles without an extension such as .prettierignore", () => {
  const steps = planGate({
    changedFiles: [".prettierignore", "apps/web/a.ts", "Dockerfile"],
    ...opts,
  });
  const cmd = step(steps, "prettier").cmd;
  assert.ok(cmd.includes("apps/web/a.ts"));
  assert.ok(!cmd.includes(".prettierignore"));
  assert.ok(!cmd.includes("Dockerfile"));
  assert.ok(!names(planGate({ changedFiles: [".prettierignore"], ...opts })).includes("prettier"));
});

test("per-workspace eslint and jest paths are workspace-relative, cwd is the workspace", () => {
  const steps = planGate({
    changedFiles: ["apps/api/src/orders/a.service.ts", "apps/api/src/orders/a.service.spec.ts"],
    ...opts,
  });
  const eslint = step(steps, "eslint:apps/api");
  assert.equal(eslint.cwd, "/r/apps/api");
  assert.deepEqual(eslint.cmd.slice(-2), [
    "src/orders/a.service.ts",
    "src/orders/a.service.spec.ts",
  ]);
  assert.ok(eslint.cmd.includes("--quiet"));
  const jest = step(steps, "jest:apps/api");
  assert.ok(jest.cmd.includes("--findRelatedTests"));
  assert.ok(jest.cmd.includes("src/orders/a.service.ts"));
  assert.deepEqual(step(steps, "tsc:apps/api").cmd, [
    "npm",
    "run",
    "check-types",
    "-w",
    "apps/api",
  ]);
});

test("web and package workspaces use tsc --noEmit in their own directory", () => {
  const steps = planGate({
    changedFiles: ["apps/web/a.tsx", "packages/pricing/src/x.ts"],
    ...opts,
  });
  assert.deepEqual(step(steps, "tsc:apps/web").cmd, ["npx", "tsc", "--noEmit"]);
  assert.equal(step(steps, "tsc:packages/pricing").cwd, "/r/packages/pricing");
});

test("fixed steps: packages-build, signature-scan, commitlint on the merge-base, size-ratchet", () => {
  const steps = planGate({ changedFiles: ["apps/web/a.ts"], ...opts });
  assert.deepEqual(step(steps, "packages-build").cmd, [
    "npx",
    "turbo",
    "run",
    "build",
    "--filter=./packages/*",
  ]);
  assert.deepEqual(step(steps, "signature-scan").cmd, [
    "node",
    ".claude/skills/bug-hunt/scripts/scan-signatures.mjs",
  ]);
  assert.deepEqual(step(steps, "commitlint").cmd.slice(-4), ["--from", "abc123", "--to", "HEAD"]);
  const sr = step(steps, "size-ratchet");
  assert.equal(sr.cwd, "/r/apps/api");
  assert.deepEqual(sr.cmd, ["npx", "jest", "-c", "jest.repo-truth.config.js", "size-ratchet"]);
});

test("db-lane only when needsDb", () => {
  assert.ok(!names(planGate({ changedFiles: ["apps/api/a.ts"], ...opts })).includes("db-lane"));
  const steps = planGate({ changedFiles: ["apps/api/a.ts"], needsDb: true, ...opts });
  assert.deepEqual(step(steps, "db-lane").cmd, ["npm", "run", "local:test:db"]);
});

test("tools/ops-monitor change adds its run-all; scripts/<x>.mjs adds its self-test when present", () => {
  const steps = planGate({
    changedFiles: ["tools/ops-monitor/lib/a.mjs", "scripts/janitor.mjs"],
    ...opts,
  });
  assert.deepEqual(step(steps, "self-test:ops-monitor").cmd, [
    "node",
    "tools/ops-monitor/test/run-all.mjs",
  ]);
  assert.deepEqual(step(steps, "self-test:scripts/janitor").cmd, [
    "node",
    "scripts/janitor.self-test.mjs",
  ]);
  const none = planGate({ changedFiles: ["scripts/janitor.mjs"], ...opts, exists: () => false });
  assert.ok(!names(none).some((n) => n.startsWith("self-test:")));
});

test("runGate runs every step after a failure and reports ok=false with a 20-line tail", async () => {
  const steps = [
    { name: "a", cwd: "/r", cmd: ["x"] },
    { name: "b", cwd: "/r", cmd: ["y"] },
    { name: "c", cwd: "/r", cmd: ["z"] },
  ];
  const seen = [];
  const exec = async (s) => {
    seen.push(s.name);
    if (s.name === "b")
      return { status: 1, output: Array.from({ length: 30 }, (_, i) => `l${i}`).join("\n") };
    return { status: 0, output: "fine" };
  };
  const r = await runGate(steps, { exec });
  assert.deepEqual(seen, ["a", "b", "c"]);
  assert.equal(r.ok, false);
  assert.deepEqual(
    r.steps.map((s) => [s.name, s.ok, s.exit]),
    [
      ["a", true, 0],
      ["b", false, 1],
      ["c", true, 0],
    ],
  );
  assert.equal(r.steps[1].tail.split("\n").length, 20);
  assert.ok(r.steps[1].tail.endsWith("l29"));
  assert.equal(typeof r.steps[0].ms, "number");
  assert.equal((await runGate(steps.slice(0, 1), { exec })).ok, true);
});

test("CLI --dry-run prints the plan and runs nothing", () => {
  const r = spawnSync(process.execPath, [path.join(here, "gate.mjs"), "--dry-run", "--needs-db"], {
    encoding: "utf8",
    cwd: here,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /packages-build/);
  assert.match(r.stdout, /size-ratchet/);
  assert.match(r.stdout, /db-lane/);
});
