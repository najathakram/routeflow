#!/usr/bin/env node
// plane-golden.self-test.mjs — SA-AIOS-01 golden-output guard (spec 2026-11-14-plane-bridge R12, R16).
//
// Every existing scripts/campaign/plane-* command must keep a byte-identical CLI surface (lanes and
// hooks parse it). This test proves it by running the BASE copy of each script (extracted from git
// at GOLDEN_BASE with `git archive`) and the HEAD copy side by side, each against its own fresh
// plane-fake-server.mjs started from the same seed, with identical argv/env and an identical copy of
// one fixture registry, then comparing stdout, stderr and the exit code byte for byte (after the
// NORMALISE list below, nothing else). It also checks the write requests each side made.
//
// Both copies run from a throwaway git repo on branch `master` with the SAME non-script repo files
// (package.json, .claude/settings.json, ... taken from the base archive) so only the scripts differ.
// A control run (base twice) proves each case is deterministic before base is compared to HEAD.
//
// T12 (R12): plane-sync against a target plane-bridge.json claims makes zero writes at HEAD and
// still writes at base.
// T16 (R16): the probe proves the comparison itself can fail on a one-byte change
// (PLANE_GOLDEN_SELF_PROBE=1 appends one space to every HEAD stdout, so every case must FAIL).
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { EXTERNAL_SOURCE, gitEnv } from "./plane-client.mjs";
import { startFakePlane, DEFAULT_STATES } from "./plane-fake-server.mjs";

// Bump ONLY with an SA ruling that allows a plane-* output change (SA-AIOS-01).
const GOLDEN_BASE = "a587d034e7";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO = join(HERE, "..", "..");
const CLI_BUDGET_MS = Number(process.env.PLANE_SELF_TEST_CLI_BUDGET_MS) || 90_000;
// Repo files the scripts read besides themselves (plane-doctor's offline checks). Taken from the
// base archive for BOTH trees so a package.json edit never reads as a script output change.
const BASE_ROOT_FILES = [
  "package.json",
  ".gitignore",
  ".claude/settings.json",
  ".claude/hooks/stop.mjs",
  ".claude/skills/plane/SKILL.md",
];

// NORMALISE: the ONLY edits applied to child output before comparing. Each carries its reason.
// (Paths are added per run: tree root and machine root -> <ROOT>, registry dir -> <REG>,
// doctor home -> <HOME>; each in raw, forward-slash and JSON-escaped form.)
const NORMALISE = [
  {
    name: "port",
    re: /127\.0\.0\.1:\d+/g,
    to: "127.0.0.1:PORT",
    why: "fake server port is ephemeral",
  },
  {
    name: "iso-timestamp",
    re: /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g,
    to: "<TS>",
    why: "plane-triage --brief and plane-retro --json print the wall-clock time of the run",
  },
];

let failures = 0;
const pass = (name) => console.log(`PASS ${name}`);
const fail = (name, why) => {
  failures++;
  console.log(`FAIL ${name}: ${why}`);
};

const TEMP_DIRS = [];
const makeTmp = (label) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), `plane-golden-${label}-`)));
  TEMP_DIRS.push(d);
  return d;
};

function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, env: gitEnv(), encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r;
}

// ── trees ────────────────────────────────────────────────────────────────────
function baseShaPresent() {
  const r = spawnSync("git", ["cat-file", "-e", `${GOLDEN_BASE}^{commit}`], {
    cwd: REPO,
    env: gitEnv(),
  });
  return r.status === 0;
}

function initTree(dir) {
  git(dir, ["init", "-q", "-b", "master"]);
  git(dir, ["add", "-A"]);
  git(dir, [
    "-c",
    "user.email=golden@example.com",
    "-c",
    "user.name=golden",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "-m",
    "golden tree",
  ]);
}

// base tree: git archive of GOLDEN_BASE. head tree: the same, with scripts/campaign and scripts/lib
// replaced by this worktree's files (uncommitted work included).
function buildTrees() {
  const baseDir = makeTmp("base");
  const arc = spawnSync(
    "git",
    ["archive", "--format=tar", GOLDEN_BASE, "scripts/campaign", "scripts/lib", ...BASE_ROOT_FILES],
    { cwd: REPO, env: gitEnv(), maxBuffer: 512 * 1024 * 1024 },
  );
  if (arc.status !== 0) throw new Error(`git archive failed: ${arc.stderr}`);
  const tar = spawnSync("tar", ["-x"], { cwd: baseDir, input: arc.stdout, encoding: "utf8" });
  if (tar.status !== 0) throw new Error(`tar -x failed: ${tar.stderr}`);
  const headDir = makeTmp("head");
  cpSync(baseDir, headDir, { recursive: true });
  for (const sub of ["scripts/campaign", "scripts/lib"]) {
    rmSync(join(headDir, sub), { recursive: true, force: true });
    cpSync(join(REPO, sub), join(headDir, sub), { recursive: true });
  }
  initTree(baseDir);
  initTree(headDir);
  return { baseDir, headDir };
}

// ── fixture (registry + fake Plane seed) ─────────────────────────────────────
const catRow = (n, title) => ({
  id: `B${n}`,
  title,
  location: "apps/web/src/acme.tsx",
  severity: n === 2 ? "high" : "low",
  batch: "F01",
  source: "plane-golden-self-test",
  filedAt: "2026-11-14",
  sensitive: false,
  sensitiveFor: [],
});
const statusRow = (n, state) => ({
  id: `B${n}`,
  batch: "F01",
  tier: "T1",
  state,
  pr: null,
  proof: null,
  evidence: null,
});

function writeRegistry(dir) {
  mkdirSync(join(dir, "status"), { recursive: true });
  const cat = [
    catRow(1, "Widget crashes on save"),
    catRow(2, "Acme export is slow"),
    catRow(3, "Tooltip clipped"),
  ];
  writeFileSync(join(dir, "bugs.jsonl"), cat.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const led = [statusRow(1, "queued"), statusRow(2, "in-flight"), statusRow(3, "done")];
  writeFileSync(
    join(dir, "status", "F01.jsonl"),
    led.map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
  writeFileSync(join(dir, "board.json"), JSON.stringify({ batches: { F01: 532 } }));
}

function fakeSeed() {
  return {
    workItems: {
      // B1 mirrored but stale (update); B2 mirrored in the wrong state (update); B3 absent (create);
      // one human item (intake candidate); an orphan mirror row.
      BUGS: [
        {
          name: "B1 · Widget crashes on save",
          priority: "low",
          state: "state-backlog",
          external_source: EXTERNAL_SOURCE,
          external_id: "B1",
          description_html: "<p>stale</p>",
          description_stripped: "stale",
        },
        {
          name: "B2 · Acme export is slow",
          priority: "high",
          state: "state-backlog",
          external_source: EXTERNAL_SOURCE,
          external_id: "B2",
          description_html: "<p>stale</p>",
          description_stripped: "stale",
        },
        { name: "Scanner crashes on iOS", priority: "urgent", external_id: null },
        {
          name: "B99 · gone",
          priority: "low",
          state: "state-backlog",
          external_source: EXTERNAL_SOURCE,
          external_id: "B99",
        },
      ],
      OPS: [{ name: "Ops item", sequence_id: 23, state: "state-backlog" }],
      ROAD: [{ name: "Road item", sequence_id: 15, state: "state-inprogress" }],
    },
    states: { BUGS: DEFAULT_STATES, OPS: DEFAULT_STATES, ROAD: DEFAULT_STATES },
    intake: { BUGS: [{ status: -2, issue: "item-999" }] },
  };
}

// ── cases ────────────────────────────────────────────────────────────────────
let OPS_FILE = null;
const CASES = () => [
  { name: "plane-sync --help", steps: [["plane-sync.mjs", "--help"]] },
  { name: "plane-sync --dry-run", steps: [["plane-sync.mjs", "--dry-run"]] },
  { name: "plane-sync --check", steps: [["plane-sync.mjs", "--check"]] },
  {
    name: "plane-sync --allow-branch then --check",
    steps: [
      ["plane-sync.mjs", "--allow-branch"],
      ["plane-sync.mjs", "--allow-branch", "--check"],
    ],
  },
  { name: "plane-sync (master, no flag)", steps: [["plane-sync.mjs"]] },
  { name: "plane-intake --help", steps: [["plane-intake.mjs", "--help"]] },
  { name: "plane-intake list", steps: [["plane-intake.mjs"]] },
  { name: "plane-intake --json", steps: [["plane-intake.mjs", "--json"]] },
  { name: "plane-triage --help", steps: [["plane-triage.mjs", "--help"]] },
  { name: "plane-triage --brief", steps: [["plane-triage.mjs", "--brief"]] },
  { name: "plane-triage --json", steps: [["plane-triage.mjs", "--json"]] },
  { name: "plane-apply --help", steps: [["plane-apply.mjs", "--help"]] },
  { name: "plane-apply ops --dry-run", steps: [["plane-apply.mjs", OPS_FILE, "--dry-run"]] },
  { name: "plane-apply ops", steps: [["plane-apply.mjs", OPS_FILE]] },
  { name: "plane-doctor --help", steps: [["plane-doctor.mjs", "--help"]] },
  { name: "plane-doctor --offline", steps: [["plane-doctor.mjs", "--offline"]] },
  { name: "plane-doctor --offline --json", steps: [["plane-doctor.mjs", "--offline", "--json"]] },
  { name: "plane-retro --help", steps: [["plane-retro.mjs", "--help"]] },
  { name: "plane-retro --json", steps: [["plane-retro.mjs", "--json"]] },
  { name: "plane-sync unknown flag", steps: [["plane-sync.mjs", "--bogus"]] },
];

// ── running ──────────────────────────────────────────────────────────────────
const variants = (p) => [p, p.replace(/\\/g, "/"), p.replace(/\\/g, "\\\\")];

function normaliser(pairs) {
  return (text) => {
    let out = String(text);
    for (const [path, token] of pairs) {
      for (const v of variants(path)) out = out.split(v).join(token);
    }
    for (const n of NORMALISE) out = out.replace(n.re, n.to);
    return out;
  };
}

function runChild(cwd, script, argv, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(cwd, "scripts", "campaign", script), ...argv], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, CLI_BUDGET_MS);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: `${stderr}[spawn error ${e}]`, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

function childEnv(extra) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(PLANE_|BUGS_|GIT_|REGISTRY_)/.test(k)) continue;
    env[k] = v;
  }
  return { ...gitEnv(env), PLANE_SYNC_SELF_TEST: "1", PLANE_API_KEY: "k", ...extra };
}

// One case on one tree: fresh fake server, fresh registry copy, fresh machine root.
async function runCase(treeDir, steps, { extraEnv = {}, probe = false } = {}) {
  const fake = await startFakePlane(fakeSeed());
  const registry = makeTmp("reg");
  writeRegistry(registry);
  const machine = makeTmp("machine");
  const home = makeTmp("home");
  const env = childEnv({
    PLANE_BASE_URL: fake.url,
    PLANE_SYNC_REGISTRY_DIR: registry,
    BUGS_ROOT: registry,
    PLANE_MACHINE_ROOT: machine,
    PLANE_DOCTOR_HOME: home,
    ...extraEnv,
  });
  const results = [];
  try {
    for (const [script, ...argv] of steps) {
      results.push(await runChild(treeDir, script, argv, env));
    }
  } finally {
    await fake.close();
  }
  const norm = normaliser([
    [treeDir, "<ROOT>"],
    [machine, "<ROOT>"],
    [registry, "<REG>"],
    [home, "<HOME>"],
  ]);
  const writes = fake.requests
    .filter((r) => r.method !== "GET")
    .map((r) => norm(`${r.method} ${r.path} ${JSON.stringify(r.body ?? null)}`));
  const rows = results.map((r, i) => ({
    step: steps[i].join(" "),
    code: r.code,
    stdout: norm(r.stdout) + (probe ? " " : ""),
    stderr: norm(r.stderr),
    timedOut: r.timedOut,
  }));
  return { rows, writes, requests: fake.requests };
}

function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  const cut = (s) => JSON.stringify(s.slice(Math.max(0, i - 25), i + 40));
  return `at byte ${i}: base ${cut(a)} vs head ${cut(b)}`;
}

// Returns null when equal, else a one-line reason. Byte-for-byte on stdout, stderr, exit code,
// and the write requests (method, path, body).
function compareRuns(a, b) {
  for (let i = 0; i < Math.max(a.rows.length, b.rows.length); i++) {
    const x = a.rows[i];
    const y = b.rows[i];
    if (!x || !y) return "step count differs";
    if (x.timedOut || y.timedOut) return `step "${x.step}" timed out`;
    if (x.code !== y.code) return `step "${x.step}" exit ${x.code} vs ${y.code}`;
    if (x.stdout !== y.stdout)
      return `step "${x.step}" stdout differs ${firstDiff(x.stdout, y.stdout)}`;
    if (x.stderr !== y.stderr)
      return `step "${x.step}" stderr differs ${firstDiff(x.stderr, y.stderr)}`;
  }
  const wa = a.writes.join("\n");
  const wb = b.writes.join("\n");
  if (wa !== wb) return `write requests differ ${firstDiff(wa, wb)}`;
  return null;
}

async function goldenCase(trees, c, { probe = false } = {}) {
  const baseA = await runCase(trees.baseDir, c.steps);
  const baseB = await runCase(trees.baseDir, c.steps);
  const control = compareRuns(baseA, baseB);
  if (control) return { control: `base is not deterministic (${control}); add a NORMALISE entry` };
  const head = await runCase(trees.headDir, c.steps, { probe });
  return { diff: compareRuns(baseA, head), baseA };
}

// ── T12 ──────────────────────────────────────────────────────────────────────
async function t12(trees) {
  const cfgDir = makeTmp("cfg");
  const cfgPath = join(cfgDir, "plane-bridge.json");
  const run = async (treeDir, argv = ["--allow-branch"]) => {
    const fake = await startFakePlane(fakeSeed());
    const cfg = JSON.parse(
      readFileSync(join(REPO, "scripts", "campaign", "plane-bridge.json"), "utf8"),
    );
    cfg.target.baseUrl = fake.url;
    cfg.target.workspace = "routeflow";
    writeFileSync(cfgPath, JSON.stringify(cfg));
    const registry = makeTmp("reg");
    writeRegistry(registry);
    const env = childEnv({
      PLANE_BASE_URL: fake.url,
      PLANE_WORKSPACE_SLUG: "routeflow",
      PLANE_SYNC_REGISTRY_DIR: registry,
      BUGS_ROOT: registry,
      PLANE_MACHINE_ROOT: makeTmp("machine"),
      PLANE_BRIDGE_CONFIG: cfgPath,
    });
    let res;
    try {
      res = await runChild(treeDir, "plane-sync.mjs", argv, env);
    } finally {
      await fake.close();
    }
    const writes = fake.requests.filter((r) => r.method === "POST" || r.method === "PATCH").length;
    return { res, writes };
  };
  const head = await run(trees.headDir);
  const headNoFlag = await run(trees.headDir, []);
  const base = await run(trees.baseDir);
  console.log(`INFO T12 writes: base ${base.writes} · head ${head.writes}`);
  if (head.writes === 0) pass("T12 head: bridge-claimed target gets 0 POST/PATCH");
  else fail("T12 head", `${head.writes} writes to a claimed target`);
  if (/Plane mirror warn: target is owned by plane-bridge — no writes/.test(head.res.stderr))
    pass("T12 head: warn line present");
  else fail("T12 head warn", `stderr: ${JSON.stringify(head.res.stderr.slice(0, 200))}`);
  if (head.res.code === 0) pass("T12 head: exit 0");
  else fail("T12 head exit", String(head.res.code));
  const claimedLine = /^Plane mirror: skipped \(target owned by plane-bridge\)\r?\n$/;
  for (const [label, r] of [
    ["with --allow-branch", head],
    ["without --allow-branch", headNoFlag],
  ]) {
    if (r.writes === 0 && r.res.code === 0 && claimedLine.test(r.res.stdout))
      pass(`T12 head ${label} (master tree): 0 writes, claimed-target stdout line`);
    else
      fail(
        `T12 head ${label}`,
        `writes ${r.writes} exit ${r.res.code} stdout ${JSON.stringify(r.res.stdout.slice(0, 160))}`,
      );
  }
  if (base.writes > 0) pass(`T12 base: same call writes ${base.writes} (guard is red on base)`);
  else fail("T12 base", "base made no writes, so the oracle cannot tell the guard from a no-op");
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  if (!baseShaPresent()) {
    console.log(`PASS golden: SKIP (base ${GOLDEN_BASE} not in this clone)`);
    return;
  }
  const trees = buildTrees();
  OPS_FILE = join(makeTmp("ops"), "ops.json");
  writeFileSync(
    OPS_FILE,
    JSON.stringify({ ops: [{ op: "update", ref: "OPS-23", set: { state: "In progress" } }] }),
  );
  const globalProbe = process.env.PLANE_GOLDEN_SELF_PROBE === "1";
  for (const c of CASES()) {
    const r = await goldenCase(trees, c, { probe: globalProbe });
    if (r.control) fail(`golden ${c.name}`, r.control);
    else if (r.diff) fail(`golden ${c.name}`, r.diff);
    else pass(`golden ${c.name}`);
  }
  // T16: the comparison itself must be able to fail. One appended space on HEAD stdout.
  const probeCase = { name: "probe", steps: [["plane-triage.mjs", "--json"]] };
  const pr = await goldenCase(trees, probeCase, { probe: true });
  if (pr.diff && /stdout differs/.test(pr.diff)) pass("golden probe caught a 1-byte change");
  else
    fail("golden probe", `a 1-byte HEAD stdout change was not caught (${pr.diff ?? pr.control})`);
  await t12(trees);
}

try {
  await main();
} catch (err) {
  fail(
    "golden harness",
    String(err?.stack ?? err)
      .split("\n")
      .slice(0, 3)
      .join(" | "),
  );
} finally {
  for (const d of TEMP_DIRS) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // a handle still open on Windows must not turn a green run red
    }
  }
}
process.exit(failures ? 1 : 0);
