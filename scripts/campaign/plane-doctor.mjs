#!/usr/bin/env node
// plane-doctor.mjs — one-shot harness health check (spec.md R3,
// .claude/pipeline/2026-09-12-plane-learning/). Answers "is the Plane
// harness actually installed and wired on this machine/repo" — a key, a
// SessionStart hook, a Stop-hook Gate 5, a scheduled task — none of which any
// existing tool asserts together. Prints one `PASS <name>: <detail>` /
// `WARN <name>: <detail>` / `FAIL <name>: <detail>` line per check and exits
// 1 iff any check FAILed. NEVER a write, online or offline — every online
// call goes through the shared client's `get`/`listAll` only.
//
// OFFLINE section (no network; this is what `npm run verify` runs via
// `plane:doctor -- --offline`): knobs file validity, denylist pattern count,
// `--help` on every plane-*.mjs tool (zero requests), the SessionStart/Stop
// hooks in `.claude/settings.json`, the `plane:*` package.json scripts +
// `verify` wiring, `.gitignore` coverage of the ledger/state files, the skill
// file's existence + size cap, Gate 5's `--max-writes`/never-`--allow-branch`
// argv shape in `.claude/hooks/stop.mjs`, the scheduled-task file (WARN-only,
// machine-local), and `local-assets/plane/ops/` (WARN-only).
//
// ONLINE section (skipped with `WARN online: skipped (no PLANE_API_KEY)`
// when unset): `GET projects/` for the five identifiers, the
// `runs.jsonl`-vs-`.claude/campaign/status` "landing without sync" check, and
// — on master only — a drift check that spawns `plane-sync.mjs --check`
// (report-only, still never a write). Budget: at most 3 GETs from this
// script's OWN client (the drift check's spawned child has its own, separate
// budget). The workspace-member "who am I" check has no cheap dedicated
// endpoint on the shared client (only a full `members/` list), so it is a
// static WARN-only skip rather than an extra GET — see checkMember().
//
// TELEMETRY (R2): one `appendRun()` line per run, in a `finally`, carrying
// `doctor: {fail, warn, pass}` plus the shared client's `summary()` —
// skipped entirely for `--help` (no run happened).
//
// `--json` -> `{checks:[{name,status,detail}], failCount, warnCount}`.
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import {
  appendRun,
  createClient,
  gitEnv,
  loadDenylist,
  loadKnobs,
  repoRoot,
  runsPath,
} from "./plane-client.mjs";

const THIS_FILE_DIR = dirname(fileURLToPath(import.meta.url));

// The four v1 tools + this file + the retro tool (R3: "the four scripts +
// doctor + retro"). plane-retro.mjs ships alongside this file under the same
// spec (WP4) — its absence here is a real FAIL, not a skip: by the time this
// PR lands, all six exist.
const HELP_SCRIPTS = [
  "plane-sync.mjs",
  "plane-intake.mjs",
  "plane-triage.mjs",
  "plane-apply.mjs",
  "plane-doctor.mjs",
  "plane-retro.mjs",
];

const REQUIRED_PLANE_NPM_SCRIPTS = [
  "plane:sync",
  "plane:check",
  "plane:triage",
  "plane:intake",
  "plane:apply",
  "plane:doctor",
  "plane:retro",
];

const REQUIRED_VERIFY_SUBSTRINGS = [
  "plane-sync.self-test.mjs",
  "plane-intake.self-test.mjs",
  "plane-triage.self-test.mjs",
  "plane-apply.self-test.mjs",
  "plane-docs.self-test.mjs",
  "plane-learning.self-test.mjs",
  "plane-doctor.self-test.mjs",
];

const REQUIRED_GITIGNORE_PATTERNS = [
  ".plane-writes.jsonl",
  ".plane-sync-state.json",
  ".plane-sync-digest",
  "local-assets/",
];

const MIN_DENYLIST_PATTERNS = 7;
const SKILL_MAX_BYTES = 6144;
// R3: "≤ 3 GETs" from this script's OWN client. Not enforced as a live
// counter here — the design keeps it structurally true instead (projects/
// once, no GET for the static-WARN member check, none for the git-only
// landing-without-sync check, none for the drift check's separate child
// process) — kept as a documented constant for the self-test to assert
// against via the fake server's own request log.
export const ONLINE_GET_BUDGET = 3;

// PLANE_DOCTOR_HOME is a TEST-ONLY override, gated the same way as
// PLANE_KNOBS_PATH/PLANE_RUNS_PATH/PLANE_DENYLIST_PATH in plane-client.mjs
// (PLANE_SYNC_SELF_TEST=1 required alongside it) — it lets a self-test fake
// HOME so the scheduled-task check can be driven positive/negative without
// touching the real machine's `~/.claude/scheduled-tasks/`.
function resolveHome() {
  if (process.env.PLANE_SYNC_SELF_TEST === "1" && process.env.PLANE_DOCTOR_HOME) {
    return process.env.PLANE_DOCTOR_HOME;
  }
  return homedir();
}

// Same shape as plane-sync.mjs's currentBranch(): git spawn scrubbed of
// GIT_* env (reference_git_worktreeconfig_bare_trap_2026-09-04), cwd pinned
// to repoRoot() (never process.cwd()), fails CLOSED to "unknown" on any
// error so a broken git never silently reads as "on master".
function currentBranch() {
  let res;
  try {
    res = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: repoRoot(),
      env: gitEnv(),
      encoding: "utf8",
      timeout: 5_000,
    });
  } catch {
    return "unknown";
  }
  if (!res || res.error || res.status !== 0) return "unknown";
  return (res.stdout || "").trim() || "unknown";
}

const result = (name, status, detail) => ({ name, status, detail });

// ── offline checks ──────────────────────────────────────────────────────

function checkKnobs() {
  try {
    const { knobs } = loadKnobs();
    return result("knobs", "PASS", `${Object.keys(knobs ?? {}).length} knobs valid`);
  } catch (err) {
    return result("knobs", "FAIL", err?.message ?? String(err));
  }
}

function checkDenylist() {
  try {
    const patterns = loadDenylist();
    if (patterns.length >= MIN_DENYLIST_PATTERNS) {
      return result("denylist", "PASS", `${patterns.length} patterns`);
    }
    return result(
      "denylist",
      "FAIL",
      `only ${patterns.length} patterns (need >= ${MIN_DENYLIST_PATTERNS})`,
    );
  } catch (err) {
    return result("denylist", "FAIL", err?.message ?? String(err));
  }
}

// Spawns each tool with --help against a closed port and no key, so a script
// whose --help short-circuit is broken and falls through to a real network
// attempt fails fast (ECONNREFUSED) or times out here, rather than hanging
// this check forever or, worse, quietly succeeding.
function checkHelp() {
  const failing = [];
  for (const script of HELP_SCRIPTS) {
    const p = join(THIS_FILE_DIR, script);
    if (!existsSync(p)) {
      failing.push(`${script} (missing)`);
      continue;
    }
    let res;
    try {
      res = spawnSync(process.execPath, [p, "--help"], {
        cwd: THIS_FILE_DIR,
        env: { ...gitEnv(), PLANE_API_KEY: "", PLANE_BASE_URL: "http://127.0.0.1:1" },
        encoding: "utf8",
        timeout: 5_000,
      });
    } catch (err) {
      failing.push(`${script} (${err?.message ?? err})`);
      continue;
    }
    if (!res || res.error || res.status !== 0) {
      failing.push(`${script} (exit ${res?.status ?? res?.error?.code ?? "error"})`);
    }
  }
  if (failing.length === 0) {
    return result("help", "PASS", `${HELP_SCRIPTS.length} scripts OK`);
  }
  return result("help", "FAIL", failing.join(", "));
}

function checkSettings() {
  const p = join(repoRoot(), ".claude", "settings.json");
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(p, "utf8"));
  } catch (err) {
    return result("settings", "FAIL", `unreadable: ${err?.message ?? err}`);
  }
  const sessionStartCommands = (parsed?.hooks?.SessionStart ?? []).flatMap((entry) =>
    (entry?.hooks ?? []).map((h) => h?.command ?? ""),
  );
  if (!sessionStartCommands.some((cmd) => /plane-triage/.test(cmd))) {
    return result("settings", "FAIL", "SessionStart plane-triage hook missing");
  }
  const stopCommands = (parsed?.hooks?.Stop ?? []).flatMap((entry) =>
    (entry?.hooks ?? []).map((h) => h?.command ?? ""),
  );
  if (!stopCommands.some((cmd) => /stop\.mjs/.test(cmd))) {
    return result("settings", "FAIL", "Stop hook missing");
  }
  return result("settings", "PASS", "SessionStart + Stop hooks present");
}

function checkPackage() {
  const p = join(repoRoot(), "package.json");
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(p, "utf8"));
  } catch (err) {
    return result("package", "FAIL", `unreadable: ${err?.message ?? err}`);
  }
  const scripts = parsed?.scripts ?? {};
  const missingScripts = REQUIRED_PLANE_NPM_SCRIPTS.filter((s) => !scripts[s]);
  if (missingScripts.length > 0) {
    return result("package", "FAIL", `missing scripts: ${missingScripts.join(", ")}`);
  }
  const verify = scripts.verify ?? "";
  const missingInVerify = REQUIRED_VERIFY_SUBSTRINGS.filter((s) => !verify.includes(s));
  if (missingInVerify.length > 0) {
    return result("package", "FAIL", `verify missing: ${missingInVerify.join(", ")}`);
  }
  if (!verify.includes("plane:doctor") || !verify.includes("--offline")) {
    return result("package", "FAIL", "verify missing plane:doctor -- --offline");
  }
  return result(
    "package",
    "PASS",
    `${REQUIRED_PLANE_NPM_SCRIPTS.length} plane:* scripts + verify wired`,
  );
}

function checkGitignore() {
  const p = join(repoRoot(), ".gitignore");
  let content;
  try {
    content = readFileSync(p, "utf8");
  } catch (err) {
    return result("gitignore", "FAIL", `unreadable: ${err?.message ?? err}`);
  }
  const missing = REQUIRED_GITIGNORE_PATTERNS.filter((pat) => !content.includes(pat));
  if (missing.length > 0) {
    return result("gitignore", "FAIL", `missing patterns: ${missing.join(", ")}`);
  }
  return result("gitignore", "PASS", "ledger/state files covered");
}

function checkSkill() {
  const p = join(repoRoot(), ".claude", "skills", "plane", "SKILL.md");
  if (!existsSync(p)) return result("skill", "FAIL", "SKILL.md missing");
  let size;
  try {
    size = statSync(p).size;
  } catch (err) {
    return result("skill", "FAIL", `unreadable: ${err?.message ?? err}`);
  }
  if (size > SKILL_MAX_BYTES) {
    return result("skill", "FAIL", `${size}B exceeds ${SKILL_MAX_BYTES}B`);
  }
  return result("skill", "PASS", `${size}B`);
}

// Comment lines are stripped BEFORE the `--allow-branch` search — the real
// stop.mjs's own explanatory comment says "Never pass `--allow-branch` here",
// which contains the literal flag text; without stripping, this check would
// FAIL on the correct, intended file. Only whole-line `//` comments are
// stripped (the repo's own style here — no trailing-comment code exists in
// this block); a code line is never touched.
function checkGate5() {
  const p = join(repoRoot(), ".claude", "hooks", "stop.mjs");
  let content;
  try {
    content = readFileSync(p, "utf8");
  } catch (err) {
    return result("gate5", "FAIL", `unreadable: ${err?.message ?? err}`);
  }
  const codeOnly = content
    .split(/\r?\n/)
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
  const gateIdx = codeOnly.indexOf("plane-sync.mjs");
  if (gateIdx === -1) {
    return result("gate5", "FAIL", "Gate 5 spawn of plane-sync.mjs not found");
  }
  // The argv literal array always sits within a few hundred chars of the
  // script-path string; 2000 is generous headroom without risking a match
  // against an unrelated, later block of the file.
  const block = codeOnly.slice(gateIdx, gateIdx + 2000);
  if (!block.includes("--max-writes")) {
    return result("gate5", "FAIL", "--max-writes missing from Gate 5 argv");
  }
  if (block.includes("--allow-branch")) {
    return result("gate5", "FAIL", "--allow-branch present (must never be passed)");
  }
  return result("gate5", "PASS", "--max-writes present, --allow-branch absent");
}

function checkScheduledTask() {
  const home = resolveHome();
  const p = join(home, ".claude", "scheduled-tasks", "routeflow-plane-daily", "SKILL.md");
  if (existsSync(p)) return result("scheduled-task", "PASS", "present");
  return result("scheduled-task", "WARN", "missing (machine-local)");
}

function checkOpsDir() {
  const p = join(repoRoot(), "local-assets", "plane", "ops");
  if (existsSync(p)) return result("ops-dir", "PASS", "present");
  return result("ops-dir", "WARN", "missing");
}

// ── online checks ───────────────────────────────────────────────────────

function checkProjects(projects) {
  const withIdentifier = (projects ?? []).filter((p) => p?.identifier);
  return result("projects", "PASS", `${withIdentifier.length} identifiers`);
}

// The shared client has no dedicated "who am I" endpoint — only a full
// `members/` list, which is not the "cheaply" R3 asks for as the bar to
// spend a GET on. Static WARN-only skip, no request made (keeps the online
// GET budget at 1 in the common case: projects/ alone).
function checkMember() {
  return result("member", "WARN", "no cheap member-lookup on the shared client (skipped)");
}

// Compares the newest `plane-sync` line in runs.jsonl against the newest
// commit touching `.claude/campaign/status` on the CURRENT branch — a
// registry landing with no sync run (or a sync run older than that landing)
// means Gate 5 never actually reached Plane for it.
function checkLandingWithoutSync() {
  let lastSyncTs = null;
  try {
    const p = runsPath();
    if (existsSync(p)) {
      for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
        if (!line) continue;
        let row;
        try {
          row = JSON.parse(line);
        } catch {
          continue; // a malformed telemetry line is skipped, never fatal
        }
        if (row?.tool === "plane-sync" && typeof row.ts === "string") {
          if (!lastSyncTs || row.ts > lastSyncTs) lastSyncTs = row.ts;
        }
      }
    }
  } catch {
    // an unreadable runs.jsonl reads as "no sync line" — handled below
  }

  let commitSha = null;
  let commitTs = null;
  try {
    const res = spawnSync(
      "git",
      ["log", "-1", "--format=%H%x1f%cI", "--", ".claude/campaign/status"],
      { cwd: repoRoot(), env: gitEnv(), encoding: "utf8", timeout: 5_000 },
    );
    if (res && !res.error && res.status === 0 && res.stdout && res.stdout.trim()) {
      const [sha, iso] = res.stdout.trim().split("\x1f");
      commitSha = sha || null;
      commitTs = iso || null;
    }
  } catch {
    // no repo / git error reads as "no such commits" — handled below
  }

  if (!commitTs) {
    return result("landing without sync", "PASS", "no status commits on this branch");
  }
  // M2 (fix-round ruling): compare ABSOLUTE instants via Date.parse on both
  // sides, never the raw ISO strings — git's `%cI` carries the commit's own
  // UTC offset (e.g. `-07:00`) while runs.jsonl's `ts` is always `Z`, so a
  // lexical string compare sorts by calendar day first and silently gets the
  // verdict backwards whenever a commit's local calendar date differs from
  // its UTC one (a commit at 23:00 in UTC-7 is "2026-09-11" as a string but
  // 2026-09-12T06:00Z in absolute time — string compare says PASS, the
  // correct answer is WARN).
  if (!lastSyncTs || Date.parse(commitTs) > Date.parse(lastSyncTs)) {
    const ageMin = Math.max(0, Math.round((Date.now() - Date.parse(commitTs)) / 60_000));
    return result(
      "landing without sync",
      "WARN",
      `${(commitSha ?? "").slice(0, 7)} ${ageMin}m ago`,
    );
  }
  return result("landing without sync", "PASS", `last sync ${lastSyncTs} is newer`);
}

// Report-only (R3: "never a write") — spawns `plane-sync.mjs --check`, which
// itself never writes regardless (dry-run/check always returns before the
// R14 branch guard). Only ever runs on master; off master this is a WARN,
// not a FAIL, since a feature branch is never expected to be drift-free
// against the live registry.
function checkDrift({ branch, apiKey }) {
  if (branch !== "master") {
    return result("drift", "WARN", `off master (branch ${branch}, skipped)`);
  }
  const script = join(THIS_FILE_DIR, "plane-sync.mjs");
  if (!existsSync(script)) {
    return result("drift", "WARN", "plane-sync.mjs missing, skipped");
  }
  let res;
  try {
    res = spawnSync(process.execPath, [script, "--check", "--quiet"], {
      cwd: repoRoot(),
      env: { ...gitEnv(), PLANE_API_KEY: apiKey ?? "" },
      encoding: "utf8",
      timeout: 20_000,
    });
  } catch (err) {
    return result("drift", "WARN", `could not run plane-sync --check: ${err?.message ?? err}`);
  }
  if (!res || res.error) {
    return result("drift", "WARN", "could not run plane-sync --check");
  }
  if (res.status === 0) return result("drift", "PASS", "no drift");
  return result("drift", "WARN", `drift detected (plane-sync --check exit ${res.status})`);
}

async function runOnlineChecks({ apiKey, branch }) {
  if (!apiKey) {
    return { checks: [result("online", "WARN", "skipped (no PLANE_API_KEY)")], client: null };
  }
  const client = createClient({
    apiKey,
    tool: "plane-doctor",
    maxWrites: 0, // defense in depth — this tool must never write, ever
  });
  const checks = [];
  try {
    const projects = await client.listAll("projects/");
    checks.push(checkProjects(projects));
  } catch (err) {
    checks.push(result("projects", "FAIL", err?.message ?? String(err)));
  }
  checks.push(checkMember());
  checks.push(checkLandingWithoutSync());
  checks.push(checkDrift({ branch, apiKey }));
  return { checks, client };
}

// ── CLI ──────────────────────────────────────────────────────────────────
const USAGE = "Usage: plane-doctor.mjs [--offline] [--json] [--help]";
const KNOWN_FLAGS = new Set(["--offline", "--json"]);

async function main() {
  const argv = process.argv.slice(2);

  // --help/-h and an unknown flag are handled before ANYTHING else — no
  // env read, no knobs/denylist load, no network — same discipline as every
  // other plane-*.mjs tool's CLI (Landmine 3/R13 precedent).
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${USAGE}\n`);
    process.exitCode = 0;
    return;
  }
  for (const tok of argv) {
    if (!KNOWN_FLAGS.has(tok)) {
      process.stderr.write(`${USAGE}\n`);
      process.exitCode = 2;
      return;
    }
  }

  const offline = argv.includes("--offline");
  const asJson = argv.includes("--json");
  const branch = currentBranch();
  const started = Date.now();
  const rec = { tool: "plane-doctor", flags: argv, branch };
  let client = null;

  try {
    const checks = [
      checkKnobs(),
      checkDenylist(),
      checkHelp(),
      checkSettings(),
      checkPackage(),
      checkGitignore(),
      checkSkill(),
      checkGate5(),
      checkScheduledTask(),
      checkOpsDir(),
    ];

    if (!offline) {
      // m3 (fix-round ruling): an offline FAIL means this machine/repo is not
      // even correctly wired — spending a network round-trip (or several) to
      // ask Plane anything is wasted, and on a broken knobs file specifically
      // it would be reading a rate ceiling this run cannot trust anyway.
      // Skip the whole online section with one WARN line and issue zero
      // requests, rather than trying and hoping.
      const offlineFailCount = checks.filter((c) => c.status === "FAIL").length;
      if (offlineFailCount > 0) {
        checks.push(result("online", "WARN", "skipped (offline FAIL)"));
      } else {
        const online = await runOnlineChecks({ apiKey: process.env.PLANE_API_KEY, branch });
        checks.push(...online.checks);
        client = online.client;
      }
    }

    const failCount = checks.filter((c) => c.status === "FAIL").length;
    const warnCount = checks.filter((c) => c.status === "WARN").length;
    const passCount = checks.filter((c) => c.status === "PASS").length;
    rec.doctor = { fail: failCount, warn: warnCount, pass: passCount };

    if (asJson) {
      process.stdout.write(`${JSON.stringify({ checks, failCount, warnCount })}\n`);
    } else {
      for (const c of checks) process.stdout.write(`${c.status} ${c.name}: ${c.detail}\n`);
    }
    process.exitCode = failCount > 0 ? 1 : 0;
  } catch (err) {
    rec.error = `${err?.name ?? "Error"}: ${String(err?.message ?? err).slice(0, 200)}`;
    process.stderr.write(`Plane doctor: failed — ${err?.message ?? err}\n`);
    process.exitCode = 1;
  } finally {
    try {
      const summary = (client ?? createClient({ tool: "plane-doctor", maxWrites: 0 })).summary();
      appendRun({
        ...rec,
        exit: process.exitCode ?? 0,
        durationMs: Date.now() - started,
        ...summary,
      });
    } catch {
      // telemetry must never fail the run
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
