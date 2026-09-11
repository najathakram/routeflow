#!/usr/bin/env node
// Coverage for Gate 5 of `.claude/hooks/stop.mjs` — the Plane BUGS mirror
// (DECIDE-27, test-plan.md TP2, requirement R7). Gate 5 spawns
// `node scripts/campaign/plane-sync.mjs --quiet [--if-digest-changed]` when
// both `scripts/campaign/plane-sync.mjs` and `.claude/campaign/bugs.jsonl`
// exist, relays the child's single `Plane mirror: ...` line to stderr, and
// MUST always `process.exit(0)` regardless of the child's outcome.
//
// No root-level test runner exists for standalone scripts (CLAUDE.md "DO NOT
// introduce ... a root-level test runner") and stop.mjs is not part of any
// Jest project, so this follows the repo's existing convention for
// standalone script coverage — a plain node script run directly
// (`node .claude/hooks/stop.gate5.spec.mjs`), the same shape as
// `.claude/hooks/stop.gates.spec.mjs`.
//
// Each case spins up a disposable git repo and spawns the REAL
// `.claude/hooks/stop.mjs` against it (never the running process's own
// repo), so this exercises Gate 5's actual spawn/relay logic once WP2 lands
// it, not a re-implementation of the gate in the test. The scaffold repo
// carries its OWN throwaway `scripts/campaign/plane-sync.mjs` fixture (a
// signature-only stand-in for WP1, which is a separate package's file) that
// honours the CLI/env contract R5/R7 describe — it is written at runtime
// into the temp dir only, never into this repository's tracked tree.
//
// T12a/T12b (test-plan.md) prove R7. Pre-implementation, `stop.mjs` has no
// Gate 5 at all, so neither case's expected `Plane mirror:` line can appear
// in its output — both fail on the string assertion below, a true RED, not
// a crash.
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";

const STOP_HOOK = fileURLToPath(new URL("./stop.mjs", import.meta.url));

// Git EXPORTS repo-scoped variables (GIT_DIR, GIT_WORK_TREE, ...) into every
// hook it runs, and a child spawned from inside one inherits them — the same
// hazard `bugs.mjs`'s self-test scrubs (scripts/campaign/bugs.mjs :2880-2903).
// Scrub them from the env handed to every spawned `git`/`node stop.mjs` here
// so the throwaway repo is never silently re-pointed at the real repository.
const GIT_KEYS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_QUARANTINE_PATH",
  "GIT_PREFIX",
  "GIT_NAMESPACE",
  "GIT_CEILING_DIRECTORIES",
];

function scrubbedEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of GIT_KEYS) delete env[k];
  delete env.PLANE_API_KEY; // never leak a real key from the ambient shell
  return { ...env, ...extra };
}

function git(cwd, args) {
  const res = spawnSync("git", args, { cwd, encoding: "utf8", env: scrubbedEnv() });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}:\n${res.stdout}${res.stderr}`);
  }
  return res;
}

// A signature-only stand-in for WP1's `scripts/campaign/plane-sync.mjs`:
// honours the R5/R7 CLI+env contract (checks PLANE_API_KEY, prints exactly
// one `Plane mirror: ...` line, exits 0) without any real Plane logic — the
// real script's own behavior is TP1's package, not this one's.
//
// STREAM CONTRACT (build-plan WP2, spelled out here because R7 only says
// "report one stderr line"): Gate 5 merges the child's stdout AND stderr,
// picks the single line matching /^Plane mirror:/ and relays it to the
// HOOK's stderr. So this fixture deliberately writes the skip line on
// stderr and the summary line on stdout, and both cases below assert on the
// hook's stderr — that pins the merge-BOTH-streams behavior instead of one
// stream by accident.
//
// The `(fixture-ok)` marker on the summary line proves THIS throwaway
// fixture ran rather than the repository's real
// `scripts/campaign/plane-sync.mjs` (which would print the same prefix
// without the marker, and would not stop at a single request).
//
// LAST-MATCH DECOYS. Gate 5 must relay the LAST `Plane mirror:` line, not the
// first — a warning that happened to share the prefix used to mask the real
// summary on every turn. So the fixture emits a `(decoy)` line carrying the
// bare prefix BEFORE its real summary, plus a `Plane mirror warn:` line (the
// prefix every real warning uses, which the gate's regex must not match at
// all). The decoy sits on stdout rather than stderr on purpose: Gate 5
// CONCATENATES stdout then stderr, so the two streams are not in chronological
// order and a stderr decoy would sort AFTER a stdout summary. A gate taking
// the first match relays `(decoy)` and T12b fails.
const PLANE_SYNC_FIXTURE = `
const key = process.env.PLANE_API_KEY;
if (!key) {
  process.stderr.write("Plane mirror: skipped (no PLANE_API_KEY)\\n");
  process.exit(0);
}
const base = process.env.PLANE_BASE_URL || "https://api.plane.so";
try {
  const res = await fetch(base + "/api/v1/ping");
  await res.text();
} catch {
  // fixture only needs to prove the request reached the fake server below
}
process.stdout.write("Plane mirror: 0 created, 0 updated (decoy)\\n");
process.stderr.write("Plane mirror warn: fixture noise\\n");
process.stdout.write("Plane mirror: 1 created, 0 updated (fixture-ok)\\n");
process.exit(0);
`;

// A fixture that never answers inside Gate 5's budget: a SYNCHRONOUS sleep
// (Atomics.wait, not a timer) so the child is unkillable-by-event-loop and the
// gate's own `timeout` is the only thing that ends it — exactly the shape that
// used to leave a turn completely silent (F1a).
const PLANE_SYNC_SLEEPER_FIXTURE = `
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10000);
process.stdout.write("Plane mirror: 1 created, 0 updated (fixture-slept)\\n");
process.exit(0);
`;

// F4: every scaffold repo this run creates is registered here and swept before
// the final report (and again from an `exit` handler, which — unlike a
// `finally` — still runs after the `process.exit()` calls this file uses).
const REPO_DIRS = [];
const REPO_PREFIX = "stop-gate5-spec-";
const countSpecTmpDirs = () =>
  readdirSync(tmpdir()).filter((n) => n.startsWith(REPO_PREFIX)).length;
function cleanupRepos() {
  for (const dir of REPO_DIRS.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // a git repo dir that refuses to go must never turn a passing run red —
      // the final count check reports it instead.
    }
  }
}
process.on("exit", cleanupRepos);
const tmpDirsBefore = countSpecTmpDirs();

// Builds a throwaway repo carrying only what Gate 5 itself inspects
// (`scripts/campaign/plane-sync.mjs` + `.claude/campaign/bugs.jsonl`) and
// deliberately NOTHING that would engage Gates 1-4 (no code-map, no
// lessons dir, no `.claude/campaign/bugs/` directory, no tracked
// .ts/.js/.jsx/.tsx source) so a run exercises Gate 5 in isolation.
function makeGate5Repo({ syncFixture = PLANE_SYNC_FIXTURE } = {}) {
  const dir = mkdtempSync(join(tmpdir(), REPO_PREFIX));
  REPO_DIRS.push(dir);
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "stop-gate5-spec@example.com"]);
  git(dir, ["config", "user.name", "stop-gate5-spec"]);

  const scriptsDir = join(dir, "scripts", "campaign");
  const campaignDir = join(dir, ".claude", "campaign");
  writeFileSync(join(dir, "README.md"), "seed\n");
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(campaignDir, { recursive: true });
  writeFileSync(join(scriptsDir, "plane-sync.mjs"), syncFixture);
  writeFileSync(join(campaignDir, "bugs.jsonl"), '{"id":"B01","title":"seed"}\n');
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "chore: seed"]);

  // Given (test-plan T12a/T12b): the registry file is MODIFIED —
  // uncommitted, so `.claude/campaign` is dirty for Gate 5's own check.
  writeFileSync(join(campaignDir, "bugs.jsonl"), '{"id":"B01","title":"seed (edited)"}\n');

  return dir;
}

// Async spawn (not spawnSync): T12b's fake Plane server lives in THIS
// process, so a synchronous spawnSync would block the event loop and the
// server could never answer the hook's child — a deadlock. Awaiting an
// async `spawn` keeps the harness loop free to service that request while
// the hook runs.
function runStopHook(dir, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [STOP_HOOK], { cwd: dir, env });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 40_000); // above Gate 5's own 25s budget so that timeout can elapse inside this
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status: timedOut ? null : status, stdout, stderr, timedOut });
    });
  });
}

// ── unit check — scrubbedEnv: ambient key never leaks, extra's key always wins ──
{
  const prevAmbient = process.env.PLANE_API_KEY;
  process.env.PLANE_API_KEY = "ambient";
  const ambientLeaked = scrubbedEnv().PLANE_API_KEY !== undefined;
  const extraDropped = scrubbedEnv({ PLANE_API_KEY: "x" }).PLANE_API_KEY !== "x";
  if (prevAmbient === undefined) delete process.env.PLANE_API_KEY;
  else process.env.PLANE_API_KEY = prevAmbient;
  if (ambientLeaked || extraDropped) {
    console.log("FAIL  unit — scrubbedEnv: ambient leaked or extra dropped");
    process.exitCode = 1;
    process.exit(1);
  } else {
    console.log("PASS  unit — scrubbedEnv: ambient scrubbed, extra wins");
  }
}

let failed = 0;
function report(name, ok, detail) {
  if (ok) {
    console.log(`PASS  ${name}`);
  } else {
    failed++;
    console.log(`FAIL  ${name}`);
    if (detail) console.log(detail);
  }
}

// ── T12a / R7 — key unset: Gate 5 never blocks, prints the skip line ──────
{
  const dir = makeGate5Repo();
  const env = scrubbedEnv(); // PLANE_API_KEY deliberately absent
  const res = await runStopHook(dir, env);

  const exitOk = res.status === 0;
  const skipLineOk = res.stderr.includes("Plane mirror: skipped (no PLANE_API_KEY)");
  // Only the conditions that actually failed are printed — the old block listed
  // every expectation unconditionally, so a pass-half rendered as the
  // self-contradicting line "expected exit 0, got 0".
  const details = [];
  if (!exitOk) details.push(`      expected exit 0, got ${res.status}`);
  if (!skipLineOk) {
    details.push('      expected stderr to include "Plane mirror: skipped (no PLANE_API_KEY)"');
  }
  report(
    "T12a/R7 — PLANE_API_KEY unset: exit 0 + skip line on stderr",
    exitOk && skipLineOk,
    [...details, `      stdout:\n${res.stdout}`, `      stderr:\n${res.stderr}`].join("\n"),
  );
}

// ── T12b / R7 — key set + fake server: relays "1 created, 0 updated" ─────
{
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(req.url);
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  const dir = makeGate5Repo();
  const env = scrubbedEnv({
    PLANE_API_KEY: "test-key-not-real",
    PLANE_BASE_URL: `http://127.0.0.1:${port}`,
  });

  const startedAt = Date.now();
  const res = await runStopHook(dir, env);
  const elapsedMs = Date.now() - startedAt;

  await new Promise((resolve) => server.close(resolve));

  const exitOk = res.status === 0;
  const lineOk = res.stderr.includes("Plane mirror: 1 created, 0 updated (fixture-ok)");
  // The gate relays the LAST prefixed line and ignores `Plane mirror warn:`
  // entirely, so neither decoy may appear in what the hook reported.
  const decoyNotRelayed = !res.stderr.includes("(decoy)") && !res.stderr.includes("fixture noise");
  const serverHit = requests.length === 1;

  // Wall-clock is NOT part of the verdict: Gate 5's 25s budget is a property of
  // the host's load, and a loaded machine must never turn a correct Gate 5 red.
  // It is reported as a warning instead.
  if (elapsedMs >= 25_000) {
    console.log(
      `WARN  T12b/R7 — Gate 5 took ${elapsedMs}ms (budget 25000) — loaded host, not a Gate 5 defect`,
    );
  }

  const details = [];
  if (!exitOk) details.push(`      expected exit 0, got ${res.status}`);
  if (!lineOk) {
    details.push(
      '      expected stderr to include "Plane mirror: 1 created, 0 updated (fixture-ok)"',
    );
  }
  if (!decoyNotRelayed) {
    details.push('      expected stderr to include neither "(decoy)" nor "fixture noise"');
  }
  if (!serverHit) {
    details.push(
      `      fake-server requests=${requests.length} (expected 1): ${JSON.stringify(requests)}`,
    );
  }
  report(
    "T12b/R7 — PLANE_API_KEY set + fake server: exit 0 + relayed create line (not the decoys), server hit once",
    exitOk && lineOk && decoyNotRelayed && serverHit,
    [
      ...details,
      `      elapsedMs=${elapsedMs} (budget 25000, reported not asserted)`,
      `      stdout:\n${res.stdout}`,
      `      stderr:\n${res.stderr}`,
    ].join("\n"),
  );
}

// ── T12c / F1a — the child never answers: one non-blocking line, never silence ──
// The gate's child timeout is read from PLANE_SYNC_GATE_TIMEOUT_MS so this case
// costs 500 ms instead of 25 s (L-066: wait on the observable with a short cap,
// never a fixed delay standing in for a readiness signal).
{
  const dir = makeGate5Repo({ syncFixture: PLANE_SYNC_SLEEPER_FIXTURE });
  const env = scrubbedEnv({
    PLANE_API_KEY: "test-key-not-real",
    PLANE_SYNC_GATE_TIMEOUT_MS: "500",
  });
  const res = await runStopHook(dir, env);
  const merged = res.stdout + res.stderr;

  const exitOk = res.status === 0;
  const reported = /^Plane mirror: timed out or failed \(non-blocking\)/m.test(merged);
  // The sleeper's own line must NOT appear — if it did, the child outlived the
  // shrunken budget and this case proved nothing about the timeout path.
  const sleeperSilent = !merged.includes("(fixture-slept)");
  const details = [];
  if (!exitOk) details.push(`      expected exit 0, got ${res.status}`);
  if (!reported) {
    details.push('      expected a "Plane mirror: timed out or failed (non-blocking)" line');
  }
  if (!sleeperSilent) details.push("      the sleeping fixture still printed its summary");
  report(
    "T12c/F1a — child times out: exit 0 + exactly one non-blocking timeout line, never silence",
    exitOk && reported && sleeperSilent,
    [...details, `      stdout:\n${res.stdout}`, `      stderr:\n${res.stderr}`].join("\n"),
  );
}

// ── T12d / F2 — a FAILING `git` must not throw out of Gate 5 ─────────────────
// DESIGN NOTE (fix-round 1). The crash shape F2 guards is `stdout === null`,
// which spawnSync only produces when the child never STARTS. A git missing
// from PATH entirely cannot be used to reproduce it here: stop.mjs's own
// top-level `git diff` (execSync) fails first and the hook exits 0 having
// printed nothing, so Gate 5 is never reached. This case therefore uses an
// argv-scoped shim — `git status` fails with empty stdout, every other git
// invocation forwards to the real binary — which reaches Gate 5, plus a source
// assertion that no `spawnSync(...).stdout` in the hook is left unguarded.
{
  const which = spawnSync(process.platform === "win32" ? "where" : "which", ["git"], {
    encoding: "utf8",
    env: scrubbedEnv(),
  });
  const realGit = (which.stdout || "").split(/\r?\n/)[0].trim();

  const shimDir = mkdtempSync(join(tmpdir(), REPO_PREFIX));
  REPO_DIRS.push(shimDir);
  if (process.platform === "win32") {
    writeFileSync(
      join(shimDir, "git.cmd"),
      `@echo off\r\nif "%1"=="status" exit /b 1\r\n"${realGit}" %*\r\n`,
    );
  } else {
    const shim = join(shimDir, "git");
    writeFileSync(
      shim,
      `#!/bin/sh\nif [ "$1" = "status" ]; then exit 1; fi\nexec "${realGit}" "$@"\n`,
    );
    chmodSync(shim, 0o755);
  }

  const dir = makeGate5Repo();
  const env = scrubbedEnv({ PLANE_API_KEY: "test-key-not-real" });
  // Windows names the variable `Path`; writing a second `PATH` key would be
  // ignored by the child's own lookup.
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "PATH";
  env[pathKey] = `${shimDir}${process.platform === "win32" ? ";" : ":"}${env[pathKey]}`;

  const res = await runStopHook(dir, env);
  const merged = res.stdout + res.stderr;

  const exitOk = res.status === 0;
  // Either outcome is correct — the gate either reports its normal line or the
  // non-blocking failure line; what it must never do is throw.
  const reportedSomething = /^Plane mirror:/m.test(merged);
  const noStack = !/^\s+at\s+.+:\d+:\d+\)?$/m.test(merged) && !/TypeError|Cannot read/.test(merged);
  // The guard itself, pinned at the source: no `.stdout` in the hook may be
  // dereferenced without the `|| ""` fallback (Gate 4's precedent).
  const hookSource = readFileSync(STOP_HOOK, "utf8");
  const unguarded = hookSource.match(/\.stdout\b(?!\s*(\|\||\?\?))/g) ?? [];

  const details = [];
  if (!exitOk) details.push(`      expected exit 0, got ${res.status}`);
  if (!reportedSomething) details.push('      expected some "Plane mirror:" line on either stream');
  if (!noStack) details.push("      the hook printed a stack trace");
  if (unguarded.length > 0) {
    details.push(
      `      stop.mjs dereferences .stdout unguarded ${unguarded.length}x (needs || "")`,
    );
  }
  report(
    "T12d/F2 — failing git: exit 0, a Plane mirror line, no stack trace, no unguarded .stdout",
    exitOk && reportedSomething && noStack && unguarded.length === 0,
    [...details, `      stdout:\n${res.stdout}`, `      stderr:\n${res.stderr}`].join("\n"),
  );
}

// ── F4 — the scaffold repos this run created are all gone ────────────────────
cleanupRepos();
report(
  "F4 — leaves no stop-gate5-spec-* dir behind",
  countSpecTmpDirs() === tmpDirsBefore,
  `      tmpdir stop-gate5-spec-* count: before=${tmpDirsBefore} after=${countSpecTmpDirs()}`,
);

const TOTAL_CASES = 5;
if (failed > 0) {
  console.log(`\nstop.gate5.spec FAILED — ${failed}/${TOTAL_CASES} case(s).`);
  process.exit(1);
}
console.log(`\nstop.gate5.spec PASS (${TOTAL_CASES}/${TOTAL_CASES} cases)`);
process.exit(0);
