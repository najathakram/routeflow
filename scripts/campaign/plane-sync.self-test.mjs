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
import { createServer } from "node:http";
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
import { deriveDesired, mapPriority, registryDigest } from "./plane-sync.mjs";

const SCRIPT_PATH = fileURLToPath(new URL("./plane-sync.mjs", import.meta.url));
const STOP_HOOK_PATH = fileURLToPath(new URL("../../.claude/hooks/stop.mjs", import.meta.url));

// ── fake Plane server ───────────────────────────────────────────────────────
// Routes only what the build plan's endpoint list names: project lookup,
// state lookup, work-item list/create/patch. Anything else is a 404 so a
// wrong URL fails loudly instead of silently 200-ing.
// Plane's list payload exposes a plain-text `description_stripped` derived
// from the submitted HTML; the fake derives it the same way, so an item the
// script itself created reads back the way the real API would return it.
const stripTags = (html) =>
  String(html ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const DEFAULT_FAKE_STATES = [
  { id: "state-backlog", name: "Backlog" },
  { id: "state-inprogress", name: "In progress" },
  { id: "state-landing", name: "Landing" },
  { id: "state-live", name: "Live" },
  { id: "state-cancelled", name: "Cancelled" },
];

// `states` lets a case model a workspace missing one of the mapped states.
// `omitDescriptionStripped` models Landmine 1 — a real Plane list response
// that drops `description_stripped` even though `fields=` asked for it.
function startFakeServer({
  existingItems = [],
  failFirstCreate = false,
  states = DEFAULT_FAKE_STATES,
  omitDescriptionStripped = false,
} = {}) {
  const requests = [];
  const items = existingItems.map((it) => ({ ...it }));
  let createFailuresLeft = failFirstCreate ? 1 : 0;
  let nextItemId = items.length + 1;

  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const u = new URL(req.url, "http://127.0.0.1");
      let body = null;
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          body = raw;
        }
      }
      requests.push({
        method: req.method,
        path: u.pathname,
        query: Object.fromEntries(u.searchParams),
        body,
      });

      const send = (status, obj) => {
        const buf = Buffer.from(JSON.stringify(obj));
        res.writeHead(status, { "content-type": "application/json" });
        res.end(buf);
      };

      const isWorkItemsCollection = /\/projects\/proj-bugs\/work-items\/$/.test(u.pathname);
      const patchMatch = /\/projects\/proj-bugs\/work-items\/([^/]+)\/$/.exec(u.pathname);

      if (req.method === "POST" && isWorkItemsCollection && createFailuresLeft > 0) {
        createFailuresLeft--;
        res.writeHead(429, {
          "content-type": "application/json",
          "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 1),
        });
        res.end(JSON.stringify({ error: "rate limited" }));
        return;
      }

      if (req.method === "GET" && /\/projects\/$/.test(u.pathname)) {
        return send(200, { results: [{ id: "proj-bugs", identifier: "BUGS", name: "Bugs" }] });
      }
      if (req.method === "GET" && /\/projects\/proj-bugs\/states\/$/.test(u.pathname)) {
        return send(200, { results: states });
      }
      if (req.method === "GET" && isWorkItemsCollection) {
        const listed = omitDescriptionStripped
          ? items.map(({ description_stripped: _dropped, ...rest }) => rest)
          : items;
        return send(200, { results: listed, next_cursor: null, next_page_results: false });
      }
      if (req.method === "POST" && isWorkItemsCollection) {
        const created = { id: `item-${nextItemId++}`, ...body };
        if (body?.description_html) created.description_stripped = stripTags(body.description_html);
        items.push(created);
        return send(201, created);
      }
      if (req.method === "PATCH" && patchMatch) {
        const idx = items.findIndex((it) => it.id === patchMatch[1]);
        if (idx !== -1) {
          items[idx] = { ...items[idx], ...body };
          if (body?.description_html) {
            items[idx].description_stripped = stripTags(body.description_html);
          }
        }
        return send(200, items[idx] ?? {});
      }
      return send(404, { error: `fake Plane server: no route for ${req.method} ${u.pathname}` });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests,
        items,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
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
// one place and swept once, and the sweep is PINNED by a final check that the
// `plane-sync-self-test-*` count in tmpdir is exactly what it was at start.
const FIXTURE_DIRS = [];
const FIXTURE_PREFIX = "plane-sync-self-test-";
const countFixtureTmpDirs = () =>
  readdirSync(tmpdir()).filter((n) => n.startsWith(FIXTURE_PREFIX)).length;
function cleanupFixtures() {
  for (const dir of FIXTURE_DIRS.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // a fixture dir that refuses to go (a live handle on Windows) must never
      // turn an otherwise-passing run red — the final count check reports it.
    }
  }
}

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
function runCli(argv, { registryDir, baseUrl, apiKey = "self-test-key", noKey = false } = {}) {
  const env = { ...process.env, PLANE_SYNC_REGISTRY_DIR: registryDir, PLANE_BASE_URL: baseUrl };
  if (noKey) delete env.PLANE_API_KEY;
  else env.PLANE_API_KEY = apiKey;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT_PATH, ...argv], {
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

  return failures;
}

// F4: the fixture sweep runs in a `finally`, and the summary/exit moved OUT of
// main() to keep it reachable — `process.exit()` never runs a finally block.
const tmpDirsBefore = countFixtureTmpDirs();
try {
  await main();
} catch (err) {
  failures++;
  console.log(`  FAIL plane-sync.self-test threw: ${err?.stack ?? err}`);
} finally {
  cleanupFixtures();
}
check(
  "F4: the run leaves no plane-sync-self-test-* dir behind",
  countFixtureTmpDirs(),
  tmpDirsBefore,
);

console.log(
  failures
    ? `\nplane-sync.self-test: ${failures} FAILURE(S)`
    : "\nplane-sync.self-test: all checks passed",
);
process.exit(failures ? 1 : 0);
