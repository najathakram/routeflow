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
  existsSync,
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

// T12 (test-plan.md, 2026-09-11-plane-harness, R12) — a fixture that only
// echoes the argv it was spawned with, wrapped in the bare `Plane mirror:`
// prefix so it rides through Gate 5's own relay regex: the gate only ever
// relays a line matching /^Plane mirror:/ from the child's merged
// stdout+stderr — anything else the child prints never reaches the hook's
// own output at all, so the argv has to be smuggled inside that one line.
const PLANE_SYNC_ARGV_FIXTURE = `
process.stdout.write("Plane mirror: argv " + JSON.stringify(process.argv.slice(2)) + "\\n");
process.exit(0);
`;

// F4: every scaffold repo this run creates is registered here and swept before
// the final report (and again from an `exit` handler, which — unlike a
// `finally` — still runs after the `process.exit()` calls this file uses).
const REPO_DIRS = [];
// ALL_REPO_DIRS additionally records every dir this run has EVER created,
// across the whole run — unlike REPO_DIRS, it is never spliced/cleared, so
// F4 (below) always has the full list to check, even after a mid-run
// cleanupRepos() call (REG-B411's case empties REPO_DIRS early on purpose).
const ALL_REPO_DIRS = [];
const REPO_PREFIX = "stop-gate5-spec-";
const countSpecTmpDirs = () =>
  readdirSync(tmpdir()).filter((n) => n.startsWith(REPO_PREFIX)).length;
function trackRepoDir(dir) {
  REPO_DIRS.push(dir);
  ALL_REPO_DIRS.push(dir);
  return dir;
}
function cleanupRepos() {
  for (const dir of REPO_DIRS.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // a git repo dir that refuses to go must never turn a passing run red —
      // F4's own per-dir existsSync check reports it instead.
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
  const dir = trackRepoDir(mkdtempSync(join(tmpdir(), REPO_PREFIX)));
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

  const shimDir = trackRepoDir(mkdtempSync(join(tmpdir(), REPO_PREFIX)));
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

// ── T12 / R12 (harness, 2026-09-11-plane-harness) — Gate 5 must pass
// `--max-writes 25` to plane-sync so a hook never bulk-writes (bulk runs are
// explicit: `npm run plane:sync -- --max-writes 400`). Pre-implementation
// Gate 5's argv is only `--quiet --budget-ms 18000 [--if-digest-changed]` —
// no `--max-writes` element at all — so this fails on the assertion below,
// a true RED, never a crash.
{
  const dir = makeGate5Repo({ syncFixture: PLANE_SYNC_ARGV_FIXTURE });
  const env = scrubbedEnv(); // the argv fixture answers regardless of key state
  const res = await runStopHook(dir, env);

  const m = /^Plane mirror: argv (\[.*\])$/m.exec(res.stderr);
  let argv = [];
  let parseOk = false;
  if (m) {
    try {
      argv = JSON.parse(m[1]);
      parseOk = true;
    } catch {
      parseOk = false;
    }
  }
  const idx = argv.indexOf("--max-writes");
  const hasMaxWrites25 = parseOk && idx !== -1 && argv[idx + 1] === "25";

  const details = [];
  if (!parseOk) {
    details.push('      expected a relayed "Plane mirror: argv [...]" line on stderr');
  }
  if (parseOk && !hasMaxWrites25) {
    details.push(
      `      expected argv to contain "--max-writes","25" adjacent, got ${JSON.stringify(argv)}`,
    );
  }
  report(
    "T12/R12 (harness) — Gate 5 spawns plane-sync with --max-writes 25",
    hasMaxWrites25,
    [...details, `      stdout:\n${res.stdout}`, `      stderr:\n${res.stderr}`].join("\n"),
  );
}

// ── T16b / R14 (harness, 2026-09-11-plane-harness) — REGRESSION LOCK: Gate 5's
// argv must never carry `--allow-branch`, the R14 branch-guard override — a
// hook must never bulk-write from a feature worktree the way the 2026-09-11
// 23:26Z incident did (spec.md R14). Reuses T12's PLANE_SYNC_ARGV_FIXTURE.
// GREEN today: pre-WP2, Gate 5's argv has no `--allow-branch` element at all
// (same as T12's pre-implementation argv), and post-WP2 it must still be
// absent — this case never flips red on a correct Gate 5, only on a future
// change that adds the flag to the hook's own spawn call.
{
  const dir = makeGate5Repo({ syncFixture: PLANE_SYNC_ARGV_FIXTURE });
  const env = scrubbedEnv(); // the argv fixture answers regardless of key state
  const res = await runStopHook(dir, env);

  const m = /^Plane mirror: argv (\[.*\])$/m.exec(res.stderr);
  let argv = [];
  let parseOk = false;
  if (m) {
    try {
      argv = JSON.parse(m[1]);
      parseOk = true;
    } catch {
      parseOk = false;
    }
  }
  const noAllowBranch = parseOk && !argv.includes("--allow-branch");

  const details = [];
  if (!parseOk) {
    details.push('      expected a relayed "Plane mirror: argv [...]" line on stderr');
  }
  if (parseOk && !noAllowBranch) {
    details.push(
      `      expected argv to never contain "--allow-branch", got ${JSON.stringify(argv)}`,
    );
  }
  report(
    "T16b/R14 (harness) — regression lock: Gate 5 argv never contains --allow-branch",
    noAllowBranch,
    [...details, `      stdout:\n${res.stdout}`, `      stderr:\n${res.stderr}`].join("\n"),
  );
}

// ── T6a-c / R6 (2026-09-12-plane-learning) — the usage guard: Gate 5 reads
// `runs.jsonl` (via PLANE_RUNS_PATH, honoured only with PLANE_SYNC_SELF_TEST=1
// — the same gated-override pattern plane-client.mjs's denylist override
// uses) and, on `master` only, prints `Plane: last sync <age> ago`, plus
// `Plane: WARN landing without sync` when R3's rule trips (the last sync run
// is NOT newer than the newest commit touching `.claude/campaign/status` on
// the current branch). Report-only: exit 0 in every case below.
//
// Pre-implementation, Gate 5 has no usage-guard lines at all, so every one of
// these three cases fails on its string assertion below — a true RED, never
// a crash (the hook still runs its existing plane-sync child-relay logic
// unmodified and reaches the unconditional `process.exit(0)`).
function oneHourAgoSyncLine() {
  return (
    JSON.stringify({
      ts: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      tool: "plane-sync",
      version: 1,
      exit: 0,
      gets: 3,
      writes: 0,
      deferred: 0,
    }) + "\n"
  );
}

function writeStatusShard(dir) {
  const statusDir = join(dir, ".claude", "campaign", "status");
  mkdirSync(statusDir, { recursive: true });
  writeFileSync(join(statusDir, "F01.jsonl"), '{"id":"F01"}\n');
}

// ── T6a / R6 — master, one recent sync run, no status-shard commit yet:
// prints "Plane: last sync", and R3's rule has nothing to trip against yet
// (no commit has ever touched `.claude/campaign/status`), so no WARN ───────
{
  const dir = makeGate5Repo();
  git(dir, ["branch", "-M", "master"]);
  const runsPath = join(dir, "runs.jsonl");
  writeFileSync(runsPath, oneHourAgoSyncLine());
  const env = scrubbedEnv({ PLANE_SYNC_SELF_TEST: "1", PLANE_RUNS_PATH: runsPath });

  const res = await runStopHook(dir, env);
  const merged = res.stdout + res.stderr;

  const exitOk = res.status === 0;
  const hasLastSync = /Plane: last sync/.test(merged);
  const noWarnYet = !/Plane: WARN landing without sync/.test(merged);

  const details = [];
  if (!exitOk) details.push(`      expected exit 0, got ${res.status}`);
  if (!hasLastSync) details.push('      expected output to include "Plane: last sync"');
  if (!noWarnYet) {
    details.push(
      '      did not expect "Plane: WARN landing without sync" (no status-shard commit yet)',
    );
  }
  report(
    "T6a/R6 — master, recent sync run, no status commit: 'Plane: last sync', no WARN",
    exitOk && hasLastSync && noWarnYet,
    [...details, `      stdout:\n${res.stdout}`, `      stderr:\n${res.stderr}`].join("\n"),
  );
}

// ── T6b / R6 — master, then a NEWER commit touches
// `.claude/campaign/status/F01.jsonl`: the last sync (1h old) is no longer
// newer than the newest status-touching commit (just now) → WARN, alongside
// the last-sync line that still prints on master ───────────────────────────
{
  const dir = makeGate5Repo();
  git(dir, ["branch", "-M", "master"]);
  const runsPath = join(dir, "runs.jsonl");
  writeFileSync(runsPath, oneHourAgoSyncLine());
  writeStatusShard(dir);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "chore: status shard"]);
  const env = scrubbedEnv({ PLANE_SYNC_SELF_TEST: "1", PLANE_RUNS_PATH: runsPath });

  const res = await runStopHook(dir, env);
  const merged = res.stdout + res.stderr;

  const exitOk = res.status === 0;
  const hasLastSync = /Plane: last sync/.test(merged);
  const hasWarn = /Plane: WARN landing without sync/.test(merged);

  const details = [];
  if (!exitOk) details.push(`      expected exit 0, got ${res.status}`);
  if (!hasLastSync) details.push('      expected output to still include "Plane: last sync"');
  if (!hasWarn) details.push('      expected output to include "Plane: WARN landing without sync"');
  report(
    "T6b/R6 — master, newer commit touching .claude/campaign/status: adds WARN landing without sync",
    exitOk && hasLastSync && hasWarn,
    [...details, `      stdout:\n${res.stdout}`, `      stderr:\n${res.stderr}`].join("\n"),
  );
}

// ── T6c / R6 — same WARN-triggering state as T6b, but off master (feat/x):
// neither usage-guard line prints — R6, verbatim, "on master only" ─────────
{
  const dir = makeGate5Repo();
  git(dir, ["branch", "-M", "feat/x"]);
  const runsPath = join(dir, "runs.jsonl");
  writeFileSync(runsPath, oneHourAgoSyncLine());
  writeStatusShard(dir);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "chore: status shard"]);
  const env = scrubbedEnv({ PLANE_SYNC_SELF_TEST: "1", PLANE_RUNS_PATH: runsPath });

  const res = await runStopHook(dir, env);
  const merged = res.stdout + res.stderr;

  const exitOk = res.status === 0;
  const neitherLine =
    !/Plane: last sync/.test(merged) && !/Plane: WARN landing without sync/.test(merged);

  const details = [];
  if (!exitOk) details.push(`      expected exit 0, got ${res.status}`);
  if (!neitherLine) {
    details.push(
      '      expected neither "Plane: last sync" nor "Plane: WARN landing without sync" off master',
    );
  }
  report(
    "T6c/R6 — off master (feat/x): neither usage-guard line prints, even with the WARN condition true",
    exitOk && neitherLine,
    [...details, `      stdout:\n${res.stdout}`, `      stderr:\n${res.stderr}`].join("\n"),
  );
}

// ── REG-B411 — F4's (fixed) per-dir check must not false-trip when a
// CONCURRENT sibling run creates its own stop-gate5-spec-* dir in the
// before/after window, even though THIS run's own REPO_DIRS entries are
// genuinely all cleaned up (root cause: .claude/campaign/bugs/B411.md — the
// OLD ambient tmpdir-count check treated any stop-gate5-spec-* dir in the
// tmp root as this run's own, so a sibling process creating one concurrently
// flipped it to FAIL even though this run leaked nothing). Deterministic, no
// host contention needed: this case does the cleanup itself, then plants an
// unregistered dir matching the naming pattern to stand in for the sibling,
// and re-runs F4's own check formula (below) verbatim against that state —
// per-dir existsSync over ALL_REPO_DIRS, which the sibling's untracked dir
// can never appear in.
{
  // "This run's own dirs are genuinely all cleaned up" — perform the same
  // cleanup the real F4 section below performs, ahead of time (idempotent —
  // F4's own `cleanupRepos()` call afterward is then a no-op).
  cleanupRepos();
  const genuinelyClean = REPO_DIRS.length === 0;

  // Simulate a CONCURRENT sibling run: a stop-gate5-spec-* dir created
  // directly, deliberately NOT registered in REPO_DIRS/ALL_REPO_DIRS since
  // it belongs to another process, not this run.
  const siblingDir = mkdtempSync(join(tmpdir(), REPO_PREFIX));
  try {
    // F4's own check, verbatim (see the F4 section below).
    const leftover = ALL_REPO_DIRS.filter((dir) => existsSync(dir));
    const f4Check = leftover.length === 0;
    report(
      "REG-B411 — F4's per-dir check must not false-trip on a concurrent sibling's dir when this run's own dirs are genuinely all gone",
      genuinelyClean && f4Check,
      `      REPO_DIRS after cleanup: ${REPO_DIRS.length} (expected 0 — this run's own dirs are genuinely gone)\n` +
        `      F4's own check (ALL_REPO_DIRS.every(!existsSync)): ${f4Check} (leftover=${JSON.stringify(leftover)})\n` +
        `      a concurrent sibling's stop-gate5-spec-* dir (untracked, not in ALL_REPO_DIRS) must never flip this run's own check to FAIL`,
    );
  } finally {
    rmSync(siblingDir, { recursive: true, force: true });
  }
}

// ── F4 — the scaffold repos this run created are all gone ────────────────────
// Asserts each dir THIS RUN created (ALL_REPO_DIRS) individually no longer
// exists, rather than comparing an ambient tmpdir-wide stop-gate5-spec-*
// count before/after — that count check false-trips whenever a CONCURRENT
// sibling run creates its own stop-gate5-spec-* dir in the before/after
// window (REG-B411), even though this run's own dirs are genuinely all
// cleaned up. Per-dir existsSync is immune to a sibling's unrelated dirs.
cleanupRepos();
const leftoverDirs = ALL_REPO_DIRS.filter((dir) => existsSync(dir));
report(
  "F4 — leaves no stop-gate5-spec-* dir behind",
  leftoverDirs.length === 0,
  `      dirs created this run: ${ALL_REPO_DIRS.length}, still present: ${leftoverDirs.length}\n` +
    (leftoverDirs.length > 0 ? `      leftover: ${JSON.stringify(leftoverDirs)}\n` : "") +
    `      tmpdir stop-gate5-spec-* count (informational only): before=${tmpDirsBefore} after=${countSpecTmpDirs()}`,
);

const TOTAL_CASES = 11;
if (failed > 0) {
  console.log(`\nstop.gate5.spec FAILED — ${failed}/${TOTAL_CASES} case(s).`);
  process.exit(1);
}
console.log(`\nstop.gate5.spec PASS (${TOTAL_CASES}/${TOTAL_CASES} cases)`);
process.exit(0);
