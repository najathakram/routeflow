#!/usr/bin/env node
// Coverage for the Bookkeeping-Follow-Up trailer bypass on Gates 2 and 3 of
// `.claude/hooks/stop.mjs` (Bookkeeping Option B, owner ruling 2026-09-05).
//
// No root-level test runner exists for standalone scripts (CLAUDE.md "DO NOT
// introduce ... a root-level test runner") and stop.mjs is not part of any
// Jest project, so this follows the repo's existing convention for
// standalone script coverage — a plain node script run directly
// (`node .claude/hooks/stop.gates.spec.mjs`), the same shape as
// scripts/validate-lessons.mjs / scripts/validate-lock-edges.mjs.
//
// Each case spins up a disposable git repo and spawns a fresh
// `node stop.mjs` against it (never the running process's own repo), so this
// is a true integration check of the gate logic, not just the trailer regex.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const STOP_HOOK = fileURLToPath(new URL("./stop.mjs", import.meta.url));

function git(cwd, args) {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}:\n${res.stdout}${res.stderr}`);
  }
  return res;
}

// Builds a throwaway repo with an uncommitted code-only change (a .prisma
// file, so it counts as "code" for isCode() without also tripping Gate 1's
// prettier check, which only matches .ts/.tsx/.js/.jsx and would otherwise
// need a working `npx prettier` in the sandbox) sitting on top of a HEAD
// commit whose message does or does not carry the trailer.
function makeScenarioRepo({ withMap, withLessons, branch, trailer }) {
  const dir = mkdtempSync(join(tmpdir(), "stop-gates-spec-"));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "stop-gates-spec@example.com"]);
  git(dir, ["config", "user.name", "stop-gates-spec"]);

  if (withMap) {
    mkdirSync(join(dir, ".claude", "code-map"), { recursive: true });
    writeFileSync(join(dir, ".claude", "code-map", "_meta.json"), "{}\n");
  }
  if (withLessons) {
    mkdirSync(join(dir, ".claude", "lessons"), { recursive: true });
    writeFileSync(join(dir, ".claude", "lessons", "LESSONS.md"), "# Lessons\n");
  }
  writeFileSync(join(dir, "README.md"), "seed\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", trailer ? "Bookkeeping-Follow-Up: pending" : "chore: seed"]);

  if (branch) git(dir, ["checkout", "-q", "-b", branch]);

  // Uncommitted code change; map/lessons deliberately left untouched.
  mkdirSync(join(dir, "apps", "api"), { recursive: true });
  writeFileSync(join(dir, "apps", "api", "schema.prisma"), "// scenario change\n");

  return dir;
}

function runStopHook(dir) {
  return spawnSync(process.execPath, [STOP_HOOK], { cwd: dir, encoding: "utf8" });
}

const cases = [
  {
    name: "Gate 2 — trailer present bypasses the code-map block",
    repo: { withMap: true, withLessons: false, branch: null, trailer: true },
    expectStatus: 0,
    check: (r) =>
      r.stdout.includes("Gate 2: bookkeeping deferred to the follow-up PR (trailer present)"),
  },
  {
    name: "Gate 2 — trailer absent still blocks (existing behavior)",
    repo: { withMap: true, withLessons: false, branch: null, trailer: false },
    expectStatus: 2,
    check: (r) =>
      r.stderr.includes("Stop gate: code changed but .claude/code-map/ was not updated"),
  },
  {
    name: "Gate 3 — trailer present bypasses the lesson block",
    repo: { withMap: false, withLessons: true, branch: "fix/stop-gates-spec", trailer: true },
    expectStatus: 0,
    check: (r) =>
      r.stdout.includes("Gate 3: bookkeeping deferred to the follow-up PR (trailer present)"),
  },
  {
    name: "Gate 3 — trailer absent still blocks (existing behavior)",
    repo: { withMap: false, withLessons: true, branch: "fix/stop-gates-spec", trailer: false },
    expectStatus: 2,
    check: (r) =>
      r.stderr.includes("Stop gate: bug-fix work on fix/stop-gates-spec without a recorded lesson"),
  },
];

let failed = 0;
for (const c of cases) {
  const dir = makeScenarioRepo(c.repo);
  const res = runStopHook(dir);
  const statusOk = res.status === c.expectStatus;
  const checkOk = c.check(res);
  if (statusOk && checkOk) {
    console.log(`PASS  ${c.name}`);
  } else {
    failed++;
    console.log(`FAIL  ${c.name}`);
    console.log(`      expected exit ${c.expectStatus}, got ${res.status}`);
    console.log(`      stdout:\n${res.stdout}`);
    console.log(`      stderr:\n${res.stderr}`);
  }
}

if (failed > 0) {
  console.log(`\nstop.gates.spec FAILED — ${failed}/${cases.length} case(s).`);
  process.exit(1);
}
console.log(`\nstop.gates.spec PASS (${cases.length}/${cases.length} cases)`);
process.exit(0);
