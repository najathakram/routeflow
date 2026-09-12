#!/usr/bin/env node
// Coverage for scripts/campaign/plane-doctor.mjs (TP2, T3, spec.md
// .claude/pipeline/2026-09-12-plane-learning/). Same standalone-script
// convention as the rest of this family (plane-sync.self-test.mjs et al.) —
// no node:test, no root-level test runner (CLAUDE.md's do-not-introduce
// list): `node scripts/campaign/plane-doctor.self-test.mjs`, `  ok`/`  FAIL`
// lines, `process.exit(failures ? 1 : 0)`.
//
// UNLIKE its siblings, plane-doctor.mjs's offline checks read REAL repo
// structure (`.claude/settings.json`, `package.json`, `.gitignore`, the
// skill file, `.claude/hooks/stop.mjs`) via `repoRoot()` — which resolves by
// walking up from the SCRIPT'S OWN file location (plane-client.mjs's
// documented convention), never `process.cwd()`. So a self-test that wants
// to flip one piece of that structure (e.g. "remove the SessionStart hook")
// cannot just set an env var — it has to give plane-doctor.mjs (and the
// plane-client.mjs it imports) a whole SCAFFOLDED FIXTURE REPO to walk up
// into: a temp dir holding its own package.json + .claude marker, with a
// byte-for-byte copy of the two real scripts dropped into
// <fixture>/scripts/campaign/ alongside a real denylist/knobs file and tiny
// stub tools (only `--help` needs to work for the six-script help check).
// Every case below spawns that COPY, never the real scripts/campaign/
// tree — the real repo is never read or written by this file.
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
import { spawn, spawnSync } from "node:child_process";
import { startFakePlane } from "./plane-fake-server.mjs";
import { gitEnv } from "./plane-client.mjs";

const REAL_DOCTOR = readFileSync(fileURLToPath(new URL("./plane-doctor.mjs", import.meta.url)));
const REAL_CLIENT = readFileSync(fileURLToPath(new URL("./plane-client.mjs", import.meta.url)));
const REAL_DENYLIST = readFileSync(
  fileURLToPath(new URL("./plane-denylist.json", import.meta.url)),
);
const REAL_KNOBS = readFileSync(fileURLToPath(new URL("./plane-knobs.json", import.meta.url)));

const DOCTOR_FIXTURE_PATH = join("scripts", "campaign", "plane-doctor.mjs");

// F4 pattern (plane-sync.self-test.mjs / plane-triage.self-test.mjs): every
// fixture dir this run creates is tracked and swept in a `finally`.
//
// Test-isolation fix (2026-09-12): FIXTURE_PREFIX is unique to THIS PROCESS
// (pid + random) — never a bare "plane-doctor-self-test-" literal shared by
// every invocation, which let two overlapping runs of this script pollute
// each other's before/after dir COUNT under load. The sweep is pinned to
// every path THIS run recorded being gone after cleanup, never a global
// count of other runs' dirs.
const FIXTURE_DIRS = [];
const FIXTURE_PREFIX = `plane-doctor-self-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}-`;
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

function newFixtureDir() {
  const dir = mkdtempSync(join(tmpdir(), FIXTURE_PREFIX));
  FIXTURE_DIRS.push(dir);
  return dir;
}

const STUB_TOOL_SOURCE = [
  "#!/usr/bin/env node",
  "const argv = process.argv.slice(2);",
  'if (argv.includes("--help") || argv.includes("-h")) {',
  '  process.stdout.write("Usage: stub --help\\n");',
  "  process.exitCode = 0;",
  "} else {",
  "  process.exitCode = 0;",
  "}",
  "",
].join("\n");

// Builds one scaffolded fixture repo with a copy of the real plane-doctor.mjs
// + plane-client.mjs + plane-denylist.json + plane-knobs.json, stub tools
// for the other four (+ retro, unless `missingPlaneRetro`), and every
// docs/config file plane-doctor.mjs's offline checks look at — all present
// and correct by default ("everything in place"); each option below flips
// exactly one piece negative for a specific test case.
function makeFixtureRepo({
  removeSessionStartHook = false,
  removeStopHook = false,
  missingPlaneRetro = false,
  includeOpsDir = true,
} = {}) {
  const dir = newFixtureDir();

  const verify = [
    "node scripts/campaign/plane-sync.self-test.mjs",
    "node scripts/campaign/plane-intake.self-test.mjs",
    "node scripts/campaign/plane-triage.self-test.mjs",
    "node scripts/campaign/plane-apply.self-test.mjs",
    "node scripts/campaign/plane-docs.self-test.mjs",
    "node scripts/campaign/plane-learning.self-test.mjs",
    "node scripts/campaign/plane-doctor.self-test.mjs",
    "npm run plane:doctor -- --offline",
  ].join(" && ");

  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify(
      {
        name: "plane-doctor-fixture",
        private: true,
        scripts: {
          "plane:sync": "node scripts/campaign/plane-sync.mjs",
          "plane:check": "node scripts/campaign/plane-sync.mjs --check",
          "plane:triage": "node scripts/campaign/plane-triage.mjs",
          "plane:intake": "node scripts/campaign/plane-intake.mjs",
          "plane:apply": "node scripts/campaign/plane-apply.mjs",
          "plane:doctor": "node scripts/campaign/plane-doctor.mjs",
          "plane:retro": "node scripts/campaign/plane-retro.mjs",
          verify,
        },
      },
      null,
      2,
    ),
  );

  mkdirSync(join(dir, ".claude", "hooks"), { recursive: true });
  const hooks = {
    SessionStart: removeSessionStartHook
      ? [{ hooks: [] }]
      : [
          {
            hooks: [{ type: "command", command: "node scripts/campaign/plane-triage.mjs --brief" }],
          },
        ],
    Stop: removeStopHook
      ? [{ hooks: [] }]
      : [{ hooks: [{ type: "command", command: "node .claude/hooks/stop.mjs" }] }],
  };
  writeFileSync(join(dir, ".claude", "settings.json"), JSON.stringify({ hooks }, null, 2));

  // A Gate 5-shaped fixture: names plane-sync.mjs, carries --max-writes,
  // never --allow-branch as CODE (a comment mentioning the flag by name is
  // exercised separately in the in-process unit check below).
  writeFileSync(
    join(dir, ".claude", "hooks", "stop.mjs"),
    [
      "// Gate 5 fixture — never actually run, only greppable by plane-doctor.mjs",
      "const gate5Argv = [",
      '  "scripts/campaign/plane-sync.mjs",',
      '  "--quiet",',
      '  "--max-writes",',
      '  "25",',
      "];",
      "process.exit(0);",
      "",
    ].join("\n"),
  );

  mkdirSync(join(dir, ".claude", "skills", "plane"), { recursive: true });
  writeFileSync(join(dir, ".claude", "skills", "plane", "SKILL.md"), "# Plane skill (fixture)\n");

  writeFileSync(
    join(dir, ".gitignore"),
    [
      "local-assets/",
      ".claude/campaign/.plane-sync-digest",
      ".claude/campaign/.plane-writes.jsonl",
      ".claude/campaign/.plane-sync-state.json",
      "",
    ].join("\n"),
  );

  const campaignDir = join(dir, "scripts", "campaign");
  mkdirSync(campaignDir, { recursive: true });
  writeFileSync(join(campaignDir, "plane-doctor.mjs"), REAL_DOCTOR);
  writeFileSync(join(campaignDir, "plane-client.mjs"), REAL_CLIENT);
  writeFileSync(join(campaignDir, "plane-denylist.json"), REAL_DENYLIST);
  writeFileSync(join(campaignDir, "plane-knobs.json"), REAL_KNOBS);

  const stubNames = ["plane-sync.mjs", "plane-intake.mjs", "plane-triage.mjs", "plane-apply.mjs"];
  if (!missingPlaneRetro) stubNames.push("plane-retro.mjs");
  for (const name of stubNames) writeFileSync(join(campaignDir, name), STUB_TOOL_SOURCE);

  if (includeOpsDir) mkdirSync(join(dir, "local-assets", "plane", "ops"), { recursive: true });

  return dir;
}

function makeFakeHome({ withScheduledTask = true } = {}) {
  const dir = newFixtureDir();
  if (withScheduledTask) {
    const taskDir = join(dir, ".claude", "scheduled-tasks", "routeflow-plane-daily");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "SKILL.md"), "# routeflow-plane-daily (fixture)\n");
  }
  return dir;
}

// A clean env: gitEnv() (scrubs GIT_*) minus every PLANE_* var this family
// gates on, so the ambient shell's real key/overrides can never leak into a
// fixture run — each case below adds back only what it needs.
function baseEnv() {
  const env = gitEnv();
  for (const key of Object.keys(env)) {
    if (key.startsWith("PLANE_")) delete env[key];
  }
  return env;
}

// Async `spawn` (never `spawnSync`) — the fake Plane server used by the
// online cases lives on this harness process's own event loop, same
// discipline as plane-triage.self-test.mjs.
function runDoctor(fixtureDir, argv, envOverrides = {}) {
  const scriptPath = join(fixtureDir, DOCTOR_FIXTURE_PATH);
  const env = { ...baseEnv(), ...envOverrides };
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath, ...argv], {
      cwd: fixtureDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), 20_000);
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function git(cwd, args) {
  const res = spawnSync("git", args, { cwd, encoding: "utf8", env: baseEnv() });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}:\n${res.stdout}${res.stderr}`);
  }
  return res;
}

let failures = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(
    `${ok ? "  ok  " : "  FAIL"} ${name}${ok ? "" : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`,
  );
}
function checkTrue(name, got) {
  check(name, Boolean(got), true);
}

async function main() {
  const before = countFixtureTmpDirs(); // always 0: FIXTURE_PREFIX embeds this process's own pid+random, so no dir under it can predate this run.

  // ── T3a: --help before anything else, zero requests, exit 0 ────────────
  {
    const dir = makeFixtureRepo();
    const { code, stdout } = await runDoctor(dir, ["--help"]);
    check("help: exit 0", code, 0);
    checkTrue("help: usage line printed", /^Usage: plane-doctor\.mjs/.test(stdout.trim()));
  }

  // ── T3b: offline, scaffolded temp repo with everything in place -> all
  // PASS, exit 0 ───────────────────────────────────────────────────────────
  {
    const dir = makeFixtureRepo();
    const home = makeFakeHome({ withScheduledTask: true });
    const { code, stdout, stderr } = await runDoctor(dir, ["--offline"], {
      PLANE_SYNC_SELF_TEST: "1",
      PLANE_DOCTOR_HOME: home,
    });
    check("offline everything-in-place: exit 0", code, 0);
    const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
    checkTrue("offline everything-in-place: at least 10 checks printed", lines.length >= 10);
    checkTrue(
      "offline everything-in-place: every line is PASS",
      lines.every((l) => l.startsWith("PASS ")),
    );
    check(
      "offline everything-in-place: no stray FAIL/WARN on stderr summary",
      stderr.includes("Plane doctor: failed"),
      false,
    );
  }

  // ── T3c: remove the SessionStart hook -> FAIL settings: SessionStart
  // plane-triage hook missing, exit 1 ─────────────────────────────────────
  {
    const dir = makeFixtureRepo({ removeSessionStartHook: true });
    const home = makeFakeHome({ withScheduledTask: true });
    const { code, stdout } = await runDoctor(dir, ["--offline"], {
      PLANE_SYNC_SELF_TEST: "1",
      PLANE_DOCTOR_HOME: home,
    });
    check("SessionStart hook missing: exit 1", code, 1);
    checkTrue(
      "SessionStart hook missing: exact FAIL line",
      stdout.includes("FAIL settings: SessionStart plane-triage hook missing"),
    );
  }

  // Same shape, the Stop hook side — not itself a T3 oracle, but the same
  // check function has two failure branches and only one is pinned above.
  {
    const dir = makeFixtureRepo({ removeStopHook: true });
    const home = makeFakeHome({ withScheduledTask: true });
    const { code, stdout } = await runDoctor(dir, ["--offline"], {
      PLANE_SYNC_SELF_TEST: "1",
      PLANE_DOCTOR_HOME: home,
    });
    check("Stop hook missing: exit 1", code, 1);
    checkTrue(
      "Stop hook missing: FAIL settings line",
      stdout.includes("FAIL settings: Stop hook missing"),
    );
  }

  // ── T3d: scheduled task file absent -> WARN, not FAIL ───────────────────
  {
    const dir = makeFixtureRepo();
    const home = makeFakeHome({ withScheduledTask: false });
    const { code, stdout } = await runDoctor(dir, ["--offline"], {
      PLANE_SYNC_SELF_TEST: "1",
      PLANE_DOCTOR_HOME: home,
    });
    check("scheduled task absent: exit 0 (WARN only)", code, 0);
    checkTrue(
      "scheduled task absent: WARN line present",
      stdout.includes("WARN scheduled-task: missing (machine-local)"),
    );
    checkTrue("scheduled task absent: no FAIL anywhere", !stdout.includes("FAIL "));
  }

  // ── T3e (also: help-check FAIL branch): plane-retro.mjs missing ────────
  {
    const dir = makeFixtureRepo({ missingPlaneRetro: true });
    const home = makeFakeHome({ withScheduledTask: true });
    const { code, stdout } = await runDoctor(dir, ["--offline"], {
      PLANE_SYNC_SELF_TEST: "1",
      PLANE_DOCTOR_HOME: home,
    });
    check("plane-retro.mjs missing: exit 1", code, 1);
    checkTrue(
      "plane-retro.mjs missing: help check names it",
      stdout.includes("FAIL help:") && stdout.includes("plane-retro.mjs (missing)"),
    );
  }

  // ── T3f: online against the fake with 5 projects -> PASS projects: 5
  // identifiers, <= 3 GETs ─────────────────────────────────────────────────
  {
    const dir = makeFixtureRepo();
    const home = makeFakeHome({ withScheduledTask: true });
    const server = await startFakePlane({});
    const { code, stdout } = await runDoctor(dir, [], {
      PLANE_SYNC_SELF_TEST: "1",
      PLANE_DOCTOR_HOME: home,
      PLANE_API_KEY: "self-test-key",
      PLANE_BASE_URL: server.url,
    });
    check("online 5 projects: exit 0", code, 0);
    checkTrue("online 5 projects: PASS line", stdout.includes("PASS projects: 5 identifiers"));
    checkTrue("online 5 projects: <= 3 GETs", server.requests.length <= 3);
    await server.close();
  }

  // ── T3g: runs.jsonl older than a synthetic commit touching
  // .claude/campaign/status -> WARN landing without sync ──────────────────
  {
    const dir = makeFixtureRepo();
    const home = makeFakeHome({ withScheduledTask: true });
    git(dir, ["init", "--quiet"]);
    git(dir, ["-c", "user.name=fixture", "-c", "user.email=fixture@example.com", "add", "-A"]);
    git(dir, [
      "-c",
      "user.name=fixture",
      "-c",
      "user.email=fixture@example.com",
      "commit",
      "--quiet",
      "-m",
      "scaffold",
    ]);

    // An OLD plane-sync telemetry line, well before the status commit below.
    mkdirSync(join(dir, "local-assets", "plane"), { recursive: true });
    const oldTs = new Date(Date.now() - 2 * 86_400_000).toISOString();
    writeFileSync(
      join(dir, "local-assets", "plane", "runs.jsonl"),
      `${JSON.stringify({ ts: oldTs, tool: "plane-sync", exit: 0 })}\n`,
    );

    // A commit touching .claude/campaign/status, strictly newer than the
    // sync line above.
    mkdirSync(join(dir, ".claude", "campaign", "status"), { recursive: true });
    writeFileSync(join(dir, ".claude", "campaign", "status", "F01.jsonl"), '{"id":"B1"}\n');
    git(dir, ["add", "-A", ".claude/campaign/status"]);
    git(dir, [
      "-c",
      "user.name=fixture",
      "-c",
      "user.email=fixture@example.com",
      "commit",
      "--quiet",
      "-m",
      "status update",
    ]);

    const server = await startFakePlane({});
    const { code, stdout } = await runDoctor(dir, [], {
      PLANE_SYNC_SELF_TEST: "1",
      PLANE_DOCTOR_HOME: home,
      PLANE_API_KEY: "self-test-key",
      PLANE_BASE_URL: server.url,
    });
    check("landing without sync: exit 0 (WARN only)", code, 0);
    checkTrue(
      "landing without sync: WARN line present",
      stdout.includes("WARN landing without sync:"),
    );
    await server.close();
  }

  // ── M2 (fix-round ruling): checkLandingWithoutSync compares ABSOLUTE
  // instants via Date.parse on both sides, not the raw ISO strings — git's
  // `%cI` carries the commit's own UTC offset while runs.jsonl's `ts` is
  // always `Z`. Commits are seeded with GIT_COMMITTER_DATE (env, via
  // baseEnv()) so the offset is exact and reproducible. ─────────────────────
  async function runLandingWithoutSyncCase(commitDateIso, syncTsIso) {
    const dir = makeFixtureRepo();
    const home = makeFakeHome({ withScheduledTask: true });
    git(dir, ["init", "--quiet"]);
    git(dir, ["-c", "user.name=fixture", "-c", "user.email=fixture@example.com", "add", "-A"]);
    git(dir, [
      "-c",
      "user.name=fixture",
      "-c",
      "user.email=fixture@example.com",
      "commit",
      "--quiet",
      "-m",
      "scaffold",
    ]);

    mkdirSync(join(dir, "local-assets", "plane"), { recursive: true });
    writeFileSync(
      join(dir, "local-assets", "plane", "runs.jsonl"),
      `${JSON.stringify({ ts: syncTsIso, tool: "plane-sync", exit: 0 })}\n`,
    );

    mkdirSync(join(dir, ".claude", "campaign", "status"), { recursive: true });
    writeFileSync(join(dir, ".claude", "campaign", "status", "F01.jsonl"), '{"id":"B1"}\n');
    spawnSync("git", ["add", "-A", ".claude/campaign/status"], {
      cwd: dir,
      encoding: "utf8",
      env: baseEnv(),
    });
    const commitEnv = {
      ...baseEnv(),
      GIT_COMMITTER_DATE: commitDateIso,
      GIT_AUTHOR_DATE: commitDateIso,
    };
    const commitRes = spawnSync(
      "git",
      [
        "-c",
        "user.name=fixture",
        "-c",
        "user.email=fixture@example.com",
        "commit",
        "--quiet",
        "-m",
        "status update",
      ],
      { cwd: dir, encoding: "utf8", env: commitEnv },
    );
    if (commitRes.status !== 0) {
      throw new Error(`git commit failed: ${commitRes.stdout}${commitRes.stderr}`);
    }

    const server = await startFakePlane({});
    const result = await runDoctor(dir, [], {
      PLANE_SYNC_SELF_TEST: "1",
      PLANE_DOCTOR_HOME: home,
      PLANE_API_KEY: "self-test-key",
      PLANE_BASE_URL: server.url,
    });
    await server.close();
    return result;
  }
  {
    // commit 2026-09-11T23:00:00-07:00 == 2026-09-12T06:00:00Z, which is
    // AFTER the sync at 2026-09-12T05:00:00Z — a naive string compare
    // ("2026-09-11..." < "2026-09-12...") gets this backwards and reports
    // PASS; Date.parse compares the true instants and reports WARN.
    const { code, stdout } = await runLandingWithoutSyncCase(
      "2026-09-11T23:00:00-07:00",
      "2026-09-12T05:00:00.000Z",
    );
    check("M2 offset (fix-round): -07:00 commit landing after sync: exit 0 (WARN only)", code, 0);
    checkTrue(
      "M2 offset (fix-round): -07:00 commit (absolute later) vs Z sync -> WARN",
      stdout.includes("WARN landing without sync:"),
    );
  }
  {
    // commit 2026-09-12T02:00:00+05:30 == 2026-09-11T20:30:00Z, which is
    // BEFORE the sync at 2026-09-12T05:00:00Z in both a naive string compare
    // and Date.parse — a companion case proving the fix still gets the
    // correct answer in this direction too.
    const { code, stdout } = await runLandingWithoutSyncCase(
      "2026-09-12T02:00:00+05:30",
      "2026-09-12T05:00:00.000Z",
    );
    check("M2 offset (fix-round): +05:30 commit landing before sync: exit 0 (PASS)", code, 0);
    checkTrue(
      "M2 offset (fix-round): +05:30 commit (absolute earlier) vs Z sync -> PASS",
      stdout.includes("PASS landing without sync:"),
    );
  }

  // ── T3h: no key -> online section WARN skipped (no PLANE_API_KEY), exit 0
  {
    const dir = makeFixtureRepo();
    const home = makeFakeHome({ withScheduledTask: true });
    const { code, stdout } = await runDoctor(dir, [], {
      PLANE_SYNC_SELF_TEST: "1",
      PLANE_DOCTOR_HOME: home,
      PLANE_BASE_URL: "http://127.0.0.1:1", // closed port; nothing listens
    });
    check("no key: exit 0", code, 0);
    checkTrue(
      "no key: WARN online skipped line",
      stdout.includes("WARN online: skipped (no PLANE_API_KEY)"),
    );
  }

  // ── m3 (fix-round ruling): an offline FAIL skips the whole online section
  // — 0 requests, `WARN online: skipped (offline FAIL)` — even with a key and
  // a live fake server, rather than spending a round-trip on a run that is
  // already known-broken (and, for the knobs case specifically, whose rate
  // ceiling this run cannot even trust).
  {
    const dir = makeFixtureRepo();
    const home = makeFakeHome({ withScheduledTask: true });
    // Overwrite the fixture's own knobs file (a byte copy of the real one)
    // with an out-of-range value -> checkKnobs() FAILs.
    writeFileSync(
      join(dir, "scripts", "campaign", "plane-knobs.json"),
      JSON.stringify(
        {
          version: 1,
          knobs: { clientRatePerMin: { value: 99, min: 20, max: 55, autoTune: true } },
          history: [],
        },
        null,
        2,
      ),
    );
    const server = await startFakePlane({});
    const { code, stdout } = await runDoctor(dir, [], {
      PLANE_SYNC_SELF_TEST: "1",
      PLANE_DOCTOR_HOME: home,
      PLANE_API_KEY: "self-test-key",
      PLANE_BASE_URL: server.url,
    });
    check("m3 (fix-round): invalid knobs -> online skipped -> exit 1", code, 1);
    checkTrue("m3 (fix-round): FAIL knobs line present", stdout.includes("FAIL knobs:"));
    checkTrue(
      "m3 (fix-round): WARN online: skipped (offline FAIL) line present",
      stdout.includes("WARN online: skipped (offline FAIL)"),
    );
    check("m3 (fix-round): zero requests reached the fake server", server.requests.length, 0);
    await server.close();
  }

  // ── --json shape ─────────────────────────────────────────────────────────
  {
    const dir = makeFixtureRepo();
    const home = makeFakeHome({ withScheduledTask: true });
    const { code, stdout } = await runDoctor(dir, ["--offline", "--json"], {
      PLANE_SYNC_SELF_TEST: "1",
      PLANE_DOCTOR_HOME: home,
    });
    check("--json: exit 0", code, 0);
    let parsed;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      parsed = null;
    }
    checkTrue("--json: parses", parsed !== null);
    checkTrue(
      "--json: shape has checks[]/failCount/warnCount",
      Array.isArray(parsed?.checks) &&
        typeof parsed?.failCount === "number" &&
        typeof parsed?.warnCount === "number",
    );
    check("--json: failCount is 0", parsed?.failCount, 0);
  }

  // ── unknown flag -> usage on stderr, exit 2, before any check runs ──────
  {
    const dir = makeFixtureRepo();
    const { code, stderr } = await runDoctor(dir, ["--bogus"]);
    check("unknown flag: exit 2", code, 2);
    checkTrue("unknown flag: usage on stderr", /^Usage: plane-doctor\.mjs/.test(stderr.trim()));
  }

  // ── telemetry: one appendRun line per run, skipped for --help ───────────
  {
    const dir = makeFixtureRepo();
    const home = makeFakeHome({ withScheduledTask: true });
    const runsPath = join(dir, "local-assets", "plane", "runs.jsonl");
    checkTrue("telemetry: no runs.jsonl before any run", !existsSync(runsPath));

    await runDoctor(dir, ["--help"]);
    checkTrue("telemetry: --help writes no runs.jsonl", !existsSync(runsPath));

    await runDoctor(dir, ["--offline"], {
      PLANE_SYNC_SELF_TEST: "1",
      PLANE_DOCTOR_HOME: home,
    });
    const lines = existsSync(runsPath)
      ? readFileSync(runsPath, "utf8").split(/\r?\n/).filter(Boolean)
      : [];
    check("telemetry: exactly one line after one run", lines.length, 1);
    let row = null;
    try {
      row = JSON.parse(lines[0]);
    } catch {
      row = null;
    }
    checkTrue("telemetry: line parses as JSON", row !== null);
    check("telemetry: tool field", row?.tool, "plane-doctor");
    checkTrue(
      "telemetry: doctor {fail,warn,pass} present",
      row?.doctor &&
        typeof row.doctor.fail === "number" &&
        typeof row.doctor.warn === "number" &&
        typeof row.doctor.pass === "number",
    );
    checkTrue(
      "telemetry: never a uuid-shaped substring",
      !/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(lines[0]),
    );
  }

  // ── in-process unit check: a Gate-5 comment mentioning "--allow-branch"
  // by name must never trip the gate5 check FAIL (comment-stripping) ──────
  {
    const dir = makeFixtureRepo();
    writeFileSync(
      join(dir, ".claude", "hooks", "stop.mjs"),
      [
        "// Never pass",
        "// `--allow-branch` here — a hook must stay opt-in only.",
        "const gate5Argv = [",
        '  "scripts/campaign/plane-sync.mjs",',
        '  "--max-writes",',
        '  "25",',
        "];",
        "process.exit(0);",
        "",
      ].join("\n"),
    );
    const home = makeFakeHome({ withScheduledTask: true });
    const { stdout } = await runDoctor(dir, ["--offline"], {
      PLANE_SYNC_SELF_TEST: "1",
      PLANE_DOCTOR_HOME: home,
    });
    checkTrue(
      "gate5: a comment mentioning --allow-branch never trips FAIL",
      stdout.includes("PASS gate5:"),
    );
  }

  // ── in-process unit check: --allow-branch actually present as CODE fails
  {
    const dir = makeFixtureRepo();
    writeFileSync(
      join(dir, ".claude", "hooks", "stop.mjs"),
      [
        "const gate5Argv = [",
        '  "scripts/campaign/plane-sync.mjs",',
        '  "--max-writes",',
        '  "25",',
        '  "--allow-branch",',
        "];",
        "process.exit(0);",
        "",
      ].join("\n"),
    );
    const home = makeFakeHome({ withScheduledTask: true });
    const { code, stdout } = await runDoctor(dir, ["--offline"], {
      PLANE_SYNC_SELF_TEST: "1",
      PLANE_DOCTOR_HOME: home,
    });
    check("gate5: --allow-branch present as code -> exit 1", code, 1);
    checkTrue(
      "gate5: --allow-branch present as code -> FAIL line",
      stdout.includes("FAIL gate5: --allow-branch present"),
    );
  }

  const createdDirs = cleanupFixtures();
  check(
    "no dir this run created is left behind",
    createdDirs.filter((d) => existsSync(d)),
    [],
  );
  check(
    "no leaked plane-doctor-self-test-<pid>-<rand>-* dirs from this run",
    countFixtureTmpDirs(),
    before,
  );

  console.log(
    failures === 0
      ? "\nplane-doctor.self-test: all checks passed"
      : `\nplane-doctor.self-test: ${failures} failure(s)`,
  );
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  cleanupFixtures();
  console.error(err);
  process.exit(1);
});
