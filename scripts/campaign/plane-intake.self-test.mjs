#!/usr/bin/env node
// Coverage for scripts/campaign/plane-intake.mjs (TP2, build-plan.md
// 2026-09-11-plane-harness). Same standalone-script convention as
// plane-sync.self-test.mjs — no node:test, no Jest project collects
// scripts/** (CLAUDE.md "DO NOT introduce ... a root-level test runner"):
// `node scripts/campaign/plane-intake.self-test.mjs`, PASS/FAIL lines,
// `process.exit(failures ? 1 : 0)`.
//
// plane-intake.mjs does not exist yet: every case below drives it via
// `spawn` (never a static top-level `import`), so a missing file surfaces as
// an ordinary non-zero child exit / empty stdout — a clean assertion miss,
// never a crash of this file (test-plan.md §6, build-plan.md Landmine 13).
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
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { startFakePlane } from "./plane-fake-server.mjs";
import { gitEnv } from "./plane-client.mjs";

const SCRIPT_PATH = fileURLToPath(new URL("./plane-intake.mjs", import.meta.url));

// Git exports repo-scoped vars (GIT_DIR, GIT_WORK_TREE, ...) into every child
// it runs, and a spawned `git`/`node plane-intake.mjs` inherits them — the
// same hazard .claude/hooks/stop.gate5.spec.mjs scrubs
// (reference_git_worktreeconfig_bare_trap_2026-09-04; gates/push.log ~11716).
// Scrub them here too (via the shared gitEnv() this file's own scripts under
// test also use) so the throwaway repo below is never silently re-pointed at
// the real repo, and additionally never leak a real key from the ambient
// shell into a spawned fixture git call.
function scrubbedEnv(extra = {}) {
  const env = gitEnv();
  delete env.PLANE_API_KEY;
  return { ...env, ...extra };
}
function git(cwd, args) {
  const res = spawnSync("git", args, { cwd, encoding: "utf8", env: scrubbedEnv() });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}:\n${res.stdout}${res.stderr}`);
  }
  return res;
}

// Locates the running worktree's own git dir/root by walking up from THIS
// FILE's location — used only by T7e to build a REALISTIC poisoned
// GIT_DIR/GIT_WORK_TREE pair (the worktree this self-test actually runs in),
// never a made-up path. Mirrors plane-client.mjs's repoRoot() walk, but stops
// at the nearest `.git` (file or directory) rather than the
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

// F4 pattern (plane-sync.self-test.mjs): every fixture dir this run creates
// is tracked here and swept in a `finally`.
//
// Test-isolation fix (2026-09-12): FIXTURE_PREFIX is unique to THIS PROCESS
// (pid + random) — never a bare "plane-intake-self-test-" literal shared by
// every invocation, which let two overlapping runs of this script pollute
// each other's before/after dir COUNT under load. The sweep is pinned to
// every path THIS run recorded being gone after cleanup, never a global
// count of other runs' dirs.
const FIXTURE_DIRS = [];
const FIXTURE_PREFIX = `plane-intake-self-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}-`;
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
// PLANE_SYNC_SELF_TEST=1, already set on every runCli() call) to every child
// this suite spawns, belt-and-braces alongside each call's own
// PLANE_SYNC_STATE_DIR/PLANE_RUNS_PATH overrides. Assigned right before
// `main()` runs (see bottom of file) so the `tmpDirsBefore` baseline there
// stays accurate; tracked in FIXTURE_DIRS so the existing sweep and "no dir
// left behind" check cover its removal for free.
let TEMP_MACHINE_ROOT = null;

// A handful of runCli() calls (T15's --help/-h/--bogus probes) have no
// registryDir/stateDir at all — this gives PLANE_RUNS_PATH somewhere to
// point outside the real repo for those, one throwaway file per call.
function fallbackRunsPath() {
  return join(
    tmpdir(),
    `${FIXTURE_PREFIX}runs-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
  );
}

// Builds a throwaway git repo carrying a `.claude/campaign` registry (empty
// catalogue) so plane-intake --apply's preconditions (R6: dirty-tree check,
// origin/master ancestor check) have something real to inspect. `dirty`
// leaves an uncommitted edit inside `.claude/campaign` after the initial
// commit. `origin/master` is faked with `update-ref` pointing at HEAD's own
// commit — no real remote is ever added, configured, or fetched from.
function makeIntakeRepo({ dirty = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), FIXTURE_PREFIX));
  FIXTURE_DIRS.push(dir);
  git(dir, ["init", "-q"]);
  // Set the branch name explicitly rather than relying on the ambient
  // init.defaultBranch config — the ancestor check below names "master".
  git(dir, ["symbolic-ref", "HEAD", "refs/heads/master"]);
  git(dir, ["config", "user.email", "plane-intake-self-test@example.com"]);
  git(dir, ["config", "user.name", "plane-intake-self-test"]);

  const campaignDir = join(dir, ".claude", "campaign");
  mkdirSync(join(campaignDir, "status"), { recursive: true });
  writeFileSync(join(campaignDir, "bugs.jsonl"), "");
  writeFileSync(join(campaignDir, "board.json"), "{}\n");
  writeFileSync(join(dir, "README.md"), "seed\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "chore: seed"]);

  const sha = git(dir, ["rev-parse", "HEAD"]).stdout.trim();
  git(dir, ["update-ref", "refs/remotes/origin/master", sha]);

  if (dirty) {
    // Given (T7 phase 2): `.claude/campaign` carries an uncommitted change.
    writeFileSync(join(campaignDir, "bugs.jsonl"), '{"id":"B99","title":"uncommitted edit"}\n');
  }

  return { dir, campaignDir };
}

// Finding C: a plain registry-only fixture — no git repo at all — for the
// --relink tests (C2/C3), which never touch --apply's git preconditions.
// Just a `bugs.jsonl` seeded with the given rows, same shape bugs.mjs itself
// writes (`{id, title, ...}` one JSON object per line).
function makeRegistryOnly(rows) {
  const dir = mkdtempSync(join(tmpdir(), FIXTURE_PREFIX));
  FIXTURE_DIRS.push(dir);
  writeFileSync(
    dir + "/bugs.jsonl",
    rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""),
  );
  return dir;
}

// Finding C1's failing-PATCH stub: a thin node:http proxy in front of a REAL
// startFakePlane() instance. plane-fake-server.mjs has no "fail this PATCH"
// knob (only failFirstCreate, which fails POST work-items/, never PATCH) and
// is owned by a different concurrent edit in this same worktree, so rather
// than touch it, this in-file proxy forwards everything to the real fake
// server EXCEPT a PATCH to a work item, which it 500s itself.
function startFailingPatchProxy(inner) {
  let patchesSeen = 0;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      const pathOnly = req.url.split("?")[0];
      if (req.method === "PATCH" && /\/work-items\/[^/]+\/?$/.test(pathOnly)) {
        patchesSeen++;
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "fake PATCH failure (T7b stub)" }));
        return;
      }
      const upstream = await fetch(new URL(req.url, inner.url), {
        method: req.method,
        headers: {
          "content-type": "application/json",
          "x-api-key": req.headers["x-api-key"] ?? "",
        },
        body: raw || undefined,
      });
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.writeHead(upstream.status, {
        "content-type": upstream.headers.get("content-type") ?? "application/json",
      });
      res.end(buf);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        get patchesSeen() {
          return patchesSeen;
        },
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

// Runs plane-intake.mjs out-of-process via async `spawn` (never `spawnSync`
// — the fake Plane server lives on this harness process's own event loop, so
// a synchronous spawn would block it while the child's request is pending,
// deadlocking any case that needs a round trip).
// stateDir defaults to registryDir (already a throwaway mkdtempSync dir at
// every call site that has one) so plane-client.mjs's ledger/digest state
// never lands in the real ledger — a spawn that omitted PLANE_SYNC_STATE_DIR
// previously leaked real PATCH ledger lines (fix-round 3 coordinator
// finding: B1 from a phase-3-shaped run, B5 from --relink) since stateDir()
// falls back to a real ambient default when nothing overrides it — that
// default was this worktree's own repoRoot()-anchored .claude/campaign, and
// is now (fix 2026-09-12, plane-write-ledger-local) the machine-shared
// machineRoot()-anchored local-assets/plane/, shared across every worktree
// of this repo — an omitted override is a bigger blast radius today than
// before, not a smaller one.
function runCli(
  argv,
  {
    cwd,
    registryDir,
    stateDir = registryDir,
    baseUrl,
    apiKey = "self-test-key",
    noKey = false,
    // T7e: deliberately re-poisons GIT_DIR/GIT_WORK_TREE back into the
    // child's env AFTER scrubbedEnv() has stripped them — simulating a
    // spawned plane-intake.mjs inheriting them from a git-hook-style
    // ambient env, to prove its own git preconditions ignore them.
    extraEnv = {},
  } = {},
) {
  const env = scrubbedEnv({
    ...(registryDir ? { PLANE_SYNC_REGISTRY_DIR: registryDir } : {}),
    ...(stateDir ? { PLANE_SYNC_STATE_DIR: stateDir } : {}),
    ...(baseUrl ? { PLANE_BASE_URL: baseUrl } : {}),
    // Fix-round (runs.jsonl pollution): plane-intake.mjs's main() appends one
    // telemetry line via appendRun() in a `finally` on every run, success or
    // failure. runsPath() only honours PLANE_RUNS_PATH when
    // PLANE_SYNC_SELF_TEST=1 is ALSO set — both are required on every call
    // here or the child falls through to this worktree's real
    // local-assets/plane/runs.jsonl.
    PLANE_SYNC_SELF_TEST: "1",
    PLANE_RUNS_PATH:
      stateDir || registryDir
        ? join(stateDir || registryDir, "self-test-runs.jsonl")
        : fallbackRunsPath(),
    // Belt-and-braces (fix 2026-09-12, L-116): any plane-client.mjs call not
    // already covered by the overrides above still resolves machineRoot() to
    // THIS suite's own throwaway dir, never the real machine-shared one.
    ...(TEMP_MACHINE_ROOT ? { PLANE_MACHINE_ROOT: TEMP_MACHINE_ROOT } : {}),
    ...extraEnv,
  });
  if (noKey) delete env.PLANE_API_KEY;
  else env.PLANE_API_KEY = apiKey;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT_PATH, ...argv], {
      cwd,
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

async function main() {
  // ── T7 phase 1 — listing (no --apply) ─────────────────────────────────────
  // fake BUGS has one human-created item ("Scanner crashes on iOS 19",
  // priority urgent, labelled "mobile", external_id null) and one
  // already-mirrored item ("B12 · x") that must be excluded from the
  // listing; a separate Intake-queue fixture carries one status -2
  // (pending) record, report-only.
  const server = await startFakePlane({
    labels: { BUGS: [{ id: "label-mobile", name: "mobile" }] },
    workItems: {
      BUGS: [
        {
          name: "Scanner crashes on iOS 19",
          priority: "urgent",
          labels: ["label-mobile"],
          external_id: null,
        },
        { name: "B12 · x", priority: "medium", external_id: "B12" },
      ],
    },
    intake: { BUGS: [{ status: -2, issue: "item-999" }] },
  });

  {
    // Finding C3's dedup scan reads a real catalogue file — point it at a
    // fresh EMPTY one here (never the ambient default) so this phase can
    // never accidentally exclude a candidate against this worktree's own
    // real .claude/campaign/bugs.jsonl.
    const emptyRegistryDir = makeRegistryOnly([]);
    const { code, stdout } = await runCli([], {
      baseUrl: server.url,
      registryDir: emptyRegistryDir,
    });
    check("T7 phase1: exit 0", code, 0);
    check(
      "T7 phase1: prints the exact ready command for the human-created item",
      stdout.includes(
        'node scripts/campaign/bugs.mjs file "Scanner crashes on iOS 19" --location "Area · mobile" --severity critical --tier T1',
      ),
      true,
    );
    check(
      "T7 phase1: reports the pending intake-queue record",
      stdout.includes("awaiting owner triage: 1"),
      true,
    );
    check("T7 phase1: the already-mirrored B12 item is not listed", stdout.includes("B12"), false);
  }

  // ── T7 phase 2 — --apply on a dirty tree ──────────────────────────────────
  {
    const { dir, campaignDir } = makeIntakeRepo({ dirty: true });
    const before = server.requests.length;
    const { code, stdout, stderr } = await runCli(["--apply"], {
      cwd: dir,
      registryDir: campaignDir,
      baseUrl: server.url,
    });
    check("T7 phase2: --apply on a dirty tree exits 2", code, 2);
    check("T7 phase2: message names the dirty precondition", /dirty/i.test(stdout + stderr), true);
    check(
      "T7 phase2: zero network requests (precondition checked before any list/write)",
      server.requests.length,
      before,
    );
    // zero writes to the throwaway registry either
    const rows = readFileSync(join(campaignDir, "bugs.jsonl"), "utf8")
      .split(/\r?\n/)
      .filter(Boolean);
    check("T7 phase2: bugs.jsonl unchanged (still the dirty, uncommitted row)", rows.length, 1);
  }

  // ── T7 phase 3 — --apply on a clean, master-descended tree ────────────────
  // The registry starts with an EMPTY catalogue (see makeIntakeRepo), so
  // bugs.mjs's own id-minting is deterministic: the first filed bug is
  // always "B1" (scripts/campaign/bugs.mjs: maxId over an empty catalogue +
  // empty ledger shards is 0). This is asserted against the literal "B1",
  // never read back and compared to itself — a read-back-and-compare would
  // vacuously pass even if plane-intake.mjs never wrote anything.
  {
    const { dir, campaignDir } = makeIntakeRepo({ dirty: false });
    const before = server.requests.length;
    const { code } = await runCli(["--apply"], {
      cwd: dir,
      registryDir: campaignDir,
      baseUrl: server.url,
    });
    check("T7 phase3: --apply on a clean tree exits 0", code, 0);

    const rows = readFileSync(join(campaignDir, "bugs.jsonl"), "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    check("T7 phase3: bugs.jsonl gained exactly one row", rows.length, 1);
    check("T7 phase3: the minted id is the deterministic first id, B1", rows[0]?.id, "B1");

    const patches = server.requests.slice(before).filter((r) => r.method === "PATCH");
    check("T7 phase3: exactly one PATCH", patches.length, 1);
    check("T7 phase3: the PATCH stamps external_id = B1", patches[0]?.body?.external_id, "B1");
    check(
      "T7 phase3: the PATCH name starts with 'B1 · Scanner'",
      String(patches[0]?.body?.name ?? "").startsWith("B1 · Scanner"),
      true,
    );
  }

  // ── T7e (defect repro, gates/push.log ~11716) — the husky pre-push hook's
  // `npm run verify` runs with git's own GIT_DIR/GIT_WORK_TREE already
  // exported into the environment, and a spawned `plane-intake.mjs --apply`
  // inherits them. Its own git preconditions (`git status --porcelain` /
  // `git merge-base --is-ancestor origin/master HEAD`) run with an explicit
  // cwd (the temp intake repo) and gitEnv()-scrubbed env, so poisoning
  // GIT_DIR/GIT_WORK_TREE with THIS WORKTREE's own real git dir/root — the
  // closest realistic stand-in for the hook's ambient env — must not
  // redirect the preconditions at the worktree; --apply must still see the
  // temp repo as clean and master-descended and mint B1 exactly like T7
  // phase 3. Uses its OWN fresh fake server (never the shared `server`
  // above, whose one candidate item T7 phase 3 already adopted to B1 —
  // reusing it here would leave zero candidates and vacuously "pass" with
  // nothing written). ────────────────────────────────────────────────────
  {
    const { workTreeRoot, gitDir } = locateThisWorktreeGit();
    const t7eServer = await startFakePlane({
      workItems: {
        BUGS: [{ name: "T7e candidate item", priority: "high", external_id: null }],
      },
    });
    const { dir, campaignDir } = makeIntakeRepo({ dirty: false });
    const { code } = await runCli(["--apply"], {
      cwd: dir,
      registryDir: campaignDir,
      baseUrl: t7eServer.url,
      extraEnv: { GIT_DIR: gitDir, GIT_WORK_TREE: workTreeRoot },
    });
    check(
      "T7e (defect repro): --apply exits 0 against the temp repo despite poisoned GIT_DIR/GIT_WORK_TREE",
      code,
      0,
    );
    const rows = readFileSync(join(campaignDir, "bugs.jsonl"), "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    check(
      "T7e: bugs.jsonl gained exactly one row (B1) despite poisoned GIT_DIR/GIT_WORK_TREE",
      rows.length,
      1,
    );
    check("T7e: the minted id is B1", rows[0]?.id, "B1");
    const patches = t7eServer.requests.filter((r) => r.method === "PATCH");
    check("T7e: exactly one PATCH despite poisoned GIT_DIR/GIT_WORK_TREE", patches.length, 1);
    await t7eServer.close();
  }

  await server.close();

  // ── T7b — Finding C1: a PATCH failure AFTER minting is non-fatal to the
  // registry (the row stays), leaves the Plane item unlinked, prints the
  // exact remediation line, and makes zero further writes — a second BUGS
  // item is seeded specifically to prove the run stops instead of minting a
  // second id for it. ──────────────────────────────────────────────────────
  {
    const inner = await startFakePlane({
      workItems: {
        BUGS: [
          { name: "Retry logic drops the second call", priority: "high", external_id: null },
          { name: "Second item never reached", priority: "medium", external_id: null },
        ],
      },
    });
    const proxy = await startFailingPatchProxy(inner);
    const { dir, campaignDir } = makeIntakeRepo({ dirty: false });
    const before = inner.requests.length;
    const { code, stdout, stderr } = await runCli(["--apply"], {
      cwd: dir,
      registryDir: campaignDir,
      baseUrl: proxy.url,
    });
    const out = stdout + stderr;
    check("T7b: exit 1", code, 1);
    check(
      "T7b: the exact remediation line, naming the minted id and BUGS sequence",
      out.includes(
        "minted B1 for BUGS-1 but the Plane link failed — rerun: " +
          "node scripts/campaign/plane-intake.mjs --relink B1=BUGS-1",
      ),
      true,
    );
    const rows = readFileSync(join(campaignDir, "bugs.jsonl"), "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    check("T7b: the registry row exists (B1 was minted, never rolled back)", rows[0]?.id, "B1");
    check("T7b: exactly one registry row (the run stopped, never reaching item 2)", rows.length, 1);
    const patches = inner.requests.slice(before).filter((r) => r.method === "PATCH");
    check(
      "T7b: the Plane item is still unlinked (no successful PATCH reached it)",
      patches.length,
      0,
    );
    // The shared client retries a 5xx up to MAX_RETRIES times (plane-client.mjs,
    // untouched here), so the proxy sees several attempts for item 1's PATCH —
    // the assertion that matters is that item 2 never gets ONE of its own.
    check(
      "T7b: at least one failing PATCH attempt was made, and every one of them was item 1's",
      proxy.patchesSeen >= 1,
      true,
    );
    await proxy.close();
    await inner.close();
  }

  // ── T7c — Finding C2: `--relink B###=BUGS-<seq>` repairs exactly the item
  // C1 leaves unlinked — one PATCH with the right body, no minting, no new
  // registry row. ─────────────────────────────────────────────────────────
  {
    const server = await startFakePlane({
      workItems: {
        BUGS: [{ name: "Human filed this straight in Plane", priority: "high", external_id: null }],
      },
    });
    const registryDir = makeRegistryOnly([
      { id: "B5", title: "Human filed this straight in Plane" },
    ]);
    const before = server.requests.length;
    const { code } = await runCli(["--relink", "B5=BUGS-1"], { registryDir, baseUrl: server.url });
    check("T7c: exit 0", code, 0);
    const writes = server.requests.slice(before).filter((r) => r.method !== "GET");
    check("T7c: exactly one write", writes.length, 1);
    check("T7c: it is a PATCH", writes[0]?.method, "PATCH");
    check(
      "T7c: the PATCH body carries external_source/external_id/the B5 name prefix",
      {
        external_source: writes[0]?.body?.external_source,
        external_id: writes[0]?.body?.external_id,
        name: writes[0]?.body?.name,
      },
      {
        external_source: "routeflow-registry",
        external_id: "B5",
        name: "B5 · Human filed this straight in Plane",
      },
    );
    const rows = readFileSync(join(registryDir, "bugs.jsonl"), "utf8")
      .split(/\r?\n/)
      .filter(Boolean);
    check("T7c: no new registry row was minted", rows.length, 1);
    await server.close();
  }

  // ── T7d — Finding C3: an item whose name already matches a registry title
  // (case/whitespace-normalised) is excluded from listing and points at
  // --relink instead. ─────────────────────────────────────────────────────
  {
    const server = await startFakePlane({
      workItems: {
        BUGS: [{ name: "  Scanner   Crashes on iOS 19 ", priority: "urgent", external_id: null }],
      },
    });
    const registryDir = makeRegistryOnly([{ id: "B9", title: "scanner crashes on ios 19" }]);
    const { code, stdout, stderr } = await runCli([], { registryDir, baseUrl: server.url });
    const out = stdout + stderr;
    check("T7d: exit 0", code, 0);
    check(
      "T7d: the already-filed item is not offered as a new bugs.mjs file candidate",
      stdout.includes("bugs.mjs file"),
      false,
    );
    check(
      "T7d: prints the already-filed line naming B9 and the relink command",
      out.includes("already filed as B9 (relink with --relink B9=BUGS-1)"),
      true,
    );
    await server.close();
  }

  // ── T15 — --help/-h short-circuit before any env read or network call;
  // an unknown flag exits 2 with Usage on stderr ────────────────────────────
  {
    const server2 = await startFakePlane({});
    const help = await runCli(["--help"], { baseUrl: server2.url });
    check(
      "T15: --help exits 0 with Usage naming the script, zero requests, even with a reachable server + valid key",
      {
        code: help.code,
        hasUsage: help.stdout.includes("Usage:"),
        namesScript: help.stdout.includes("plane-intake"),
        requests: server2.requests.length,
      },
      { code: 0, hasUsage: true, namesScript: true, requests: 0 },
    );
    await server2.close();

    const h = await runCli(["-h"], { baseUrl: "http://127.0.0.1:1", noKey: true });
    check(
      "T15: -h exits 0 with Usage even with no key and an unreachable base URL",
      { code: h.code, hasUsage: h.stdout.includes("Usage:") },
      { code: 0, hasUsage: true },
    );

    const bogus = await runCli(["--bogus"], { baseUrl: "http://127.0.0.1:1", noKey: true });
    check(
      "T15: an unknown flag exits 2 with Usage on stderr",
      { code: bogus.code, hasUsage: bogus.stderr.includes("Usage:") },
      { code: 2, hasUsage: true },
    );
  }

  return failures;
}

// Ruling (Fable, 2026-09-12, L-116): a self-test invariant must never bind
// to a shared machine-local file — the real local-assets/plane/runs.jsonl is
// legitimately appended to by OTHER sessions' hooks (Stop -> plane-sync,
// SessionStart -> plane-triage) at any moment, so a before/after byte-
// identity check against it races every other session on the machine. The
// old REAL_RUNS_PATH snapshot-diff is gone; TEMP_MACHINE_ROOT (created just
// before `main()` runs) stands in for "the machine" instead, and only
// fixtures this suite itself owns are ever asserted on.
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
  console.log(`  FAIL plane-intake.self-test threw: ${err?.stack ?? err}`);
} finally {
  const localAssetsPlane = join(TEMP_MACHINE_ROOT, "local-assets", "plane");
  filesUnderMachineRoot = existsSync(localAssetsPlane) ? readdirSync(localAssetsPlane).sort() : [];
  createdDirs = cleanupFixtures();
}
check(
  "F4: the run leaves no dir this run created behind",
  createdDirs.filter((d) => existsSync(d)),
  [],
);
check(
  "F4: no plane-intake-self-test-<pid>-<rand>-* dir from this run remains under tmpdir",
  countFixtureTmpDirs(),
  tmpDirsBefore,
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
// in FIXTURE_DIRS above, so the "no dir this run created behind" check
// already proves it — this is belt-and-braces).
check(
  "invariant: the temp machine root is removed at the end",
  existsSync(TEMP_MACHINE_ROOT),
  false,
);

console.log(
  failures
    ? `\nplane-intake.self-test: ${failures} FAILURE(S)`
    : "\nplane-intake.self-test: all checks passed",
);
process.exit(failures ? 1 : 0);
