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

// Run inside a git hook (the pre-push `npm run verify`), git exports GIT_DIR /
// GIT_INDEX_FILE / GIT_WORK_TREE etc., which would point every child git — the
// scenario repos' AND the spawned stop.mjs's — back at the real repository
// (B420). Strip them so each child resolves its own cwd's repo.
const CLEAN_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !/^GIT_/i.test(k)),
);

function git(cwd, args) {
  const res = spawnSync("git", args, { cwd, encoding: "utf8", env: CLEAN_ENV });
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

// Committed-history scenarios for the per-commit trailer on the drift checks
// (2b, 3b): a seed commit anchors the map/lessons, then `commits` land in
// order with a CLEAN working tree, so only the committed-drift checks can
// fire. Each commit touches its own file — a code file under apps/ when
// `code` is set — and carries the trailer in its body when `trailer` is set.
function makeHistoryRepo({ withMap, withLessons, commits }) {
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
  git(dir, ["commit", "-q", "-m", "chore: seed"]);

  commits.forEach((c, i) => {
    if (c.code) {
      mkdirSync(join(dir, "apps", "api"), { recursive: true });
      writeFileSync(join(dir, "apps", "api", `change-${i}.prisma`), `// change ${i}\n`);
    } else {
      writeFileSync(join(dir, `notes-${i}.md`), `change ${i}\n`);
    }
    git(dir, ["add", "-A"]);
    const msg = ["commit", "-q", "-m", c.subject];
    if (c.trailer) msg.push("-m", "Bookkeeping-Follow-Up: pending");
    git(dir, msg);
  });
  return dir;
}

function runStopHook(dir) {
  return spawnSync(process.execPath, [STOP_HOOK], { cwd: dir, encoding: "utf8", env: CLEAN_ENV });
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
  // ── per-commit trailer on the committed-drift checks (2026-09-28) ──────
  {
    name: "Gate 3b — every fix commit carries its own trailer, trailerless HEAD → pass",
    build: makeHistoryRepo,
    repo: {
      withMap: false,
      withLessons: true,
      commits: [
        { subject: "fix(mobile): first deferred fix", trailer: true },
        { subject: "fix(returns): second deferred fix", trailer: true },
        { subject: "docs(bookkeeping): unrelated follow-up", trailer: false },
      ],
    },
    expectStatus: 0,
    check: (r) =>
      r.stdout.includes("Gate 3: 2 fix commit(s) since the last lessons update carry") &&
      !r.stderr.includes("Stop gate"),
  },
  {
    name: "Gate 3b — one fix commit without its own trailer still blocks, and only it is listed",
    build: makeHistoryRepo,
    repo: {
      withMap: false,
      withLessons: true,
      commits: [
        { subject: "fix(mobile): deferred fix", trailer: true },
        { subject: "fix(returns): undeferred fix", trailer: false },
        { subject: "docs(bookkeeping): unrelated follow-up", trailer: false },
      ],
    },
    expectStatus: 2,
    check: (r) =>
      r.stderr.includes(
        "Stop gate: 1 fix commit(s) landed after the last .claude/lessons/ update",
      ) &&
      r.stderr.includes("fix(returns): undeferred fix") &&
      !r.stderr.includes("fix(mobile): deferred fix"),
  },
  {
    name: "Gate 3b — a trailered HEAD no longer hides an earlier undeferred fix commit",
    build: makeHistoryRepo,
    repo: {
      withMap: false,
      withLessons: true,
      commits: [
        { subject: "fix(api): undeferred fix", trailer: false },
        { subject: "docs: trailered head", trailer: true },
      ],
    },
    expectStatus: 2,
    check: (r) => r.stderr.includes("fix(api): undeferred fix"),
  },
  {
    name: "Gate 2b — code committed only by trailered commits, trailerless HEAD → pass",
    build: makeHistoryRepo,
    repo: {
      withMap: true,
      withLessons: false,
      commits: [
        { subject: "feat(api): deferred code change", trailer: true, code: true },
        { subject: "docs(bookkeeping): unrelated follow-up", trailer: false },
      ],
    },
    expectStatus: 0,
    check: (r) => !r.stderr.includes("Stop gate"),
  },
  {
    name: "Gate 2b — code committed without a trailer still blocks as stale",
    build: makeHistoryRepo,
    repo: {
      withMap: true,
      withLessons: false,
      commits: [
        { subject: "feat(api): deferred code change", trailer: true, code: true },
        { subject: "feat(api): undeferred code change", trailer: false, code: true },
      ],
    },
    expectStatus: 2,
    check: (r) =>
      r.stderr.includes("Stop gate: the code map is STALE") &&
      r.stderr.includes("change-1.prisma") &&
      !r.stderr.includes("change-0.prisma"),
  },
];

let failed = 0;
for (const c of cases) {
  const dir = (c.build ?? makeScenarioRepo)(c.repo);
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
