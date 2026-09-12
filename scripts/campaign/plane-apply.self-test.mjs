#!/usr/bin/env node
// Coverage for scripts/campaign/plane-apply.mjs (TP4, build-plan.md
// 2026-09-11-plane-harness). Same standalone-script convention as
// plane-sync.self-test.mjs / plane-intake.self-test.mjs / plane-triage.self-
// test.mjs — no node:test: `node scripts/campaign/plane-apply.self-test.mjs`,
// PASS/FAIL lines, `process.exit(failures ? 1 : 0)`.
//
// plane-apply.mjs does not exist yet: every case below drives it via `spawn`
// (never a static top-level `import`), so a missing file surfaces as an
// ordinary non-zero child exit / empty stdout — a clean assertion miss,
// never a crash of this file (test-plan.md §6).
//
// ASSUMED OPS-FILE SCHEMA (flagged, not guessed past this point — see the
// closing report): spec.md R8 gives `"ref":"ROAD-15"` (target identifier)
// and `"project":"OPS"` (project identifier) as separate examples but never
// states whether `update`/`comment`/`relation`/`archive` need an explicit
// `project` alongside `ref`. This file assumes the project is parsed from
// the `ref`'s own "<PROJECT>-<sequence_id>" prefix (the standard shape for
// this style of identifier, and the only reading consistent with the
// resolution-order comment in ruling-s4-s5.md: "GET work-items/... of that
// project" with no separate project input for a ref-bearing op) — so only
// `create` (which has no natural ref) carries an explicit `"project"` field
// below. If WP5 lands requiring `project` on every op instead, these fixture
// ops files need one field added, not a rewrite.
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
import { machineRoot } from "./plane-client.mjs";

const SCRIPT_PATH = fileURLToPath(new URL("./plane-apply.mjs", import.meta.url));

// F4 pattern: every fixture dir this run creates (ops-file dirs and ledger
// state dirs alike) is tracked and swept in a `finally`.
//
// Test-isolation fix (2026-09-12): FIXTURE_PREFIX is unique to THIS PROCESS
// (pid + random) — never a bare "plane-apply-self-test-" literal shared by
// every invocation, which let two overlapping runs of this script pollute
// each other's before/after dir COUNT under load. The sweep is pinned to
// every path THIS run recorded being gone after cleanup, never a global
// count of other runs' dirs.
const FIXTURE_DIRS = [];
const FIXTURE_PREFIX = `plane-apply-self-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}-`;
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
function makeTmpDir() {
  const dir = mkdtempSync(join(tmpdir(), FIXTURE_PREFIX));
  FIXTURE_DIRS.push(dir);
  return dir;
}
function writeOpsFile(ops) {
  const dir = makeTmpDir();
  const p = join(dir, "ops.json");
  writeFileSync(p, JSON.stringify({ ops }));
  return p;
}

// Runs plane-apply.mjs out-of-process via async `spawn` (never `spawnSync`
// — the fake Plane server lives on this harness process's own event loop, so
// a synchronous spawn would block it while the child's request is pending).
function fallbackRunsPath() {
  return join(
    tmpdir(),
    `${FIXTURE_PREFIX}runs-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
  );
}

function runCli(argv, { baseUrl, stateDir, apiKey = "self-test-key", noKey = false } = {}) {
  const env = { ...process.env };
  if (baseUrl) env.PLANE_BASE_URL = baseUrl;
  if (stateDir) env.PLANE_SYNC_STATE_DIR = stateDir;
  // Fix-round (runs.jsonl pollution): plane-apply.mjs's main() appends one
  // telemetry line via appendRun() in a `finally` on every run. runsPath()
  // only honours PLANE_RUNS_PATH when PLANE_SYNC_SELF_TEST=1 is ALSO set —
  // both required here or the child writes into this worktree's real
  // local-assets/plane/runs.jsonl.
  env.PLANE_SYNC_SELF_TEST = "1";
  env.PLANE_RUNS_PATH = stateDir ? join(stateDir, "self-test-runs.jsonl") : fallbackRunsPath();
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

// Classifies one recorded write request by its (method, path) shape so the
// ordered-write assertion (T9) doesn't have to hardcode positional indices —
// it reads the actual sequence back out of the fake server's own log.
function kindOf(req) {
  if (req.method === "PATCH") return "update";
  if (req.method === "POST") {
    if (/\/comments\/?$/.test(req.path)) return "comment";
    if (/\/relations\/?$/.test(req.path)) return "relation";
    if (/\/archive\/?$/.test(req.path)) return "archive";
    if (/\/work-items\/?$/.test(req.path)) return "create";
  }
  return `other:${req.method}`;
}
const writesSince = (server, since) =>
  server.requests.slice(since).filter((r) => r.method !== "GET");

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
// Finding B's own (looser) probe — just the first two UUID groups — since the
// bug it guards against is "prints a Plane id fragment", not specifically a
// full RFC4122 uuid.
const PARTIAL_UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-/i;

async function main() {
  // ── T9 (5 phases) + T9b — shared fixture ──────────────────────────────────
  // ROAD-15 (In progress, group started — also T9b's archive target),
  // ROAD-68 (Backlog — the `create` op's `parent`), OPS-23 (Backlog),
  // DECIDE-6 (Cancelled, group completed — the T9 archive target),
  // DECIDE-12 (Backlog — the relation target).
  {
    const server = await startFakePlane({
      workItems: {
        ROAD: [
          { name: "Road item", sequence_id: 15, state: "state-inprogress" },
          { name: "Road epic", sequence_id: 68, state: "state-backlog" },
          // Finding B fixture: a `state` id that ISN'T in ROAD's own (default)
          // state list at all — models a deleted/orphaned state reference, the
          // actual "group map misses" case the old code leaked the raw id on.
          { name: "Road orphan", sequence_id: 77, state: "state-does-not-exist" },
        ],
        OPS: [{ name: "Ops item", sequence_id: 23, state: "state-backlog" }],
        DECIDE: [
          { name: "Decide A", sequence_id: 6, state: "state-cancelled" },
          { name: "Decide B", sequence_id: 12, state: "state-backlog" },
        ],
      },
    });
    const stateDir = makeTmpDir();

    const fiveOps = [
      { op: "update", ref: "ROAD-15", set: { state: "In review" } },
      { op: "comment", ref: "OPS-23", html: "<p>status check for OPS-23</p>" },
      {
        op: "create",
        project: "OPS",
        name: "New task from ops file",
        state: "Backlog",
        priority: "medium",
        parent: "ROAD-68",
      },
      { op: "relation", ref: "DECIDE-6", to: "DECIDE-12", type: "duplicate" },
      { op: "archive", ref: "DECIDE-6" },
    ];
    const opsPath = writeOpsFile(fiveOps);

    // Phase 1 — --dry-run: zero writes; the plan names identifiers/the new
    // item's name, never a uuid.
    {
      const before = server.requests.length;
      const { code, stdout } = await runCli(["--dry-run", opsPath], {
        baseUrl: server.url,
        stateDir,
      });
      check("T9 phase1 (--dry-run): exit 0", code, 0);
      check("T9 phase1 (--dry-run): zero writes", writesSince(server, before).length, 0);
      check(
        "T9 phase1 (--dry-run): plan names every identifier and the new item's name, never a uuid",
        {
          road15: stdout.includes("ROAD-15"),
          ops23: stdout.includes("OPS-23"),
          decide6: stdout.includes("DECIDE-6"),
          decide12: stdout.includes("DECIDE-12"),
          createdName: stdout.includes("New task from ops file"),
          noUuid: !UUID_RE.test(stdout),
        },
        {
          road15: true,
          ops23: true,
          decide6: true,
          decide12: true,
          createdName: true,
          noUuid: true,
        },
      );
    }

    // Phase 2 — real run: writes = 5, in order PATCH, comment, create,
    // relation, archive.
    {
      const before = server.requests.length;
      const { code } = await runCli([opsPath], { baseUrl: server.url, stateDir });
      check("T9 phase2 (real run): exit 0", code, 0);
      const writes = writesSince(server, before);
      check("T9 phase2 (real run): exactly 5 writes", writes.length, 5);
      check("T9 phase2 (real run): writes land in the required order", writes.map(kindOf), [
        "update",
        "comment",
        "create",
        "relation",
        "archive",
      ]);
    }

    // Phase 3 — invalid ref: an unresolvable state name exits 1 before any
    // write, naming the op index and the bad value.
    {
      const badOpsPath = writeOpsFile([{ op: "update", ref: "ROAD-15", set: { state: "Nope" } }]);
      const before = server.requests.length;
      const { code, stdout, stderr } = await runCli([badOpsPath], {
        baseUrl: server.url,
        stateDir,
      });
      check("T9 phase3 (invalid ref): exit 1", code, 1);
      check("T9 phase3 (invalid ref): zero writes", writesSince(server, before).length, 0);
      const out = stdout + stderr;
      check("T9 phase3 (invalid ref): message names the op index", out.includes("#1"), true);
      check("T9 phase3 (invalid ref): message names the bad value", out.includes("Nope"), true);
    }

    // Phase 4 — manual write-budget refusal: 20 manual (non-plane-sync)
    // writes already logged today -> exit 3, zero writes, no --over-budget.
    {
      const today = new Date().toISOString();
      const lines = Array.from({ length: 20 }, (_, i) =>
        JSON.stringify({
          ts: today,
          tool: "plane-apply",
          method: "PATCH",
          path: `/api/v1/workspaces/routeflow/projects/proj-road/work-items/seed-${i}/`,
          ref: `SEED-${i}`,
        }),
      );
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(join(stateDir, ".plane-writes.jsonl"), lines.join("\n") + "\n");

      const before = server.requests.length;
      const { code } = await runCli([opsPath], { baseUrl: server.url, stateDir });
      check("T9 phase4 (over manual budget, no override): exit 3", code, 3);
      check(
        "T9 phase4 (over manual budget, no override): zero writes",
        writesSince(server, before).length,
        0,
      );

      // Phase 5 — same, with --over-budget: proceeds; one ledger line's
      // reason carries the given text.
      const before2 = server.requests.length;
      const { code: code2 } = await runCli([opsPath, "--over-budget", "window 15"], {
        baseUrl: server.url,
        stateDir,
      });
      check("T9 phase5 (--over-budget): exit 0", code2, 0);
      check("T9 phase5 (--over-budget): 5 writes proceed", writesSince(server, before2).length, 5);
      const ledgerLines = readFileSync(join(stateDir, ".plane-writes.jsonl"), "utf8")
        .split(/\r?\n/)
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      check(
        "T9 phase5 (--over-budget): a ledger line carries the reason",
        ledgerLines.some((l) => String(l.reason ?? "").includes("window 15")),
        true,
      );
    }

    // T9b — archive precondition violation: ROAD-15 is still "In review"
    // (group started, set by phase 2's update, never archived) — archiving
    // it must fail validation before any write.
    {
      const archiveOpsPath = writeOpsFile([{ op: "archive", ref: "ROAD-15" }]);
      const before = server.requests.length;
      const { code, stdout, stderr } = await runCli([archiveOpsPath], {
        baseUrl: server.url,
        stateDir,
      });
      const out = stdout + stderr;
      check("T9b (archive on a started item): exit 1", code, 1);
      check("T9b (archive on a started item): zero writes", writesSince(server, before).length, 0);
      check(
        "T9b (archive on a started item): message names the op index",
        out.includes("#1"),
        true,
      );
      check("T9b (archive on a started item): message names the op", out.includes("archive"), true);
      check(
        "T9b (archive on a started item): message states the precondition",
        out.includes("completed or cancelled"),
        true,
      );
      // Finding B (Opus #6) extension: never a Plane-id-shaped fragment, and
      // the KNOWN state's own name ("In review") is what's shown instead.
      check(
        "T9b (archive on a started item): message names the known state, never a uuid fragment",
        { noPartialUuid: !PARTIAL_UUID_RE.test(out), namesState: /in review/i.test(out) },
        { noPartialUuid: true, namesState: true },
      );
    }

    // T9b (unknown state, Finding B / Opus #6): the item's current `state`
    // id isn't in the project's own state list at all (group map misses AND
    // name map misses) — the message must say "<unknown state>", never leak
    // the raw (here fake, but uuid-shaped in prod) state id.
    {
      const orphanOpsPath = writeOpsFile([{ op: "archive", ref: "ROAD-77" }]);
      const before = server.requests.length;
      const { code, stdout, stderr } = await runCli([orphanOpsPath], {
        baseUrl: server.url,
        stateDir,
      });
      const out = stdout + stderr;
      check("T9b (unknown state): exit 1", code, 1);
      check("T9b (unknown state): zero writes", writesSince(server, before).length, 0);
      check(
        "T9b (unknown state): message says <unknown state>, never the raw state id",
        {
          hasUnknownMarker: out.includes("<unknown state>"),
          hasRawId: out.includes("state-does-not-exist"),
        },
        { hasUnknownMarker: true, hasRawId: false },
      );
    }

    await server.close();
  }

  // ── T9c — Finding A (Opus #2): `--max-writes` deferral is reported,
  // counted, and halts further op attempts (never silently reported as
  // applied). 5 independent ops, `--max-writes 2`: exactly 2 real writes
  // land, the other 3 are counted+printed as deferred WITHOUT ever being
  // attempted, and the run exits 4.
  {
    const server = await startFakePlane({
      workItems: { OPS: [{ name: "Ops item", sequence_id: 23, state: "state-backlog" }] },
    });
    const stateDir = makeTmpDir();
    const fiveComments = Array.from({ length: 5 }, (_, i) => ({
      op: "comment",
      ref: "OPS-23",
      html: `<p>c${i + 1}</p>`,
    }));
    const opsPath = writeOpsFile(fiveComments);
    const before = server.requests.length;
    const { code, stdout } = await runCli([opsPath, "--max-writes", "2"], {
      baseUrl: server.url,
      stateDir,
    });
    check("T9c (--max-writes 2): exit 4", code, 4);
    check(
      "T9c (--max-writes 2): exactly 2 writes actually reach the server",
      writesSince(server, before).length,
      2,
    );
    check(
      "T9c (--max-writes 2): output reports a deferred op",
      stdout.includes("deferred (max-writes)"),
      true,
    );
    check(
      "T9c (--max-writes 2): summary is applied=2 deferred=3",
      stdout.includes("Plane apply: applied=2 deferred=3"),
      true,
    );
    await server.close();
  }

  // ── T10 — denylist on the apply path ──────────────────────────────────────
  {
    const server = await startFakePlane({
      workItems: { OPS: [{ name: "Ops item", sequence_id: 23, state: "state-backlog" }] },
    });
    const stateDir = makeTmpDir();
    const uuid = "123e4567-e89b-12d3-a456-426614174000";
    const opsPath = writeOpsFile([
      { op: "comment", ref: "OPS-23", html: `<p>tenant ${uuid} needs review</p>` },
    ]);
    const before = server.requests.length;
    const { code, stdout, stderr } = await runCli([opsPath], { baseUrl: server.url, stateDir });
    const out = stdout + stderr;
    check("T10: exit 1", code, 1);
    check("T10: zero writes", writesSince(server, before).length, 0);
    check("T10: output names the forbidden pattern", out.includes("forbidden (tenant-uuid)"), true);
    check("T10: the uuid itself is never printed", out.includes(uuid), false);
    await server.close();
  }

  // ── T11 (defect fix 2026-09-12, R2/CONTENT_KEYS/uuidIds) — proven live:
  // the old scanBodyDeep walked EVERY string in a write body, so a
  // uuid-shaped state/label id tripped the tenant-uuid pattern purely by
  // coincidental shape and plane-apply refused every op that named a state
  // or label. T10 above never caught this because plane-fake-server.mjs's
  // literal ids ("state-backlog", ...) never LOOK uuid-shaped. `uuidIds:
  // true` makes this server's ids real RFC-4122-shaped uuids so an update op
  // setting state + labels by name must still issue exactly 1 PATCH and
  // exit 0 — proving the id-key exemption works — while a comment whose HTML
  // carries a uuid (content, not an id field) is still forbidden, exactly
  // as T10 proved without uuidIds.
  {
    const server = await startFakePlane({
      uuidIds: true,
      workItems: { OPS: [] },
      labels: { OPS: [{ name: "urgent" }] },
    });
    const opsStates = server.state.states.OPS;
    const backlog = opsStates.find((s) => s.name === "Backlog");
    const inReview = opsStates.find((s) => s.name === "In review");
    const urgentLabel = server.state.labels.OPS.find((l) => l.name === "urgent");
    check(
      "T11: the uuidIds fixture's In review state and urgent label ids are actually uuid-shaped",
      { state: UUID_RE.test(inReview?.id ?? ""), label: UUID_RE.test(urgentLabel?.id ?? "") },
      { state: true, label: true },
    );
    server.state.workItems.OPS.push({
      id: "item-t11-existing",
      sequence_id: 23,
      name: "Ops item",
      state: backlog.id,
    });
    const stateDir = makeTmpDir();
    const opsPath = writeOpsFile([
      { op: "update", ref: "OPS-23", set: { state: "In review", labels: ["urgent"] } },
    ]);
    const before = server.requests.length;
    const { code } = await runCli([opsPath], { baseUrl: server.url, stateDir });
    const patches = writesSince(server, before).filter((r) => r.method === "PATCH");
    check(
      "T11: exactly 1 PATCH, exit 0",
      { patches: patches.length, code },
      { patches: 1, code: 0 },
    );
    check(
      "T11: the PATCH body carries the real uuid-shaped state+labels ids, unscrubbed (proves ids are sent, not scrubbed)",
      {
        stateIsUuid: UUID_RE.test(patches[0]?.body?.state ?? ""),
        stateMatchesInReview: patches[0]?.body?.state === inReview.id,
        labelsMatchUrgent:
          JSON.stringify(patches[0]?.body?.labels ?? []) === JSON.stringify([urgentLabel.id]),
      },
      { stateIsUuid: true, stateMatchesInReview: true, labelsMatchUrgent: true },
    );

    // Negative twin (T10 still applies with uuidIds on): a comment whose
    // HTML carries a uuid is CONTENT, not an id field — still forbidden.
    const uuid = "123e4567-e89b-12d3-a456-426614174000";
    const badOpsPath = writeOpsFile([
      { op: "comment", ref: "OPS-23", html: `<p>tenant ${uuid} needs review</p>` },
    ]);
    const before2 = server.requests.length;
    const {
      code: code2,
      stdout: stdout2,
      stderr: stderr2,
    } = await runCli([badOpsPath], { baseUrl: server.url, stateDir });
    const out2 = stdout2 + stderr2;
    check(
      "T11 (negative twin, T10/R2 still applies): a content-field uuid is still forbidden with uuidIds on",
      {
        code: code2,
        writes: writesSince(server, before2).length,
        namesForbidden: out2.includes("forbidden (tenant-uuid)"),
      },
      { code: 1, writes: 0, namesForbidden: true },
    );
    await server.close();
  }

  // ── T12 — relation type normalization (defect fix 2026-09-12, proven live:
  // the API's real `relation_type` enum is snake_case, so the ops file's
  // human label ("relates to") got HTTP 400). Accept an enum value as-is or
  // a human label folded case-insensitively with spaces/hyphens -> "_";
  // reject anything else at validation time, zero writes, naming the value
  // and the valid list.
  {
    const server = await startFakePlane({
      workItems: {
        OPS: [
          { name: "Ops item", sequence_id: 23, state: "state-backlog" },
          { name: "Ops item 2", sequence_id: 24, state: "state-backlog" },
        ],
      },
    });
    const stateDir = makeTmpDir();

    // "relates to" -> relates_to, recorded verbatim in the POST body.
    {
      const opsPath = writeOpsFile([
        { op: "relation", ref: "OPS-23", to: "OPS-24", type: "relates to" },
      ]);
      const before = server.requests.length;
      const { code } = await runCli([opsPath], { baseUrl: server.url, stateDir });
      const writes = writesSince(server, before);
      const relWrite = writes.find((r) => kindOf(r) === "relation");
      check(
        `T12 ("relates to" -> relates_to): exit 0, one relation write, normalised relation_type`,
        { code, count: writes.length, relationType: relWrite?.body?.relation_type },
        { code: 0, count: 1, relationType: "relates_to" },
      );
    }

    // "blocked by" -> blocked_by
    {
      const opsPath = writeOpsFile([
        { op: "relation", ref: "OPS-23", to: "OPS-24", type: "blocked by" },
      ]);
      const before = server.requests.length;
      const { code } = await runCli([opsPath], { baseUrl: server.url, stateDir });
      const writes = writesSince(server, before);
      const relWrite = writes.find((r) => kindOf(r) === "relation");
      check(
        `T12 ("blocked by" -> blocked_by): exit 0, one relation write, normalised relation_type`,
        { code, count: writes.length, relationType: relWrite?.body?.relation_type },
        { code: 0, count: 1, relationType: "blocked_by" },
      );
    }

    // "sideways" -> not a recognized enum or label: exit 1, zero writes,
    // message names the op index, the bad value, and the valid list.
    {
      const opsPath = writeOpsFile([
        { op: "relation", ref: "OPS-23", to: "OPS-24", type: "sideways" },
      ]);
      const before = server.requests.length;
      const { code, stdout, stderr } = await runCli([opsPath], { baseUrl: server.url, stateDir });
      const out = stdout + stderr;
      check(`T12 ("sideways"): exit 1`, code, 1);
      check(`T12 ("sideways"): zero writes`, writesSince(server, before).length, 0);
      check(
        `T12 ("sideways"): message names the op index, the bad value, and the valid list`,
        {
          namesIndex: out.includes("#1"),
          namesBad: out.includes("sideways"),
          namesValidMarker: out.includes("valid:"),
          namesRelatesTo: out.includes("relates_to"),
          namesBlockedBy: out.includes("blocked_by"),
        },
        {
          namesIndex: true,
          namesBad: true,
          namesValidMarker: true,
          namesRelatesTo: true,
          namesBlockedBy: true,
        },
      );
    }

    await server.close();
  }

  // ── T15 — --help/-h short-circuit before any env read or network call;
  // an unknown flag exits 2 with Usage on stderr ────────────────────────────
  {
    const server = await startFakePlane({});
    const opsPath = writeOpsFile([]);
    const help = await runCli(["--help", opsPath], { baseUrl: server.url });
    check(
      "T15: --help exits 0 with Usage naming the script, zero requests, even with a reachable server + valid key",
      {
        code: help.code,
        hasUsage: help.stdout.includes("Usage:"),
        namesScript: help.stdout.includes("plane-apply"),
        requests: server.requests.length,
      },
      { code: 0, hasUsage: true, namesScript: true, requests: 0 },
    );
    await server.close();

    const h = await runCli(["-h", opsPath], { baseUrl: "http://127.0.0.1:1", noKey: true });
    check(
      "T15: -h exits 0 with Usage even with no key and an unreachable base URL",
      { code: h.code, hasUsage: h.stdout.includes("Usage:") },
      { code: 0, hasUsage: true },
    );

    const bogus = await runCli(["--bogus", opsPath], {
      baseUrl: "http://127.0.0.1:1",
      noKey: true,
    });
    check(
      "T15: an unknown flag exits 2 with Usage on stderr",
      { code: bogus.code, hasUsage: bogus.stderr.includes("Usage:") },
      { code: 2, hasUsage: true },
    );
  }

  return failures;
}

// Fix-round (runs.jsonl pollution, 2026-09-12): belt-and-suspenders proof
// that every runCli() call above's PLANE_SYNC_SELF_TEST+PLANE_RUNS_PATH pair
// keeps the real runs.jsonl untouched. Fix 2026-09-12 (plane-write-ledger-
// local) moved its ambient default from this worktree's own repoRoot() to
// the machine-shared machineRoot() anchor every worktree of this repo
// resolves the same way — see plane-client.mjs's machineRoot() doc comment.
const REAL_RUNS_PATH = join(machineRoot(), "local-assets", "plane", "runs.jsonl");
const realRunsBefore = existsSync(REAL_RUNS_PATH) ? readFileSync(REAL_RUNS_PATH, "utf8") : null;

const tmpDirsBefore = countFixtureTmpDirs(); // always 0: FIXTURE_PREFIX embeds this process's own pid+random, so no dir under it can predate this run.
let createdDirs = [];
try {
  await main();
} catch (err) {
  failures++;
  console.log(`  FAIL plane-apply.self-test threw: ${err?.stack ?? err}`);
} finally {
  createdDirs = cleanupFixtures();
}
check(
  "F4: the run leaves no dir this run created behind",
  createdDirs.filter((d) => existsSync(d)),
  [],
);
check(
  "F4: no plane-apply-self-test-<pid>-<rand>-* dir from this run remains under tmpdir",
  countFixtureTmpDirs(),
  tmpDirsBefore,
);
const realRunsAfter = existsSync(REAL_RUNS_PATH) ? readFileSync(REAL_RUNS_PATH, "utf8") : null;
check(
  "F4: the real machine-shared local-assets/plane/runs.jsonl is byte-identical before/after the suite (or absent both times)",
  realRunsAfter,
  realRunsBefore,
);

console.log(
  failures
    ? `\nplane-apply.self-test: ${failures} FAILURE(S)`
    : "\nplane-apply.self-test: all checks passed",
);
process.exit(failures ? 1 : 0);
