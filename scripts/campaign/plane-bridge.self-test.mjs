#!/usr/bin/env node
// Coverage for scripts/campaign/plane-bridge*.mjs (AI OS plan step 2.2; spec 2026-11-14-plane-bridge).
// Standalone, house convention: `node scripts/campaign/plane-bridge.self-test.mjs`, PASS/FAIL lines,
// `process.exit(failures ? 1 : 0)`. Every CLI runs as a child (spawn, CLI_BUDGET_MS) against
// plane-fake-server.mjs with a temp token file, temp config and temp machine root. Never touches a
// real Plane, the real token, or anything under .claude/campaign/ except a READ in T1.
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { startFakePlane } from "./plane-fake-server.mjs";
import { registryRoot } from "../lib/registry-root.mjs";

const CLI_BUDGET_MS = Number(process.env.PLANE_SELF_TEST_CLI_BUDGET_MS) || 90_000;
const HERE = fileURLToPath(new URL(".", import.meta.url));
const SCRIPT = join(HERE, "plane-bridge.mjs");
const REAL_CONFIG = join(HERE, "plane-bridge.json");
const SENTINEL = "tok-SENTINEL-123";
const HELD_EMAIL = "someone@example.com";

const DIRS = [];
const mk = (label) => {
  const d = mkdtempSync(join(tmpdir(), `plane-bridge-st-${process.pid}-${label}-`));
  DIRS.push(d);
  return d;
};
const sha = (s) => createHash("sha256").update(s).digest("hex");
const OUTPUTS = []; // every stdout/stderr of every child, for the leak scans

let failures = 0;
function report(name, ok, why = "") {
  if (!ok) failures++;
  console.log(ok ? `PASS ${name}` : `FAIL ${name}: ${why}`);
}

// ── fixtures ────────────────────────────────────────────────────────────────
function cat(id, title, extra = {}) {
  return {
    id,
    title,
    location: "apps/acme/src/self-test.ts",
    severity: "medium",
    register: "Open",
    batch: "F01",
    source: "plane-bridge-self-test",
    filedAt: "2026-11-01",
    sensitive: false,
    sensitiveFor: [],
    ...extra,
  };
}
function st(id, batch, state, extra = {}) {
  return { id, batch, tier: "T1", state, pr: null, proof: null, evidence: null, ...extra };
}
function fixtureRows({ withHeld = true } = {}) {
  const catalogue = [
    cat("B1", "Acme queued bug"),
    cat("B2", "Acme done bug", { severity: "high" }),
    cat("B3", "Acme never campaigned", { severity: "low", batch: null }),
    cat("B4", "Acme already fixed", { severity: "critical", batch: "F02" }),
    cat("B5", "T".repeat(300)),
    cat("B6", "Acme escape bug", { symptom: "<b>&\"quote'</b> a b" }),
  ];
  const status = [
    st("B1", "F01", "queued"),
    st("B2", "F01", "done", { pr: 12, proof: "REG-B2 acme proof" }),
    st("B4", "F02", "already-fixed", { roundSha: "abc12345", buildPlan: "acme/build-plan.md" }),
    st("B6", "F02", "in-flight"),
  ];
  if (withHeld) {
    catalogue.push(cat("B7", "Acme held row", { symptom: `contact ${HELD_EMAIL}` }));
    status.push(st("B7", "F02", "queued"));
  }
  return { catalogue, status };
}
const jl = (rows) => rows.map((r) => JSON.stringify(r) + "\n").join("");
function makeRegistry(opts) {
  const dir = mk("reg");
  mkdirSync(join(dir, "status"), { recursive: true });
  const { catalogue, status } = fixtureRows(opts);
  writeFileSync(join(dir, "bugs.jsonl"), jl(catalogue));
  writeFileSync(join(dir, "status", "F00.jsonl"), "");
  for (const b of ["F01", "F02"]) {
    writeFileSync(join(dir, "status", `${b}.jsonl`), jl(status.filter((s) => s.batch === b)));
  }
  return dir;
}
function readTree(dir) {
  const out = {};
  const walk = (d, rel) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p, `${rel}${e.name}/`);
      else out[`${rel}${e.name}`] = readFileSync(p, "utf8");
    }
  };
  if (existsSync(dir)) walk(dir, "");
  return out;
}
const withoutId = (text, id) =>
  text
    .split("\n")
    .filter((l) => l && JSON.parse(l).id !== id)
    .map((l) => l + "\n")
    .join("");

function makeConfig(owner) {
  const cfg = JSON.parse(readFileSync(REAL_CONFIG, "utf8"));
  cfg.registries.bugs.owner = owner;
  const p = join(mk("cfg"), "plane-bridge.json");
  writeFileSync(p, JSON.stringify(cfg));
  return p;
}
const TOKEN_FILE = join(mk("tok"), "token");
writeFileSync(TOKEN_FILE, `${SENTINEL}\n`);
const MACHINE = mk("machine");
const CFG_REGISTRY = makeConfig("registry");
const CFG_PLANE = makeConfig("plane");

const freshFake = () =>
  startFakePlane({ projects: [{ id: "proj-demo", identifier: "ROUTE", name: "Demo" }] });

function runCli(argv, { registryDir, server, config = CFG_REGISTRY, tokenFile = TOKEN_FILE } = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("PLANE_")) delete env[k];
  env.PLANE_SYNC_SELF_TEST = "1";
  env.PLANE_MACHINE_ROOT = MACHINE;
  env.PLANE_SYNC_STATE_DIR = join(MACHINE, "state");
  env.PLANE_RUNS_PATH = join(MACHINE, "runs.jsonl");
  if (registryDir) env.PLANE_SYNC_REGISTRY_DIR = registryDir;
  if (server) env.PLANE_BRIDGE_BASE_URL = server.url;
  if (config) env.PLANE_BRIDGE_CONFIG = config;
  if (tokenFile) env.PLANE_BRIDGE_TOKEN_FILE = tokenFile;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...argv], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), CLI_BUDGET_MS);
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (code) => {
      clearTimeout(timer);
      OUTPUTS.push(stdout, stderr);
      resolve({ code, stdout, stderr, all: stdout + stderr });
    });
  });
}

const writesOf = (server, from = 0) =>
  server.requests.slice(from).filter((r) => r.method !== "GET");
const itemsOf = (server) => server.state.workItems.BUGS ?? [];
const itemOf = (server, id) => itemsOf(server).find((i) => i.external_id === id);
const stateId = (server, name) => server.state.states.BUGS.find((s) => s.name === name)?.id;
const stateName = (server, sid) => server.state.states.BUGS.find((s) => s.id === sid)?.name;

async function seeded(registryDir) {
  const server = await freshFake();
  const r = await runCli(["push", "--apply", "--max-writes", "100"], { registryDir, server });
  return { server, push: r };
}
async function regenOut(registryDir, server, extra = []) {
  const out = mk("out");
  const r = await runCli(["regen", "--out", out, ...extra], { registryDir, server });
  return { ...r, out, tree: readTree(out) };
}

// ── cases ───────────────────────────────────────────────────────────────────
async function t1() {
  let codec;
  let cfg;
  try {
    codec = await import("./plane-bridge-codec.mjs");
    cfg = JSON.parse(readFileSync(REAL_CONFIG, "utf8")).registries.bugs;
  } catch (e) {
    report("T1 codec round-trips every record", false, `codec unavailable: ${e.message}`);
    return;
  }
  const names = new Map(cfg.states.map((s) => [`sid-${s.name}`, s.name]));
  const sidOf = (n) => `sid-${n}`;
  const roundTrip = (rec) => {
    const enc = codec.encodeItem(rec, cfg);
    const item = {
      name: enc.name,
      description_html: enc.description_html,
      priority: enc.priority,
      state: sidOf(enc.stateName),
      external_source: enc.external_source,
      external_id: enc.external_id,
    };
    const dec = codec.decodeItem(item, names, cfg);
    return dec.problem === null && dec.edits.length === 0 && codec.sameRecord(dec.record, rec);
  };
  const fxDir = makeRegistry({ withHeld: true });
  const fx = [...codec.recordsFromRegistry(fxDir).values()];
  const badFx = fx.filter((r) => !roundTrip(r)).map((r) => r.catalogue.id);
  report("T1 codec round-trips every fixture record", badFx.length === 0, `lossy: ${badFx}`);
  let real = null;
  try {
    real = registryRoot();
  } catch {
    real = null;
  }
  if (!real || !existsSync(join(real, "bugs.jsonl"))) {
    report("T1 codec round-trips the live register (SKIP: register absent)", true);
    return;
  }
  const all = [...codec.recordsFromRegistry(real).values()];
  const bad = all.filter((r) => !roundTrip(r)).map((r) => r.catalogue.id);
  report(
    `T1 codec round-trips the live register (${all.length} rows)`,
    bad.length === 0 && all.length > 0,
    `lossy ids: ${bad.slice(0, 5)}`,
  );
}

async function t2t6t10t11a() {
  const reg = makeRegistry();
  const { server, push } = await seeded(reg);
  try {
    report(
      "T2 push --apply exits 0 (held is not an error)",
      push.code === 0,
      `exit ${push.code} ${push.all}`,
    );
    const g = await regenOut(reg, server);
    const want = readTree(reg);
    const catOk = g.tree["bugs.jsonl"] === withoutId(want["bugs.jsonl"], "B7");
    report(
      "T2 regen --out reproduces bugs.jsonl byte-for-byte (minus held)",
      catOk,
      `sha ${sha(g.tree["bugs.jsonl"] ?? "")} vs ${sha(withoutId(want["bugs.jsonl"], "B7"))}`,
    );
    const shardsOk = ["F00", "F01", "F02"].every(
      (b) => (g.tree[`status/${b}.jsonl`] ?? "") === withoutId(want[`status/${b}.jsonl`], "B7"),
    );
    report(
      "T2 regen --out reproduces every shard byte-for-byte (minus held)",
      shardsOk,
      "shard text differs",
    );
    const chk = await runCli(["regen", "--check"], { registryDir: reg, server });
    report(
      "T2 regen --check clean with one held row",
      chk.code === 0 && /clean/.test(chk.stdout) && /held 1/.test(chk.stdout),
      `${chk.code} ${chk.all}`,
    );

    // T6
    const bodies = JSON.stringify(server.requests.map((r) => r.body));
    report(
      "T6 held row never in any request body",
      !bodies.includes(HELD_EMAIL) && !itemOf(server, "B7"),
      "found in a body",
    );
    const stat = await runCli(["status"], { registryDir: reg, server });
    report(
      "T6 status says held 1 and flip preconditions not met",
      /held 1/.test(stat.stdout) && /flip preconditions: not met/.test(stat.stdout),
      stat.stdout,
    );

    // T10
    const w = writesOf(server);
    const states = w.filter((r) => r.path.endsWith("/states/")).map((r) => r.body.name);
    report(
      "T10 project created first, then the 4 missing states in order",
      w[0]?.method === "POST" &&
        w[0].path.endsWith("/projects/") &&
        JSON.stringify(states) ===
          JSON.stringify(["Ready for agent", "Agent working", "Needs approval", "Blocked"]) &&
        w.slice(1, 5).every((r) => r.path.endsWith("/states/")),
      JSON.stringify(w.slice(0, 6).map((r) => `${r.method} ${r.path}`)),
    );
    const items = w.filter((r) => r.path.endsWith("/work-items/"));
    const got = items.map((r) => `${r.body.external_id}:${stateName(server, r.body.state)}`);
    const exp = [
      "B1:Backlog",
      "B2:Done",
      "B3:Backlog",
      "B4:Cancelled",
      "B5:Backlog",
      "B6:In Progress",
    ];
    report(
      "T10 item creates land in the mapped states",
      JSON.stringify(got) === JSON.stringify(exp),
      JSON.stringify(got),
    );
    report(
      "T10 long title cut to 255",
      items.find((r) => r.body.external_id === "B5")?.body.name.length === 255,
      "name length",
    );

    // T11a
    const before = readTree(reg);
    const ip = await runCli(["regen"], { registryDir: reg, server });
    report(
      "T11 in-place regen refused while registry-owned (exit 2, message)",
      ip.code === 2 &&
        /refused — bugs is registry-owned/.test(ip.all) &&
        JSON.stringify(readTree(reg)) === JSON.stringify(before),
      `${ip.code} ${ip.all}`,
    );
  } finally {
    await server.close();
  }
}

async function t3() {
  const reg = makeRegistry();
  const { server } = await seeded(reg);
  try {
    itemOf(server, "B1").state = stateId(server, "In Progress");
    itemOf(server, "B2").priority = "urgent";
    itemOf(server, "B3").name = "B3 · renamed";
    const g = await regenOut(reg, server);
    const cats = (g.tree["bugs.jsonl"] ?? "")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const sts = (g.tree["status/F01.jsonl"] ?? "")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const ok =
      sts.find((s) => s.id === "B1")?.state === "in-flight" &&
      cats.find((c) => c.id === "B2")?.severity === "critical" &&
      cats.find((c) => c.id === "B3")?.title === "renamed";
    report("T3 Plane edits (state, priority, name) show up in regen", ok, g.all);
    const from = server.requests.length;
    const p = await runCli(["push", "--apply"], { registryDir: reg, server });
    report(
      "T3 push does not overwrite them (0 writes, pull-pending 3)",
      writesOf(server, from).length === 0 && /pull-pending 3/.test(p.stdout) && p.code === 0,
      `${writesOf(server, from).length} ${p.all}`,
    );
  } finally {
    await server.close();
  }
}

async function t4t5() {
  const reg = makeRegistry();
  const { server } = await seeded(reg);
  try {
    const rows = readFileSync(join(reg, "bugs.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    rows.find((r) => r.id === "B4").title = "Acme already fixed, retitled";
    writeFileSync(join(reg, "bugs.jsonl"), jl(rows));
    const from = server.requests.length;
    const p1 = await runCli(["push", "--apply"], { registryDir: reg, server });
    const w = writesOf(server, from);
    report(
      "T4 local edit pushes as exactly one PATCH to that item",
      p1.code === 0 &&
        w.length === 1 &&
        w[0].method === "PATCH" &&
        w[0].path.endsWith(`/${itemOf(server, "B4").id}/`),
      `${p1.all} ${w.length}`,
    );
    const from2 = server.requests.length;
    const p2 = await runCli(["push", "--apply"], { registryDir: reg, server });
    report(
      "T4 second push makes zero writes",
      p2.code === 0 && writesOf(server, from2).length === 0,
      p2.all,
    );

    // T5 (F3d): the SAME native (state) edited on both sides with different values
    itemOf(server, "B1").state = stateId(server, "Done");
    editRow(reg, "status", "B1", (r) => (r.state = "proven"));
    const from3 = server.requests.length;
    const p3 = await runCli(["push", "--apply"], { registryDir: reg, server });
    report(
      "T5 same field edited on both sides: conflict 1, exit 1, zero writes",
      p3.code === 1 && /conflict 1/.test(p3.stdout) && writesOf(server, from3).length === 0,
      `${p3.code} ${p3.all}`,
    );
  } finally {
    await server.close();
  }
}

function readJl(p) {
  return readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}
// Local edit helper: kind "cat" edits bugs.jsonl, "status" edits whichever shard holds the row.
function editRow(reg, kind, id, fn) {
  const files =
    kind === "cat"
      ? [join(reg, "bugs.jsonl")]
      : readdirSync(join(reg, "status")).map((f) => join(reg, "status", f));
  for (const f of files) {
    const rows = readJl(f);
    const row = rows.find((r) => r.id === id);
    if (!row) continue;
    fn(row);
    writeFileSync(f, jl(rows));
    return;
  }
  throw new Error(`editRow: ${id} not found`);
}
const bodyKeys = (r) => Object.keys(r.body).sort().join(",");

async function f1() {
  const reg = makeRegistry();
  const { server } = await seeded(reg);
  try {
    const before = JSON.stringify(readTree(reg));
    const a = await runCli(["regen", "--out", reg], { registryDir: reg, server });
    report(
      "F1 --out <registry dir> refused (exit 2), registry unchanged",
      a.code === 2 && /refused/.test(a.all) && JSON.stringify(readTree(reg)) === before,
      `${a.code} ${a.all}`,
    );
    const b = await runCli(["regen", "--out", join(reg, "status")], { registryDir: reg, server });
    report(
      "F1 --out inside the registry refused",
      b.code === 2 && JSON.stringify(readTree(reg)) === before,
      `${b.code}`,
    );
    const full = mk("full");
    writeFileSync(join(full, "keep.txt"), "x");
    const c = await runCli(["regen", "--out", full], { registryDir: reg, server });
    report(
      "F1 --out non-empty directory refused, file kept",
      c.code === 2 && readdirSync(full).join() === "keep.txt",
      `${c.code} ${c.all}`,
    );
    // M2: a junction/symlink pointing into the registry
    mkdirSync(join(reg, "emptydir"));
    const before2 = JSON.stringify(readTree(reg));
    const link = join(mk("link"), "out-link");
    symlinkSync(join(reg, "emptydir"), link, "junction");
    const d = await runCli(["regen", "--out", link], { registryDir: reg, server });
    report(
      "M2 --out through a junction into the registry refused, registry unchanged",
      d.code === 2 && JSON.stringify(readTree(reg)) === before2,
      `${d.code} ${d.all}`,
    );
    const link2 = join(mk("link"), "out-link");
    symlinkSync(reg, link2, "junction");
    const e = await runCli(["regen", "--out", join(link2, "new-sub")], {
      registryDir: reg,
      server,
    });
    report(
      "M2 --out under a not-yet-existing child of a linked parent refused",
      e.code === 2 && !existsSync(join(reg, "new-sub")),
      `${e.code} ${e.all}`,
    );
  } finally {
    await server.close();
  }
}

async function m1() {
  const reg = makeRegistry({ withHeld: false });
  const { server } = await seeded(reg);
  try {
    const f01 = join(reg, "status", "F01.jsonl");
    const orig = readFileSync(f01, "utf8");
    const extra = orig.split("\n").filter(Boolean)[1] + "\n";
    writeFileSync(f01, orig + extra);
    const before = JSON.stringify(readTree(reg));
    const a = await runCli(["regen"], { registryDir: reg, server, config: CFG_PLANE });
    report(
      "M1 in-place regen refuses when a tracked line would be dropped (exit 1, files unchanged)",
      a.code === 1 && /refused/.test(a.all) && JSON.stringify(readTree(reg)) === before,
      `${a.code} ${a.all}`,
    );
    const b = await runCli(["regen", "--accept-removals"], {
      registryDir: reg,
      server,
      config: CFG_PLANE,
    });
    report(
      "M1 --accept-removals writes the canonical shard",
      b.code === 0 && readFileSync(f01, "utf8") === orig,
      `${b.code} ${b.all}`,
    );
    const lines = orig.split("\n").filter(Boolean);
    writeFileSync(
      f01,
      lines
        .slice()
        .reverse()
        .map((l) => l + "\n")
        .join(""),
    );
    const c = await runCli(["regen"], { registryDir: reg, server, config: CFG_PLANE });
    report(
      "M1 order-only difference is still written, sorted",
      c.code === 0 && readFileSync(f01, "utf8") === orig,
      `${c.code} ${c.all}`,
    );
  } finally {
    await server.close();
  }
}

async function f2() {
  const reg = makeRegistry();
  const { server } = await seeded(reg);
  try {
    const created = itemOf(server, "B4").description_html;
    report(
      "F2 create sends the payload block only",
      /^<pre><code>routeflow-bridge\/v1 sha256=/.test(created) && !/<p>/.test(created),
      created.slice(0, 60),
    );
    const it = itemOf(server, "B4");
    it.description_html = `<p>HUMAN NOTE</p>${it.description_html}<p>TAIL NOTE</p>`;
    editRow(reg, "cat", "B4", (r) => (r.title = "Acme already fixed v2"));
    const from = server.requests.length;
    const p = await runCli(["push", "--apply"], { registryDir: reg, server });
    const after = itemOf(server, "B4").description_html;
    report(
      "F2 update keeps human text outside the block and replaces the block",
      p.code === 0 &&
        writesOf(server, from).length === 1 &&
        after.startsWith("<p>HUMAN NOTE</p><pre>") &&
        after.endsWith("<p>TAIL NOTE</p>") &&
        after.includes("Acme already fixed v2"),
      after.slice(0, 80),
    );
    const g = await regenOut(reg, server);
    report(
      "F2 text outside the block never reaches the registry",
      !g.tree["bugs.jsonl"].includes("HUMAN") && !g.tree["bugs.jsonl"].includes("NOTE"),
      "leaked",
    );
    const codec = await import("./plane-bridge-codec.mjs");
    const cfg = JSON.parse(readFileSync(REAL_CONFIG, "utf8")).registries.bugs;
    const enc = codec.encodeItem(
      { catalogue: { id: "B9", title: "t", severity: "low", batch: "F01" }, status: null },
      cfg,
    );
    const appended = codec.spliceDescription("<p>only human</p>", enc);
    report(
      "F2 splice with no block appends it after the human text",
      appended === `<p>only human</p>${enc.description_html}`,
      appended.slice(0, 60),
    );
    // an item with no block is a conflict at push time (never overwritten blind)
    itemOf(server, "B4").description_html = "<p>only human</p>";
    editRow(reg, "cat", "B4", (r) => (r.title = "Acme already fixed v3"));
    const from2 = server.requests.length;
    const nb = await runCli(["push", "--apply"], { registryDir: reg, server });
    report(
      "F2 item without a block: conflict no-payload, description untouched",
      nb.code === 1 &&
        /no-payload/.test(nb.stdout) &&
        writesOf(server, from2).length === 0 &&
        itemOf(server, "B4").description_html === "<p>only human</p>",
      nb.all,
    );
  } finally {
    await server.close();
  }
}

async function f3() {
  const reg = makeRegistry();
  const { server } = await seeded(reg);
  try {
    // (a) Plane Done absorbed locally -> one rebaseline PATCH with no natives; then a local change updates
    itemOf(server, "B1").state = stateId(server, "Done");
    editRow(reg, "status", "B1", (r) => (r.state = "done"));
    let from = server.requests.length;
    const a = await runCli(["push", "--apply"], { registryDir: reg, server });
    let w = writesOf(server, from);
    report(
      "F3a absorbed Plane edit: 1 rebaseline PATCH, body has no state/name/priority",
      a.code === 0 &&
        /rebaseline 1/.test(a.stdout) &&
        w.length === 1 &&
        bodyKeys(w[0]) === "description_html",
      `${a.all} ${w.map(bodyKeys)}`,
    );
    editRow(reg, "status", "B1", (r) => (r.pr = 99));
    from = server.requests.length;
    const a2 = await runCli(["push", "--apply"], { registryDir: reg, server });
    w = writesOf(server, from);
    report(
      "F3a next local change is an update, not a conflict",
      a2.code === 0 && /update 1/.test(a2.stdout) && /conflict 0/.test(a2.stdout) && w.length === 1,
      a2.all,
    );
    // (b) no-status row moved in Plane + local title edit -> name only, Plane state kept
    itemOf(server, "B3").state = stateId(server, "In Progress");
    editRow(reg, "cat", "B3", (r) => (r.title = "Acme never campaigned v2"));
    from = server.requests.length;
    const b = await runCli(["push", "--apply"], { registryDir: reg, server });
    w = writesOf(server, from);
    report(
      "F3b no-status row: PATCH carries name only and the item keeps In Progress",
      b.code === 0 &&
        w.length === 1 &&
        bodyKeys(w[0]) === "description_html,name" &&
        stateName(server, itemOf(server, "B3").state) === "In Progress",
      `${b.all} ${w.map(bodyKeys)}`,
    );
    // (c) Blocked item + local pr change -> no state in the PATCH
    itemOf(server, "B6").state = stateId(server, "Blocked");
    editRow(reg, "status", "B6", (r) => (r.pr = 5));
    from = server.requests.length;
    const c = await runCli(["push", "--apply"], { registryDir: reg, server });
    w = writesOf(server, from);
    report(
      "F3c Blocked stays Blocked: PATCH has no state key",
      c.code === 0 &&
        w.length === 1 &&
        !("state" in w[0].body) &&
        stateName(server, itemOf(server, "B6").state) === "Blocked",
      `${c.all} ${w.map(bodyKeys)}`,
    );
  } finally {
    await server.close();
  }
  const reg2 = makeRegistry();
  const s2 = await seeded(reg2);
  try {
    // (d) same field both sides
    itemOf(s2.server, "B2").state = stateId(s2.server, "In Progress");
    editRow(reg2, "status", "B2", (r) => (r.state = "proven"));
    const from = s2.server.requests.length;
    const d = await runCli(["push", "--apply"], { registryDir: reg2, server: s2.server });
    report(
      "F3d same native on both sides: conflict, exit 1, no writes",
      d.code === 1 && /conflict 1/.test(d.stdout) && writesOf(s2.server, from).length === 0,
      d.all,
    );
  } finally {
    await s2.server.close();
  }
  const reg3 = makeRegistry();
  const s3 = await seeded(reg3);
  try {
    // (e) duplicate external_id
    const orig = itemOf(s3.server, "B5");
    s3.server.state.workItems.BUGS.push({ ...orig, id: "item-dup" });
    editRow(reg3, "cat", "B5", (r) => (r.title = "changed"));
    const from = s3.server.requests.length;
    const e = await runCli(["push", "--apply"], { registryDir: reg3, server: s3.server });
    report(
      "F3e duplicate external_id: counted, exit 1, row never written",
      e.code === 1 && /duplicate 1/.test(e.stdout) && writesOf(s3.server, from).length === 0,
      e.all,
    );
  } finally {
    await s3.server.close();
  }
}

async function f4() {
  const reg = makeRegistry();
  const { server } = await seeded(reg);
  try {
    const f01 = join(reg, "status", "F01.jsonl");
    const orig = readFileSync(f01, "utf8");
    const ls = orig.split("\n").filter(Boolean);
    writeFileSync(
      f01,
      ls
        .slice()
        .reverse()
        .map((l) => l + "\n")
        .join(""),
    );
    const a = await runCli(["regen", "--check"], { registryDir: reg, server });
    report(
      "F4 unsorted tracked shard is clean with order-only 1",
      a.code === 0 && /clean/.test(a.stdout) && /order-only 1/.test(a.stdout),
      `${a.code} ${a.all}`,
    );
    writeFileSync(f01, orig.replace('"id":"B1",', '"id":"B1", '));
    const b = await runCli(["regen", "--check"], { registryDir: reg, server });
    report(
      "F4 non-canonical tracked line (extra space) is drift",
      b.code === 1 && /shards differ 1/.test(b.stdout),
      `${b.code} ${b.all}`,
    );
    writeFileSync(f01, orig + ls[1] + "\n");
    const c = await runCli(["regen", "--check"], { registryDir: reg, server });
    report(
      "F4 duplicated status row is drift",
      c.code === 1 && /shards differ 1/.test(c.stdout),
      `${c.code} ${c.all}`,
    );
    writeFileSync(f01, orig);
    const catPath = join(reg, "bugs.jsonl");
    writeFileSync(catPath, readFileSync(catPath, "utf8").replace("\n", "  \n"));
    const d = await runCli(["regen", "--check"], { registryDir: reg, server });
    report(
      "F4 trailing whitespace in bugs.jsonl is drift",
      d.code === 1 && /catalogue differs/.test(d.stdout),
      `${d.code} ${d.all}`,
    );
  } finally {
    await server.close();
  }
}

async function f5f6() {
  const codec = await import("./plane-bridge-codec.mjs");
  const reg = JSON.parse(readFileSync(REAL_CONFIG, "utf8")).registries.bugs;
  const names = new Map(reg.states.map((s) => [`sid-${s.name}`, s.name]));
  const asItem = (enc, over = {}) => ({
    name: enc.name,
    description_html: enc.description_html,
    priority: enc.priority,
    state: `sid-${enc.stateName}`,
    external_source: enc.external_source,
    external_id: enc.external_id,
    ...over,
  });
  const rec = (title, extra = {}) => ({
    catalogue: { id: "B9", title, severity: "low", batch: "F01", ...extra },
    status: null,
  });
  const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
  // F5
  const e1 = codec.encodeItem(rec("x".repeat(245) + "😀".repeat(12)), reg);
  const d1 = codec.decodeItem(asItem(e1), names, reg);
  report(
    "F5 name cut at a code point: no lone surrogate, 255 code points, no edit",
    !lone.test(e1.name) &&
      Array.from(e1.name).length === 255 &&
      d1.problem === null &&
      d1.edits.length === 0,
    `${Array.from(e1.name).length} ${d1.edits}`,
  );
  const e2 = codec.encodeItem(rec("abc "), reg);
  const d2 = codec.decodeItem(asItem(e2, { name: e2.name.trim() }), names, reg);
  report(
    "F5 Plane trimming a trailing space is not an edit",
    d2.edits.length === 0 && d2.problem === null,
    `${d2.edits}`,
  );
  // F6
  const hashOf = (t) => createHash("sha256").update(t).digest("hex");
  const r3 = rec("t", { symptom: "&lt;" });
  const j3 = JSON.stringify(r3);
  const h3 = `<pre><code>routeflow-bridge/v1 sha256=${hashOf(j3)}\n${j3.replace(/&/g, "&#38;")}</code></pre>`;
  const d3 = codec.decodeItem(
    asItem(codec.encodeItem(r3, reg), { description_html: h3 }),
    names,
    reg,
  );
  report(
    "F6 &#38;lt; decodes to the literal &lt; (single pass)",
    d3.problem === null && d3.record.catalogue.symptom === "&lt;",
    String(d3.problem),
  );
  const r4 = rec("t", { symptom: "it's \"q\" <b> & x y 'z'" });
  const j4 = JSON.stringify(r4);
  let first = true;
  const body4 = j4
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, () => {
      const o = first ? "&#x27;" : "&apos;";
      first = false;
      return o;
    })
    .replace(/ /g, "&nbsp;");
  const h4 = `<pre class="a"><code class="b">routeflow-bridge/v1 sha256=${hashOf(j4)}<br>${body4}</code></pre>`;
  const d4 = codec.decodeItem(
    asItem(codec.encodeItem(r4, reg), { description_html: h4 }),
    names,
    reg,
  );
  report(
    "F6 sanitiser variant (class attrs, &#x27;, &apos;, <br>, &nbsp;) round-trips",
    d4.problem === null && codec.sameRecord(d4.record, r4),
    String(d4.problem),
  );
}

async function f10() {
  const codec = await import("./plane-bridge-codec.mjs");
  const reg = JSON.parse(readFileSync(REAL_CONFIG, "utf8")).registries.bugs;
  const bad = {
    catalogue: { id: "B9", title: "t", severity: "low", batch: "F01" },
    status: { id: "B9", batch: null, state: "queued" },
  };
  const e = codec.encodeItem(bad, reg);
  const d = codec.decodeItem(
    {
      name: e.name,
      description_html: e.description_html,
      priority: e.priority,
      state: `sid-${e.stateName}`,
      external_id: "B9",
    },
    new Map(),
    reg,
  );
  report(
    "F10 codec: status row with null batch decodes as problem no-batch",
    d.problem === "no-batch",
    String(d.problem),
  );
  const dir = makeRegistry();
  editRow(dir, "status", "B1", (r) => (r.batch = null));
  const server = await freshFake();
  try {
    const dry = await runCli(["push"], { registryDir: dir, server });
    report(
      "F10 push dry run reports the no-batch row as a conflict",
      dry.code === 1 && /conflict 1/.test(dry.stdout) && /no-batch/.test(dry.stdout),
      dry.all,
    );
    const ap = await runCli(["push", "--apply", "--max-writes", "100"], {
      registryDir: dir,
      server,
    });
    report(
      "F10 no-batch row never written (no item, exit 1)",
      ap.code === 1 && !itemOf(server, "B1"),
      ap.all,
    );
  } finally {
    await server.close();
  }
}

async function t7() {
  const reg = makeRegistry();
  const server = await freshFake();
  try {
    const r = await runCli(["push"], { registryDir: reg, server });
    const line = r.stdout;
    report("T7 dry run makes zero writes", writesOf(server).length === 0 && r.code === 0, r.all);
    const need = ["project create", "states +4", "create 6", "held 1", "needs --max-writes 11"];
    report(
      "T7 dry run reports the plan",
      need.every((s) => line.includes(s)),
      line,
    );
    const j = await runCli(["push", "--json"], { registryDir: reg, server });
    let parsed = null;
    try {
      parsed = JSON.parse(j.stdout);
    } catch {
      parsed = null;
    }
    report(
      "T7 --json is one object with the same counts",
      parsed?.neededMaxWrites === 11 && parsed?.counts?.create === 6 && parsed?.counts?.held === 1,
      j.stdout,
    );
  } finally {
    await server.close();
  }
}

async function t8() {
  const reg = makeRegistry();
  const { server } = await seeded(reg);
  try {
    // failing routes: an unreachable base URL and a missing workspace project
    const dead = { url: "http://127.0.0.1:9" };
    const a = await runCli(["push", "--apply"], { registryDir: reg, server: dead });
    report("T8 unreachable target fails without leaking the token", a.code !== 0, `exit ${a.code}`);
    const blob = OUTPUTS.join("\n");
    const files = readTree(MACHINE);
    const inFiles = Object.values(files).some((t) => t.includes(SENTINEL));
    report(
      "T8 token absent from stdout, stderr, machine files and the write ledger",
      !blob.includes(SENTINEL) && !inFiles && Object.keys(files).length > 0,
      `blob ${blob.includes(SENTINEL)} files ${inFiles}`,
    );
    // F9: a server that echoes X-API-Key in a 401 body; the scrub must catch it
    const echo = createServer((req, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `bad key ${req.headers["x-api-key"]}` }));
    });
    await new Promise((r) => echo.listen(0, "127.0.0.1", r));
    try {
      const url = `http://127.0.0.1:${echo.address().port}`;
      const x = await runCli(["status"], { registryDir: reg, server: { url } });
      report(
        "F9 echoed key is redacted in stderr, never the sentinel",
        x.code !== 0 && x.all.includes("<redacted>") && !x.all.includes(SENTINEL),
        x.all,
      );
      const runs = readTree(MACHINE);
      report(
        "F9 sentinel absent from every machine file after the echo",
        !Object.values(runs).some((t) => t.includes(SENTINEL)),
        "found in machine files",
      );
    } finally {
      await new Promise((r) => echo.close(r));
    }
    const missing = join(mk("notoken"), "absent");
    const d = await runCli(["push"], { registryDir: reg, server, tokenFile: missing });
    report(
      "T8 missing token file skips (exit 0)",
      d.code === 0 && /skipped \(no token file\)/.test(d.all),
      d.all,
    );
    const e = await runCli(["push", "--apply"], { registryDir: reg, server, tokenFile: missing });
    report(
      "T8 missing token file with --apply exits 2",
      e.code === 2 && /skipped \(no token file\)/.test(e.all),
      `${e.code} ${e.all}`,
    );
  } finally {
    await server.close();
  }
}

async function t9() {
  const reg = makeRegistry();
  const { server } = await seeded(reg);
  try {
    const a = await runCli(["regen", "--check"], { registryDir: reg, server });
    report("T9a clean check exits 0", a.code === 0 && /clean/.test(a.stdout), `${a.code} ${a.all}`);
    const it = itemOf(server, "B2");
    const saved = it.description_html;
    it.description_html = saved.replace(
      /sha256=([0-9a-f])/,
      (_, c) => `sha256=${c === "0" ? "1" : "0"}`,
    );
    const b = await runCli(["regen", "--check"], { registryDir: reg, server });
    report(
      "T9b corrupt payload: exit 1, problems 1",
      b.code === 1 && /problems 1/.test(b.stdout),
      `${b.code} ${b.all}`,
    );
    it.description_html = saved;
    const idx = itemsOf(server).findIndex((i) => i.external_id === "B5");
    itemsOf(server).splice(idx, 1);
    const c = await runCli(["regen", "--check"], { registryDir: reg, server });
    report(
      "T9c row missing from Plane: exit 1, missing-in-plane 1",
      c.code === 1 && /missing-in-plane 1/.test(c.stdout),
      `${c.code} ${c.all}`,
    );
  } finally {
    await server.close();
  }
}

async function t11b() {
  const reg = makeRegistry({ withHeld: false });
  const { server } = await seeded(reg);
  try {
    const before = readTree(reg);
    const r = await runCli(["regen"], { registryDir: reg, server, config: CFG_PLANE });
    report(
      "T11 plane-owned in-place regen on a clean Plane leaves files byte-identical",
      r.code === 0 && JSON.stringify(readTree(reg)) === JSON.stringify(before),
      `${r.code} ${r.all}`,
    );
    itemOf(server, "B1").priority = "urgent";
    const r2 = await runCli(["regen"], { registryDir: reg, server, config: CFG_PLANE });
    const cats = readFileSync(join(reg, "bugs.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    report(
      "T11 plane-owned in-place regen writes a Plane edit",
      r2.code === 0 && cats.find((c) => c.id === "B1")?.severity === "critical",
      r2.all,
    );
  } finally {
    await server.close();
  }
}

async function t13() {
  const server = await freshFake();
  try {
    const h = await runCli(["--help"], { server, config: null, tokenFile: null });
    const b = await runCli(["--bogus"], { server, config: null, tokenFile: null });
    const v = await runCli(["bogusverb"], { server, config: null, tokenFile: null });
    report(
      "T13 --help exits 0, unknown flag and verb exit 2, all print Usage",
      h.code === 0 && b.code === 2 && v.code === 2 && [h, b, v].every((x) => /Usage:/.test(x.all)),
      `${h.code}/${b.code}/${v.code}`,
    );
    report(
      "T13 usage handled before any network read",
      server.requests.length === 0,
      `${server.requests.length} requests`,
    );
  } finally {
    await server.close();
  }
  const uuidRe = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  const files = [
    "plane-bridge.json",
    "plane-bridge-config.mjs",
    "plane-bridge-codec.mjs",
    "plane-bridge.mjs",
  ];
  const hit = files.filter(
    (f) => existsSync(join(HERE, f)) && uuidRe.test(readFileSync(join(HERE, f), "utf8")),
  );
  report("T13 no uuid-shaped literal in the new files", hit.length === 0, hit.join(","));
  const cli = existsSync(SCRIPT) ? readFileSync(SCRIPT, "utf8") : "";
  report(
    "G4 pin: the CLI never builds or reads description_html / external_id itself",
    cli.length > 0 && !/description_html|external_id/.test(cli),
    "found in plane-bridge.mjs",
  );
}

async function t14() {
  const reg = makeRegistry();
  const { server } = await seeded(reg);
  try {
    itemOf(server, "B3").state = stateId(server, "Done");
    itemOf(server, "B1").state = stateId(server, "Blocked");
    const g = await regenOut(reg, server);
    const f01 = (g.tree["status/F01.jsonl"] ?? "")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const ok =
      !Object.values(g.tree).join("").includes('"id":"B3","batch"') &&
      f01.find((s) => s.id === "B1")?.state === "queued" &&
      /not representable/.test(g.all);
    report(
      "T14 no-status state edit warns and is kept out; Blocked keeps the payload state",
      ok,
      g.all,
    );
  } finally {
    await server.close();
  }
}

async function t15() {
  const reg = makeRegistry();
  const server = await freshFake();
  try {
    const a = await runCli(["push", "--apply", "--max-writes", "3"], { registryDir: reg, server });
    report(
      "T15 --max-writes 3 does 3 writes and defers the rest",
      writesOf(server).length === 3 && /deferred [1-9]/.test(a.stdout),
      `${writesOf(server).length} ${a.all}`,
    );
    const b = await runCli(["push", "--apply", "--max-writes", "100"], {
      registryDir: reg,
      server,
    });
    const posts = writesOf(server).filter(
      (r) => r.method === "POST" && r.path.endsWith("/work-items/"),
    );
    report(
      "T15 re-run completes with no duplicates (6 item POSTs total)",
      b.code === 0 && posts.length === 6 && itemsOf(server).length === 6,
      `${posts.length} ${itemsOf(server).length} ${b.all}`,
    );
    const c = await runCli(["push", "--apply"], { registryDir: reg, server });
    const total = writesOf(server).length;
    report("T15 third push is a no-op", c.code === 0 && writesOf(server).length === total, c.all);
    const reg2 = makeRegistry();
    const s2 = await freshFake();
    try {
      await runCli(["push", "--apply", "--max-writes", "100", "--limit", "2"], {
        registryDir: reg2,
        server: s2,
      });
      const items = writesOf(s2).filter((r) => r.path.endsWith("/work-items/"));
      report("T15 --limit caps item writes", items.length === 2, `${items.length}`);
    } finally {
      await s2.close();
    }
  } finally {
    await server.close();
  }
}

const CASES = [
  ["F1", f1],
  ["M1", m1],
  ["F2", f2],
  ["F3", f3],
  ["F4", f4],
  ["F5/F6", f5f6],
  ["F10", f10],
  ["T1", t1],
  ["T2/T6/T10/T11", t2t6t10t11a],
  ["T3", t3],
  ["T4/T5", t4t5],
  ["T7", t7],
  ["T8", t8],
  ["T9", t9],
  ["T11b", t11b],
  ["T13", t13],
  ["T14", t14],
  ["T15", t15],
];
try {
  for (const [name, fn] of CASES) {
    try {
      await fn();
    } catch (e) {
      report(`${name} crashed`, false, e.message);
    }
  }
  const blob = OUTPUTS.join("\n");
  report(
    "T6 held email never printed by any command",
    !blob.includes(HELD_EMAIL),
    "email on stdout/stderr",
  );
} finally {
  for (const d of DIRS) rmSync(d, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
