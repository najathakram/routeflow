#!/usr/bin/env node
// Coverage for scripts/campaign/plane-triage.mjs (TP3, build-plan.md
// 2026-09-11-plane-harness). Same standalone-script convention as
// plane-sync.self-test.mjs / plane-intake.self-test.mjs — no node:test:
// `node scripts/campaign/plane-triage.self-test.mjs`, PASS/FAIL lines,
// `process.exit(failures ? 1 : 0)`.
//
// plane-triage.mjs does not exist yet: every case below drives it via
// `spawn` (never a static top-level `import`), so a missing file surfaces as
// an ordinary non-zero child exit / empty stdout — a clean assertion miss,
// never a crash of this file (test-plan.md §6).
import {
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
import { spawn } from "node:child_process";
import { startFakePlane } from "./plane-fake-server.mjs";
import { repoRoot, machineRoot } from "./plane-client.mjs";

const SCRIPT_PATH = fileURLToPath(new URL("./plane-triage.mjs", import.meta.url));

// F4 pattern: every fixture dir this run creates is tracked and swept in a
// `finally`.
//
// Test-isolation fix (2026-09-12): FIXTURE_PREFIX is unique to THIS PROCESS
// (pid + random) — never a bare "plane-triage-self-test-" literal shared by
// every invocation, which let two overlapping runs of this script pollute
// each other's before/after dir COUNT under load. The sweep is pinned to
// every path THIS run recorded being gone after cleanup, never a global
// count of other runs' dirs.
const FIXTURE_DIRS = [];
const FIXTURE_PREFIX = `plane-triage-self-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}-`;
const countFixtureTmpDirs = () =>
  readdirSync(tmpdir()).filter((n) => n.startsWith(FIXTURE_PREFIX)).length;
function cleanupFixtures() {
  const dirs = FIXTURE_DIRS.splice(0);
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // a fixture dir that refuses to go must never turn a passing run red —
      // the final leftover-path check below reports it instead.
    }
  }
  return dirs;
}

// A minimal registry: one row per `ids` entry (default one, "B12"), each
// ledger state "done" (pr 600). Paired against a fake Plane BUGS item with a
// matching `external_id` still in Backlog, so plane-triage's reused
// `planDiff` (R7: "never a second diff implementation", imported from
// plane-sync.mjs) reports each as drift. `ids` defaults to `["B12"]` so every
// pre-existing call site (T8, T15) is byte-for-byte unchanged; the Defect 2
// page-cap case below is the one caller that passes more than one id.
function makeRegistryFixture({ ids = ["B12"] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), FIXTURE_PREFIX));
  FIXTURE_DIRS.push(dir);
  mkdirSync(join(dir, "status"), { recursive: true });
  const catalogue = ids.map((id) => ({
    id,
    title: "Drifted bug",
    location: "apps/api/src/self-test.ts",
    severity: "medium",
    batch: "F01",
    source: "plane-triage-self-test",
    filedAt: "2026-09-01",
    sensitive: false,
    sensitiveFor: [],
  }));
  writeFileSync(join(dir, "bugs.jsonl"), catalogue.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const ledger = ids.map((id) => ({
    id,
    batch: "F01",
    tier: "T1",
    state: "done",
    pr: 600,
    proof: `REG-${id}`,
    evidence: null,
  }));
  writeFileSync(
    join(dir, "status", "F01.jsonl"),
    ledger.map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
  writeFileSync(join(dir, "board.json"), JSON.stringify({ batches: { F01: 600 } }));
  return dir;
}

// Runs plane-triage.mjs out-of-process via async `spawn` (never `spawnSync`
// — the fake Plane server lives on this harness process's own event loop).
function fallbackRunsPath() {
  return join(
    tmpdir(),
    `${FIXTURE_PREFIX}runs-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
  );
}

function runCli(
  argv,
  {
    registryDir,
    baseUrl,
    apiKey = "self-test-key",
    noKey = false,
    // F4 test-isolation (same pattern as plane-sync.self-test.mjs's runCli):
    // plane-triage.mjs's own writesToday() call reads
    // `.claude/campaign/.plane-writes.jsonl` via plane-client.mjs's
    // stateDir(), which falls through to the ambient
    // `.claude/campaign` of whatever repo/worktree this happens to run in
    // unless PLANE_SYNC_STATE_DIR is set. Defaulting to `registryDir` (always
    // a throwaway makeRegistryFixture() dir, tracked in FIXTURE_DIRS and
    // swept in the `finally` below) gives every call site isolation for free.
    stateDir = registryDir,
  } = {},
) {
  const env = { ...process.env };
  if (registryDir) env.PLANE_SYNC_REGISTRY_DIR = registryDir;
  if (baseUrl) env.PLANE_BASE_URL = baseUrl;
  if (stateDir) env.PLANE_SYNC_STATE_DIR = stateDir;
  // Fix-round (runs.jsonl pollution): plane-triage.mjs's main() appends one
  // telemetry line via appendRun() in a `finally` on every run. runsPath()
  // only honours PLANE_RUNS_PATH when PLANE_SYNC_SELF_TEST=1 is ALSO set —
  // both required here or the child writes into this worktree's real
  // local-assets/plane/runs.jsonl.
  env.PLANE_SYNC_SELF_TEST = "1";
  env.PLANE_RUNS_PATH = registryDir
    ? join(registryDir, "self-test-runs.jsonl")
    : fallbackRunsPath();
  if (noKey) delete env.PLANE_API_KEY;
  else env.PLANE_API_KEY = apiKey;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT_PATH, ...argv], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), 15_000);
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

let failures = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(
    `${ok ? "  ok  " : "  FAIL"} ${name}${ok ? "" : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`,
  );
}

// Relative to Date.now() at test-run time, never a hardcoded calendar date
// (test-plan.md §10's flake-risk rule for the triage day-boundary fixture).
const isoDaysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString();
const isoDateOnly = (isoString) => isoString.slice(0, 10);

async function main() {
  const registryDir = makeRegistryFixture();
  const server = await startFakePlane({
    workItems: {
      OPS: [
        {
          name: "Overdue OPS item",
          state: "state-backlog",
          target_date: isoDateOnly(isoDaysAgo(1)),
        },
      ],
      DECIDE: [{ name: "Open ruling", state: "state-backlog" }],
      ROAD: [
        {
          name: "Stale road item",
          state: "state-inprogress",
          updated_at: isoDaysAgo(10),
        },
      ],
      BUGS: [{ name: "B12 · x", external_id: "B12", state: "state-backlog" }],
    },
  });

  {
    const { code, stdout } = await runCli(["--brief"], { registryDir, baseUrl: server.url });
    check("T8: --brief exits 0", code, 0);
    check("T8: brief reports one overdue item", stdout.includes("overdue 1"), true);
    check("T8: brief reports one open ruling", stdout.includes("open rulings 1"), true);
    check("T8: brief reports one stale-started item", stdout.includes("stale started 1"), true);
    check("T8: brief reports one BUGS drift", stdout.includes("BUGS drift 1"), true);
    check("T8: total GET call budget is <= 12", server.requests.length <= 12, true);
    check("T8: brief is <= 1536 bytes", Buffer.byteLength(stdout, "utf8") <= 1536, true);
    check(
      "T8: first line carries its own UTC timestamp",
      /^\d{4}-\d{2}-\d{2}T/.test(stdout.split(/\r?\n/)[0] ?? ""),
      true,
    );
  }
  await server.close();

  // No key -> exact skip line, exit 0, before any network call (R7).
  {
    const registryDir2 = makeRegistryFixture();
    const noKeyRun = await runCli(["--brief"], {
      registryDir: registryDir2,
      baseUrl: "http://127.0.0.1:1", // closed port; nothing listens
      noKey: true,
    });
    check(
      "T8: no key -> exact skip line, exit 0",
      { code: noKeyRun.code, stdout: noKeyRun.stdout.trim() },
      { code: 0, stdout: "Plane triage: skipped (no PLANE_API_KEY)" },
    );
  }

  // ── T15 — --help/-h short-circuit before any env read or network call;
  // an unknown flag exits 2 with Usage on stderr ────────────────────────────
  {
    const registryDir3 = makeRegistryFixture();
    const server2 = await startFakePlane({});
    const help = await runCli(["--help"], { registryDir: registryDir3, baseUrl: server2.url });
    check(
      "T15: --help exits 0 with Usage naming the script, zero requests, even with a reachable server + valid key",
      {
        code: help.code,
        hasUsage: help.stdout.includes("Usage:"),
        namesScript: help.stdout.includes("plane-triage"),
        requests: server2.requests.length,
      },
      { code: 0, hasUsage: true, namesScript: true, requests: 0 },
    );
    await server2.close();

    const h = await runCli(["-h"], {
      registryDir: registryDir3,
      baseUrl: "http://127.0.0.1:1",
      noKey: true,
    });
    check(
      "T15: -h exits 0 with Usage even with no key and an unreachable base URL",
      { code: h.code, hasUsage: h.stdout.includes("Usage:") },
      { code: 0, hasUsage: true },
    );

    const bogus = await runCli(["--bogus"], {
      registryDir: registryDir3,
      baseUrl: "http://127.0.0.1:1",
      noKey: true,
    });
    check(
      "T15: an unknown flag exits 2 with Usage on stderr",
      { code: bogus.code, hasUsage: bogus.stderr.includes("Usage:") },
      { code: 2, hasUsage: true },
    );
  }

  // T8b (Defect 2, proven live) — capping the BUGS listing at 2 pages counted
  // 200 of 392 live items and reported drift from a partial list. A BUGS
  // project with 250 items (3 pages of <=100) must now paginate to
  // completion: the per-group counts sum to 250, and every one of the 3
  // registry rows seeded to drift — placed on page 3 (items 247-249 of the
  // 0-indexed 250) — is counted, proving the fix reads past page 2. Well
  // within the new GET_BUDGET (16): 1 projects/ + 5 states/ + 4 ROAD/OPS/
  // DECIDE/CLIENT page-1s + 3 BUGS pages = 13, so no page-cap partial fires.
  {
    const driftIds = ["B901", "B902", "B903"];
    const registryDir = makeRegistryFixture({ ids: driftIds });
    const fillerItems = Array.from({ length: 247 }, (_, i) => ({
      name: `Filler bug ${i}`,
      state: "state-backlog",
    }));
    // Placed LAST (indices 247-249) so they land on page 3 (offset 200-249)
    // of the 250-item, per_page-100 listing — still in Backlog on the Plane
    // side, so the registry's ledger state "done" (-> desired state "Live")
    // diffs against it for every one of the 3.
    const driftItems = driftIds.map((id) => ({
      name: `${id} · drifted on page 3`,
      external_id: id,
      state: "state-backlog",
    }));
    const server = await startFakePlane({
      workItems: { BUGS: [...fillerItems, ...driftItems] },
    });

    const { code, stdout } = await runCli(["--brief"], { registryDir, baseUrl: server.url });
    check("T8b: --brief exits 0 against a 250-item, 3-page BUGS project", code, 0);

    // "BUGS backlog=..." (the per-project counts line), never "BUGS drift N"
    // which also starts with "BUGS " and renders earlier in the brief.
    const bugsCountsLine = (stdout.split(/\r?\n/) ?? []).find((l) => l.startsWith("BUGS backlog="));
    const groupCountsSum = (bugsCountsLine?.match(/=(\d+)/g) ?? [])
      .map((m) => Number(m.slice(1)))
      .reduce((a, b) => a + b, 0);
    check(
      "T8b: the BUGS per-group counts sum to all 250 items, not just page 1-2's 200",
      groupCountsSum,
      250,
    );

    check(
      "T8b: BUGS drift reflects all 3 page-3 rows, not the 0 a 2-page cap would have found",
      stdout.includes("BUGS drift 3"),
      true,
    );
    check(
      "T8b: no page-cap partial line — 13 GETs stays well under GET_BUDGET (16)",
      stdout.includes("Plane triage: partial (page cap)"),
      false,
    );
    const bugsPagesFetched = server.requests.filter(
      (r) => r.method === "GET" && /\/work-items\/$/.test(r.path) && r.path.includes("proj-bugs"),
    ).length;
    check("T8b: BUGS was paginated across exactly 3 GETs (100+100+50)", bugsPagesFetched, 3);
    check("T8b: total GET call budget is <= 16 (GET_BUDGET)", server.requests.length <= 16, true);

    await server.close();
  }

  return failures;
}

// Fix-round (runs.jsonl pollution, 2026-09-12): belt-and-suspenders proof
// that every runCli() call above's PLANE_SYNC_SELF_TEST+PLANE_RUNS_PATH pair
// keeps the real runs.jsonl untouched. machineRoot()-anchored (fix
// 2026-09-12, plane-write-ledger-local) — that is where the real ambient
// default now lives, shared across every worktree of this repo.
const REAL_RUNS_PATH = join(machineRoot(), "local-assets", "plane", "runs.jsonl");
const realRunsBefore = existsSync(REAL_RUNS_PATH) ? readFileSync(REAL_RUNS_PATH, "utf8") : null;

// F4 (same belt-and-suspenders proof as plane-sync.self-test.mjs): every
// runCli() call above now defaults PLANE_SYNC_STATE_DIR to its own throwaway
// registryDir, so nothing here should ever fall through to the ambient
// default — checked at BOTH the legacy per-worktree `.claude/campaign/` home
// and the machine-shared `machineRoot()/local-assets/plane/` home the
// 2026-09-12 fix moved the real default to.
const REAL_CAMPAIGN_DIR = join(repoRoot(), ".claude", "campaign");
const REAL_LEGACY_WRITES_LEDGER = join(REAL_CAMPAIGN_DIR, ".plane-writes.jsonl");
const REAL_LEGACY_SYNC_STATE = join(REAL_CAMPAIGN_DIR, ".plane-sync-state.json");
const REAL_SHARED_DIR = join(machineRoot(), "local-assets", "plane");
const REAL_WRITES_LEDGER = join(REAL_SHARED_DIR, ".plane-writes.jsonl");
const REAL_SYNC_STATE = join(REAL_SHARED_DIR, ".plane-sync-state.json");
const snapshotRealFiles = () => ({
  legacyWrites: existsSync(REAL_LEGACY_WRITES_LEDGER)
    ? readFileSync(REAL_LEGACY_WRITES_LEDGER, "utf8")
    : null,
  legacyState: existsSync(REAL_LEGACY_SYNC_STATE)
    ? readFileSync(REAL_LEGACY_SYNC_STATE, "utf8")
    : null,
  writes: existsSync(REAL_WRITES_LEDGER) ? readFileSync(REAL_WRITES_LEDGER, "utf8") : null,
  state: existsSync(REAL_SYNC_STATE) ? readFileSync(REAL_SYNC_STATE, "utf8") : null,
});
const realFilesBefore = snapshotRealFiles();

const tmpDirsBefore = countFixtureTmpDirs(); // always 0: FIXTURE_PREFIX embeds this process's own pid+random, so no dir under it can predate this run.
let createdDirs = [];
try {
  await main();
} catch (err) {
  failures++;
  console.log(`  FAIL plane-triage.self-test threw: ${err?.stack ?? err}`);
} finally {
  createdDirs = cleanupFixtures();
}
check(
  "F4: the run leaves no dir this run created behind",
  createdDirs.filter((d) => existsSync(d)),
  [],
);
check(
  "F4: no plane-triage-self-test-<pid>-<rand>-* dir from this run remains under tmpdir",
  countFixtureTmpDirs(),
  tmpDirsBefore,
);
const realRunsAfter = existsSync(REAL_RUNS_PATH) ? readFileSync(REAL_RUNS_PATH, "utf8") : null;
check(
  "F4: the real machine-shared local-assets/plane/runs.jsonl is byte-identical before/after the suite (or absent both times)",
  realRunsAfter,
  realRunsBefore,
);
const realFilesAfter = snapshotRealFiles();
check(
  "F4: this worktree's legacy .claude/campaign/.plane-writes.jsonl is untouched by the suite",
  realFilesAfter.legacyWrites,
  realFilesBefore.legacyWrites,
);
check(
  "F4: this worktree's legacy .claude/campaign/.plane-sync-state.json is untouched by the suite",
  realFilesAfter.legacyState,
  realFilesBefore.legacyState,
);
check(
  "F4: the real machine-shared local-assets/plane/.plane-writes.jsonl is untouched by the suite",
  realFilesAfter.writes,
  realFilesBefore.writes,
);
check(
  "F4: the real machine-shared local-assets/plane/.plane-sync-state.json is untouched by the suite",
  realFilesAfter.state,
  realFilesBefore.state,
);

console.log(
  failures
    ? `\nplane-triage.self-test: ${failures} FAILURE(S)`
    : "\nplane-triage.self-test: all checks passed",
);
process.exit(failures ? 1 : 0);
