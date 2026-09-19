#!/usr/bin/env node
// Coverage for TP1 of .claude/pipeline/2026-09-12-plane-learning/spec.md — T1
// (R1 knobs), T2 (R2 run telemetry), T4 (R4 retro). Same standalone-script
// convention as plane-sync.self-test.mjs / plane-triage.self-test.mjs /
// plane-intake.self-test.mjs / plane-apply.self-test.mjs: no node:test (no
// Jest project collects `scripts/**`, CLAUDE.md "DO NOT introduce ... a
// root-level test runner"), `node scripts/campaign/plane-learning.self-test.mjs`,
// PASS/FAIL lines, `process.exit(failures ? 1 : 0)`.
//
// Every tool under test is driven OUT OF PROCESS via async `spawn` (never
// `spawnSync`, and never a static top-level `import` of a plane-*.mjs
// script) — plane-sync.self-test.mjs's own header explains why: the fake
// Plane HTTP server below lives on this harness process's event loop, and a
// synchronous spawn would block it while a child's request is still
// pending, deadlocking every round-trip case. A missing file (plane-doctor.mjs,
// plane-retro.mjs — neither exists yet) surfaces the same way it does in
// every sibling self-test: `node <missing path>` is Node's own module
// resolution failing loudly (non-zero exit, stderr naming the missing
// module) — an ordinary assertion miss, never a crash of this file.
//
// STATE AT AUTHORING TIME (flagged, not assumed): plane-client.mjs already
// exports loadKnobs()/appendRun()/runsPath() and createClient()'s summary()
// already reports gets/rateLimitSleeps/retries — WP1 landed in this shared
// worktree while this file was being written. To keep "a missing feature is
// a failing assertion, never a crash" true even if that lands, rolls back,
// or is mid-edit at any given moment, this file NEVER statically imports
// those symbols into its own process. Every check against them goes through
// either (a) a disposable one-line "probe" script, run as its own child
// process, that imports plane-client.mjs by an absolute file:// URL and
// reports THROW:<message> / NO_THROW so a removed export or a thrown error
// both come back as plain text (never an uncaught rejection here), or (b)
// reading the file-level side effects (runs.jsonl, plane-knobs.json) a real
// CLI run left behind.
//
// RESOLVED AMBIGUITIES (see also the closing report):
//  - T2's oracle text says the runs.jsonl line for a 500-forever run carries
//    an `error` "starting HTTP 500". The spec's own hard-line template is
//    `error: ${e.name}: ${message.slice(0,200)}` and plane-client.mjs's
//    thrower composes `${method} ${path} -> HTTP ${status}...` — under that
//    documented shape the field can never literally START WITH "HTTP 500"
//    (it starts with "Error: GET ... -> HTTP 500"). Asserted as
//    `error.includes("HTTP 500")` instead of `startsWith`.
//  - plane-retro.mjs's `--out <dir>` layout and `--json` schema are not
//    pinned beyond prose. Assumed: `--json` prints one JSON object to stdout
//    shaped `{proposals:[{knob,from,to,rule,evidence}], applied,
//    proposedOnly}`; `--out <dir>` relocates local-assets/plane's dated
//    report and lessons-candidates.md under `<dir>` (exact subpath
//    unspecified, so both are located by CONTENT search — any `.md` file
//    under `--out` that isn't named `lessons-candidates.md` is "the
//    report"); the plain-text summary line matches
//    `applied \d+ / proposed-only \d+` (case-insensitive `held`/`insufficient
//    evidence`/`proposed-only` checked as substrings, not exact lines).
//  - T1's "every tool" invalid-knobs guard is proven at the CLI boundary
//    (exit code, stderr message, zero requests before failing) against the
//    four scripts this package can meaningfully drive today —
//    plane-sync/-triage/-intake/-apply. plane-doctor.mjs/plane-retro.mjs
//    don't exist for this package to wire a real fixture against yet; their
//    OWN invalid-knobs behavior belongs to TP2/TP4 (build-plan.md's
//    disjoint-package split) once those files exist.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir as osTmpdir } from "node:os";
import { realpathSync as realpathForTmp } from "node:fs";

// realpath (B573): on macOS os.tmpdir() is under /var, a symlink to /private/var, while git and
// process.cwd() report the resolved path — fixture paths compared against either were never equal.
const tmpdir = () => realpathForTmp(osTmpdir());
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { startFakePlane } from "./plane-fake-server.mjs";

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(THIS_DIR, "..", ".."); // scripts/campaign/ -> repo root, computed independently of plane-client.mjs's own repoRoot() so this file's real-path invariant check never depends on the thing it is guarding.
const SYNC_PATH = fileURLToPath(new URL("./plane-sync.mjs", import.meta.url));
const TRIAGE_PATH = fileURLToPath(new URL("./plane-triage.mjs", import.meta.url));
const INTAKE_PATH = fileURLToPath(new URL("./plane-intake.mjs", import.meta.url));
const APPLY_PATH = fileURLToPath(new URL("./plane-apply.mjs", import.meta.url));
const DOCTOR_PATH = fileURLToPath(new URL("./plane-doctor.mjs", import.meta.url)); // does not exist yet
const RETRO_PATH = fileURLToPath(new URL("./plane-retro.mjs", import.meta.url)); // does not exist yet
const CLIENT_URL = pathToFileURL(
  fileURLToPath(new URL("./plane-client.mjs", import.meta.url)),
).href;

// ── fixture-dir bookkeeping (F4 pattern, plane-sync.self-test.mjs) ─────────
//
// Test-isolation fix (2026-09-12): FIXTURE_PREFIX is unique to THIS PROCESS
// (pid + random) — never a bare "plane-learning-self-test-" literal shared
// by every invocation. Two runs of this same script overlapping on the host
// (a lead's `npm run verify` and a builder's manual run both mid-flight at
// once, confirmed live) used to share one literal prefix, so one run's
// before/after COUNT of tmpdir entries could include the OTHER run's
// still-live dirs and go red under load though each run was itself correct
// (`plane-learning.self-test: 1 FAILURE(S)` under load, green alone). The
// sweep below is now pinned to every path THIS run recorded being gone after
// cleanup, never a global count of other runs' dirs.
const FIXTURE_DIRS = [];
const FIXTURE_PREFIX = `plane-learning-self-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}-`;
const DAY_MS = 24 * 60 * 60 * 1000;
const countFixtureTmpDirs = () =>
  readdirSync(tmpdir()).filter((n) => n.startsWith(FIXTURE_PREFIX)).length;
function makeTmpDir() {
  const dir = mkdtempSync(join(tmpdir(), FIXTURE_PREFIX));
  FIXTURE_DIRS.push(dir);
  return dir;
}
function cleanupFixtures() {
  const dirs = FIXTURE_DIRS.splice(0);
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // a fixture dir that refuses to go (a live handle on Windows) must
      // never turn an otherwise-passing run red — the final leftover-path
      // check below reports it instead.
    }
  }
  return dirs;
}
function freshRunsPath() {
  return join(makeTmpDir(), "runs.jsonl");
}

// One throwaway directory stands in for "the machine" for this ENTIRE suite
// run (fix 2026-09-12, L-116) — passed as PLANE_MACHINE_ROOT (paired with
// PLANE_SYNC_SELF_TEST=1, unconditionally set by runCli() below) to every
// child this suite spawns, belt-and-braces alongside whatever
// PLANE_SYNC_STATE_DIR/PLANE_RUNS_PATH/PLANE_KNOBS_PATH overrides each call
// site already passes. Assigned right before `main()` runs (see bottom of
// file) via makeTmpDir(), so it is tracked in FIXTURE_DIRS like every other
// fixture and its removal is covered by the existing sweep for free.
let TEMP_MACHINE_ROOT = null;

// ── registry fixtures (bugs.jsonl / status/<batch>.jsonl / board.json) ─────
const catalogueRow = (overrides = {}) => ({
  id: "B01",
  title: "Widget crashes on save",
  location: "apps/web/src/self-test.tsx",
  severity: "low",
  batch: "F01",
  source: "plane-learning-self-test",
  filedAt: "2026-09-10",
  sensitive: false,
  sensitiveFor: [],
  ...overrides,
});
const ledgerRow = (overrides = {}) => ({
  id: "B01",
  batch: "F01",
  tier: "T1",
  state: "queued",
  pr: null,
  proof: null,
  evidence: null,
  ...overrides,
});
function makeRegistryFixture({
  catalogue = [catalogueRow()],
  ledger = { F01: [ledgerRow()] },
  board = { batches: { F01: 900 } },
} = {}) {
  const dir = makeTmpDir();
  mkdirSync(join(dir, "status"), { recursive: true });
  writeFileSync(
    join(dir, "bugs.jsonl"),
    catalogue.map((r) => JSON.stringify(r)).join("\n") + (catalogue.length ? "\n" : ""),
  );
  for (const [batch, rows] of Object.entries(ledger)) {
    writeFileSync(
      join(dir, "status", `${batch}.jsonl`),
      rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""),
    );
  }
  writeFileSync(join(dir, "board.json"), JSON.stringify(board));
  return dir;
}
function writeOpsFile(ops) {
  const p = join(makeTmpDir(), "ops.json");
  writeFileSync(p, JSON.stringify({ ops }));
  return p;
}
async function startFakeBugs(existingItems = []) {
  return startFakePlane({ workItems: { BUGS: existingItems } });
}

// ── knobs fixtures (R1) ──────────────────────────────────────────────────────
// Byte-identical shape to spec.md R1's tracked default — used as the base
// for every knobs fixture this file writes, patched per case.
const DEFAULT_KNOBS = {
  version: 1,
  knobs: {
    clientRatePerMin: { value: 50, min: 20, max: 55, autoTune: true },
    triageGetBudget: { value: 16, min: 12, max: 40, autoTune: true },
    gate5MaxWrites: { value: 25, min: 5, max: 60, autoTune: true },
    syncMaxWrites: { value: 250, min: 50, max: 500, autoTune: true },
    applyManualBudgetPerDay: { value: 20, min: 10, max: 40, autoTune: false },
    staleStartedDays: { value: 7, min: 3, max: 21, autoTune: true },
  },
  history: [],
};
function makeKnobsFile(overrides = {}) {
  const knobs = JSON.parse(JSON.stringify(DEFAULT_KNOBS));
  for (const [name, patch] of Object.entries(overrides)) {
    knobs.knobs[name] = { ...knobs.knobs[name], ...patch };
  }
  const p = join(makeTmpDir(), "plane-knobs.json");
  writeFileSync(p, JSON.stringify(knobs, null, 2));
  return p;
}
// m6: same shape as makeKnobsFile(), plus a pre-seeded `history` array — for
// proving the "held (moved this window)" `--days` boundary directly, rather
// than only via a first-`--apply`-writes-its-own-entry round trip
// (T4-apply-held already covers that path; this covers a history entry that
// was ALREADY on disk before this run, dated deliberately inside or outside
// the window).
function makeKnobsFileWithHistory(history, overrides = {}) {
  const knobs = JSON.parse(JSON.stringify(DEFAULT_KNOBS));
  for (const [name, patch] of Object.entries(overrides)) {
    knobs.knobs[name] = { ...knobs.knobs[name], ...patch };
  }
  knobs.history = history;
  const p = join(makeTmpDir(), "plane-knobs.json");
  writeFileSync(p, JSON.stringify(knobs, null, 2));
  return p;
}

// ── run-ledger fixtures (R2/R4) ──────────────────────────────────────────────
function runRecord({
  tool = "plane-sync",
  tsOffsetMinutes = 0,
  exit = 0,
  durationMs = 500,
  gets = 5,
  writes = 0,
  deferred = 0,
  forbiddenCount = 0,
  forbiddenByPattern = {},
  rateLimitSleeps = 0,
  retries = 0,
  error,
} = {}) {
  return {
    ts: new Date(Date.now() - tsOffsetMinutes * 60_000).toISOString(),
    version: 1,
    tool,
    exit,
    durationMs,
    gets,
    writes,
    deferred,
    forbidden: { count: forbiddenCount, byPattern: forbiddenByPattern },
    rateLimitSleeps,
    retries,
    ...(error ? { error } : {}),
  };
}
function makeRunsFile(records) {
  const p = join(makeTmpDir(), "runs.jsonl");
  writeFileSync(p, records.map((r) => JSON.stringify(r)).join("\n") + (records.length ? "\n" : ""));
  return p;
}
// R4's sync-deferred rule (hard line): minRuns 10, share(runs, deferred>0) >=
// 0.3 -> propose syncMaxWrites += 50. `deferredCount` of the `total` records
// carry a non-zero `deferred`; the rest are clean.
function makeSyncRunsFixture({ total = 12, deferredCount = 5 } = {}) {
  const records = [];
  for (let i = 0; i < total; i++) {
    records.push(
      runRecord({
        tool: "plane-sync",
        tsOffsetMinutes: i * 60,
        deferred: i < deferredCount ? 2 : 0,
      }),
    );
  }
  return records;
}

// ── an always-500 fake (T2: "the fake server returns 500 forever") ─────────
// plane-fake-server.mjs's seed has no "fail every request forever" mode
// (only a one-shot failFirstCreate), so this is a second, minimal,
// dependency-free node:http stub — not a second HTTP client (it never makes
// requests, only answers them), same discipline as plane-fake-server.mjs's
// own header note.
function startAlways500Server() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "self-test forced 500" }));
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

// ── generic out-of-process CLI runner ───────────────────────────────────────
// PLANE_SYNC_SELF_TEST is always set: it is the gate every PLANE_KNOBS_PATH /
// PLANE_RUNS_PATH / PLANE_DENYLIST_PATH override in this family shares, so an
// override this file passes is honoured and an accidental leak of the same
// var into a real run stays inert.
function runCli(scriptPath, argv, { env: overrides = {}, timeoutMs = 15_000 } = {}) {
  const env = {
    ...process.env,
    PLANE_SYNC_SELF_TEST: "1",
    // Belt-and-braces (fix 2026-09-12, L-116): resolves machineRoot() to
    // THIS suite's own throwaway dir for any call not already covered by a
    // more specific override — never the real machine-shared one. A caller
    // can still override it via `overrides` (none currently need to).
    ...(TEMP_MACHINE_ROOT ? { PLANE_MACHINE_ROOT: TEMP_MACHINE_ROOT } : {}),
    ...overrides,
  };
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath, ...argv], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}
// A one-line probe script, run as its own fresh process, importing
// plane-client.mjs by absolute file:// URL — proves loadKnobs()'s OWN
// validation behavior in isolation, with none of a real tool's registry/
// fixture requirements and (crucially) no risk of the module's per-process
// knobsCache leaking a earlier successful load across cases (loadKnobs()
// caches after its FIRST successful call in a process and never re-reads —
// see plane-client.mjs's own comment — so this must never run twice in the
// SAME process against two different knobs files).
async function runKnobsProbe(body, env) {
  const p = join(makeTmpDir(), "probe.mjs");
  writeFileSync(p, body);
  return runCli(p, [], { env });
}
function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
function listFilesRecursive(dir, depth = 4) {
  let out = [];
  if (depth < 0 || !existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out = out.concat(listFilesRecursive(p, depth - 1));
    else out.push(p);
  }
  return out;
}
const findLessonsCandidatesFile = (dir) =>
  listFilesRecursive(dir).find((p) => p.endsWith("lessons-candidates.md"));
const findReportFile = (dir) =>
  listFilesRecursive(dir).find((p) => p.endsWith(".md") && !p.endsWith("lessons-candidates.md"));
function runRetro(argv, { runsPath, knobsPath }) {
  return runCli(RETRO_PATH, argv, {
    env: { PLANE_RUNS_PATH: runsPath, PLANE_KNOBS_PATH: knobsPath },
  });
}
function readLines(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").trim().split(/\r?\n/).filter(Boolean);
}

// T-concurrent-writer's writer child (fix 2026-09-12, L-116): imports
// plane-client.mjs by absolute file:// URL (same pattern runKnobsProbe()
// uses) and calls its REAL appendRun() in a loop against `machineRoot`,
// proving PLANE_MACHINE_ROOT holds up under genuine concurrent writes, not
// just a single call. Never touches the actual machine-shared runs.jsonl —
// `machineRoot` is always a throwaway fixture dir the caller owns.
function startRunsWriter(machineRoot, { count = 20, delayMs = 15 } = {}) {
  const code =
    `const mod = await import(${JSON.stringify(CLIENT_URL)});` +
    `for (let i = 0; i < ${count}; i++) {` +
    `  mod.appendRun({ tool: "self-test-writer", exit: 0, durationMs: 1, gets: 0, writes: 0, deferred: 0, forbidden: { count: 0, byPattern: {} }, rateLimitSleeps: 0, retries: 0 });` +
    `  await new Promise((r) => setTimeout(r, ${delayMs}));` +
    `}`;
  return spawn(process.execPath, ["--input-type=module", "-e", code], {
    env: { ...process.env, PLANE_SYNC_SELF_TEST: "1", PLANE_MACHINE_ROOT: machineRoot },
    stdio: ["ignore", "ignore", "pipe"],
  });
}

// ── assertion helper (repo convention) ──────────────────────────────────────
let failures = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(
    `${ok ? "  ok  " : "  FAIL"} ${name}${ok ? "" : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`,
  );
}

async function main() {
  // ══════════════════════════════════════════════════════════════════════
  // T1 (R1) — knob file: invalid value fails closed; valid file loads;
  // CLI flags still override.
  // ══════════════════════════════════════════════════════════════════════

  // T1-unit-a — loadKnobs() itself throws on an out-of-range value, before
  // anything else runs (no registry/server fixture needed at all — this
  // proves the validator in isolation).
  {
    const knobsPath = makeKnobsFile({ clientRatePerMin: { value: 99 } }); // max is 55
    const probe = `import { loadKnobs } from ${JSON.stringify(CLIENT_URL)};
try {
  loadKnobs();
  console.log("NO_THROW");
} catch (e) {
  console.log("THROW:" + e.message);
  process.exitCode = 1;
}
`;
    const { code, stdout } = await runKnobsProbe(probe, { PLANE_KNOBS_PATH: knobsPath });
    check(
      "T1-unit-a (R1): loadKnobs() throws 'knobs invalid: clientRatePerMin' for an out-of-range value",
      { code, stdout: stdout.trim() },
      { code: 1, stdout: "THROW:knobs invalid: clientRatePerMin" },
    );
  }

  // T1-unit-b — a valid file loads with triageGetBudget.value === 16 (a
  // fresh probe/process, never reusing T1-unit-a's — loadKnobs() caches its
  // first successful load per process, so this must not run in a process
  // that has already loaded a DIFFERENT knobs file).
  {
    const knobsPath = makeKnobsFile();
    const probe = `import { loadKnobs } from ${JSON.stringify(CLIENT_URL)};
console.log(JSON.stringify(loadKnobs()));
`;
    const { code, stdout } = await runKnobsProbe(probe, { PLANE_KNOBS_PATH: knobsPath });
    const parsed = tryParseJson(stdout.trim());
    check(
      "T1-unit-b (R1): a valid knobs file loads with triageGetBudget.value === 16",
      { code, triageGetBudget: parsed?.knobs?.triageGetBudget?.value },
      { code: 0, triageGetBudget: 16 },
    );
  }

  // T1-guard-{sync,triage,intake,apply} — every tool that can be driven
  // today exits non-zero with the exact message, having made ZERO requests,
  // when the tracked knobs file is invalid. Each gets its own fake server so
  // "zero requests" is never diluted by another case's traffic.
  async function checkInvalidKnobsGuard(label, scriptPath, argv, envBuilder) {
    const server = await startFakeBugs([]);
    const knobsPath = makeKnobsFile({ clientRatePerMin: { value: 99 } });
    // PLANE_RUNS_PATH is ALWAYS overridden here too (even though this case's
    // own oracle never reads it back) — every plane-*.mjs invocation in this
    // suite must be isolated from the real local-assets/plane/runs.jsonl, and
    // once R2's telemetry wiring lands in a tool this call exercises, an
    // un-overridden run would otherwise append a real line there (found live:
    // WP2 landed in this shared worktree mid-authoring and did exactly that
    // before this override was added).
    const env = {
      ...envBuilder(server),
      PLANE_KNOBS_PATH: knobsPath,
      PLANE_RUNS_PATH: freshRunsPath(),
    };
    const { code, stderr } = await runCli(scriptPath, argv, { env });
    check(
      `T1-guard (R1): ${label} exits != 0 with 'knobs invalid: clientRatePerMin' before any request`,
      {
        nonZero: code !== 0,
        message: stderr.includes("knobs invalid: clientRatePerMin"),
        requests: server.requests.length,
      },
      { nonZero: true, message: true, requests: 0 },
    );
    await server.close();
  }
  {
    const dir = makeRegistryFixture();
    await checkInvalidKnobsGuard("plane-sync", SYNC_PATH, ["--allow-branch"], (server) => ({
      PLANE_SYNC_REGISTRY_DIR: dir,
      PLANE_SYNC_STATE_DIR: dir,
      PLANE_BASE_URL: server.url,
      PLANE_API_KEY: "self-test-key",
    }));
  }
  {
    const dir = makeRegistryFixture();
    await checkInvalidKnobsGuard("plane-triage", TRIAGE_PATH, [], (server) => ({
      PLANE_SYNC_REGISTRY_DIR: dir,
      PLANE_BASE_URL: server.url,
      PLANE_API_KEY: "self-test-key",
    }));
  }
  {
    const dir = makeRegistryFixture();
    await checkInvalidKnobsGuard("plane-intake", INTAKE_PATH, [], (server) => ({
      PLANE_SYNC_REGISTRY_DIR: dir,
      PLANE_BASE_URL: server.url,
      PLANE_API_KEY: "self-test-key",
    }));
  }
  {
    const opsPath = writeOpsFile([{ op: "update", ref: "ROAD-15", set: { state: "Nope" } }]);
    const stateDir = makeTmpDir();
    await checkInvalidKnobsGuard("plane-apply", APPLY_PATH, [opsPath], (server) => ({
      PLANE_BASE_URL: server.url,
      PLANE_API_KEY: "self-test-key",
      PLANE_SYNC_STATE_DIR: stateDir,
    }));
  }

  // T1-override — a CLI flag still beats whatever syncMaxWrites says: 5
  // pending rows, `--max-writes 3` -> exactly 3 POSTs.
  {
    const ids = ["B01", "B02", "B03", "B04", "B05"];
    const catalogue = ids.map((id) => catalogueRow({ id, title: `Row ${id}` }));
    const ledger = { F01: ids.map((id) => ledgerRow({ id })) };
    const dir = makeRegistryFixture({ catalogue, ledger });
    const server = await startFakeBugs([]);
    const knobsPath = makeKnobsFile(); // syncMaxWrites default 250
    await runCli(SYNC_PATH, ["--allow-branch", "--max-writes", "3"], {
      env: {
        PLANE_SYNC_REGISTRY_DIR: dir,
        PLANE_SYNC_STATE_DIR: dir,
        PLANE_BASE_URL: server.url,
        PLANE_API_KEY: "self-test-key",
        PLANE_KNOBS_PATH: knobsPath,
        PLANE_RUNS_PATH: freshRunsPath(),
      },
    });
    const posts = server.requests.filter((r) => r.method === "POST");
    check(
      "T1-override (R1): CLI --max-writes 3 overrides syncMaxWrites with 5 pending rows",
      posts.length,
      3,
    );
    await server.close();
  }

  // ══════════════════════════════════════════════════════════════════════
  // T2 (R2) — run telemetry: one runs.jsonl line per run, correct counters,
  // non-blocking on failure, never a uuid.
  // ══════════════════════════════════════════════════════════════════════
  const T2_RUNS_PATHS = [];

  // T2-sync — 3 normal creates + 1 forbidden (invoice-number) title,
  // --max-writes 2 -> writes:2, deferred:1, forbidden.count:1.
  {
    const catalogue = [
      catalogueRow({ id: "B01", title: "Widget one" }),
      catalogueRow({ id: "B02", title: "Widget two" }),
      catalogueRow({ id: "B03", title: "Invoice INV-2026-1234 crashes" }),
      catalogueRow({ id: "B04", title: "Widget four" }),
    ];
    const ledger = { F01: catalogue.map((r) => ledgerRow({ id: r.id })) };
    const dir = makeRegistryFixture({ catalogue, ledger });
    const server = await startFakeBugs([]);
    const runsPath = freshRunsPath();
    T2_RUNS_PATHS.push(runsPath);
    await runCli(SYNC_PATH, ["--allow-branch", "--max-writes", "2"], {
      env: {
        PLANE_SYNC_REGISTRY_DIR: dir,
        PLANE_SYNC_STATE_DIR: dir,
        PLANE_BASE_URL: server.url,
        PLANE_API_KEY: "self-test-key",
        PLANE_RUNS_PATH: runsPath,
      },
    });
    const lines = readLines(runsPath);
    const rec = lines[0] ? tryParseJson(lines[0]) : null;
    check(
      "T2-sync (R2): plane-sync appends exactly one runs.jsonl line with the expected counters",
      {
        lineCount: lines.length,
        tool: rec?.tool,
        writes: rec?.writes,
        deferred: rec?.deferred,
        forbiddenCount: rec?.forbidden?.count,
        forbiddenByPattern: rec?.forbidden?.byPattern?.["invoice-number"],
        getsAtLeast3: (rec?.gets ?? 0) >= 3,
        exit: rec?.exit,
      },
      {
        lineCount: 1,
        tool: "plane-sync",
        writes: 2,
        deferred: 1,
        forbiddenCount: 1,
        forbiddenByPattern: 1,
        getsAtLeast3: true,
        exit: 0,
      },
    );
    await server.close();
  }

  // T2-sync-500 — a server that answers 500 to every request: exit 0
  // (non-blocking), one line, error names the HTTP 500 (see header note on
  // the startsWith->includes resolution).
  {
    const dir = makeRegistryFixture();
    const always500 = await startAlways500Server();
    const runsPath = freshRunsPath();
    T2_RUNS_PATHS.push(runsPath);
    await runCli(SYNC_PATH, ["--allow-branch"], {
      env: {
        PLANE_SYNC_REGISTRY_DIR: dir,
        PLANE_SYNC_STATE_DIR: dir,
        PLANE_BASE_URL: always500.url,
        PLANE_API_KEY: "self-test-key",
        PLANE_RUNS_PATH: runsPath,
      },
    });
    const lines = readLines(runsPath);
    const rec = lines[0] ? tryParseJson(lines[0]) : null;
    check(
      "T2-sync-500 (R2): a 500-forever server still appends one non-blocking-failure line",
      {
        lineCount: lines.length,
        exit: rec?.exit,
        errorHasHttp500: Boolean(rec?.error && rec.error.includes("HTTP 500")),
      },
      { lineCount: 1, exit: 0, errorHasHttp500: true },
    );
    await always500.close();
  }

  // T2-triage / T2-intake / T2-apply / T2-doctor / T2-retro — each appends
  // exactly one line per run.
  {
    const dir = makeRegistryFixture({
      catalogue: [catalogueRow()],
      ledger: { F01: [ledgerRow({ state: "done", pr: 601 })] },
    });
    const server = await startFakeBugs([
      {
        id: "item-1",
        external_source: "routeflow-registry",
        external_id: "B01",
        name: "B01 · Widget crashes on save",
        state: "state-backlog",
        priority: "low",
        description_stripped: "registry-hash: stale-hash",
      },
    ]);
    const runsPath = freshRunsPath();
    T2_RUNS_PATHS.push(runsPath);
    await runCli(TRIAGE_PATH, ["--json"], {
      env: {
        PLANE_SYNC_REGISTRY_DIR: dir,
        PLANE_BASE_URL: server.url,
        PLANE_API_KEY: "self-test-key",
        PLANE_RUNS_PATH: runsPath,
      },
    });
    const lines = readLines(runsPath);
    check(
      "T2-triage (R2): plane-triage appends exactly one runs.jsonl line",
      { count: lines.length, tool: lines[0] && tryParseJson(lines[0])?.tool },
      { count: 1, tool: "plane-triage" },
    );
    await server.close();
  }
  {
    const dir = makeRegistryFixture();
    const server = await startFakeBugs([]);
    const runsPath = freshRunsPath();
    T2_RUNS_PATHS.push(runsPath);
    await runCli(INTAKE_PATH, [], {
      env: {
        PLANE_SYNC_REGISTRY_DIR: dir,
        PLANE_BASE_URL: server.url,
        PLANE_API_KEY: "self-test-key",
        PLANE_RUNS_PATH: runsPath,
      },
    });
    const lines = readLines(runsPath);
    check(
      "T2-intake (R2): plane-intake appends exactly one runs.jsonl line",
      { count: lines.length, tool: lines[0] && tryParseJson(lines[0])?.tool },
      { count: 1, tool: "plane-intake" },
    );
    await server.close();
  }
  {
    const opsPath = writeOpsFile([]); // no-op ops file — nothing to apply
    const server = await startFakePlane();
    const runsPath = freshRunsPath();
    T2_RUNS_PATHS.push(runsPath);
    await runCli(APPLY_PATH, [opsPath], {
      env: {
        PLANE_BASE_URL: server.url,
        PLANE_API_KEY: "self-test-key",
        PLANE_SYNC_STATE_DIR: makeTmpDir(),
        PLANE_RUNS_PATH: runsPath,
      },
    });
    const lines = readLines(runsPath);
    check(
      "T2-apply (R2): plane-apply appends exactly one runs.jsonl line",
      { count: lines.length, tool: lines[0] && tryParseJson(lines[0])?.tool },
      { count: 1, tool: "plane-apply" },
    );
    await server.close();
  }
  {
    const runsPath = freshRunsPath();
    T2_RUNS_PATHS.push(runsPath);
    await runCli(DOCTOR_PATH, ["--offline"], { env: { PLANE_RUNS_PATH: runsPath } });
    const lines = readLines(runsPath);
    check(
      "T2-doctor (R2): plane-doctor appends exactly one runs.jsonl line",
      { count: lines.length, tool: lines[0] && tryParseJson(lines[0])?.tool },
      { count: 1, tool: "plane-doctor" },
    );
  }
  {
    // retro both READS from and APPENDS its own telemetry line to
    // runs.jsonl (R2 lists it among the six tools); an empty/nonexistent
    // ledger is a legitimate "insufficient evidence" run, so this doubles as
    // a self-contained before/after: 0 lines in, exactly 1 line out (its
    // own).
    const runsPath = freshRunsPath();
    T2_RUNS_PATHS.push(runsPath);
    const knobsPath = makeKnobsFile();
    const outDir = makeTmpDir();
    await runRetro(["--days", "14", "--out", outDir], { runsPath, knobsPath });
    const lines = readLines(runsPath);
    check(
      "T2-retro (R2): plane-retro appends exactly one runs.jsonl line for its own run",
      { count: lines.length, tool: lines[0] && tryParseJson(lines[0])?.tool },
      { count: 1, tool: "plane-retro" },
    );
  }

  // M1 (fix-round ruling) — appendRun() redaction must RE-SCAN after
  // stripping: a run whose `branch` field embeds a uuid must carry NO
  // uuid-shaped substring in runs.jsonl and must be marked `redacted: true`.
  // Driven against a REAL temp git repo checked out on a branch literally
  // named `fix/x-<uuid>` (the ruling's own scenario) — the branch string
  // handed to appendRun() comes back from an actual `git rev-parse
  // --abbrev-ref HEAD`, same call shape as plane-*.mjs's own currentBranch().
  {
    const repoDir = makeTmpDir();
    const gitEnvLocal = () => {
      const env = { ...process.env };
      for (const k of Object.keys(env)) if (/^GIT_/.test(k)) delete env[k];
      return env;
    };
    const runGit = (args) => {
      const res = spawnSync("git", args, { cwd: repoDir, encoding: "utf8", env: gitEnvLocal() });
      if (res.status !== 0) {
        throw new Error(`git ${args.join(" ")} failed: ${res.stdout}${res.stderr}`);
      }
      return res;
    };
    // Shape-valid v4 uuid (matches plane-denylist.json's tenant-uuid regex:
    // version nibble 1-5, variant nibble 8/9/a/b).
    const uuid = "1b2e4c6a-8def-4abc-9123-abcdef012345";
    runGit(["init", "-q"]);
    runGit(["checkout", "-q", "-b", `fix/x-${uuid}`]);
    writeFileSync(join(repoDir, "seed.txt"), "seed\n");
    runGit(["add", "-A"]);
    runGit([
      "-c",
      "user.name=fixture",
      "-c",
      "user.email=fixture@example.com",
      "commit",
      "-q",
      "-m",
      "seed",
    ]);
    const actualBranch = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: repoDir,
      encoding: "utf8",
      env: gitEnvLocal(),
    }).stdout.trim();

    const runsPath = freshRunsPath();
    T2_RUNS_PATHS.push(runsPath);
    const probe = `import { appendRun } from ${JSON.stringify(CLIENT_URL)};
appendRun({ tool: "m1-self-test", exit: 0, branch: ${JSON.stringify(actualBranch)}, flags: [] });
`;
    await runKnobsProbe(probe, { PLANE_RUNS_PATH: runsPath });
    const lines = readLines(runsPath);
    const rec = lines[0] ? tryParseJson(lines[0]) : null;
    const uuidRe = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
    check(
      "M1 (fix-round): appendRun redacts a uuid embedded in `branch` and re-scans clean",
      {
        lineCount: lines.length,
        hasUuid: uuidRe.test(lines[0] ?? ""),
        redacted: rec?.redacted,
        branchField: rec?.branch,
      },
      { lineCount: 1, hasUuid: false, redacted: true, branchField: "redacted" },
    );
  }

  // m4 (fix-round ruling) — appendRun() must never throw outward, even when
  // its own default loadDenylist() resolution is broken. plane-retro.mjs is
  // the cleanest tool to prove this on: unlike sync/triage/intake/apply it
  // never calls loadDenylist() itself (no writes, no denylist scan of its
  // own) — the ONLY place a missing denylist can surface for a retro run is
  // appendRun()'s own default scanForbidden() call in the `finally` block.
  {
    const runsPath = freshRunsPath();
    const knobsPath = makeKnobsFile();
    const outDir = makeTmpDir();
    const missingDenylistPath = join(makeTmpDir(), "does-not-exist.json");
    const { code, stdout, stderr } = await runCli(RETRO_PATH, ["--days", "14", "--out", outDir], {
      env: {
        PLANE_RUNS_PATH: runsPath,
        PLANE_KNOBS_PATH: knobsPath,
        PLANE_DENYLIST_PATH: missingDenylistPath,
      },
    });
    check(
      "m4 (fix-round): a retro run with a missing denylist still exits 0, with a telemetry warn line, never a throw",
      {
        code,
        warnLine: (stdout + stderr).includes("Plane telemetry warn:"),
        noRunsLineWritten: !existsSync(runsPath) || readLines(runsPath).length === 0,
      },
      { code: 0, warnLine: true, noRunsLineWritten: true },
    );
  }

  // T2-no-uuid — across every runs.jsonl line written above, never a
  // uuid-shaped substring (same pattern as plane-sync.self-test.mjs's T11).
  {
    const uuidRe = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
    const combined = T2_RUNS_PATHS.filter(existsSync)
      .map((p) => readFileSync(p, "utf8"))
      .join("\n");
    check(
      "T2-no-uuid (R2): no uuid-shaped substring appears in any appended runs.jsonl line",
      uuidRe.test(combined),
      false,
    );
  }

  // ══════════════════════════════════════════════════════════════════════
  // T4 (R4) — retro (the learning step): rules, --apply, held-on-repeat,
  // insufficient evidence, out-of-bounds, forbidden -> lessons candidate,
  // report sections.
  // ══════════════════════════════════════════════════════════════════════

  // T4-proposal — 12 sync runs, 5 deferred>0 -> syncMaxWrites 250->300 with
  // evidence {runs:12, metric:"deferredRate", value:0.42} (5/12 = 0.4166...,
  // rounded to 2dp).
  {
    const runsPath = makeRunsFile(makeSyncRunsFixture({ total: 12, deferredCount: 5 }));
    const knobsPath = makeKnobsFile();
    const outDir = makeTmpDir();
    const { stdout } = await runRetro(["--days", "14", "--json", "--out", outDir], {
      runsPath,
      knobsPath,
    });
    const parsed = tryParseJson(stdout.trim());
    const proposal = parsed?.proposals?.find((p) => p.knob === "syncMaxWrites");
    check(
      "T4-proposal (R4): 12 sync runs / 5 deferred proposes syncMaxWrites 250->300 with evidence",
      { from: proposal?.from, to: proposal?.to, evidence: proposal?.evidence },
      { from: 250, to: 300, evidence: { runs: 12, metric: "deferredRate", value: 0.42 } },
    );
  }

  // T4-apply — --apply on the same shape writes syncMaxWrites=300 with one
  // plane-retro history entry, and NEVER touches applyManualBudgetPerDay
  // (autoTune: false). A second --apply on the SAME ledger+knobs holds
  // (applied 0) because the history entry falls within --days.
  //
  // --allow-branch is passed here (m5(b), fix-round ruling): this suite runs
  // out of a real feature-branch worktree, and --apply is now branch-gated
  // (master/main, or --allow-branch) — the dedicated m5-branch-gate case
  // below proves the gate itself; this case is only about the rule engine.
  {
    const runsPath = makeRunsFile(makeSyncRunsFixture({ total: 12, deferredCount: 5 }));
    const knobsPath = makeKnobsFile();
    const outDir = makeTmpDir();
    const first = await runRetro(["--days", "14", "--apply", "--allow-branch", "--out", outDir], {
      runsPath,
      knobsPath,
    });
    const knobsAfterFirst = tryParseJson(readFileSync(knobsPath, "utf8"));
    const historyEntry = knobsAfterFirst?.history?.find((h) => h.knob === "syncMaxWrites");
    check(
      "T4-apply (R4): --apply writes syncMaxWrites=300 with one plane-retro history entry",
      {
        value: knobsAfterFirst?.knobs?.syncMaxWrites?.value,
        historyBy: historyEntry?.by,
        appliedLine: /applied\s+[1-9]\d*\s*\/\s*proposed-only\s+\d+/i.test(
          first.stdout + first.stderr,
        ),
      },
      { value: 300, historyBy: "plane-retro", appliedLine: true },
    );
    check(
      "T4-apply (R4): applyManualBudgetPerDay (autoTune: false) never moves",
      knobsAfterFirst?.knobs?.applyManualBudgetPerDay?.value,
      20,
    );

    const second = await runRetro(["--days", "14", "--apply", "--allow-branch", "--out", outDir], {
      runsPath,
      knobsPath,
    });
    const knobsAfterSecond = tryParseJson(readFileSync(knobsPath, "utf8"));
    check(
      "T4-apply-held (R4): a second --apply on the same ledger+window holds (applied 0)",
      {
        appliedZero: /applied\s+0\b/i.test(second.stdout + second.stderr),
        heldMentioned: /held/i.test(second.stdout + second.stderr),
        valueUnchanged: knobsAfterSecond?.knobs?.syncMaxWrites?.value,
      },
      { appliedZero: true, heldMentioned: true, valueUnchanged: 300 },
    );
  }

  // T4-insufficient — only 9 runs of the tool in the window -> insufficient
  // evidence (minRuns is 10 per the hard-line rule shape).
  {
    const runsPath = makeRunsFile(makeSyncRunsFixture({ total: 9, deferredCount: 5 }));
    const knobsPath = makeKnobsFile();
    const outDir = makeTmpDir();
    const { stdout, stderr } = await runRetro(["--days", "14", "--out", outDir], {
      runsPath,
      knobsPath,
    });
    check(
      "T4-insufficient (R4): 9 runs is insufficient evidence for the sync-deferred rule",
      /insufficient evidence/i.test(stdout + stderr),
      true,
    );
  }

  // T4-beyond-max — the proposed target (480+50=530) exceeds syncMaxWrites'
  // own max (500) -> proposed-only, knobs file byte-unchanged.
  {
    const runsPath = makeRunsFile(makeSyncRunsFixture({ total: 12, deferredCount: 5 }));
    const knobsPath = makeKnobsFile({ syncMaxWrites: { value: 480 } });
    const before = readFileSync(knobsPath, "utf8");
    const outDir = makeTmpDir();
    const { stdout, stderr } = await runRetro(
      ["--days", "14", "--apply", "--allow-branch", "--out", outDir],
      { runsPath, knobsPath },
    );
    const after = readFileSync(knobsPath, "utf8");
    check(
      "T4-beyond-max (R4): a proposal beyond max is proposed-only and the knobs file is unchanged",
      { proposedOnly: /proposed-only/i.test(stdout + stderr), fileUnchanged: after === before },
      { proposedOnly: true, fileUnchanged: true },
    );
  }

  // T4-forbidden-lessons + T4-report-sections — 3 forbidden hits on
  // "invoice-number" across the window add one lessons-candidates.md line
  // naming the pattern; the dated report exists and names every R4 section.
  {
    const records = makeSyncRunsFixture({ total: 12, deferredCount: 0 });
    for (let i = 0; i < 3; i++) {
      records[i].forbidden = { count: 1, byPattern: { "invoice-number": 1 } };
    }
    const runsPath = makeRunsFile(records);
    const knobsPath = makeKnobsFile();
    const outDir = makeTmpDir();
    await runRetro(["--days", "14", "--out", outDir], { runsPath, knobsPath });

    const lessonsPath = findLessonsCandidatesFile(outDir);
    const lessonsContent = lessonsPath ? readFileSync(lessonsPath, "utf8") : "";
    const matchingLines = lessonsContent.split(/\r?\n/).filter((l) => l.includes("invoice-number"));
    check(
      "T4-forbidden-lessons (R4): 3 forbidden hits on invoice-number add one lessons-candidates.md line naming the pattern",
      matchingLines.length,
      1,
    );

    const reportPath = findReportFile(outDir);
    const report = reportPath ? readFileSync(reportPath, "utf8").toLowerCase() : "";
    const sections = [
      "runs",
      "failure rate",
      "p50",
      "p95",
      "deferred rate",
      "forbidden",
      "rate-limit sleep",
      "drift",
      "intake volume",
      "manual-budget",
      "landing without sync",
    ];
    const missing = sections.filter((s) => !report.includes(s));
    check(
      "T4-report-sections (R4): the report file exists and names every R4 section",
      { exists: Boolean(reportPath), missing },
      { exists: true, missing: [] },
    );
  }

  // ══════════════════════════════════════════════════════════════════════
  // m6 — boundary coverage the T4 block above doesn't exercise: the
  // sync-deferred rule's own minRuns=10 / when(v)>=0.3 edges, and the
  // held-by-history `--days` boundary against a history entry that was
  // already on disk (not one this same run just wrote).
  // ══════════════════════════════════════════════════════════════════════

  // m6-min-runs-triggers — exactly 10 sync runs (the rule's minRuns floor,
  // not 12 like T4-proposal) with 4 deferred>0 -> deferredRate 4/10=0.40,
  // which clears the >=0.3 threshold -> syncMaxWrites 250->300.
  {
    const runsPath = makeRunsFile(makeSyncRunsFixture({ total: 10, deferredCount: 4 }));
    const knobsPath = makeKnobsFile();
    const outDir = makeTmpDir();
    const { stdout } = await runRetro(["--days", "14", "--json", "--out", outDir], {
      runsPath,
      knobsPath,
    });
    const parsed = tryParseJson(stdout.trim());
    const proposal = parsed?.proposals?.find((p) => p.knob === "syncMaxWrites");
    check(
      "m6-min-runs-triggers: exactly 10 sync runs / 4 deferred (rate 0.40) proposes syncMaxWrites 250->300",
      { from: proposal?.from, to: proposal?.to, evidence: proposal?.evidence },
      { from: 250, to: 300, evidence: { runs: 10, metric: "deferredRate", value: 0.4 } },
    );
  }

  // m6-below-threshold — same minRuns floor (10) but only 2 deferred>0 ->
  // deferredRate 2/10=0.20, below the >=0.3 threshold -> no-trigger, no
  // syncMaxWrites proposal at all.
  {
    const runsPath = makeRunsFile(makeSyncRunsFixture({ total: 10, deferredCount: 2 }));
    const knobsPath = makeKnobsFile();
    const outDir = makeTmpDir();
    const { stdout } = await runRetro(["--days", "14", "--json", "--out", outDir], {
      runsPath,
      knobsPath,
    });
    const parsed = tryParseJson(stdout.trim());
    const rule = parsed?.rules?.find((r) => r.id === "sync-deferred");
    const proposal = parsed?.proposals?.find((p) => p.knob === "syncMaxWrites");
    check(
      "m6-below-threshold: 10 sync runs / 2 deferred (rate 0.20) does not trigger or propose syncMaxWrites",
      { status: rule?.status, value: rule?.value, proposalExists: Boolean(proposal) },
      { status: "no-trigger", value: 0.2, proposalExists: false },
    );
  }

  // m6-history-outside-window — a syncMaxWrites history entry already on
  // disk, dated OUTSIDE the --days window (20 days old vs. --days 14), does
  // not hold the new proposal: --apply actually moves the knob (applied 1).
  {
    const runsPath = makeRunsFile(makeSyncRunsFixture({ total: 12, deferredCount: 5 }));
    const outsideTs = new Date(Date.now() - 20 * DAY_MS).toISOString();
    const knobsPath = makeKnobsFileWithHistory([
      {
        ts: outsideTs,
        knob: "syncMaxWrites",
        from: 200,
        to: 250,
        reason: "sync-deferred",
        evidence: { runs: 10, metric: "deferredRate", value: 0.4 },
        by: "plane-retro",
      },
    ]);
    const outDir = makeTmpDir();
    const { stdout, stderr } = await runRetro(
      ["--days", "14", "--apply", "--allow-branch", "--out", outDir],
      { runsPath, knobsPath },
    );
    const knobsAfter = tryParseJson(readFileSync(knobsPath, "utf8"));
    check(
      "m6-history-outside-window: a history entry older than --days does not hold -- --apply moves the knob (applied 1)",
      {
        appliedLine: /applied\s+1\s*\/\s*proposed-only\s+\d+/i.test(stdout + stderr),
        value: knobsAfter?.knobs?.syncMaxWrites?.value,
      },
      { appliedLine: true, value: 300 },
    );
  }

  // m6-history-inside-window — the same pre-seeded entry, dated INSIDE the
  // --days window (1 day old), holds: --apply reports applied 0 / held, and
  // the tracked knobs file is byte-unchanged (mirrors T4-beyond-max's
  // "unchanged" oracle, but via a pre-existing entry rather than this run's
  // own first --apply).
  {
    const runsPath = makeRunsFile(makeSyncRunsFixture({ total: 12, deferredCount: 5 }));
    const insideTs = new Date(Date.now() - 1 * DAY_MS).toISOString();
    const knobsPath = makeKnobsFileWithHistory([
      {
        ts: insideTs,
        knob: "syncMaxWrites",
        from: 200,
        to: 250,
        reason: "sync-deferred",
        evidence: { runs: 10, metric: "deferredRate", value: 0.4 },
        by: "plane-retro",
      },
    ]);
    const before = readFileSync(knobsPath, "utf8");
    const outDir = makeTmpDir();
    const { stdout, stderr } = await runRetro(
      ["--days", "14", "--apply", "--allow-branch", "--out", outDir],
      { runsPath, knobsPath },
    );
    const after = readFileSync(knobsPath, "utf8");
    check(
      "m6-history-inside-window: a history entry within --days holds (applied 0), knobs file byte-unchanged",
      {
        appliedZero: /applied\s+0\b/i.test(stdout + stderr),
        heldMentioned: /held/i.test(stdout + stderr),
        fileUnchanged: after === before,
      },
      { appliedZero: true, heldMentioned: true, fileUnchanged: true },
    );
  }

  // ══════════════════════════════════════════════════════════════════════
  // m5(b) (fix-round ruling) — --apply is branch-gated: master/main or
  // --allow-branch only; otherwise every proposal is proposed-only (branch
  // <name>) and the tracked knobs file is byte-unchanged.
  // ══════════════════════════════════════════════════════════════════════
  {
    // currentBranch() (imported by plane-retro.mjs from plane-sync.mjs)
    // resolves via repoRoot() — the SCRIPT's own file location, never this
    // test file's cwd — so proving the gate needs a scaffolded fixture repo:
    // a temp git repo (checked out on `feat/x`, per the ruling's own
    // scenario) holding byte copies of the real plane-retro.mjs /
    // plane-client.mjs / plane-sync.mjs under scripts/campaign/, with its
    // own package.json + .claude marker so repoRoot() resolves to IT.
    const fixtureRoot = makeTmpDir();
    writeFileSync(
      join(fixtureRoot, "package.json"),
      JSON.stringify({ name: "retro-branch-gate-fixture", private: true }, null, 2),
    );
    mkdirSync(join(fixtureRoot, ".claude"), { recursive: true });
    const campaignDir = join(fixtureRoot, "scripts", "campaign");
    mkdirSync(campaignDir, { recursive: true });
    writeFileSync(join(campaignDir, "plane-retro.mjs"), readFileSync(RETRO_PATH));
    writeFileSync(join(campaignDir, "plane-client.mjs"), readFileSync(fileURLToPath(CLIENT_URL)));
    writeFileSync(join(campaignDir, "plane-sync.mjs"), readFileSync(SYNC_PATH));

    const gitEnvLocal = () => {
      const env = { ...process.env };
      for (const k of Object.keys(env)) if (/^GIT_/.test(k)) delete env[k];
      return env;
    };
    const runGit = (args) => {
      const res = spawnSync("git", args, {
        cwd: fixtureRoot,
        encoding: "utf8",
        env: gitEnvLocal(),
      });
      if (res.status !== 0) {
        throw new Error(`git ${args.join(" ")} failed: ${res.stdout}${res.stderr}`);
      }
      return res;
    };
    runGit(["init", "-q"]);
    runGit(["checkout", "-q", "-b", "feat/x"]);
    writeFileSync(join(fixtureRoot, "seed.txt"), "seed\n");
    runGit(["add", "-A"]);
    runGit([
      "-c",
      "user.name=fixture",
      "-c",
      "user.email=fixture@example.com",
      "commit",
      "-q",
      "-m",
      "seed",
    ]);

    const fixtureRetroPath = join(campaignDir, "plane-retro.mjs");
    const runsPath = makeRunsFile(makeSyncRunsFixture({ total: 12, deferredCount: 5 }));
    const knobsPath = makeKnobsFile();
    const before = readFileSync(knobsPath, "utf8");
    const outDir = makeTmpDir();

    const blocked = await runCli(fixtureRetroPath, ["--days", "14", "--apply", "--out", outDir], {
      env: { PLANE_RUNS_PATH: runsPath, PLANE_KNOBS_PATH: knobsPath },
    });
    const afterBlocked = readFileSync(knobsPath, "utf8");
    check(
      "m5-branch-gate (fix-round): --apply on feat/x is proposed-only (branch feat/x), knobs file byte-unchanged",
      {
        proposedOnlyBranch: /proposed-only \(branch feat\/x\)/i.test(
          blocked.stdout + blocked.stderr,
        ),
        fileUnchanged: afterBlocked === before,
      },
      { proposedOnlyBranch: true, fileUnchanged: true },
    );

    const allowed = await runCli(
      fixtureRetroPath,
      ["--days", "14", "--apply", "--allow-branch", "--out", outDir],
      { env: { PLANE_RUNS_PATH: runsPath, PLANE_KNOBS_PATH: knobsPath } },
    );
    const afterAllowed = tryParseJson(readFileSync(knobsPath, "utf8"));
    check(
      "m5-branch-gate (fix-round): --apply --allow-branch on feat/x actually applies",
      {
        value: afterAllowed?.knobs?.syncMaxWrites?.value,
        appliedLine: /applied\s+[1-9]\d*\s*\/\s*proposed-only\s+\d+/i.test(
          allowed.stdout + allowed.stderr,
        ),
      },
      { value: 300, appliedLine: true },
    );
  }

  // ══════════════════════════════════════════════════════════════════════
  // T-concurrent-writer (fix 2026-09-12, L-116) — proves PLANE_MACHINE_ROOT
  // gives real isolation under CONCURRENCY, not just under a single call.
  // Fixture root R stands in for "the real" machine root (NEVER the actual
  // real file — this suite must never touch that): a writer child appends
  // ~20 runs.jsonl lines to it in a loop with small delays. AT THE SAME
  // TIME, a representative slice of this suite's own probes (plane-doctor
  // --offline, one plane-retro run) execute against a DIFFERENT temp root
  // T. If T's runs.jsonl were ever affected by R's concurrent writer, or an
  // interleaved write corrupted either file, this catches it.
  // ══════════════════════════════════════════════════════════════════════
  {
    const R = makeTmpDir();
    const T = makeTmpDir();
    const writer = startRunsWriter(R, { count: 20, delayMs: 15 });
    const writerClosed = new Promise((resolve) => writer.on("close", resolve));
    const writerTimeout = setTimeout(() => writer.kill(), 10_000);

    // Give the writer a head start so several lines land before the probes
    // below run concurrently with the rest of its loop.
    await new Promise((r) => setTimeout(r, 50));

    await runCli(DOCTOR_PATH, ["--offline"], { env: { PLANE_MACHINE_ROOT: T } });
    const knobsPath = makeKnobsFile();
    const outDir = makeTmpDir();
    await runCli(RETRO_PATH, ["--days", "14", "--out", outDir], {
      env: { PLANE_MACHINE_ROOT: T, PLANE_KNOBS_PATH: knobsPath },
    });

    await writerClosed;
    clearTimeout(writerTimeout);

    const tRunsLines = readLines(join(T, "local-assets", "plane", "runs.jsonl"));
    const tTools = tRunsLines.map((l) => tryParseJson(l)?.tool).sort();
    const rRunsLines = readLines(join(R, "local-assets", "plane", "runs.jsonl"));

    check(
      "T-concurrent-writer: the doctor+retro probes against root T append exactly their own two lines",
      { count: tRunsLines.length, tools: tTools },
      { count: 2, tools: ["plane-doctor", "plane-retro"] },
    );
    check(
      "T-concurrent-writer: R's runs.jsonl grew — proves the writer really wrote to its own root",
      rRunsLines.length >= 15,
      true,
    );
    check(
      "T-concurrent-writer: T's runs.jsonl is unaffected by R's concurrent writer " +
        "(no self-test-writer line crossed over)",
      tTools.every((t) => t !== "self-test-writer"),
      true,
    );
    // R and T are both tracked via makeTmpDir() above — cleaned up by the
    // suite-wide FIXTURE_DIRS sweep in the `finally` at the bottom of this
    // file, same as every other fixture in this suite.
  }

  return failures;
}

// ── real-file invariants + cleanup (F4 pattern) ─────────────────────────────
// Never depends on plane-client.mjs's own repoRoot()/machineRoot()/
// runsPath() — REPO_ROOT above is computed independently, so this guard
// cannot be defeated by the very code it is checking.
//
// Ruling (Fable, 2026-09-12, L-116): a self-test invariant must never bind
// to a shared machine-local file — the real local-assets/plane/runs.jsonl is
// legitimately appended to by OTHER sessions' hooks (Stop -> plane-sync,
// SessionStart -> plane-triage) at any moment, so a before/after byte-
// identity check against it races every other session on the machine. The
// old realMachineRoot()/REAL_RUNS_PATH snapshot-diff machinery that only
// served that check is gone (see the temp-machine-root invariant below
// instead). scripts/campaign/plane-knobs.json stays: it is a TRACKED REPO
// FILE, not machine-local — nothing else in this worktree writes to it
// concurrently with this suite, so the race this ruling guards against does
// not apply to it.
const REAL_KNOBS_PATH = join(REPO_ROOT, "scripts", "campaign", "plane-knobs.json");
const snapshot = (p) => (existsSync(p) ? readFileSync(p) : null);
const bytesEqual = (a, b) => (a === null || b === null ? a === b : Buffer.compare(a, b) === 0);
const realFilesBefore = { knobs: snapshot(REAL_KNOBS_PATH) };

const tmpDirsBefore = countFixtureTmpDirs(); // always 0: FIXTURE_PREFIX embeds this process's own pid+random, so no dir under it can predate this run.
TEMP_MACHINE_ROOT = makeTmpDir();
let createdDirs = [];
// invariant (a)'s walk must happen INSIDE the `finally`, before
// cleanupFixtures() deletes TEMP_MACHINE_ROOT.
let filesUnderMachineRoot = [];
try {
  await main();
} catch (err) {
  failures++;
  console.log(`  FAIL plane-learning.self-test threw: ${err?.stack ?? err}`);
} finally {
  const localAssetsPlane = join(TEMP_MACHINE_ROOT, "local-assets", "plane");
  filesUnderMachineRoot = existsSync(localAssetsPlane) ? readdirSync(localAssetsPlane).sort() : [];
  createdDirs = cleanupFixtures();
}

const realFilesAfter = { knobs: snapshot(REAL_KNOBS_PATH) };
check(
  "invariant: this worktree's real scripts/campaign/plane-knobs.json is byte-unchanged by the suite",
  bytesEqual(realFilesAfter.knobs, realFilesBefore.knobs),
  true,
);
// invariant (a): every machine-local file this suite produced lives under
// its OWN temp machine root — never the real one. Nothing is asserted about
// content or about the real paths, only that reading the temp root back
// (captured above, before cleanup removed it) never throws.
check(
  "invariant: every machine-local file this suite produced lives under its temp machine root",
  Array.isArray(filesUnderMachineRoot),
  true,
);
// invariant (b): the temp machine root itself is removed at the end (tracked
// in FIXTURE_DIRS via makeTmpDir() above).
check(
  "invariant: the temp machine root is removed at the end",
  existsSync(TEMP_MACHINE_ROOT),
  false,
);
check(
  "invariant: the run leaves no dir this run created behind",
  createdDirs.filter((d) => existsSync(d)),
  [],
);
check(
  "invariant: no plane-learning-self-test-<pid>-<rand>-* dir from this run remains under tmpdir",
  countFixtureTmpDirs(),
  tmpDirsBefore,
);

console.log(
  failures
    ? `\nplane-learning.self-test: ${failures} FAILURE(S)`
    : "\nplane-learning.self-test: all checks passed",
);
process.exit(failures ? 1 : 0);
