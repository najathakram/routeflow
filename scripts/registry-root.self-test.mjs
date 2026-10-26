#!/usr/bin/env node
/**
 * Pin for the register-location contract (B1-a, SPEC v3.2 section G4).
 *
 * Every reader of the bug register must get its location from
 * scripts/lib/registry-root.mjs, never from a literal path. This self-test:
 *
 *   P1  runs the two predicate forms over the tracked tree and fails on any hit
 *       outside an explicit allow-list (the "exception map may only shrink" rule,
 *       L-340: PENDING entries that no longer match fail too).
 *   P2  pins the module's contract (anchored on the repo root, never the cwd;
 *       BUGS_ROOT override; a missing register throws and names the fix).
 *   P3  pins the two cloud-image copies of registry-source.json to each other and
 *       to the module's constants.
 *   P4  runs the real bugs.mjs against missing / relocated registers: exit 2 plus
 *       the fix command instead of "0 rows"; the sync anchor never lands in a
 *       register; running from a subdirectory still finds the register (B278).
 *   P5  runs the other six filesystem readers against a missing register: exit 2 plus the
 *       fix command, never "skipped" / "absent" / a clean exit.
 *
 * Run directly: `node scripts/registry-root.self-test.mjs` (wired into `npm run verify`).
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { scrubbedGitEnv } from "./lib/check-git-hooks.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUGS = join(REPO_ROOT, "scripts", "campaign", "bugs.mjs");
const FIX = "npm run registry:clone";

let failures = 0;
let passes = 0;
function check(name, ok, detail = "") {
  if (ok) {
    passes++;
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ""}`);
  }
}

// ── P1: the predicate ─────────────────────────────────────────────────────
// Form A: a literal path. Form B: a path assembled from quoted segments.
const FORM_A = "\\.claude[/\\\\]+campaign";
const FORM_B = "[\"'`]\\.claude[\"'`][[:space:]]*,[[:space:]]*[\"'`]campaign[\"'`]";
const EXCLUDES = [":!*.md", ":!.claude/pipeline", ":!.claude/campaign"];

// The contract module itself is the one production file that may name the path.
const CONTRACT = ["scripts/lib/registry-root.mjs"];
// Tests and fixtures build register paths on purpose.
const FIXTURES = [
  ".claude/hooks/stop.gate5.spec.mjs",
  "apps/api/src/auth/google-oauth.service.spec.ts",
  "apps/api/src/common/campaign-check-freshness.spec.ts",
  "apps/api/src/common/campaign-check-web-report.spec.ts",
  "apps/control/test/wp4-fix.spec.ts",
  "scripts/campaign/plane-doctor.self-test.mjs",
  "scripts/campaign/plane-intake.self-test.mjs",
  "scripts/campaign/plane-sync.self-test.mjs",
  "scripts/campaign/plane-triage.self-test.mjs",
  "scripts/registry-root.self-test.mjs",
  "scripts/verify-turbo.self-test.mjs",
  "tools/ops-monitor/test/collector.test.mjs",
  "tools/ops-monitor/test/fixtures/a2-gitlog-bugs.txt",
  "tools/ops-monitor/test/snapshot.test.mjs",
  "tools/ops-monitor/test/store.test.mjs",
];
// Ignore files name the tracked path until B1-c moves the register out of the tree.
const CONFIG = [".gitignore", ".prettierignore"];
// Left alone on purpose: plane-client.mjs reads legacy state, and verify-scope.mjs
// classifies changed paths (it must keep recognising the tracked tree until B1-c).
const LEGACY = ["scripts/campaign/plane-client.mjs", "scripts/lib/verify-scope.mjs"];
// Production readers not yet routed through the module. This list may only shrink.
const PENDING = [
  ".claude/hooks/stop.mjs",
  "apps/control/src/sources/registers.ts",
  "scripts/campaign/plane-doctor.mjs",
  "scripts/campaign/plane-retro.mjs",
  "tools/ops-monitor/lib/collector.mjs",
  "tools/ops-monitor/lib/store.mjs",
];

const ALLOWED = new Set([...CONTRACT, ...FIXTURES, ...CONFIG, ...LEGACY]);

function gitGrepFiles(pattern) {
  const r = spawnSync("git", ["grep", "-l", "-E", pattern, "--", ".", ...EXCLUDES], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: scrubbedGitEnv(),
  });
  if (r.status === 1) return [];
  if (r.status !== 0) throw new Error(`git grep failed: ${r.stderr}`);
  return r.stdout.split(/\r?\n/).filter(Boolean);
}

console.log("P1 predicate: no reader names the register path outside the allow-list");
const hits = new Set([...gitGrepFiles(FORM_A), ...gitGrepFiles(FORM_B)]);
const unrouted = [...hits].filter((f) => !ALLOWED.has(f) && !PENDING.includes(f)).sort();
check(
  "every production hit goes through registry-root.mjs",
  unrouted.length === 0,
  `${unrouted.length} unrouted file(s): ${unrouted.join(", ")}`,
);
const stale = PENDING.filter((f) => !hits.has(f));
check(
  "PENDING only lists files that still hit (the exception map may only shrink)",
  stale.length === 0,
  `remove from PENDING: ${stale.join(", ")}`,
);
const allowStale = [...CONTRACT, ...LEGACY].filter((f) => !existsSync(join(REPO_ROOT, f)));
check("allow-listed production files exist", allowStale.length === 0, allowStale.join(", "));

// ── P2: the module contract ───────────────────────────────────────────────
console.log("P2 contract: scripts/lib/registry-root.mjs");
const modPath = join(REPO_ROOT, "scripts", "lib", "registry-root.mjs");
let mod = null;
if (existsSync(modPath)) mod = await import(pathToFileURL(modPath).href);
check("module exists", mod !== null);

const savedEnv = { BUGS_ROOT: process.env.BUGS_ROOT };
const savedCwd = process.cwd();
if (mod) {
  check("REGISTRY_MODE is tracked in B1-a", mod.REGISTRY_MODE === "tracked");
  check("REGISTRY_PUSH_RETRIES is 5", mod.REGISTRY_PUSH_RETRIES === 5);
  check("REGISTRY_GIT_TIMEOUT_MS is 20000", mod.REGISTRY_GIT_TIMEOUT_MS === 20000);
  check("REGISTRY_LOCK_WAIT_MS is 240000", mod.REGISTRY_LOCK_WAIT_MS === 240000);
  check(
    "lock wait covers the worst-case transaction",
    mod.REGISTRY_LOCK_WAIT_MS >= mod.REGISTRY_PUSH_RETRIES * 2 * mod.REGISTRY_GIT_TIMEOUT_MS,
  );

  delete process.env.BUGS_ROOT;
  try {
    process.chdir(join(REPO_ROOT, "apps", "api"));
    const root = mod.registryRoot();
    check(
      "registryRoot() is anchored on the repo root, not the cwd (B278)",
      resolve(root) === join(REPO_ROOT, ".claude", "campaign"),
      `got ${root}`,
    );
    const src = mod.registrySource();
    check(
      "registrySource() in tracked mode is { repoDir: repo root, ref: HEAD, prefix }",
      resolve(src.repoDir) === REPO_ROOT && src.ref === "HEAD" && src.prefix === ".claude/campaign",
      JSON.stringify(src),
    );
  } finally {
    process.chdir(savedCwd);
  }

  const fx = mkdtempSync(join(tmpdir(), "registry-root-"));
  try {
    process.env.BUGS_ROOT = fx;
    check("BUGS_ROOT overrides the root", resolve(mod.registryRoot()) === resolve(fx));
    const missing = join(fx, "does-not-exist");
    process.env.BUGS_ROOT = missing;
    let msg = null;
    try {
      mod.registryRoot();
    } catch (e) {
      msg = String(e.message);
    }
    check("a missing register throws", msg !== null);
    check("the error names the fix command", msg !== null && msg.includes(FIX), String(msg));
    check("the error names the missing path", msg !== null && msg.includes("does-not-exist"));
    let created = null;
    try {
      created = mod.registryRoot({ allowMissing: true });
    } catch {
      created = null;
    }
    check(
      "allowMissing returns the path without creating it (for the writers)",
      created !== null && resolve(created) === resolve(missing) && !existsSync(missing),
    );
  } finally {
    if (savedEnv.BUGS_ROOT === undefined) delete process.env.BUGS_ROOT;
    else process.env.BUGS_ROOT = savedEnv.BUGS_ROOT;
    rmSync(fx, { recursive: true, force: true });
  }
}

// ── P3: JSON parity ───────────────────────────────────────────────────────
console.log("P3 parity: registry-source.json in both images");
const rootJson = join(REPO_ROOT, "scripts", "lib", "registry-source.json");
const monJson = join(REPO_ROOT, "tools", "ops-monitor", "lib", "registry-source.json");
check("root copy exists", existsSync(rootJson));
check("ops-monitor copy exists", existsSync(monJson));
if (existsSync(rootJson) && existsSync(monJson)) {
  const a = JSON.parse(readFileSync(rootJson, "utf8"));
  const b = JSON.parse(readFileSync(monJson, "utf8"));
  check(
    "the two copies deep-equal",
    JSON.stringify(a, Object.keys(a).sort()) === JSON.stringify(b, Object.keys(b).sort()),
  );
  check(
    "the file carries exactly repo, branch and prefix",
    JSON.stringify(Object.keys(a).sort()) === JSON.stringify(["branch", "prefix", "repo"]),
  );
  if (mod) {
    check(
      "the module's constants equal the JSON",
      mod.REGISTRY_REPO === a.repo &&
        mod.REGISTRY_BRANCH === a.branch &&
        mod.REGISTRY_PREFIX === a.prefix,
    );
  }
}

// ── P4: the real bugs.mjs ─────────────────────────────────────────────────
console.log("P4 behaviour: bugs.mjs fails closed and anchors on the repo root");
function bugs(args, { cwd = REPO_ROOT, env = {} } = {}) {
  const e = { ...process.env, ...env };
  for (const k of ["BUGS_ROOT", "BUGS_SYNC_STATE"]) if (!(k in env)) delete e[k];
  const r = spawnSync(process.execPath, [BUGS, ...args], {
    cwd,
    encoding: "utf8",
    env: e,
    timeout: 120000,
  });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
}

const tmp = mkdtempSync(join(tmpdir(), "registry-pin-"));
try {
  const gone = join(tmp, "no-register-here");
  const list = bugs(["list", "--open"], { env: { BUGS_ROOT: gone } });
  check("list --open with no register exits 2", list.code === 2, `exit ${list.code}`);
  check(
    "list --open names the fix command",
    list.err.includes(FIX),
    `stdout=${list.out.trim().slice(-80)} stderr=${list.err.trim().slice(0, 120)}`,
  );
  check("list --open prints no row count", !/\d+ row\(s\)/.test(list.out), list.out.trim());

  const chk = bugs(["sync", "--check"], { env: { BUGS_ROOT: gone } });
  check("sync --check with no register exits 2", chk.code === 2, `exit ${chk.code}`);
  check("sync --check names the fix command", chk.err.includes(FIX), chk.out.trim());
  check("sync --check does not claim records mirror", !/mirror the ledger/.test(chk.out));

  // The anchor must never be written into a register directory.
  const regDir = join(tmp, "register");
  mkdirSync(regDir, { recursive: true });
  const realAnchor = join(REPO_ROOT, ".campaign", "bugs-sync-state.json");
  const hadAnchor = existsSync(realAnchor);
  const savedAnchor = hadAnchor ? readFileSync(realAnchor) : null;
  try {
    bugs(["sync", "--quiet"], { env: { BUGS_ROOT: regDir } });
    check(
      "BUGS_ROOT does not hold the sync anchor",
      !existsSync(join(regDir, "sync-state.json")),
      "anchor landed in the register dir",
    );
    check(
      "the anchor defaults to REPO_ROOT/.campaign/bugs-sync-state.json",
      existsSync(realAnchor),
    );
  } finally {
    if (hadAnchor) writeFileSync(realAnchor, savedAnchor);
    else rmSync(realAnchor, { force: true });
  }

  // B278: from a subdirectory the real register is still found.
  const sub = bugs(["list", "--open"], { cwd: join(REPO_ROOT, "apps", "api") });
  const m = /(\d+) row\(s\)/.exec(sub.out);
  check(
    "list --open from apps/api reads the real register (B278)",
    sub.code === 0 && m !== null && Number(m[1]) > 0,
    `exit ${sub.code} ${m ? m[0] : sub.out.trim().slice(-60)}`,
  );

  // ── P5: every other filesystem reader fails closed on a missing register ──
  console.log("P5 readers: a missing register exits 2 and names the fix, never 'skipped' or 0");
  const planeEnv = {
    PLANE_SYNC_SELF_TEST: "1",
    PLANE_RUNS_PATH: join(tmp, "plane-runs.jsonl"),
  };
  const readers = [
    { name: "campaign-check", args: ["scripts/campaign-check.mjs"] },
    { name: "plane-sync", args: ["scripts/campaign/plane-sync.mjs", "--dry-run"], env: planeEnv },
    { name: "plane-triage", args: ["scripts/campaign/plane-triage.mjs"], env: planeEnv },
    { name: "plane-intake", args: ["scripts/campaign/plane-intake.mjs"], env: planeEnv },
    {
      name: "fleet-status",
      args: [".claude/skills/fleet-lead/scripts/fleet-status.mjs", "--json"],
    },
    { name: "roadmap render", args: ["scripts/roadmap/render.mjs", "--out", join(tmp, "roadmap")] },
  ];
  for (const rd of readers) {
    const e = { ...process.env, ...(rd.env ?? {}), BUGS_ROOT: join(tmp, "no-register-here") };
    for (const k of ["PLANE_API_KEY", "PLANE_SYNC_REGISTRY_DIR", "CAMPAIGN_CHECK_STATUS_DIR"])
      delete e[k];
    const r = spawnSync(process.execPath, rd.args, {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: e,
      timeout: 30000,
    });
    check(
      `${rd.name}: a missing register exits 2`,
      r.status === 2,
      `exit ${r.status} out=${(r.stdout ?? "").trim().slice(0, 80)}`,
    );
    check(
      `${rd.name}: the failure names the fix command`,
      `${r.stdout}${r.stderr}`.includes(FIX),
      `stderr=${(r.stderr ?? "").trim().slice(0, 120)}`,
    );
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\nregistry-root self-test: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
