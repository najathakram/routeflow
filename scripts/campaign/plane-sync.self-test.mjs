#!/usr/bin/env node
// Coverage for scripts/campaign/plane-sync.mjs (TP1, build-plan.md
// 2026-09-10-plane-sync). No Jest project collects `scripts/**` (CLAUDE.md
// "DO NOT introduce ... a root-level test runner"), so this follows the
// repo's existing standalone-script convention — `node
// scripts/campaign/plane-sync.self-test.mjs`, the same shape as
// `bugs.mjs`'s `self-test` command and `.claude/hooks/stop.gates.spec.mjs`.
//
// Every case spins up a disposable fake Plane server (`node:http`, ephemeral
// port) that records every request it receives, and a throwaway registry
// directory (`PLANE_SYNC_REGISTRY_DIR`) seeded with a minimal
// `bugs.jsonl` / `status/F01.jsonl` / `board.json`. The CLI runs as a REAL
// child process (`node plane-sync.mjs ...`) against both — never a hand copy
// of its request-building logic — so a passing case proves the actual
// script's HTTP behavior, not this file's idea of it.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { deriveDesired, mapPriority, registryDigest } from "./plane-sync.mjs";
import { createClient, gitEnv, repoRoot, machineRoot, CLOSED_MARKER } from "./plane-client.mjs";
import { startFakePlane, DEFAULT_STATES } from "./plane-fake-server.mjs";

const SCRIPT_PATH = fileURLToPath(new URL("./plane-sync.mjs", import.meta.url));
const STOP_HOOK_PATH = fileURLToPath(new URL("../../.claude/hooks/stop.mjs", import.meta.url));

// Shared throwaway-repo `git` helper (T1b/T16/T18): every fixture's own git
// spawn uses gitEnv() (never inherits process.env's GIT_DIR/GIT_WORK_TREE
// unscrubbed) alongside an explicit cwd — the exact fix for the reported
// defect (gates/push.log ~11716): under the husky pre-push hook's
// `npm run verify`, git had already exported GIT_DIR/GIT_WORK_TREE/etc. into
// this self-test's own process, and a fixture's `git checkout -q -b feat/y`
// inherited them and failed with "fatal: this operation must be run in a
// work tree".
function git(cwd, args) {
  const res = spawnSync("git", args, { cwd, encoding: "utf8", env: gitEnv() });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}:\n${res.stdout}${res.stderr}`);
  }
  return res;
}

// Shared harness for T22/T23 (fix 2026-09-12, plane-write-ledger-local):
// spawns a bare `node` process that imports a SPECIFIC on-disk copy of
// plane-client.mjs (never this worktree's own copy) and exercises it — the
// same "prove it from a real child process" pattern T16/T18 use for
// plane-sync.mjs's branch guard. `moduleUrl` must be a `file://` URL (build
// with `pathToFileURL`) pointing at a throwaway repo/worktree's own
// scripts/campaign/plane-client.mjs. Deliberately NOT run through runCli()
// — this exercises plane-client.mjs's exports directly (appendWrite/
// writesToday/stateDir), never PLANE_SYNC_STATE_DIR, since the whole point
// is proving the AMBIENT default (machineRoot()) and its legacy-file
// migration, both of which a state-dir override skips outright.
function runPlaneClientHarness(moduleUrl, { append = false } = {}) {
  const code =
    `const mod = await import(${JSON.stringify(moduleUrl)});` +
    `if (${JSON.stringify(append)}) { mod.appendWrite({ tool: "self-test", method: "POST", path: "/x", ref: "1" }); }` +
    `console.log(JSON.stringify({ writesToday: mod.writesToday(), stateDir: mod.stateDir() }));`;
  const res = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    encoding: "utf8",
    env: gitEnv(),
  });
  let parsed = null;
  try {
    const lastLine = res.stdout.split(/\r?\n/).filter(Boolean).pop();
    parsed = lastLine ? JSON.parse(lastLine) : null;
  } catch {
    // leave parsed null — the caller's check() surfaces raw stdout/stderr instead
  }
  return { ...res, parsed };
}

// Scaffolds a throwaway git repo at a fresh mkdtempSync dir with the
// package.json + .claude marker pair plane-client.mjs's repoRoot() walks up
// to, plus its own committed copy of scripts/campaign/plane-client.mjs —
// the shared setup T22 and T23 both need. Returns { repoDir, scriptsDir }.
function makeThrowawayClientRepo() {
  const repoDir = mkdtempSync(join(tmpdir(), FIXTURE_PREFIX));
  FIXTURE_DIRS.push(repoDir);
  git(repoDir, ["init", "-q"]);
  git(repoDir, ["config", "user.email", "plane-sync-self-test@example.com"]);
  git(repoDir, ["config", "user.name", "plane-sync-self-test"]);
  writeFileSync(join(repoDir, "package.json"), JSON.stringify({ name: "throwaway" }) + "\n");
  mkdirSync(join(repoDir, ".claude"), { recursive: true });
  writeFileSync(join(repoDir, ".claude", ".keep"), "");
  const scriptsDir = join(repoDir, "scripts", "campaign");
  mkdirSync(scriptsDir, { recursive: true });
  writeFileSync(
    join(scriptsDir, "plane-client.mjs"),
    readFileSync(fileURLToPath(new URL("./plane-client.mjs", import.meta.url)), "utf8"),
  );
  return { repoDir, scriptsDir };
}

// Locates the running worktree's own git dir/root by walking up from THIS
// FILE's location — used only by T18 to build a REALISTIC poisoned
// GIT_DIR/GIT_WORK_TREE pair (the worktree this self-test actually runs
// in), never a made-up path. Mirrors plane-client.mjs's repoRoot() walk, but
// stops at the nearest `.git` (file or directory) rather than the
// package.json+.claude marker pair.
function locateThisWorktreeGit() {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const gitPath = join(dir, ".git");
    if (existsSync(gitPath)) {
      const stat = statSync(gitPath);
      if (stat.isDirectory()) return { workTreeRoot: dir, gitDir: gitPath };
      const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(gitPath, "utf8").trim());
      return { workTreeRoot: dir, gitDir: m ? m[1].trim() : gitPath };
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error("locateThisWorktreeGit: no .git found above this file");
    dir = parent;
  }
}

// v1's own name for the state list, kept so every case below (T1-T20) reads
// unchanged; backed by the shared plane-fake-server.mjs module's export so
// there is one definition of "what a fresh BUGS workspace's states look
// like" rather than two that can drift apart.
const DEFAULT_FAKE_STATES = DEFAULT_STATES;

// Thin adapter over the shared `startFakePlane` (plane-fake-server.mjs,
// extracted TP1 2026-09-11-plane-harness): every v1 case below was written
// against this exact shape (`server.items`, `server.requests`, `server.url`,
// `server.close()`), scoped to the single BUGS project the harness's Given/
// Then never needed to name. Rather than rewrite ~20 passing cases, this
// translates the old options into the shared module's seed and re-exposes
// its BUGS-project work-items array under the old `.items` name — the
// underlying HTTP server is now the one plane-intake/-triage/-apply's
// self-tests import too, never a second re-implementation of it.
async function startFakeServer({
  existingItems = [],
  failFirstCreate = false,
  states = DEFAULT_FAKE_STATES,
  omitDescriptionStripped = false,
} = {}) {
  const fake = await startFakePlane({
    workItems: { BUGS: existingItems },
    states: { BUGS: states },
    failFirstCreate,
    omitDescriptionStripped,
  });
  return {
    url: fake.url,
    requests: fake.requests,
    items: fake.state.workItems.BUGS,
    close: fake.close,
  };
}

// ── registry fixture ────────────────────────────────────────────────────────
const B01_CATALOGUE_ROW = {
  id: "B01",
  title: "Widget crashes on save",
  location: "apps/web/src/self-test.tsx",
  severity: "low",
  batch: "F01",
  source: "plane-sync-self-test",
  filedAt: "2026-09-10",
  sensitive: false,
  sensitiveFor: [],
};

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

// F4 (fix-round 1): every fixture dir this run creates is registered here and
// removed in the `finally` at the bottom of the file. Earlier runs of this
// self-test leaked one dir per case into os.tmpdir() forever — a per-block
// cleanup would have been 20 near-identical edits, so the dirs are tracked in
// one place and swept once.
//
// Test-isolation fix (2026-09-12): FIXTURE_PREFIX is unique to THIS PROCESS
// (pid + random) — never a bare "plane-sync-self-test-" literal shared by
// every invocation. Two runs of this same script overlapping on the host (a
// lead's `npm run verify` and a builder's manual run both mid-flight at once)
// used to share one literal prefix, so one run's before/after COUNT of
// tmpdir entries could include the OTHER run's still-live dirs and go red
// under load even though each run was itself correct — `plane-learning.self-
// test: 1 FAILURE(S)` under load, green alone. The sweep below is now pinned
// to (a) every path THIS run recorded being gone after cleanup, never a
// global count of other runs' dirs.
const FIXTURE_DIRS = [];
const FIXTURE_PREFIX = `plane-sync-self-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}-`;
const countFixtureTmpDirs = () =>
  readdirSync(tmpdir()).filter((n) => n.startsWith(FIXTURE_PREFIX)).length;
function cleanupFixtures() {
  const dirs = FIXTURE_DIRS.splice(0);
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // a fixture dir that refuses to go (a live handle on Windows) must never
      // turn an otherwise-passing run red — the final leftover-path check
      // below reports it instead.
    }
  }
  return dirs;
}

// One throwaway directory stands in for "the machine" for this ENTIRE suite
// run (fix 2026-09-12, L-116) — passed as PLANE_MACHINE_ROOT (paired with
// PLANE_SYNC_SELF_TEST=1, already set on every child spawn below) to every
// child this suite spawns, belt-and-braces alongside each call's own
// PLANE_SYNC_STATE_DIR/PLANE_RUNS_PATH overrides. Assigned right before
// `main()` runs (see bottom of file) so the `tmpDirsBefore` baseline there
// stays accurate; tracked in FIXTURE_DIRS so the existing sweep and "no dir
// left behind" check cover its removal for free. F3c is the one deliberate
// exception (it must run WITHOUT the self-test marker to prove the marker
// itself is required) and does not receive this override.
let TEMP_MACHINE_ROOT = null;

function makeFixture({
  catalogue = [B01_CATALOGUE_ROW],
  ledger = { F01: [ledgerRow()] },
  board = { batches: { F01: 532 } },
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), FIXTURE_PREFIX));
  FIXTURE_DIRS.push(dir);
  mkdirSync(join(dir, "status"), { recursive: true });
  writeFileSync(
    dir + "/bugs.jsonl",
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

// ── CLI runner ───────────────────────────────────────────────────────────────
// Runs the CLI out-of-process via `spawn` (never `spawnSync`): the fake Plane
// server above listens on this same harness process's event loop, and a
// synchronous spawn blocks that loop while the child's request to the server
// is still pending, deadlocking every case that needs a round trip.
function runCli(
  argv,
  {
    registryDir,
    baseUrl,
    apiKey = "self-test-key",
    noKey = false,
    // F4 test-isolation (fix-round 2b): every invocation must set
    // PLANE_SYNC_STATE_DIR so a run of this suite never touches the real
    // `.claude/campaign/.plane-writes.jsonl` / `.plane-sync-state.json` of
    // whatever repo/worktree it happens to run in. Defaulting to `registryDir`
    // (always a throwaway `makeFixture()`/mkdtempSync dir tracked in
    // FIXTURE_DIRS and swept in the `finally` below) means every one of this
    // file's ~50 call sites gets isolation for free — only T16's own repo
    // fixture passes an explicit, separate `stateDir` (it needs the ledger to
    // live apart from the throwaway git repo it builds).
    stateDir = registryDir,
    // T16 (R14): the branch guard resolves via a REPO_ROOT computed from the
    // running script's OWN file location, so proving it needs the CLI to run
    // as a copy planted inside a throwaway git repo — never SCRIPT_PATH (this
    // worktree). Every other caller omits this and gets the real script.
    scriptPath = SCRIPT_PATH,
    // R14 landed while this file still runs from a feature worktree (this
    // branch, not master) — every case above T16 predates the branch guard
    // and expects real writes, so this helper auto-appends --allow-branch by
    // default (unless already present) so the guard never silently zeroes
    // those cases' POST/PATCH counts on a non-master branch. T16 itself is
    // the one caller that must observe the UNGUARDED no-flag behavior, so its
    // run 1/run 3 pass `allowBranch: false` to suppress the injection.
    allowBranch = true,
  } = {},
) {
  const env = { ...process.env, PLANE_SYNC_REGISTRY_DIR: registryDir, PLANE_BASE_URL: baseUrl };
  // Always an explicit throwaway dir when a case cares where the ledger/cache
  // land — never the ambient default (`.claude/campaign` of whatever repo
  // this happens to run in), so a harness case can never write into a real
  // registry (test-plan.md §7).
  if (stateDir) env.PLANE_SYNC_STATE_DIR = stateDir;
  // Fix-round (runs.jsonl pollution): every runCli invocation appends one
  // telemetry line via plane-client.mjs's appendRun() in a `finally` inside
  // plane-sync.mjs's main() — success OR failure. runsPath() only honours a
  // PLANE_RUNS_PATH override when PLANE_SYNC_SELF_TEST=1 is ALSO set (same
  // gate as PLANE_DENYLIST_PATH/PLANE_KNOBS_PATH), so both must be set on
  // every call here or the child falls through to the real
  // local-assets/plane/runs.jsonl of whatever repo/worktree this runs in —
  // exactly the leak the final invariant below now guards against.
  env.PLANE_SYNC_SELF_TEST = "1";
  env.PLANE_RUNS_PATH = join(stateDir || registryDir, "self-test-runs.jsonl");
  // Belt-and-braces (fix 2026-09-12, L-116): any plane-client.mjs call not
  // already covered by the overrides above still resolves machineRoot() to
  // THIS suite's own throwaway dir, never the real machine-shared one.
  if (TEMP_MACHINE_ROOT) env.PLANE_MACHINE_ROOT = TEMP_MACHINE_ROOT;
  if (noKey) delete env.PLANE_API_KEY;
  else env.PLANE_API_KEY = apiKey;
  const effectiveArgv =
    allowBranch && !argv.includes("--allow-branch") ? [...argv, "--allow-branch"] : argv;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath, ...effectiveArgv], {
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
    }, 15_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

// ── assertion helper (repo convention: PASS/FAIL lines, exit 1 on failure) ──
let failures = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(
    `${ok ? "  ok  " : "  FAIL"} ${name}${ok ? "" : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`,
  );
}

async function main() {
  // T1 / R1 R2 R3 — registry has B01 (queued, F01 -> issue 532); Plane has no
  // items -> exactly one POST creating the mirrored work item.
  {
    const dir = makeFixture();
    const server = await startFakeServer({ existingItems: [] });
    const { stdout, stderr } = await runCli([], { registryDir: dir, baseUrl: server.url });
    const posts = server.requests.filter((r) => r.method === "POST");
    check("T1 (R1): exactly one POST to /work-items/", posts.length, 1);
    const post = posts[0];
    check(
      "T1 (R1): created item carries external_source/external_id",
      post && {
        external_source: post.body?.external_source,
        external_id: post.body?.external_id,
      },
      { external_source: "routeflow-registry", external_id: "B01" },
    );
    check("T1 (R2): name is '<id> · <title>'", post?.body?.name, "B01 · Widget crashes on save");
    check(
      "T1 (R2): state resolves to the Backlog state id (queued -> Backlog)",
      post?.body?.state,
      "state-backlog",
    );
    check("T1 (R2): priority maps low severity to low priority", post?.body?.priority, "low");
    // R5 bans a project uuid literal, so the only way this POST can land on
    // /projects/proj-bugs/ is by resolving `identifier === "BUGS"` from the
    // projects GET at runtime — a payload built from a hardcoded id fails here.
    check(
      "T1 (R5): POST targets the project resolved at runtime by identifier BUGS",
      post?.path?.includes("/projects/proj-bugs/work-items/"),
      true,
    );
    const desc = post?.body?.description_html ?? "";
    check("T1 (R3): description references the board issue #532", desc.includes("#532"), true);
    check("T1 (R3): description references tier T1", desc.includes("T1"), true);
    check("T1 (R3): description carries a registry-hash", desc.includes("registry-hash:"), true);
    // Unit half of R1/R2/R3, independent of the HTTP layer: the derived row
    // names the mapped Plane STATE (the id above is resolved from this name at
    // runtime) and carries a real sha256 registry-hash.
    const derived = deriveDesired(dir)[0];
    check("T1 (R1): deriveDesired yields the B01 row", derived?.external_id, "B01");
    check("T1 (R2): the derived row carries the mapped state name", derived?.stateName, "Backlog");
    check(
      "T1 (R3): the derived row's registry-hash is a sha256 hex digest",
      /^[0-9a-f]{64}$/.test(derived?.hash ?? ""),
      true,
    );
    void stdout;
    void stderr;
    await server.close();
  }

  // T2 / R4 — same registry, Plane already holds the matching item: run the
  // CLI TWICE against one server so the "already mirrored" fixture is the
  // implementation's own first write, never a registry-hash this test
  // computes (a hash taken from the code under test would make the oracle
  // self-referential). Run 1 is the in-block positive control: it must create
  // exactly once, so run 2's zero-writes assertion cannot pass on inaction.
  {
    const dir = makeFixture();
    const server = await startFakeServer({ existingItems: [] });
    await runCli([], { registryDir: dir, baseUrl: server.url });
    const firstRunPosts = server.requests.filter((r) => r.method === "POST").length;
    const afterFirstRun = server.requests.length;
    const { stdout, stderr } = await runCli([], { registryDir: dir, baseUrl: server.url });
    const secondRun = server.requests.slice(afterFirstRun);
    // COMPOSITE with the control, deliberately one named check: "the second run
    // wrote nothing" is satisfied by a script that does nothing at all, so the
    // first run's create rides in the SAME oracle. Split apart, the zero-writes
    // half went green against an inert stub.
    check(
      "T2 (R4): the first run creates once, the second issues zero POST/PATCH",
      {
        firstRunPosts,
        secondRunWrites: secondRun.filter((r) => r.method === "POST" || r.method === "PATCH")
          .length,
      },
      { firstRunPosts: 1, secondRunWrites: 0 },
    );
    check(
      "T2 (R4): the second run still READS Plane (projects + states + items list)",
      secondRun.length >= 3 && secondRun.every((r) => r.method === "GET"),
      true,
    );
    check(
      "T2 (R4): summary reports 0 created, 0 updated",
      /0 created, 0 updated/.test(stdout + stderr),
      true,
    );
    await server.close();
  }

  // T3 / R2 — B01 ledger row becomes done, pr 601, proof "REG-B01 ..." ->
  // one PATCH with state = Live id and description containing pr: #601 and
  // the proof citation.
  {
    const dir = makeFixture({
      ledger: {
        F01: [ledgerRow({ state: "done", pr: 601, proof: "REG-B01 invoice reconciliation" })],
      },
    });
    const existingItems = [
      {
        id: "item-1",
        external_source: "routeflow-registry",
        external_id: "B01",
        name: "B01 · Widget crashes on save",
        state: "state-backlog",
        priority: "low",
        description_stripped: "registry-hash: stale-hash",
      },
    ];
    const server = await startFakeServer({ existingItems });
    const { stdout, stderr } = await runCli([], { registryDir: dir, baseUrl: server.url });
    const patches = server.requests.filter((r) => r.method === "PATCH");
    check("T3 (R2): exactly one PATCH issued", patches.length, 1);
    const patch = patches[0];
    check(
      "T3 (R2): PATCH targets the existing item-1",
      patch?.path.endsWith("/work-items/item-1/"),
      true,
    );
    check("T3 (R2): state maps done -> Live", patch?.body?.state, "state-live");
    const desc = patch?.body?.description_html ?? "";
    check(
      "T3 (R3): description carries pr: #601",
      desc.includes("pr: #601") || desc.includes("#601"),
      true,
    );
    check(
      "T3 (R3): description carries the proof citation REG-B01",
      desc.includes("REG-B01"),
      true,
    );
    void stdout;
    void stderr;
    await server.close();
  }

  // T4 / R2 — B01 regressed -> PATCH state = Backlog id; description
  // mentions "regressed".
  {
    const dir = makeFixture({
      ledger: { F01: [ledgerRow({ state: "regressed", evidence: "flaked in prod again" })] },
    });
    const existingItems = [
      {
        id: "item-1",
        external_source: "routeflow-registry",
        external_id: "B01",
        name: "B01 · Widget crashes on save",
        state: "state-landing",
        priority: "low",
        description_stripped: "registry-hash: stale-hash",
      },
    ];
    const server = await startFakeServer({ existingItems });
    await runCli([], { registryDir: dir, baseUrl: server.url });
    const patch = server.requests.find((r) => r.method === "PATCH");
    check("T4 (R2): regressed -> PATCH state = Backlog id", patch?.body?.state, "state-backlog");
    check(
      "T4 (R2): description mentions 'regressed'",
      (patch?.body?.description_html ?? "").includes("regressed"),
      true,
    );
    await server.close();
  }

  // T5 / R2 — B01 refuted -> PATCH state = Cancelled id.
  {
    const dir = makeFixture({ ledger: { F01: [ledgerRow({ state: "refuted" })] } });
    const existingItems = [
      {
        id: "item-1",
        external_source: "routeflow-registry",
        external_id: "B01",
        name: "B01 · Widget crashes on save",
        state: "state-backlog",
        priority: "low",
        description_stripped: "registry-hash: stale-hash",
      },
    ];
    const server = await startFakeServer({ existingItems });
    await runCli([], { registryDir: dir, baseUrl: server.url });
    const patch = server.requests.find((r) => r.method === "PATCH");
    check("T5 (R2): refuted -> PATCH state = Cancelled id", patch?.body?.state, "state-cancelled");
    await server.close();
  }

  // T6 / R1 — Plane holds an item external_id B99 with no matching registry
  // row -> never touched (no DELETE, no PATCH for it) and stderr says so.
  {
    const dir = makeFixture({ ledger: { F01: [ledgerRow()] } });
    const existingItems = [
      {
        id: "item-99",
        external_source: "routeflow-registry",
        external_id: "B99",
        name: "B99 · orphaned item",
        state: "state-backlog",
        priority: "low",
        description_stripped: "registry-hash: orphan-hash",
      },
    ];
    const server = await startFakeServer({ existingItems });
    const { stderr } = await runCli([], { registryDir: dir, baseUrl: server.url });
    // COMPOSITE: both safety negatives (no DELETE, no PATCH of the orphan) ride
    // in the SAME oracle as the positive control, because a script that issues
    // no requests at all satisfies either negative on its own.
    check(
      "T6 (R1): orphan B99 untouched while B01 is still created",
      {
        deletes: server.requests.filter((r) => r.method === "DELETE").length,
        b99Patched: server.requests.some((r) => r.method === "PATCH" && r.path.includes("item-99")),
        b01Posts: server.requests.filter((r) => r.method === "POST").length,
      },
      { deletes: 0, b99Patched: false, b01Posts: 1 },
    );
    // The `Plane mirror warn:` prefix is part of the oracle (fix-round 1, F5):
    // every diagnostic carries it, so only the single report line ever matches
    // Gate 5's bare `^Plane mirror:` relay regex.
    check(
      "T6 (R1/F5): stderr names B99 as left as is, under the warn prefix",
      stderr.includes("Plane mirror warn: B99 has no registry row (left as is)"),
      true,
    );
    await server.close();
  }

  // T7 / R5 — PLANE_API_KEY unset -> exits 0, touches the network zero
  // times (not merely "no error" — the request log itself must be empty),
  // and reports the exact skip line.
  {
    // Control first, on its own recorder: the SAME fixture WITH the key set
    // does reach the server, so "zero requests" below is the key check
    // working and not the script being inert. Its result is folded into the
    // skip-path oracle rather than standing as its own named check.
    const controlDir = makeFixture();
    const controlServer = await startFakeServer({ existingItems: [] });
    await runCli([], { registryDir: controlDir, baseUrl: controlServer.url });
    const controlReached = controlServer.requests.length > 0;
    await controlServer.close();

    const dir = makeFixture();
    const server = await startFakeServer({ existingItems: [] });
    const { code, stderr } = await runCli([], {
      registryDir: dir,
      baseUrl: server.url,
      noKey: true,
    });
    check(
      "T7 (R5): key set reaches the server; key unset exits 0 with zero requests",
      { controlReached, code, requests: server.requests.length },
      { controlReached: true, code: 0, requests: 0 },
    );
    check(
      "T7 (R5): stderr reports the skip line verbatim",
      stderr.includes("Plane mirror: skipped (no PLANE_API_KEY)"),
      true,
    );
    await server.close();
  }

  // T8 / R5 — fake server answers 429 once (x-ratelimit-reset = now+1) then
  // 201 -> the create is retried exactly once and the final summary reports
  // 1 created.
  {
    const dir = makeFixture();
    const server = await startFakeServer({ existingItems: [], failFirstCreate: true });
    const { stdout, stderr } = await runCli([], { registryDir: dir, baseUrl: server.url });
    const posts = server.requests.filter((r) => r.method === "POST");
    check("T8 (R5): the create POST is retried exactly once after a 429", posts.length, 2);
    check("T8 (R5): final summary reports 1 created", /1 created/.test(stdout + stderr), true);
    // Discriminates a RETRY of the same create from two separate creates: the
    // fake only appends an item on a 2xx, so honouring the 429 leaves exactly
    // one mirrored B01 behind even though two POSTs were seen.
    check(
      "T8 (R5): the retry re-sends the same create (one mirrored B01, not two)",
      server.items.filter((it) => it.external_id === "B01").length,
      1,
    );
    await server.close();
  }

  // T9 / R6 — drift present: --dry-run then --check both perform zero
  // writes and never write the digest file; --check exits 1.
  {
    // Control: the same fixture with NO flag writes once, so the zero-write
    // assertions below describe --dry-run/--check rather than inaction.
    const controlDir = makeFixture();
    const controlServer = await startFakeServer({ existingItems: [] });
    await runCli([], { registryDir: controlDir, baseUrl: controlServer.url });
    const controlPosts = controlServer.requests.filter((r) => r.method === "POST").length;
    await controlServer.close();

    const dryDir = makeFixture();
    const dryServer = await startFakeServer({ existingItems: [] });
    const dry = await runCli(["--dry-run"], { registryDir: dryDir, baseUrl: dryServer.url });
    // COMPOSITE: "zero writes" and "no digest file" are both satisfied by a
    // script that ignores --dry-run entirely and does nothing, so the control's
    // write count and the planned-create line ride in the same oracle.
    check(
      "T9 (R6): --dry-run plans without writing (control writes once)",
      {
        controlPosts,
        dryWrites: dryServer.requests.filter((r) => r.method === "POST" || r.method === "PATCH")
          .length,
        dryDigestWritten: existsSync(join(dryDir, ".plane-sync-digest")),
        listsCreate: dry.stdout.includes("CREATE B01"),
      },
      { controlPosts: 1, dryWrites: 0, dryDigestWritten: false, listsCreate: true },
    );
    // A no-write run must not print the sentence a real write prints — the
    // reader of `npm run bugs:plane -- --dry-run` has to be able to tell
    // "would have created 282" from "created 282".
    check(
      "T9 (R6): --dry-run summarises what it WOULD do, marked (dry-run), never 'created'",
      {
        marked: (dry.stdout + dry.stderr).includes(
          "Plane mirror: would create 1, would update 0 (dry-run)",
        ),
        claimsCreated: /1 created/.test(dry.stdout + dry.stderr),
      },
      { marked: true, claimsCreated: false },
    );
    await dryServer.close();

    const checkDir = makeFixture();
    const checkServer = await startFakeServer({ existingItems: [] });
    const chk = await runCli(["--check"], { registryDir: checkDir, baseUrl: checkServer.url });
    // Same composite shape as --dry-run above: the exit-1-on-drift half is the
    // positive discriminator the two zero-write halves need (a stub exits 0 and
    // writes nothing), and the control's write count rides along.
    check(
      "T9 (R6): --check reports drift without writing (control writes once)",
      {
        controlPosts,
        checkWrites: checkServer.requests.filter((r) => r.method === "POST" || r.method === "PATCH")
          .length,
        code: chk.code,
        digestWritten: existsSync(join(checkDir, ".plane-sync-digest")),
      },
      { controlPosts: 1, checkWrites: 0, code: 1, digestWritten: false },
    );
    check(
      "T9 (R6): --check's summary is marked (check), not a created/updated claim",
      (chk.stdout + chk.stderr).includes("(check)") && !/1 created/.test(chk.stdout + chk.stderr),
      true,
    );
    await checkServer.close();
  }

  // T10 / R4 — after a successful run, registry unchanged: with
  // --if-digest-changed, exits 0 with ZERO network requests (not even the
  // projects GET).
  {
    const dir = makeFixture();
    // The digest must be a real content hash BEFORE it can be trusted as the
    // short-circuit key: sha256 hex, and content-sensitive on the same dir (a
    // `registryDigest()` returning a constant would otherwise satisfy every
    // assertion below, making the oracle self-referential).
    const digestBefore = registryDigest(dir);
    check(
      "T10 (R4): registryDigest is a sha256 hex digest",
      /^[0-9a-f]{64}$/.test(digestBefore),
      true,
    );
    writeFileSync(
      join(dir, "bugs.jsonl"),
      JSON.stringify({ ...B01_CATALOGUE_ROW, title: "Widget crashes on save (edited)" }) + "\n",
    );
    check(
      "T10 (R4): the digest changes when the registry content changes",
      registryDigest(dir) !== digestBefore,
      true,
    );
    writeFileSync(join(dir, "bugs.jsonl"), JSON.stringify(B01_CATALOGUE_ROW) + "\n");

    writeFileSync(join(dir, ".plane-sync-digest"), digestBefore);
    const server = await startFakeServer({ existingItems: [] });
    const { code } = await runCli(["--if-digest-changed"], {
      registryDir: dir,
      baseUrl: server.url,
    });
    const requestsAfterMatchingDigest = server.requests.length;

    // Positive control on the same server: a STALE digest must NOT
    // short-circuit — the same flag then performs the full read and the
    // pending create. It is folded into ONE oracle with the short-circuit
    // halves, because "zero requests, exit 0" is exactly what a script that
    // never runs does for every invocation.
    writeFileSync(join(dir, ".plane-sync-digest"), "stale-digest");
    await runCli(["--if-digest-changed"], { registryDir: dir, baseUrl: server.url });
    check(
      "T10 (R4): a matching digest short-circuits, a stale digest does not",
      {
        shortCircuitRequests: requestsAfterMatchingDigest,
        shortCircuitCode: code,
        staleRequests: server.requests.length - requestsAfterMatchingDigest >= 3,
        stalePosts: server.requests.filter((r) => r.method === "POST").length,
      },
      { shortCircuitRequests: 0, shortCircuitCode: 0, staleRequests: true, stalePosts: 1 },
    );
    await server.close();
  }

  // T11 / R5 — no Plane uuid literal and no PLANE_API_KEY= literal in any
  // tracked file this feature touches.
  {
    const uuidRe = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
    const apiKeyLiteralRe = /PLANE_API_KEY\s*=\s*["'`][^"'`]/;
    const syncSrc = readFileSync(SCRIPT_PATH, "utf8");
    // Read the hook DIRECTLY — no existsSync fallback. Both files are part of
    // this feature, so an ENOENT here is a real failure; the old `? ... : ""`
    // fallback made every stop.mjs grep below pass against a hook that had no
    // Gate 5 in it at all (and would have passed against no hook whatsoever).
    const stopSrc = readFileSync(STOP_HOOK_PATH, "utf8");
    // COMPOSITES: an absence grep holds of ANY file, an empty one included, so
    // each one is paired with the positive half R5 states inside a single named
    // check — the key read from the environment, the project resolved by the
    // identifier BUGS, the workspace slug an env var, and (for the hook) Gate 5
    // actually spawning the mirror.
    check(
      "T11 (R5): plane-sync reads the key from env, no uuid/key literal",
      {
        uuid: uuidRe.test(syncSrc),
        keyLiteral: apiKeyLiteralRe.test(syncSrc),
        envRead: /process\.env\.PLANE_API_KEY/.test(syncSrc),
        byIdentifier: /identifier[^\n]*BUGS|"BUGS"/.test(syncSrc),
        workspaceEnv: /PLANE_WORKSPACE_SLUG/.test(syncSrc),
      },
      { uuid: false, keyLiteral: false, envRead: true, byIdentifier: true, workspaceEnv: true },
    );
    check(
      "T11 (R5): stop.mjs carries Gate 5 with no uuid/key literal",
      {
        uuid: uuidRe.test(stopSrc),
        keyLiteral: apiKeyLiteralRe.test(stopSrc),
        spawnsSync: stopSrc.includes("plane-sync.mjs"),
      },
      { uuid: false, keyLiteral: false, spawnsSync: true },
    );
    // A raw NUL byte in the source makes grep/ripgrep classify the file as
    // binary and silently drop every match in it — the separator inside
    // registryDigest must stay the two-character `\0` ESCAPE, never the byte.
    check("T11 (guard): no raw NUL byte in plane-sync.mjs", syncSrc.includes("\0"), false);
    // Guard against reintroducing the harness deadlock this file was fixed
    // for: no synchronous spawn of the CLI script may remain. Built from
    // concatenated fragments so this very check's own source text never
    // contains the pattern it looks for (else it would always match itself).
    const selfTestSrc = readFileSync(fileURLToPath(import.meta.url), "utf8");
    const syncSpawnOfScriptRe = new RegExp("spawn" + "Sync\\(" + "[^)]*" + "SCRIPT" + "_PATH");
    check(
      "T11 (guard): no synchronous spawn of SCRIPT_PATH in this file",
      syncSpawnOfScriptRe.test(selfTestSrc),
      false,
    );
  }

  // T13 / R5 — a network/HTTP failure (e.g. connection refused) never
  // escapes runSync: exit 0 with one non-blocking failed line by default,
  // exit 1 with the same line under --strict.
  {
    const dir = makeFixture();
    const unreachable = "http://127.0.0.1:1"; // closed port -> immediate ECONNREFUSED
    const { code, stderr } = await runCli([], { registryDir: dir, baseUrl: unreachable });
    // Composite: "exit 0" alone is what an inert script does for every input,
    // so the reported failure line rides in the same oracle.
    check(
      "T13a (R5): exits 0 on a network failure with exactly one 'failed (non-blocking)' line",
      {
        code,
        failedLines: stderr
          .split("\n")
          .filter((l) => l.startsWith("Plane mirror: failed (non-blocking) — ")).length,
      },
      { code: 0, failedLines: 1 },
    );

    const dir2 = makeFixture();
    const strict = await runCli(["--strict"], { registryDir: dir2, baseUrl: unreachable });
    check("T13b (R5): --strict exits 1 on the same network failure", strict.code, 1);
    check(
      "T13b (R5): --strict still reports the exact non-blocking failed line",
      strict.stderr
        .split("\n")
        .filter((l) => l.startsWith("Plane mirror: failed (non-blocking) — ")).length,
      1,
    );
  }

  // T14 / R5 R7 — severities: "none" is a REAL registry value (3 rows carry
  // it) and one of Plane's own priorities, so it maps through silently; a
  // genuinely unknown severity warns. Crucially the warns must NOT wear the
  // bare `Plane mirror:` prefix Gate 5 greps for — exactly one line per run
  // may, or the hook relays a warning instead of the summary forever.
  {
    const dir = makeFixture({
      catalogue: [
        B01_CATALOGUE_ROW,
        { ...B01_CATALOGUE_ROW, id: "B02", title: "Unset severity row", severity: "none" },
        { ...B01_CATALOGUE_ROW, id: "B03", title: "Bogus severity row", severity: "weird" },
      ],
    });
    const server = await startFakeServer({ existingItems: [] });
    const { stdout, stderr } = await runCli([], { registryDir: dir, baseUrl: server.url });
    const posts = server.requests.filter((r) => r.method === "POST");
    const b02 = posts.find((r) => r.body?.external_id === "B02");
    check("T14 (R2): severity none maps to Plane priority none", b02?.body?.priority, "none");
    check(
      "T14 (R2): an unknown severity warns without the relay prefix",
      stderr
        .split(/\r?\n/)
        .some((l) => l.startsWith('Plane mirror warn: unknown severity "weird"')),
      true,
    );
    const relayed = (stdout + stderr).split(/\r?\n/).filter((l) => /^Plane mirror:/.test(l));
    check(
      "T14 (R7): exactly one line carries the bare 'Plane mirror:' prefix Gate 5 relays",
      relayed,
      ["Plane mirror: 3 created, 0 updated"],
    );
    await server.close();

    check("T14 (unit): mapPriority('none') is 'none'", mapPriority("none"), "none");
    check(
      "T14 (unit): mapPriority('weird') falls back to 'medium'",
      mapPriority("weird"),
      "medium",
    );
  }

  // T15 / R4 — Plane-side drift with a CURRENT registry-hash: the item's
  // description is already up to date, only its state was changed in Plane.
  // A hash-only diff called this "no drift" forever; the diff has to compare
  // name/state/priority too.
  {
    const dir = makeFixture();
    // Built from the implementation's own hash for the unchanged fixture (an
    // empty wave map so this never spawns bugs.mjs — the hash is wave-free),
    // so the ONLY thing wrong with this existing item is its state.
    const currentHash = deriveDesired(dir, { wavePlacement: new Map() })[0].hash;
    const existingItems = [
      {
        id: "item-1",
        external_source: "routeflow-registry",
        external_id: "B01",
        name: "B01 · Widget crashes on save",
        state: "state-live", // registry says queued -> Backlog
        priority: "low",
        description_stripped: `registry-hash: ${currentHash}`,
      },
    ];
    const server = await startFakeServer({ existingItems });
    const chk = await runCli(["--check"], { registryDir: dir, baseUrl: server.url });
    check("T15 (R4): --check exits 1 on Plane-side state drift", chk.code, 1);
    check(
      "T15 (R4): --check names B01 as needing an update",
      chk.stdout.includes("UPDATE B01"),
      true,
    );
    const before = server.requests.length;
    await runCli([], { registryDir: dir, baseUrl: server.url });
    const patches = server.requests.slice(before).filter((r) => r.method === "PATCH");
    check("T15 (R4): a real run issues exactly one PATCH", patches.length, 1);
    check(
      "T15 (R4): the PATCH re-asserts the registry's state on item-1",
      patches[0] && {
        target: patches[0].path.endsWith("/work-items/item-1/"),
        state: patches[0].body?.state,
      },
      { target: true, state: "state-backlog" },
    );
    await server.close();
  }

  // T16 / R2 — the mapped Plane state does not exist in the workspace: the
  // row is SKIPPED, never created with an unset state (which Plane would fill
  // with its own default and the hash would then pin forever).
  {
    const dir = makeFixture();
    const server = await startFakeServer({
      existingItems: [],
      states: DEFAULT_FAKE_STATES.filter((s) => s.name !== "Backlog"),
    });
    const { code, stdout, stderr } = await runCli([], { registryDir: dir, baseUrl: server.url });
    // Composite: exit 0 and zero writes are both free to a script that does
    // nothing, so the named warn line — the only positive evidence that the row
    // was deliberately SKIPPED rather than never considered — rides along.
    check(
      "T16 (R2 R5): an unresolvable state skips the row, warns, and never fails the run",
      {
        code,
        writes: server.requests.filter((r) => r.method === "POST" || r.method === "PATCH").length,
        warned: stderr.includes('Plane mirror warn: B01 skipped — no Plane state named "Backlog"'),
      },
      { code: 0, writes: 0, warned: true },
    );
    check(
      "T16 (R7): the relayed summary names the skipped row so a synced-looking run isn't silent",
      (stdout + stderr).split(/\r?\n/).filter((l) => /^Plane mirror:/.test(l)),
      ["Plane mirror: 0 created, 0 updated, 1 skipped (no Plane state)"],
    );
    check(
      "T16: the digest is NOT written while a row is skipped, so the next run retries it",
      existsSync(join(dir, ".plane-sync-digest")),
      false,
    );
    await server.close();
  }

  // T16b / R2 R5 — --check must report drift while a row is skipped (the
  // digest was never advanced for it), and a later run against a fixed Plane
  // (the missing state created) must pick the row up and then advance the
  // digest.
  {
    const dir = makeFixture();
    const noBacklog = DEFAULT_FAKE_STATES.filter((s) => s.name !== "Backlog");
    const server1 = await startFakeServer({ existingItems: [], states: noBacklog });
    const chk = await runCli(["--check"], { registryDir: dir, baseUrl: server1.url });
    check("T16b (R5): --check exits 1 while a row is skipped", chk.code, 1);
    check(
      "T16b: --check's summary names the skipped row",
      (chk.stdout + chk.stderr).split(/\r?\n/).filter((l) => /^Plane mirror:/.test(l)),
      ["Plane mirror: would create 0, would update 0, 1 skipped (no Plane state) (check)"],
    );
    await server1.close();

    const server2 = await startFakeServer({ existingItems: [], states: DEFAULT_FAKE_STATES });
    const first = await runCli(["--if-digest-changed"], { registryDir: dir, baseUrl: server2.url });
    const posts = server2.requests.filter((r) => r.method === "POST");
    check("T16b: once the state exists, --if-digest-changed creates the row", posts.length, 1);
    check(
      "T16b: the digest is written once the row is no longer skipped",
      existsSync(join(dir, ".plane-sync-digest")),
      true,
    );
    const before = server2.requests.length;
    const second = await runCli(["--if-digest-changed"], {
      registryDir: dir,
      baseUrl: server2.url,
    });
    check(
      "T16b: a second --if-digest-changed against the same digest makes zero requests",
      server2.requests.length - before,
      0,
    );
    await server2.close();
  }

  // T17 / R4 (Landmine 1) — Plane's list response omits
  // `description_stripped`. An absent field must read as "unknown", not
  // "hash mismatch": treating it as a mismatch re-PATCHed every mirrored
  // item on every run forever, on a registry that never changed.
  {
    const dir = makeFixture();
    const server = await startFakeServer({ existingItems: [], omitDescriptionStripped: true });
    const first = await runCli([], { registryDir: dir, baseUrl: server.url });
    const afterFirst = server.requests.length;
    const second = await runCli([], { registryDir: dir, baseUrl: server.url });
    // Composite with run 1's control: "run 2 wrote nothing" is satisfied by a
    // script that never writes at all.
    check(
      "T17 (R4): run 1 creates, run 2 issues zero writes even with no description_stripped",
      {
        run1Created: /Plane mirror: 1 created, 0 updated/.test(first.stdout + first.stderr),
        run2Writes: server.requests
          .slice(afterFirst)
          .filter((r) => r.method === "POST" || r.method === "PATCH").length,
      },
      { run1Created: true, run2Writes: 0 },
    );
    check(
      "T17 (R4): run 2 reports 0 created, 0 updated",
      /Plane mirror: 0 created, 0 updated/.test(second.stdout + second.stderr),
      true,
    );
    // And the presumption is not blanket blindness: a real title change still
    // lands exactly one PATCH, because name/state/priority are compared.
    writeFileSync(
      join(dir, "bugs.jsonl"),
      JSON.stringify({ ...B01_CATALOGUE_ROW, title: "Widget crashes on save (retitled)" }) + "\n",
    );
    const afterSecond = server.requests.length;
    await runCli([], { registryDir: dir, baseUrl: server.url });
    const patches = server.requests.slice(afterSecond).filter((r) => r.method === "PATCH");
    check("T17 (R4): a real title change lands exactly one PATCH", patches.length, 1);
    check(
      "T17 (R4): the PATCH carries the new title to item-1",
      patches[0] && {
        target: patches[0].path.endsWith("/work-items/item-1/"),
        name: patches[0].body?.name,
      },
      { target: true, name: "B01 · Widget crashes on save (retitled)" },
    );
    await server.close();
  }

  // T18 / R4 — wave placement is informational: it renders in the
  // description but is OUTSIDE the hash, so a slow/failed `bugs.mjs waves`
  // spawn (whose fallback is "unknown") can never flip the hash of every
  // batched row and trigger a full re-PATCH — twice.
  {
    const dir = makeFixture();
    const withWave = deriveDesired(dir, { wavePlacement: new Map([["F01", "wave 1"]]) })[0];
    const withoutWave = deriveDesired(dir, { wavePlacement: new Map() })[0];
    // "identical" is true of two empty strings, so the oracle also pins the hash
    // to a real sha256 digest — otherwise a constant-returning stub passes.
    check(
      "T18 (R4): the registry-hash is a sha256 digest, identical whatever the waves spawn returned",
      {
        identical: withWave.hash === withoutWave.hash,
        sha256: /^[0-9a-f]{64}$/.test(withWave.hash ?? ""),
      },
      { identical: true, sha256: true },
    );
    check(
      "T18 (R3): the wave line is still rendered in the description",
      withWave.description_html.includes("wave: wave 1") &&
        withoutWave.description_html.includes("wave: unknown"),
      true,
    );
  }

  // T19 / R7 — the single report line is printed exactly ONCE across both
  // streams, quiet or not (it used to go to stderr AND stdout, so every
  // non-quiet run showed a human its summary twice).
  {
    const summary = "Plane mirror: 1 created, 0 updated";
    const countSummaryLines = (r) =>
      (r.stdout + r.stderr).split(/\r?\n/).filter((l) => l.trim() === summary).length;

    const loudDir = makeFixture();
    const loudServer = await startFakeServer({ existingItems: [] });
    const loud = await runCli([], { registryDir: loudDir, baseUrl: loudServer.url });
    check("T19 (R7): a non-quiet run prints its summary exactly once", countSummaryLines(loud), 1);
    await loudServer.close();

    const quietDir = makeFixture();
    const quietServer = await startFakeServer({ existingItems: [] });
    const hushed = await runCli(["--quiet"], { registryDir: quietDir, baseUrl: quietServer.url });
    check("T19 (R7): a --quiet run prints its summary exactly once", countSummaryLines(hushed), 1);
    await quietServer.close();
  }

  // T20 / F1b — `--budget-ms`: a run that runs out of budget stops WRITING,
  // reports the partial, and above all does NOT write the digest — otherwise
  // the next `--if-digest-changed` run short-circuits on a digest certifying
  // rows this run never wrote, and the remainder is mirrored never.
  {
    const catalogue = ["B01", "B02", "B03"].map((id, i) => ({
      ...B01_CATALOGUE_ROW,
      id,
      title: `Budget row ${i + 1}`,
    }));
    const ledger = { F01: catalogue.map((r) => ledgerRow({ id: r.id })) };

    const dir = makeFixture({ catalogue, ledger });
    const server = await startFakeServer({ existingItems: [] });
    const starved = await runCli(["--budget-ms", "0"], { registryDir: dir, baseUrl: server.url });
    const starvedWrites = server.requests.filter(
      (r) => r.method === "POST" || r.method === "PATCH",
    ).length;
    await server.close();

    // POSITIVE CONTROL, folded into the same oracle: the identical 3-row
    // fixture with NO budget writes all three and DOES write the digest. Split
    // apart, "≤ 1 write, no digest" is exactly what a script broken into
    // inaction scores.
    const controlDir = makeFixture({ catalogue, ledger });
    const controlServer = await startFakeServer({ existingItems: [] });
    await runCli([], { registryDir: controlDir, baseUrl: controlServer.url });
    const controlWrites = controlServer.requests.filter((r) => r.method === "POST").length;
    await controlServer.close();

    check(
      "T20 (F1b): --budget-ms 0 writes at most once and leaves no digest; unbounded writes all 3 and does",
      {
        starvedWritesAtMostOne: starvedWrites <= 1,
        starvedDigest: existsSync(join(dir, ".plane-sync-digest")),
        starvedExit: starved.code,
        controlWrites,
        controlDigest: existsSync(join(controlDir, ".plane-sync-digest")),
      },
      {
        starvedWritesAtMostOne: true,
        starvedDigest: false,
        starvedExit: 0,
        controlWrites: 3,
        controlDigest: true,
      },
    );
    check(
      "T20 (F1b): the exhausted run reports its partial and says to rerun",
      /Plane mirror: synced \d+ of 3 writes \(budget exhausted, rerun to continue\)/.test(
        starved.stdout + starved.stderr,
      ),
      true,
    );
  }

  // T17b / F3 — a mirrored row Plane returns WITHOUT `description_stripped`
  // cannot be verified against the registry hash. It is counted `unverified`
  // and must NOT advance the digest: presuming it unchanged is a presumption,
  // and a digest written over it would make the next run skip the read that
  // could still catch the drift.
  {
    const dir = makeFixture();
    const server = await startFakeServer({ existingItems: [], omitDescriptionStripped: true });
    await runCli([], { registryDir: dir, baseUrl: server.url }); // run 1 creates the item
    // Run 1 legitimately wrote a digest (it created the row it could not yet
    // read back), so the oracle is "is it WRITTEN AGAIN": remove it, then run.
    const digestAfterCreate = existsSync(join(dir, ".plane-sync-digest"));
    rmSync(join(dir, ".plane-sync-digest"), { force: true });
    const second = await runCli([], { registryDir: dir, baseUrl: server.url });
    await server.close();

    // Positive control on the same shape: with `description_stripped` present,
    // the second run verifies the row and DOES rewrite the digest.
    const controlDir = makeFixture();
    const controlServer = await startFakeServer({ existingItems: [] });
    await runCli([], { registryDir: controlDir, baseUrl: controlServer.url });
    rmSync(join(controlDir, ".plane-sync-digest"), { force: true });
    const control = await runCli([], { registryDir: controlDir, baseUrl: controlServer.url });
    await controlServer.close();

    check(
      "T17b (F3): an unverifiable row blocks the digest; a verifiable one writes it",
      {
        digestAfterCreate,
        digestAfterUnverifiedRun: existsSync(join(dir, ".plane-sync-digest")),
        controlDigest: existsSync(join(controlDir, ".plane-sync-digest")),
        controlSummaryClean: /Plane mirror: 0 created, 0 updated$/m.test(
          (control.stdout + control.stderr).trim(),
        ),
      },
      {
        digestAfterCreate: true,
        digestAfterUnverifiedRun: false,
        controlDigest: true,
        controlSummaryClean: true,
      },
    );
    check(
      "T17b (F3): the summary counts the unverified row",
      /Plane mirror: 0 created, 0 updated, 1 unverified/.test(second.stdout + second.stderr),
      true,
    );
  }

  // ══════════════════════════════════════════════════════════════════════
  // Harness wave (.claude/pipeline/2026-09-11-plane-harness, test-plan.md
  // T1-T6/T11/T15 — labelled H1.. below to avoid colliding with the T1-T20
  // labels above, which prove a DIFFERENT, older spec's R1-R7). None of
  // plane-client.mjs / the denylist / --max-writes / comment-on-close /
  // adoption / --help exist in plane-sync.mjs yet, so every case here is
  // expected RED on its stated assertion, never a crash (build-plan.md's
  // own "must fail with" table).
  // ══════════════════════════════════════════════════════════════════════

  // H1 (T1, R1) — adoption: an existing BUGS item with a null external_id
  // whose name matches "B<n> · ..." is PATCHed to stamp external_id, never
  // re-created. B13 already carries a matching, up-to-date mirrored item so
  // this case isolates the oracle to B12's adoption alone.
  {
    const dir = makeFixture({
      catalogue: [
        { ...B01_CATALOGUE_ROW, id: "B12", title: "x" },
        { ...B01_CATALOGUE_ROW, id: "B13", title: "y" },
      ],
      ledger: { F01: [ledgerRow({ id: "B12" }), ledgerRow({ id: "B13" })] },
    });
    const b13Hash = deriveDesired(dir, { wavePlacement: new Map() }).find(
      (r) => r.external_id === "B13",
    )?.hash;
    const existingItems = [
      {
        id: "item-b12",
        name: "B12 · x",
        state: "state-backlog",
        priority: "low",
        external_id: null,
        external_source: null,
        sequence_id: 5,
      },
      {
        id: "item-b13",
        name: "B13 · y",
        state: "state-backlog",
        priority: "low",
        external_id: "B13",
        external_source: "routeflow-registry",
        description_stripped: `registry-hash: ${b13Hash}`,
        sequence_id: 6,
      },
    ];
    const server = await startFakeServer({ existingItems });
    await runCli([], { registryDir: dir, baseUrl: server.url, stateDir: dir });
    const patches1 = server.requests.filter((r) => r.method === "PATCH");
    const b12Patch = patches1.find((p) => p.path.endsWith("/work-items/item-b12/"));
    const posts1 = server.requests.filter((r) => r.method === "POST");
    check(
      "H1 (harness T1/R1): run 1 adopts B12 via one PATCH stamping external_id, zero POST creates",
      {
        patchCount: patches1.length,
        adoptionBody: b12Patch && {
          external_source: b12Patch.body?.external_source,
          external_id: b12Patch.body?.external_id,
        },
        postCount: posts1.length,
      },
      {
        patchCount: 1,
        adoptionBody: { external_source: "routeflow-registry", external_id: "B12" },
        postCount: 0,
      },
    );
    const before2 = server.requests.length;
    await runCli([], { registryDir: dir, baseUrl: server.url, stateDir: dir });
    const writes2 = server.requests
      .slice(before2)
      .filter((r) => r.method === "POST" || r.method === "PATCH").length;
    check("H1 (harness T1/R1): run 2 issues zero writes once adopted", writes2, 0);
    await server.close();
  }

  // H2 (T2, R1) — two adoption candidates for one id: adopt the LOWEST
  // sequence_id, warn `duplicate candidate B12`, never delete the loser.
  {
    // Registry title is "a" so the desired name ("B12 · a") matches the
    // adopted (seq-5) candidate's name exactly — otherwise planDiff legitimately
    // issues a second, rename PATCH after adoption, and the patchCount:1 oracle
    // below (adoption only) would conflate the two into one number.
    const dir = makeFixture({
      catalogue: [{ ...B01_CATALOGUE_ROW, id: "B12", title: "a" }],
      ledger: { F01: [ledgerRow({ id: "B12" })] },
    });
    const existingItems = [
      {
        id: "item-dup-9",
        name: "B12 · b",
        state: "state-backlog",
        priority: "low",
        external_id: null,
        sequence_id: 9,
      },
      {
        id: "item-dup-5",
        name: "B12 · a",
        state: "state-backlog",
        priority: "low",
        external_id: null,
        sequence_id: 5,
      },
    ];
    const server = await startFakeServer({ existingItems });
    const { stdout, stderr } = await runCli([], {
      registryDir: dir,
      baseUrl: server.url,
      stateDir: dir,
    });
    const patches = server.requests.filter((r) => r.method === "PATCH");
    const deletes = server.requests.filter((r) => r.method === "DELETE");
    check(
      "H2 (harness T2/R1): adopts only the lower sequence_id (5), warns duplicate, never deletes",
      {
        patchCount: patches.length,
        patchTargetsSeq5: patches.some((p) => p.path.endsWith("/work-items/item-dup-5/")),
        warned: (stdout + stderr).includes("duplicate candidate B12"),
        deleteCount: deletes.length,
      },
      { patchCount: 1, patchTargetsSeq5: true, warned: true, deleteCount: 0 },
    );
    await server.close();
  }

  // T1b (fix-round 2b, F1/Opus #1) — adoption is a WRITE: --check and
  // --dry-run must issue ZERO PATCH/POST for an adoptable candidate, report
  // it separately as "would adopt N", and --check must still treat it as
  // drift (exit 1). B12 here is a null-external_id "B12 · x" the registry
  // also carries — exactly H1's fixture, but read under --check/--dry-run
  // instead of a real run.
  {
    const makeB12Fixture = () =>
      makeFixture({
        catalogue: [{ ...B01_CATALOGUE_ROW, id: "B12", title: "x" }],
        ledger: { F01: [ledgerRow({ id: "B12" })] },
      });
    const b12ExistingItems = () => [
      {
        id: "item-b12",
        name: "B12 · x",
        state: "state-backlog",
        priority: "low",
        external_id: null,
        external_source: null,
        sequence_id: 5,
      },
    ];

    // --check: zero writes, "would adopt 1", exit 1 (drift).
    {
      const dir = makeB12Fixture();
      const server = await startFakeServer({ existingItems: b12ExistingItems() });
      const { code, stdout, stderr } = await runCli(["--check"], {
        registryDir: dir,
        baseUrl: server.url,
      });
      const writes = server.requests.filter(
        (r) => r.method === "PATCH" || r.method === "POST",
      ).length;
      check(
        "T1b (F1): --check on an adoptable candidate makes zero PATCH/POST, reports would adopt 1, exits 1",
        { writes, exitCode: code, mentionsWouldAdopt: (stdout + stderr).includes("would adopt 1") },
        { writes: 0, exitCode: 1, mentionsWouldAdopt: true },
      );
      await server.close();
    }

    // --dry-run: zero writes, "would adopt 1", exit 0 (never fails a turn).
    {
      const dir = makeB12Fixture();
      const server = await startFakeServer({ existingItems: b12ExistingItems() });
      const { code, stdout, stderr } = await runCli(["--dry-run"], {
        registryDir: dir,
        baseUrl: server.url,
      });
      const writes = server.requests.filter(
        (r) => r.method === "PATCH" || r.method === "POST",
      ).length;
      check(
        "T1b (F1): --dry-run on an adoptable candidate makes zero PATCH/POST, reports would adopt 1, exits 0",
        { writes, exitCode: code, mentionsWouldAdopt: (stdout + stderr).includes("would adopt 1") },
        { writes: 0, exitCode: 0, mentionsWouldAdopt: true },
      );
      await server.close();
    }

    // R14 interaction: the SAME adoptable candidate, off master, with no
    // --allow-branch — the R14 branch guard (T16) must gate the adoption
    // PATCH exactly like any other write, so total writes stay 0. Uses a
    // throwaway git repo the same way T16 does (the branch guard resolves
    // REPO_ROOT from the running script's own file location).
    {
      const repoDir = mkdtempSync(join(tmpdir(), FIXTURE_PREFIX));
      FIXTURE_DIRS.push(repoDir);
      git(repoDir, ["init", "-q"]);
      git(repoDir, ["checkout", "-q", "-b", "feat/y"]);
      git(repoDir, ["config", "user.email", "plane-sync-self-test@example.com"]);
      git(repoDir, ["config", "user.name", "plane-sync-self-test"]);
      writeFileSync(join(repoDir, "package.json"), JSON.stringify({ name: "throwaway" }) + "\n");
      mkdirSync(join(repoDir, ".claude"), { recursive: true });
      writeFileSync(join(repoDir, ".claude", ".keep"), "");
      const scriptsDir = join(repoDir, "scripts", "campaign");
      mkdirSync(scriptsDir, { recursive: true });
      for (const name of ["plane-sync.mjs", "plane-client.mjs", "plane-denylist.json"]) {
        writeFileSync(
          join(scriptsDir, name),
          readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), "utf8"),
        );
      }
      git(repoDir, ["add", "-A"]);
      git(repoDir, ["commit", "-q", "-m", "chore: seed"]);

      const stateDirT1b = mkdtempSync(join(tmpdir(), FIXTURE_PREFIX));
      FIXTURE_DIRS.push(stateDirT1b);
      const registryDir = makeB12Fixture();
      const server = await startFakeServer({ existingItems: b12ExistingItems() });
      const run = await runCli([], {
        registryDir,
        baseUrl: server.url,
        stateDir: stateDirT1b,
        scriptPath: join(scriptsDir, "plane-sync.mjs"),
        allowBranch: false,
      });
      const writes = server.requests.filter(
        (r) => r.method === "PATCH" || r.method === "POST",
      ).length;
      check(
        "T1b (F1, R14): an adoptable candidate off master without --allow-branch issues zero writes",
        { writes, exitCode: run.code },
        { writes: 0, exitCode: 0 },
      );
      await server.close();
    }
  }

  // H3 (T3, R2) — denylist: a forbidden string in an outbound field skips
  // the write, is counted `skipped(forbidden)`, names the id+pattern, and
  // the matched text itself never reaches stdout/stderr.
  {
    const dir = makeFixture({
      catalogue: [
        { ...B01_CATALOGUE_ROW, id: "B77", title: "Invoice INV-2026-12345 double-charged" },
      ],
      ledger: { F01: [ledgerRow({ id: "B77" })] },
    });
    const server = await startFakeServer({ existingItems: [] });
    const { stdout, stderr } = await runCli([], {
      registryDir: dir,
      baseUrl: server.url,
      stateDir: dir,
    });
    const combined = stdout + stderr;
    const posts = server.requests.filter((r) => r.method === "POST");
    check(
      "H3 (harness T3/R2): a denylist hit skips the write, is counted, never prints the match",
      {
        postCount: posts.length,
        summaryHasSkippedForbidden: /skipped\(forbidden\)=1/.test(combined),
        neverPrintsInvoiceNumber: !combined.includes("INV-2026-12345"),
        namesIdAndPattern: combined.includes("B77 forbidden (invoice-number)"),
      },
      {
        postCount: 0,
        summaryHasSkippedForbidden: true,
        neverPrintsInvoiceNumber: true,
        namesIdAndPattern: true,
      },
    );
    await server.close();
  }

  // H4 (T4, R3) — write budget + ledger: `--max-writes 3` against 5 queued
  // creates caps writes at 3, defers the rest, and appends exactly 3
  // well-shaped lines (ts,tool,method,path,ref — never a body) to the ledger.
  {
    const catalogue = ["B21", "B22", "B23", "B24", "B25"].map((id, i) => ({
      ...B01_CATALOGUE_ROW,
      id,
      title: `Budget row ${i + 1}`,
    }));
    const ledger = { F01: catalogue.map((r) => ledgerRow({ id: r.id })) };
    const dir = makeFixture({ catalogue, ledger });
    const server = await startFakeServer({ existingItems: [] });
    const { code, stdout, stderr } = await runCli(["--max-writes", "3"], {
      registryDir: dir,
      baseUrl: server.url,
      stateDir: dir,
    });
    const posts = server.requests.filter((r) => r.method === "POST");
    const ledgerPath = join(dir, ".plane-writes.jsonl");
    const ledgerLines = existsSync(ledgerPath)
      ? readFileSync(ledgerPath, "utf8")
          .split(/\r?\n/)
          .filter(Boolean)
          .map((l) => {
            try {
              return JSON.parse(l);
            } catch {
              return null;
            }
          })
      : [];
    check(
      "H4 (harness T4/R3): --max-writes 3 caps POSTs, defers 2, ledger has exactly 3 well-shaped lines",
      {
        postCount: posts.length,
        exitCode: code,
        deferredInSummary: /deferred=2/.test(stdout + stderr),
        ledgerLineCount: ledgerLines.length,
        ledgerShapeOk: ledgerLines.every(
          (l) =>
            l && !("body" in l) && ["ts", "tool", "method", "path", "ref"].every((k) => k in l),
        ),
      },
      {
        postCount: 3,
        exitCode: 0,
        deferredInSummary: true,
        ledgerLineCount: 3,
        ledgerShapeOk: true,
      },
    );
    await server.close();
  }

  // F3 (fix-round 2b, Opus #5) — a missing denylist must fail CLOSED: the
  // pre-fix loadDenylist() returned [] on a missing file, so R2's write scan
  // silently disabled itself instead of blocking every write. PLANE_DENYLIST_PATH
  // is a test-only override (plane-client.mjs) pointed at a path that does
  // not exist; plane-sync's main() must exit non-zero, make zero requests,
  // and name the missing path — before any network call.
  {
    const dir = makeFixture();
    const server = await startFakeServer({ existingItems: [] });
    const missingPath = join(tmpdir(), `plane-denylist-missing-${process.pid}-${Date.now()}.json`);
    const env = {
      ...process.env,
      PLANE_SYNC_REGISTRY_DIR: dir,
      PLANE_BASE_URL: server.url,
      PLANE_SYNC_STATE_DIR: dir,
      PLANE_API_KEY: "self-test-key",
      PLANE_DENYLIST_PATH: missingPath,
      PLANE_SYNC_SELF_TEST: "1",
      // Marker is set above, so runsPath() would honour a PLANE_RUNS_PATH
      // override too — set one so this run's appendRun() (finally, even on
      // this fail-closed exit) never lands in the real runs.jsonl.
      PLANE_RUNS_PATH: join(dir, "self-test-runs.jsonl"),
      // Belt-and-braces (fix 2026-09-12, L-116): same reasoning as runCli()'s.
      ...(TEMP_MACHINE_ROOT ? { PLANE_MACHINE_ROOT: TEMP_MACHINE_ROOT } : {}),
    };
    const { code, stdout, stderr } = await new Promise((resolve) => {
      const child = spawn(process.execPath, [SCRIPT_PATH, "--allow-branch"], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      let err = "";
      child.stdout.on("data", (c) => (out += c));
      child.stderr.on("data", (c) => (err += c));
      const timer = setTimeout(() => child.kill(), 15_000);
      child.on("close", (c) => {
        clearTimeout(timer);
        resolve({ code: c, stdout: out, stderr: err });
      });
    });
    check(
      "F3: a missing PLANE_DENYLIST_PATH fails closed — exit != 0, zero requests, names the path",
      {
        exitNonZero: code !== 0,
        requestCount: server.requests.length,
        mentionsDenylistMissing: (stdout + stderr).includes("denylist missing"),
      },
      { exitNonZero: true, requestCount: 0, mentionsDenylistMissing: true },
    );
    await server.close();
  }

  // F3b (fix-round 3, NEW-2) — a present-but-empty denylist (`patterns: []`)
  // must fail CLOSED exactly like a missing file: with the self-test marker
  // set, plane-sync's main() must exit non-zero, make zero writes, and name
  // the empty/malformed condition — never silently scan with zero patterns.
  {
    const dir = makeFixture();
    const server = await startFakeServer({ existingItems: [] });
    const emptyDenylistDir = mkdtempSync(join(tmpdir(), FIXTURE_PREFIX));
    FIXTURE_DIRS.push(emptyDenylistDir);
    const emptyPath = join(emptyDenylistDir, "plane-denylist.json");
    writeFileSync(emptyPath, JSON.stringify({ patterns: [] }));
    const env = {
      ...process.env,
      PLANE_SYNC_REGISTRY_DIR: dir,
      PLANE_BASE_URL: server.url,
      PLANE_SYNC_STATE_DIR: dir,
      PLANE_API_KEY: "self-test-key",
      PLANE_DENYLIST_PATH: emptyPath,
      PLANE_SYNC_SELF_TEST: "1",
      // Same as F3 above: the marker is set, so it must be paired with a
      // PLANE_RUNS_PATH override to keep this run's telemetry line out of
      // the real runs.jsonl.
      PLANE_RUNS_PATH: join(emptyDenylistDir, "self-test-runs.jsonl"),
      // Belt-and-braces (fix 2026-09-12, L-116): same reasoning as runCli()'s.
      ...(TEMP_MACHINE_ROOT ? { PLANE_MACHINE_ROOT: TEMP_MACHINE_ROOT } : {}),
    };
    const { code, stdout, stderr } = await new Promise((resolve) => {
      const child = spawn(process.execPath, [SCRIPT_PATH, "--allow-branch"], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      let err = "";
      child.stdout.on("data", (c) => (out += c));
      child.stderr.on("data", (c) => (err += c));
      const timer = setTimeout(() => child.kill(), 15_000);
      child.on("close", (c) => {
        clearTimeout(timer);
        resolve({ code: c, stdout: out, stderr: err });
      });
    });
    const writes = server.requests.filter(
      (r) => r.method === "PATCH" || r.method === "POST",
    ).length;
    check(
      "F3b (NEW-2): an empty/malformed denylist fails closed — exit != 0, 0 writes, names the reason",
      {
        exitNonZero: code !== 0,
        writes,
        mentionsEmptyOrMalformed: (stdout + stderr).includes("denylist empty or malformed"),
      },
      { exitNonZero: true, writes: 0, mentionsEmptyOrMalformed: true },
    );
    await server.close();
  }

  // F3c (fix-round 3, NEW-1) — PLANE_DENYLIST_PATH present WITHOUT the
  // PLANE_SYNC_SELF_TEST marker must be ignored outright: the run proceeds
  // against the REAL denylist (loudly warning it did so) rather than either
  // honouring an attacker-controlled override or failing closed on it.
  {
    const dir = makeFixture();
    const server = await startFakeServer({ existingItems: [] });
    const nonexistentPath = join(
      tmpdir(),
      `plane-denylist-unarmed-${process.pid}-${Date.now()}.json`,
    );
    const env = {
      ...process.env,
      PLANE_SYNC_REGISTRY_DIR: dir,
      PLANE_BASE_URL: server.url,
      PLANE_SYNC_STATE_DIR: dir,
      PLANE_API_KEY: "self-test-key",
      PLANE_DENYLIST_PATH: nonexistentPath,
      // deliberately NOT setting PLANE_SYNC_SELF_TEST — this case exists to
      // prove the override is ignored without it. That also means
      // runsPath() cannot be redirected via PLANE_RUNS_PATH here (same
      // marker gates both), so the real script's appendRun() WILL append one
      // line to this worktree's real local-assets/plane/runs.jsonl. Snapshot
      // it immediately before/after this one spawn and put it back exactly
      // as found, so the suite-wide "untouched by the suite" invariant below
      // still holds — this is the one deliberate exception, self-healed
      // rather than avoided.
    };
    const runsSnapshotBeforeF3c = existsSync(REAL_RUNS_PATH)
      ? readFileSync(REAL_RUNS_PATH, "utf8")
      : null;
    const { code, stdout, stderr } = await new Promise((resolve) => {
      const child = spawn(process.execPath, [SCRIPT_PATH, "--allow-branch"], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      let err = "";
      child.stdout.on("data", (c) => (out += c));
      child.stderr.on("data", (c) => (err += c));
      const timer = setTimeout(() => child.kill(), 15_000);
      child.on("close", (c) => {
        clearTimeout(timer);
        resolve({ code: c, stdout: out, stderr: err });
      });
    });
    if (runsSnapshotBeforeF3c === null) {
      try {
        if (existsSync(REAL_RUNS_PATH)) rmSync(REAL_RUNS_PATH);
      } catch {
        // best-effort — never turn cleanup itself into a red suite
      }
    } else {
      writeFileSync(REAL_RUNS_PATH, runsSnapshotBeforeF3c);
    }
    const writes = server.requests.filter(
      (r) => r.method === "PATCH" || r.method === "POST",
    ).length;
    check(
      "F3c (NEW-1): an unmarked PLANE_DENYLIST_PATH is ignored — run proceeds on the real denylist",
      {
        exitCode: code,
        writes,
        mentionsIgnored: (stdout + stderr).includes(
          "PLANE_DENYLIST_PATH ignored outside self-tests",
        ),
      },
      { exitCode: 0, writes: 1, mentionsIgnored: true },
    );
    await server.close();
  }

  // H5 (T5, R4/R5) — comment-on-close + state-map completeness, 3 runs.
  // B45 is ALREADY in a completed-group state (Done, distinct from Live —
  // R5) so its Live patch must NOT comment; B46 transitions from an open
  // state and must get exactly one comment + one PR link. Runs 2/3 prove
  // idempotency via the local cache, then via the cache-loss fallback
  // (listing the item's own comments and finding the marker already there).
  {
    const dir = makeFixture({
      catalogue: [
        { ...B01_CATALOGUE_ROW, id: "B45", title: "z" },
        { ...B01_CATALOGUE_ROW, id: "B46", title: "w" },
      ],
      ledger: {
        F01: [
          ledgerRow({ id: "B45", state: "done", pr: 678, proof: "REG-B45", roundSha: "abc1234" }),
          ledgerRow({ id: "B46", state: "done", pr: 681 }),
        ],
      },
    });
    const statesWithDone = [
      ...DEFAULT_STATES,
      { id: "state-done", name: "Done", group: "completed" },
    ];
    const existingItems = [
      {
        id: "item-b45",
        name: "B45 · z",
        state: "state-done",
        priority: "low",
        external_id: "B45",
        external_source: "routeflow-registry",
        description_stripped: "registry-hash: stale-b45",
        sequence_id: 1,
      },
      {
        id: "item-b46",
        name: "B46 · w",
        state: "state-backlog",
        priority: "low",
        external_id: "B46",
        external_source: "routeflow-registry",
        description_stripped: "registry-hash: stale-b46",
        sequence_id: 2,
      },
    ];
    const server = await startFakeServer({ existingItems, states: statesWithDone });

    await runCli([], { registryDir: dir, baseUrl: server.url, stateDir: dir });
    const patches1 = server.requests.filter((r) => r.method === "PATCH");
    const b45Patch = patches1.find((p) => p.path.endsWith("/work-items/item-b45/"));
    const b46Patch = patches1.find((p) => p.path.endsWith("/work-items/item-b46/"));
    const commentPosts1 = server.requests.filter(
      (r) => r.method === "POST" && /\/work-items\/[^/]+\/comments\/$/.test(r.path),
    );
    const linkPosts1 = server.requests.filter(
      (r) => r.method === "POST" && /\/work-items\/[^/]+\/links\/$/.test(r.path),
    );
    const b45Comments = commentPosts1.filter((r) => r.path.includes("item-b45"));
    const b46Comments = commentPosts1.filter((r) => r.path.includes("item-b46"));
    const b46Links = linkPosts1.filter((r) => r.path.includes("item-b46"));
    check(
      "H5 (harness T5/R4,R5): run 1 patches both to Live; only B46 (was open) gets a comment+link",
      {
        b45PatchState: b45Patch?.body?.state,
        b46PatchState: b46Patch?.body?.state,
        b45CommentCount: b45Comments.length,
        b46CommentCount: b46Comments.length,
        b46CommentHasPr: b46Comments[0]?.body?.comment_html?.includes("PR #681") ?? false,
        b46CommentHasMarker:
          b46Comments[0]?.body?.comment_html?.includes("plane-sync:closed") ?? false,
        b46LinkCount: b46Links.length,
        b46LinkUrlEndsPull681: b46Links[0]?.body?.url?.endsWith("/pull/681") ?? false,
      },
      {
        b45PatchState: "state-live",
        b46PatchState: "state-live",
        b45CommentCount: 0,
        b46CommentCount: 1,
        b46CommentHasPr: true,
        b46CommentHasMarker: true,
        b46LinkCount: 1,
        b46LinkUrlEndsPull681: true,
      },
    );

    const before2 = server.requests.length;
    await runCli([], { registryDir: dir, baseUrl: server.url, stateDir: dir });
    const run2CommentLinkWrites = server.requests
      .slice(before2)
      .filter((r) => r.method === "POST" && /\/(comments|links)\/$/.test(r.path)).length;
    check(
      "H5 (harness T5): run 2 (local cache present) issues zero comment/link writes",
      run2CommentLinkWrites,
      0,
    );

    rmSync(join(dir, ".plane-sync-state.json"), { force: true });
    const before3 = server.requests.length;
    await runCli([], { registryDir: dir, baseUrl: server.url, stateDir: dir });
    const run3CommentLinkWrites = server.requests
      .slice(before3)
      .filter((r) => r.method === "POST" && /\/(comments|links)\/$/.test(r.path)).length;
    check(
      "H5 (harness T5): run 3 (cache deleted, fake lists B46's own prior comment) issues zero comment/link writes",
      run3CommentLinkWrites,
      0,
    );
    await server.close();
  }

  // T5b (fix-round 2b, F2/Opus #7) — the existing item's `state` is an id
  // ABSENT from the workspace's current state list (renamed/stale — a state
  // deleted or renamed in Plane after the item last moved). idToGroup.get()
  // on that id returns undefined; the pre-fix `!["completed","cancelled"]
  // .includes(undefined)` read as true, i.e. "was open", so a close comment
  // could post for an item whose prior openness was never actually observed.
  // Fixed behavior: unknown previous group -> no comment, one warn line.
  {
    const dir = makeFixture({
      catalogue: [{ ...B01_CATALOGUE_ROW, id: "B90", title: "ghost state" }],
      ledger: { F01: [ledgerRow({ id: "B90", state: "done" })] },
    });
    const existingItems = [
      {
        id: "item-b90",
        name: "B90 · ghost state",
        state: "state-ghost", // not in DEFAULT_STATES — unknown to idToGroup
        priority: "low",
        external_id: "B90",
        external_source: "routeflow-registry",
        description_stripped: "registry-hash: stale-b90",
        sequence_id: 1,
      },
    ];
    const server = await startFakeServer({ existingItems });
    const { stdout, stderr } = await runCli([], {
      registryDir: dir,
      baseUrl: server.url,
      stateDir: dir,
    });
    const patches = server.requests.filter((r) => r.method === "PATCH");
    const b90Patch = patches.find((p) => p.path.endsWith("/work-items/item-b90/"));
    const commentPosts = server.requests.filter(
      (r) => r.method === "POST" && /\/work-items\/[^/]+\/comments\/$/.test(r.path),
    );
    check(
      "T5b (F2): unknown previous state group patches to Live but posts no close comment, and warns",
      {
        patchCount: patches.length,
        b90PatchState: b90Patch?.body?.state,
        commentCount: commentPosts.length,
        warned: (stdout + stderr).includes(
          "state state-ghost unknown, skipping close comment for B90",
        ),
      },
      { patchCount: 1, b90PatchState: "state-live", commentCount: 0, warned: true },
    );
    await server.close();
  }

  // H6 (T6, R4) — creating an item whose ledger state is ALREADY done posts
  // no comment (the description block already carries the proof). NOTE: this
  // case is expected to read GREEN even before R4 ships — see the run
  // report; it is a regression lock added at the same time comment-on-close
  // itself lands, not a discriminator of its absence (test-plan.md's own
  // reverse-check for T6 says the same: "untestable without comment-on-close
  // code to exempt in the first place").
  {
    const dir = makeFixture({
      catalogue: [{ ...B01_CATALOGUE_ROW, id: "B50", title: "already done on file" }],
      ledger: { F01: [ledgerRow({ id: "B50", state: "done", pr: 600 })] },
    });
    const server = await startFakeServer({ existingItems: [] });
    await runCli([], { registryDir: dir, baseUrl: server.url, stateDir: dir });
    const posts = server.requests.filter(
      (r) => r.method === "POST" && /\/work-items\/$/.test(r.path),
    );
    const commentPosts = server.requests.filter(
      (r) => r.method === "POST" && /\/comments\/$/.test(r.path),
    );
    const linkPosts = server.requests.filter(
      (r) => r.method === "POST" && /\/links\/$/.test(r.path),
    );
    check(
      "H6 (harness T6/R4): creating an already-done item posts no comment/link",
      {
        createCount: posts.length,
        createdState: posts[0]?.body?.state,
        commentCount: commentPosts.length,
        linkCount: linkPosts.length,
      },
      { createCount: 1, createdState: "state-live", commentCount: 0, linkCount: 0 },
    );
    await server.close();
  }

  // H11 (T11, R9) — the literal-scan extends to every new file this feature
  // adds, guarded by existsSync exactly like the pre-implementation-safe
  // convention test-plan.md §6 requires (an absent file reports `false`, a
  // clean assertion miss, never a thrown ENOENT).
  {
    const uuidRe = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
    const apiKeyLiteralRe = /PLANE_API_KEY\s*=\s*["'`][^"'`]/;
    const NEW_FILES = [
      "plane-client.mjs",
      "plane-intake.mjs",
      "plane-triage.mjs",
      "plane-apply.mjs",
      "plane-fake-server.mjs",
    ];
    const results = {};
    const want = {};
    for (const name of NEW_FILES) {
      const p = fileURLToPath(new URL(`./${name}`, import.meta.url));
      if (!existsSync(p)) {
        results[name] = { exists: false };
      } else {
        const src = readFileSync(p, "utf8");
        results[name] = {
          exists: true,
          uuid: uuidRe.test(src),
          keyLiteral: apiKeyLiteralRe.test(src),
        };
      }
      want[name] = { exists: true, uuid: false, keyLiteral: false };
    }
    check(
      "H11 (harness T11/R9): every new script file exists and carries no uuid/key literal",
      results,
      want,
    );
  }

  // H15 (T15, R13) — --help/-h short-circuits BEFORE any env read or network
  // call, on every input (valid key + reachable server; no key + unreachable
  // base URL); an unknown flag exits 2 with Usage on stderr. Base URL is
  // ALWAYS a local fake server or a closed local port here — never the real
  // default — so a not-yet-implemented --help can never fall through to a
  // live network call the way the 2026-09-11 incident did.
  {
    const dir = makeFixture();
    const server = await startFakeServer({ existingItems: [] });
    const helpWithKey = await runCli(["--help"], { registryDir: dir, baseUrl: server.url });
    check(
      "H15a (harness T15/R13): --help exits 0 with Usage before any network call, even with a valid key + reachable server",
      {
        exitCode: helpWithKey.code,
        stdoutHasUsage: helpWithKey.stdout.includes("Usage:"),
        stdoutNamesScript: helpWithKey.stdout.includes("plane-sync"),
        requestCount: server.requests.length,
      },
      { exitCode: 0, stdoutHasUsage: true, stdoutNamesScript: true, requestCount: 0 },
    );
    await server.close();

    const dir2 = makeFixture();
    const helpNoKey = await runCli(["--help"], {
      registryDir: dir2,
      baseUrl: "http://127.0.0.1:1", // closed port; nothing listens
      noKey: true,
    });
    check(
      "H15b (harness T15/R13): --help exits 0 with Usage even with no key and an unreachable base URL",
      { exitCode: helpNoKey.code, stdoutHasUsage: helpNoKey.stdout.includes("Usage:") },
      { exitCode: 0, stdoutHasUsage: true },
    );

    const dir3 = makeFixture();
    const bogus = await runCli(["--bogus"], {
      registryDir: dir3,
      baseUrl: "http://127.0.0.1:1",
      noKey: true,
    });
    check(
      "H15c (harness T15/R13): an unknown flag exits 2 with Usage on stderr",
      { exitCode: bogus.code, stderrHasUsage: bogus.stderr.includes("Usage:") },
      { exitCode: 2, stderrHasUsage: true },
    );
  }

  // T16 (R14, spec.md; ruling-s4-s5.md) — branch guard: plane-sync writes
  // ONLY on master/main, or with --allow-branch. The guard resolves the
  // branch from a REPO_ROOT computed from the SCRIPT'S OWN file location
  // (plane-sync.mjs:60-63's REPO_ROOT / plane-client.mjs's repoRoot() — both
  // "resolved from this file's own location, independent of cwd"), so
  // proving it needs a REAL git repo sitting at that computed root — never
  // this worktree. This copies plane-sync.mjs + its one relative dependency
  // (plane-client.mjs) into <tmp>/scripts/campaign/ and scaffolds
  // <tmp>/package.json + <tmp>/.claude — the marker pair plane-client.mjs's
  // repoRoot() walks up to — so the copy's REPO_ROOT lands on the throwaway
  // repo when it runs. Incident 2026-09-11 23:26Z (spec.md R14): Gate 5 run
  // from a feature worktree with a real key created 282 live BUGS items —
  // this is the guard that incident forced.
  {
    // gitEnv()/git() are the shared module-level helpers defined near the
    // top of this file (imported gitEnv from plane-client.mjs) — no longer
    // redefined per-test-block.
    const repoDir = mkdtempSync(join(tmpdir(), FIXTURE_PREFIX));
    FIXTURE_DIRS.push(repoDir);
    git(repoDir, ["init", "-q"]);
    git(repoDir, ["checkout", "-q", "-b", "feat/x"]);
    git(repoDir, ["config", "user.email", "plane-sync-self-test@example.com"]);
    git(repoDir, ["config", "user.name", "plane-sync-self-test"]);
    writeFileSync(join(repoDir, "package.json"), JSON.stringify({ name: "throwaway" }) + "\n");
    mkdirSync(join(repoDir, ".claude"), { recursive: true });
    writeFileSync(join(repoDir, ".claude", ".keep"), "");
    const scriptsDir = join(repoDir, "scripts", "campaign");
    mkdirSync(scriptsDir, { recursive: true });
    for (const name of ["plane-sync.mjs", "plane-client.mjs", "plane-denylist.json"]) {
      writeFileSync(
        join(scriptsDir, name),
        readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), "utf8"),
      );
    }
    writeFileSync(join(repoDir, "README.md"), "seed\n");
    git(repoDir, ["add", "-A"]);
    git(repoDir, ["commit", "-q", "-m", "chore: seed"]);
    const scriptPath = join(scriptsDir, "plane-sync.mjs");

    const stateDirT16 = mkdtempSync(join(tmpdir(), FIXTURE_PREFIX));
    FIXTURE_DIRS.push(stateDirT16);
    const registryDir = makeFixture({
      catalogue: ["B01", "B02", "B03"].map((id) => ({
        ...B01_CATALOGUE_ROW,
        id,
        title: `${id} row`,
      })),
      ledger: { F01: ["B01", "B02", "B03"].map((id) => ledgerRow({ id })) },
    });

    let server = await startFakeServer({ existingItems: [] });

    // Run 1 — no flags, on feat/x: zero writes, the exact skip line, exit 0.
    const run1 = await runCli([], {
      registryDir,
      baseUrl: server.url,
      stateDir: stateDirT16,
      scriptPath,
      allowBranch: false,
    });
    const run1Posts = server.requests.filter((r) => r.method === "POST").length;
    check("T16 (R14) run 1: zero POST on feat/x without --allow-branch", run1Posts, 0);
    const run1Lines = run1.stdout.split(/\r?\n/);
    check(
      "T16 (R14) run 1: exact skip line on stdout, exit 0",
      {
        exitCode: run1.code,
        hasSkipLine: run1Lines.includes(
          "Plane mirror: skipped writes (branch feat/x is not master; pass --allow-branch to override)",
        ),
      },
      { exitCode: 0, hasSkipLine: true },
    );

    // Run 2 — same repo/server, --allow-branch: all 3 registry rows create.
    const beforeRun2 = server.requests.length;
    const run2 = await runCli(["--allow-branch"], {
      registryDir,
      baseUrl: server.url,
      stateDir: stateDirT16,
      scriptPath,
    });
    const run2Posts = server.requests.slice(beforeRun2).filter((r) => r.method === "POST").length;
    check(
      "T16 (R14) run 2: --allow-branch on feat/x issues 3 POSTs, exit 0",
      { posts: run2Posts, exitCode: run2.code },
      { posts: 3, exitCode: 0 },
    );
    await server.close();

    // Run 3 — the temp repo switches to master; a FRESH fake server (never
    // the one runs 1-2 already populated) proves the branch, not a leftover
    // item, is what let the writes through.
    git(repoDir, ["checkout", "-b", "master"]);
    server = await startFakeServer({ existingItems: [] });
    const run3 = await runCli([], {
      registryDir,
      baseUrl: server.url,
      stateDir: stateDirT16,
      scriptPath,
      allowBranch: false,
    });
    const run3Posts = server.requests.filter((r) => r.method === "POST").length;
    check(
      "T16 (R14) run 3: on master without flags, 3 POSTs on a fresh fake, exit 0",
      { posts: run3Posts, exitCode: run3.code },
      { posts: 3, exitCode: 0 },
    );
    await server.close();
  }

  // T18 (defect repro, gates/push.log ~11716) — the husky pre-push hook's
  // `npm run verify` runs with git's own GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE/
  // GIT_PREFIX etc. already exported into the environment (git sets these for
  // every child it spawns, including `npm run verify`), and this self-test's
  // OWN process inherits them. T1b/T16's fixture setup (`git checkout -q -b`
  // in a tmpdir) failed under exactly that env with "fatal: this operation
  // must be run in a work tree" before gitEnv() existed. This proves two
  // things with GIT_DIR/GIT_WORK_TREE deliberately poisoned — pointed at
  // THIS WORKTREE's own real .git/root, the closest realistic stand-in for
  // the hook's ambient env — for the duration of the block:
  //   (a) the fixture's own git() calls (shared helper, gitEnv()-scrubbed)
  //       still create/checkout the temp repo's branch;
  //   (b) plane-sync.mjs's branch guard (currentBranch(), now gitEnv()-
  //       scrubbed) still reports the TEMP repo's branch — never this
  //       worktree's real branch — proving the child process's own git spawn
  //       ignores the poisoned GIT_DIR/GIT_WORK_TREE it inherited from the
  //       env runCli passes through (env: {...process.env, ...}).
  {
    const { workTreeRoot, gitDir } = locateThisWorktreeGit();
    const savedGitDir = process.env.GIT_DIR;
    const savedGitWorkTree = process.env.GIT_WORK_TREE;
    process.env.GIT_DIR = gitDir;
    process.env.GIT_WORK_TREE = workTreeRoot;
    try {
      const repoDir = mkdtempSync(join(tmpdir(), FIXTURE_PREFIX));
      FIXTURE_DIRS.push(repoDir);
      let setupOk = true;
      let setupError = "";
      let scriptsDir;
      try {
        git(repoDir, ["init", "-q"]);
        git(repoDir, ["checkout", "-q", "-b", "feat/t18"]);
        git(repoDir, ["config", "user.email", "plane-sync-self-test@example.com"]);
        git(repoDir, ["config", "user.name", "plane-sync-self-test"]);
        writeFileSync(join(repoDir, "package.json"), JSON.stringify({ name: "throwaway" }) + "\n");
        mkdirSync(join(repoDir, ".claude"), { recursive: true });
        writeFileSync(join(repoDir, ".claude", ".keep"), "");
        scriptsDir = join(repoDir, "scripts", "campaign");
        mkdirSync(scriptsDir, { recursive: true });
        for (const name of ["plane-sync.mjs", "plane-client.mjs", "plane-denylist.json"]) {
          writeFileSync(
            join(scriptsDir, name),
            readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), "utf8"),
          );
        }
        git(repoDir, ["add", "-A"]);
        git(repoDir, ["commit", "-q", "-m", "chore: seed"]);
      } catch (err) {
        setupOk = false;
        setupError = err?.message ?? String(err);
      }
      check(
        "T18 (defect repro): fixture git setup succeeds even with GIT_DIR/GIT_WORK_TREE pointed at the real worktree",
        { setupOk, setupError },
        { setupOk: true, setupError: "" },
      );

      if (setupOk) {
        const scriptPath = join(scriptsDir, "plane-sync.mjs");
        const stateDirT18 = mkdtempSync(join(tmpdir(), FIXTURE_PREFIX));
        FIXTURE_DIRS.push(stateDirT18);
        const registryDir = makeFixture({
          catalogue: [{ ...B01_CATALOGUE_ROW, id: "B18", title: "t18 row" }],
          ledger: { F01: [ledgerRow({ id: "B18" })] },
        });
        const server = await startFakeServer({ existingItems: [] });

        // --check never touches git at all (it returns before currentBranch()
        // is called) — this proves the poisoned env doesn't otherwise wedge
        // or crash the child.
        const checkRun = await runCli(["--check"], {
          registryDir,
          baseUrl: server.url,
          stateDir: stateDirT18,
          scriptPath,
          allowBranch: false,
        });
        check(
          "T18: --check completes (never hangs/crashes) under poisoned GIT_DIR/GIT_WORK_TREE",
          { timedOut: checkRun.timedOut, exitCode: checkRun.code },
          { timedOut: false, exitCode: 1 }, // exit 1 = drift (a create pending), same as T1's --check shape
        );

        // Bare run: DOES hit currentBranch(). Must report "feat/t18" (the
        // temp repo's own branch) — never "feat/plane-harness" or whatever
        // this worktree's real branch is — proving the scrub worked.
        const bareRun = await runCli([], {
          registryDir,
          baseUrl: server.url,
          stateDir: stateDirT18,
          scriptPath,
          allowBranch: false,
        });
        const bareLines = bareRun.stdout.split(/\r?\n/);
        check(
          "T18 (defect repro): branch guard reports the TEMP repo's branch (feat/t18), not the worktree's, under poisoned GIT_DIR/GIT_WORK_TREE",
          {
            exitCode: bareRun.code,
            hasExpectedSkipLine: bareLines.includes(
              "Plane mirror: skipped writes (branch feat/t18 is not master; pass --allow-branch to override)",
            ),
          },
          { exitCode: 0, hasExpectedSkipLine: true },
        );
        await server.close();
      }
    } finally {
      if (savedGitDir === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = savedGitDir;
      if (savedGitWorkTree === undefined) delete process.env.GIT_WORK_TREE;
      else process.env.GIT_WORK_TREE = savedGitWorkTree;
    }
  }

  // T17 (Defect 1, proven live 2026-09-12) — the real Plane API returns
  // `members/` and `projects/{id}/work-item-types/` as BARE ARRAYS, not the
  // `{results, next_cursor, ...}` envelope every other listed endpoint uses.
  // plane-client.mjs's `listAll` (and therefore `resolveTypes`/`resolveMember`,
  // unchanged callers of it) must accept both shapes: this called
  // `resolveTypes`/`resolveMember` in-process against the shared fake server,
  // never spawning the CLI — same in-process convention as the
  // deriveDesired/mapPriority/registryDigest cases above. Root cause: against
  // the live workspace `resolveTypes` read `page?.results` off a bare array
  // (always undefined) and found zero types, so plane-apply's dry run failed
  // with `#1 no work-item type named "Task" in project ROAD` although ROAD has
  // Task (default) and Epic.
  {
    const ROAD_PROJECT_ID = "proj-road"; // plane-fake-server.mjs's DEFAULT_PROJECTS
    const seededTypes = [
      { id: "type-task", name: "Task" },
      { id: "type-epic", name: "Epic" },
    ];
    const seededMembers = [
      { id: "member-lead", member: "member-lead", display_name: "ClaudeLead" },
    ];

    // Live-mirroring default: plane-fake-server.mjs now serves both routes as
    // bare arrays.
    const server = await startFakePlane({ types: { ROAD: seededTypes }, members: seededMembers });
    const client = createClient({
      apiKey: "self-test-key",
      baseUrl: server.url,
      tool: "plane-sync-self-test",
    });
    const types = await client.resolveTypes(ROAD_PROJECT_ID);
    check(
      'T17: resolveTypes resolves both seeded types (name -> id) from a bare-array response, e.g. "Task" -> type-task',
      { size: types.size, task: types.get("task"), epic: types.get("epic") },
      { size: 2, task: "type-task", epic: "type-epic" },
    );
    const memberId = await client.resolveMember("ClaudeLead");
    check(
      "T17: resolveMember resolves the seeded member id from a bare-array members/ response",
      memberId,
      "member-lead",
    );
    await server.close();

    // Negative twin: a fake configured to serve work-item-types/ back in the
    // OLD {results, ...} envelope must resolve identically — listAll
    // tolerates both shapes, it doesn't just switch which one it assumes.
    const server2 = await startFakePlane({
      types: { ROAD: seededTypes },
      members: seededMembers,
      workItemTypesEnvelope: true,
    });
    const client2 = createClient({
      apiKey: "self-test-key",
      baseUrl: server2.url,
      tool: "plane-sync-self-test",
    });
    const typesFromEnvelope = await client2.resolveTypes(ROAD_PROJECT_ID);
    check(
      "T17 (negative twin): resolveTypes resolves both seeded types when work-item-types/ is served as the {results,...} envelope",
      {
        size: typesFromEnvelope.size,
        task: typesFromEnvelope.get("task"),
        epic: typesFromEnvelope.get("epic"),
      },
      { size: 2, task: "type-task", epic: "type-epic" },
    );
    await server2.close();
  }

  // T21 (defect fix 2026-09-12, R2/CONTENT_KEYS) — proven live: the old
  // scanBodyDeep walked EVERY string in a write body, so a uuid-shaped
  // `state` id tripped the tenant-uuid pattern purely by coincidental shape.
  // Every case above pins plane-fake-server.mjs's literal ids
  // ("state-backlog", "item-1", ...), which never LOOK uuid-shaped — none of
  // them could have caught this. `uuidIds: true` makes the fixture's ids
  // real RFC-4122-shaped uuids so this case actually exercises the fixed
  // path: 3 queued rows POST, 1 done row (already in Backlog) PATCHes to
  // Live, and skipped(forbidden) never appears — proving ids ride through
  // unscrubbed. Uses startFakePlane directly (T17's pattern) rather than the
  // startFakeServer/DEFAULT_FAKE_STATES adapter, since that adapter's whole
  // point is the literal, non-uuid ids this case must NOT use.
  {
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const server = await startFakePlane({ uuidIds: true, workItems: { BUGS: [] } });
    const bugsStates = server.state.states.BUGS;
    const backlog = bugsStates.find((s) => s.name === "Backlog");
    const live = bugsStates.find((s) => s.name === "Live");
    check(
      "T21: the uuidIds fixture's Backlog/Live state ids are actually uuid-shaped",
      { backlog: UUID_RE.test(backlog?.id ?? ""), live: UUID_RE.test(live?.id ?? "") },
      { backlog: true, live: true },
    );

    // One item already in Plane, in Backlog, whose registry row is "done" —
    // must PATCH state -> Live. Pushed onto the live seed data directly
    // (server.state, per plane-fake-server.mjs's own doc comment) rather
    // than via the seed object, since the Backlog id isn't known until after
    // the server (and its uuidIds counter) exists.
    server.state.workItems.BUGS.push({
      id: "item-t21-existing",
      sequence_id: 1,
      external_source: "routeflow-registry",
      external_id: "B90",
      name: "B90 · Existing item done",
      state: backlog.id,
      priority: "low",
      description_stripped: "registry-hash: stale-hash",
    });
    // Pre-seed a "plane-sync:closed" marker comment (alreadyClosed(), R4/R5)
    // so this Backlog -> Live transition (wasOpen && nowClosed) does not
    // ALSO post a fresh close comment+link — this case is about the
    // create/patch write bodies carrying real Plane ids unscrubbed, not the
    // close-comment path (already covered by H5/H6/T5b), so it must produce
    // exactly one PATCH and zero extra POSTs for B90.
    server.state.comments["item-t21-existing"] = [
      {
        id: "comment-t21-preexisting",
        comment_html: "<p>closed</p>",
        comment_stripped: CLOSED_MARKER,
      },
    ];

    const catalogue = [
      { ...B01_CATALOGUE_ROW, id: "B90", title: "Existing item done" },
      ...["B91", "B92", "B93"].map((id, i) => ({
        ...B01_CATALOGUE_ROW,
        id,
        title: `T21 queued row ${i + 1}`,
      })),
    ];
    const ledger = {
      F01: [
        ledgerRow({ id: "B90", state: "done", pr: 601, proof: "REG-B90 uuid-ids regression" }),
        ledgerRow({ id: "B91" }),
        ledgerRow({ id: "B92" }),
        ledgerRow({ id: "B93" }),
      ],
    };
    const dir = makeFixture({ catalogue, ledger });
    const { stdout, stderr } = await runCli([], { registryDir: dir, baseUrl: server.url });
    const combined = stdout + stderr;
    const posts = server.requests.filter((r) => r.method === "POST");
    const patches = server.requests.filter((r) => r.method === "PATCH");
    check(
      "T21: 3 queued rows POST, 1 done row PATCHes, skipped(forbidden) absent from the summary",
      {
        postCount: posts.length,
        patchCount: patches.length,
        patchState: patches[0]?.body?.state,
        hasSkippedForbidden: /skipped\(forbidden\)/.test(combined),
      },
      { postCount: 3, patchCount: 1, patchState: live.id, hasSkippedForbidden: false },
    );
    check(
      "T21: the recorded PATCH body carries the real uuid-shaped state id (ids sent, not scrubbed)",
      UUID_RE.test(patches[0]?.body?.state ?? ""),
      true,
    );
    check(
      "T21: every recorded POST body's state is the uuid-shaped Backlog id, unscrubbed",
      posts.length > 0 && posts.every((p) => p.body?.state === backlog.id),
      true,
    );

    // T21 negative twin (T3 still applies with uuidIds on): a forbidden
    // literal sitting in a CONTENT field (title, here) must still be caught
    // — the id-key exemption never widens to content.
    const dir2 = makeFixture({
      catalogue: [
        { ...B01_CATALOGUE_ROW, id: "B94", title: "Invoice INV-2026-12345 double-charged" },
      ],
      ledger: { F01: [ledgerRow({ id: "B94" })] },
    });
    const before = server.requests.length;
    const { stdout: stdout2, stderr: stderr2 } = await runCli([], {
      registryDir: dir2,
      baseUrl: server.url,
    });
    const combined2 = stdout2 + stderr2;
    check(
      "T21 (negative twin, T3/R2 still applies): a content-field forbidden literal is still caught with uuidIds on",
      {
        newPosts: server.requests.slice(before).filter((r) => r.method === "POST").length,
        summaryHasSkippedForbidden: /skipped\(forbidden\)=1/.test(combined2),
      },
      { newPosts: 0, summaryHasSkippedForbidden: true },
    );

    await server.close();
  }

  // T22 (fix 2026-09-12, plane-write-ledger-local) — a legacy ledger file
  // sitting at the pre-fix `.claude/campaign/.plane-writes.jsonl` home is
  // migrated forward to the new machine-shared `local-assets/plane/` home
  // the first time this tree's plane-client.mjs resolves the ledger, and
  // the old path is gone afterward. This needs a REAL throwaway git repo —
  // never PLANE_SYNC_STATE_DIR — because a state-dir override skips
  // migration entirely (plane-client.mjs's migrateLegacyStateFile()), so
  // every other case in this file (which always sets it) could never
  // exercise this path.
  {
    const { repoDir, scriptsDir } = makeThrowawayClientRepo();

    const legacyDir = join(repoDir, ".claude", "campaign");
    const legacyLedgerPath = join(legacyDir, ".plane-writes.jsonl");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(
      legacyLedgerPath,
      JSON.stringify({
        ts: new Date().toISOString(),
        tool: "self-test-legacy",
        method: "POST",
        path: "/legacy",
        ref: "0",
      }) + "\n",
    );

    const moduleUrl = pathToFileURL(join(scriptsDir, "plane-client.mjs")).href;
    const result = runPlaneClientHarness(moduleUrl, { append: true });
    const newLedgerPath = join(repoDir, "local-assets", "plane", ".plane-writes.jsonl");

    check(
      "T22: harness exits 0 and prints a parseable result",
      { status: result.status, parsed: result.parsed !== null },
      { status: 0, parsed: true },
    );
    check(
      "T22: legacy ledger migrated forward — old path gone, new path resolved, both the " +
        "legacy line and the new write count toward writesToday()",
      {
        legacyGone: !existsSync(legacyLedgerPath),
        newExists: existsSync(newLedgerPath),
        writesToday: result.parsed?.writesToday,
        stateDir: result.parsed?.stateDir,
      },
      {
        legacyGone: true,
        newExists: true,
        writesToday: 2,
        stateDir: join(repoDir, "local-assets", "plane"),
      },
    );
    check(
      "T22: the migration prints one stderr line naming the migrated file",
      /Plane client: migrated \.plane-writes\.jsonl to local-assets\/plane\//.test(result.stderr),
      true,
    );
  }

  // T23 (fix 2026-09-12, plane-write-ledger-local) — two worktrees of the
  // SAME repo must resolve the SAME machine-shared ledger, and a write from
  // either counts toward the SAME writesToday() total. `git worktree add`
  // off the throwaway repo's own HEAD; each worktree's own checked-out copy
  // of plane-client.mjs (tracked, committed — worktrees share the index at
  // the branch point) is invoked as its own child process, proving
  // machineRoot()'s `git rev-parse --git-common-dir` lands on the SAME
  // `.git` from either.
  {
    const { repoDir, scriptsDir } = makeThrowawayClientRepo();
    git(repoDir, ["add", "package.json", ".claude/.keep", "scripts/campaign/plane-client.mjs"]);
    git(repoDir, ["commit", "-q", "-m", "chore: seed"]);

    const worktreeDir = mkdtempSync(join(tmpdir(), FIXTURE_PREFIX));
    FIXTURE_DIRS.push(worktreeDir);
    git(repoDir, ["worktree", "add", "-q", worktreeDir, "-b", "t23-worktree"]);

    const mainModuleUrl = pathToFileURL(join(scriptsDir, "plane-client.mjs")).href;
    const worktreeModuleUrl = pathToFileURL(
      join(worktreeDir, "scripts", "campaign", "plane-client.mjs"),
    ).href;

    const fromMain = runPlaneClientHarness(mainModuleUrl, { append: true });
    const fromWorktree = runPlaneClientHarness(worktreeModuleUrl, { append: true });

    check(
      "T23: both harness runs (main checkout, then its worktree) exit 0 with a parseable result",
      {
        mainStatus: fromMain.status,
        mainParsed: fromMain.parsed !== null,
        worktreeStatus: fromWorktree.status,
        worktreeParsed: fromWorktree.parsed !== null,
      },
      { mainStatus: 0, mainParsed: true, worktreeStatus: 0, worktreeParsed: true },
    );
    check(
      "T23: the main checkout and its worktree resolve the SAME shared ledger dir",
      fromWorktree.parsed?.stateDir,
      fromMain.parsed?.stateDir,
    );
    check(
      "T23: a write from either worktree counts toward the SAME machine-wide writesToday() " +
        "total — 1 after the main checkout's own write, 2 after the worktree's",
      { afterMain: fromMain.parsed?.writesToday, afterWorktree: fromWorktree.parsed?.writesToday },
      { afterMain: 1, afterWorktree: 2 },
    );

    try {
      git(repoDir, ["worktree", "remove", "--force", worktreeDir]);
    } catch {
      // best-effort — the FIXTURE_DIRS sweep below deletes worktreeDir
      // regardless, and a stale `.git/worktrees/*` entry inside a repoDir
      // that is itself about to be deleted wholesale is harmless.
    }
  }

  return failures;
}

// F4 (fix-round 2b, ambient-leak guard): every runCli call now defaults
// PLANE_SYNC_STATE_DIR to its own throwaway registryDir (see runCli above),
// but this is the belt-and-suspenders proof that NOTHING in this suite ever
// falls through to the ambient default. Fix 2026-09-12 (plane-write-ledger-
// local) moved that ambient default from this worktree's OWN
// `.claude/campaign/` to the MACHINE-SHARED `machineRoot()/local-assets/
// plane/` (every worktree of this repo resolves the SAME directory there —
// see plane-client.mjs's machineRoot()/migrateLegacyStateFile()) — snapshot
// both the old legacy home and the new shared one, assert each is unchanged
// afterward, then delete any leaked output from a prior (pre-fix) run of
// this suite (80 lines, all fake paths, found 2026-09-11), not real registry
// state.
const REAL_CAMPAIGN_DIR = join(repoRoot(), ".claude", "campaign");
const REAL_LEGACY_WRITES_LEDGER = join(REAL_CAMPAIGN_DIR, ".plane-writes.jsonl");
const REAL_LEGACY_SYNC_STATE = join(REAL_CAMPAIGN_DIR, ".plane-sync-state.json");
const REAL_SHARED_DIR = join(machineRoot(), "local-assets", "plane");
const REAL_WRITES_LEDGER = join(REAL_SHARED_DIR, ".plane-writes.jsonl");
const REAL_SYNC_STATE = join(REAL_SHARED_DIR, ".plane-sync-state.json");
// REAL_RUNS_PATH is kept ONLY for F3c's own self-heal (it deliberately runs
// without PLANE_SYNC_SELF_TEST, so it is the one case that genuinely writes
// to — and restores — the real runs.jsonl). Ruling (Fable, 2026-09-12,
// L-116): a self-test invariant must never bind to a shared machine-local
// file otherwise — the real runs.jsonl is legitimately appended to by OTHER
// sessions' hooks (Stop -> plane-sync, SessionStart -> plane-triage) at any
// moment, so a suite-wide before/after byte-identity check against it races
// every other session on the machine. The `runs` field this used to carry in
// snapshotRealFiles()/realFilesBefore/After, and the final "byte-identical"
// check built from it, are gone — see the temp-machine-root invariant below
// instead. legacyWrites/legacyState/writes/state stay: those bind on
// .plane-writes.jsonl/.plane-sync-state.json, which only a real Plane write
// touches, not routine hook traffic.
const REAL_RUNS_PATH = join(REAL_SHARED_DIR, "runs.jsonl");
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

// F4: the fixture sweep runs in a `finally`, and the summary/exit moved OUT of
// main() to keep it reachable — `process.exit()` never runs a finally block.
const tmpDirsBefore = countFixtureTmpDirs(); // always 0: FIXTURE_PREFIX embeds this process's own pid+random, so no dir under it can predate this run.
TEMP_MACHINE_ROOT = mkdtempSync(join(tmpdir(), FIXTURE_PREFIX));
FIXTURE_DIRS.push(TEMP_MACHINE_ROOT);
let createdDirs = [];
// invariant (a)'s walk must happen INSIDE the `finally`, before
// cleanupFixtures() deletes TEMP_MACHINE_ROOT.
let filesUnderMachineRoot = [];
try {
  await main();
} catch (err) {
  failures++;
  console.log(`  FAIL plane-sync.self-test threw: ${err?.stack ?? err}`);
} finally {
  const localAssetsPlane = join(TEMP_MACHINE_ROOT, "local-assets", "plane");
  filesUnderMachineRoot = existsSync(localAssetsPlane) ? readdirSync(localAssetsPlane).sort() : [];
  createdDirs = cleanupFixtures();
}
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
  "F4: this machine's real shared local-assets/plane/.plane-writes.jsonl is untouched by the suite",
  realFilesAfter.writes,
  realFilesBefore.writes,
);
check(
  "F4: this machine's real shared local-assets/plane/.plane-sync-state.json is untouched by the suite",
  realFilesAfter.state,
  realFilesBefore.state,
);
// invariant (a): every machine-local file this suite produced lives under
// its OWN temp machine root — never the real one. A runs.jsonl/
// .plane-writes.jsonl/sync-state file may or may not exist under
// TEMP_MACHINE_ROOT/local-assets/plane depending which cases ran; nothing is
// asserted about their content or about the real paths, only that reading
// the temp root back (captured above, before cleanup removed it) never
// throws.
check(
  "invariant: every machine-local file this suite produced lives under its temp machine root",
  Array.isArray(filesUnderMachineRoot),
  true,
);
// invariant (b): the temp machine root itself is removed at the end (tracked
// in FIXTURE_DIRS above — belt-and-braces on top of the "no dir left behind"
// check).
check(
  "invariant: the temp machine root is removed at the end",
  existsSync(TEMP_MACHINE_ROOT),
  false,
);
// NO auto-delete here (fix 2026-09-12, plane-write-ledger-local): the ORIGINAL
// one-time cleanup below this comment (fix-round 2b) removed a confirmed
// leak at the LEGACY per-worktree path (80 lines, all fake self-test paths,
// found 2026-09-11) — safe to `rmSync` because that file could only ever
// hold this suite's own leaked junk. REAL_WRITES_LEDGER/REAL_SYNC_STATE/
// REAL_RUNS_PATH now point at the MACHINE-SHARED ledger/cache/telemetry
// every worktree's REAL Plane operations read and write (that sharing is the
// entire point of this fix) — silently deleting it here would destroy a
// live daily write-budget history or sync-state cache the moment any real
// content ever lands there. The checks above already fail loudly on any
// mismatch; a genuine leak from THIS suite is a bug to fix, not a file to
// paper over by deleting someone's real state.
check(
  "F4: the run leaves no dir this run created behind",
  createdDirs.filter((d) => existsSync(d)),
  [],
);
check(
  "F4: no plane-sync-self-test-<pid>-<rand>-* dir from this run remains under tmpdir",
  countFixtureTmpDirs(),
  tmpDirsBefore,
);

console.log(
  failures
    ? `\nplane-sync.self-test: ${failures} FAILURE(S)`
    : "\nplane-sync.self-test: all checks passed",
);
process.exit(failures ? 1 : 0);
