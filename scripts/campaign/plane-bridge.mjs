#!/usr/bin/env node
// plane-bridge.mjs — RouteFlow registry <-> local Plane CE bridge (AI OS plan step 2.2).
//   node scripts/campaign/plane-bridge.mjs <status|push|regen> [flags]   (npm run plane:bridge)
// Built on plane-client.mjs (the one HTTP client: denylist, budget, ledger). Every conversion
// between a registry row and a Plane work item lives in plane-bridge-codec.mjs. Dry by default.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { appendRun, createClient, loadDenylist, scanForbidden } from "./plane-client.mjs";
import { registryRoot } from "../lib/registry-root.mjs";
import { bridgeBaseUrl, loadBridgeConfig, readBridgeToken } from "./plane-bridge-config.mjs";
import {
  catalogueText,
  compareTracked,
  decideRow,
  decodeItem,
  encodeItem,
  itemBody,
  itemPatch,
  linkOf,
  recordsFromRegistry,
  sameRecord,
  scanText,
  shardTexts,
} from "./plane-bridge-codec.mjs";

export const BRIDGE_DEFAULT_MAX_WRITES = 25;
// What Plane gives a brand-new project (used only to plan states in a dry run).
const PLANE_DEFAULT_STATE_NAMES = ["backlog", "todo", "in progress", "done", "cancelled"];

const USAGE = `Usage: node scripts/campaign/plane-bridge.mjs <status|push|regen> [flags]
  status                  owner, counts and the ownership-flip preconditions
  push                    registry -> Plane (dry run unless --apply)
  regen                   Plane -> registry files (--check, --out <dir>, or in place when plane-owned)
Flags: --registry bugs  --apply  --max-writes <n>  --limit <n>  --check  --present-only
       --out <dir>  --accept-removals  --json  --help`;

const VERBS = new Set(["status", "push", "regen"]);
const BOOL = new Set(["--apply", "--check", "--present-only", "--accept-removals", "--json"]);
const VALUE = new Set(["--registry", "--max-writes", "--limit", "--out"]);

function parseArgs(argv) {
  const flags = {};
  let verb = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") return { help: true };
    if (BOOL.has(a)) flags[a.slice(2)] = true;
    else if (VALUE.has(a)) {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) return { error: `${a} needs a value` };
      flags[a.slice(2)] = v;
    } else if (a.startsWith("-")) return { error: `unknown flag ${a}` };
    else if (verb === null && VERBS.has(a)) verb = a;
    else return { error: `unknown argument ${a}` };
  }
  if (!verb) return { error: "missing verb" };
  for (const k of ["max-writes", "limit"]) {
    if (flags[k] !== undefined && !(Number.isInteger(Number(flags[k])) && Number(flags[k]) >= 0)) {
      return { error: `--${k} must be a non-negative integer` };
    }
  }
  return { verb, flags };
}

const idNum = (id) => Number(String(id).slice(1));
const byIdNum = (a, b) => idNum(a) - idNum(b);

async function findProject(client, identifier) {
  try {
    return await client.resolveProject(identifier);
  } catch (err) {
    if (String(err?.message).startsWith("no project with identifier")) return null;
    throw err;
  }
}

// Reads the registry and Plane once; everything else decides from this snapshot.
async function gather({ client, reg, registryDir }) {
  const records = recordsFromRegistry(registryDir);
  const patterns = loadDenylist();
  const enc = new Map();
  const held = new Map(); // id -> pattern name (never the text)
  for (const [id, rec] of records) {
    const e = encodeItem(rec, reg);
    enc.set(id, e);
    const hit = scanForbidden(scanText(e), patterns);
    if (hit) held.set(id, hit.name);
  }
  const project = await findProject(client, reg.project.identifier);
  let states = [];
  let items = [];
  if (project) {
    states = await client.listAll(`projects/${project.id}/states/`);
    items = await client.listAll(`projects/${project.id}/work-items/`);
  }
  const stateNameById = new Map(states.map((s) => [s.id, s.name]));
  const linked = new Map();
  let unlinked = 0;
  for (const item of items) {
    const link = linkOf(item);
    if (link === null) unlinked++;
    else if (linked.has(link)) {
      // two items claim one registry id: refuse the row, never write it
      const dup = { id: link, record: null, payload: null, edits: [], warnings: [] };
      linked.set(link, { item, dec: { ...dup, problem: "duplicate" } });
    } else {
      linked.set(link, { item, dec: decodeItem(item, stateNameById, reg) });
    }
  }
  return { records, enc, held, project, states, items, linked, unlinked, stateNameById, reg };
}

function planPush(g) {
  const plan = {
    create: [],
    update: [],
    rebaseline: [],
    noop: [],
    pullPending: [],
    conflict: [],
    duplicate: [],
    held: [],
    orphan: [],
  };
  for (const id of [...g.records.keys()].sort(byIdNum)) {
    if (g.held.has(id)) {
      plan.held.push(id);
      continue;
    }
    const local = g.records.get(id);
    if (local.status && !local.status.batch) {
      plan.conflict.push({ id, reason: "no-batch" });
      continue;
    }
    const hit = g.linked.get(id);
    if (!hit) {
      plan.create.push({ id });
      continue;
    }
    const { item, dec } = hit;
    if (dec.problem === "duplicate") {
      plan.duplicate.push({ id, reason: "duplicate" });
      continue;
    }
    if (dec.problem) {
      plan.conflict.push({ id, reason: dec.problem });
      continue;
    }
    const d = decideRow(local, item, dec, g.stateNameById, g.reg);
    if (d.action === "conflict") plan.conflict.push({ id, reason: d.reason });
    else if (d.action === "noop") plan.noop.push(id);
    else if (d.action === "pull-pending") plan.pullPending.push(id);
    else if (d.action === "rebaseline") plan.rebaseline.push({ id, item, fields: [] });
    else plan.update.push({ id, item, fields: d.fields });
  }
  for (const id of g.linked.keys()) if (!g.records.has(id)) plan.orphan.push(id);
  return plan;
}

function statesToCreate(reg, g) {
  const have = new Set(
    g.project ? g.states.map((s) => String(s.name).toLowerCase()) : PLANE_DEFAULT_STATE_NAMES,
  );
  return reg.states.filter((s) => !have.has(s.name.toLowerCase()));
}

// regen comparison: Plane-derived records vs the tracked registry files (bytes, F4).
function compareRegen(g, { presentOnly, registryDir }) {
  const planeRecords = new Map();
  const problems = [];
  const warnings = [];
  let edited = 0;
  for (const [id, { dec }] of g.linked) {
    if (dec.problem) problems.push(`${id}:${dec.problem}`);
    else {
      planeRecords.set(dec.id, dec.record);
      if (dec.edits.length) edited++;
      for (const w of dec.warnings) warnings.push(`${dec.id} ${w}`);
    }
  }
  const missing = [];
  for (const id of g.records.keys()) {
    if (!g.held.has(id) && !g.linked.has(id)) missing.push(id);
  }
  const planeList = [...planeRecords.values()];
  const tracked = compareTracked(registryDir, planeRecords, {
    excludeIds: new Set(g.held.keys()),
    onlyIds: presentOnly ? new Set(g.linked.keys()) : null,
  });
  const diffIds = [];
  for (const id of [...planeRecords.keys()].sort(byIdNum)) {
    const reg = g.records.get(id);
    if (!reg || !sameRecord(reg, planeRecords.get(id))) diffIds.push(id);
  }
  const missingCounted = presentOnly ? [] : missing;
  return {
    planeCat: catalogueText(planeList),
    planeShards: shardTexts(planeList),
    problems,
    warnings,
    edited,
    missing: missingCounted,
    catDiffers: tracked.catDiffers,
    shardsDiffer: tracked.shardsDiffer,
    orderOnly: tracked.orderOnly,
    diffIds,
    drift:
      tracked.catDiffers ||
      tracked.shardsDiffer > 0 ||
      problems.length > 0 ||
      missingCounted.length > 0,
  };
}

const sampleLine = (verb, id, g) => {
  const e = g.enc.get(id);
  const bytes = Buffer.byteLength(scanText(e));
  return `  ${verb} ${id} · state ${e.stateName} · priority ${e.priority} · payload ${bytes} B`;
};

async function doPush({ client, reg, g, flags, out }) {
  const apply = Boolean(flags.apply);
  const plan = planPush(g);
  const missingStates = statesToCreate(reg, g);
  const counts = {
    create: plan.create.length,
    update: plan.update.length,
    rebaseline: plan.rebaseline.length,
    noop: plan.noop.length,
    pullPending: plan.pullPending.length,
    conflict: plan.conflict.length,
    duplicate: plan.duplicate.length,
    held: plan.held.length,
    orphan: plan.orphan.length,
  };
  const heldByPattern = {};
  for (const id of plan.held) {
    heldByPattern[g.held.get(id)] = (heldByPattern[g.held.get(id)] ?? 0) + 1;
  }
  const needed =
    (g.project ? 0 : 1) + missingStates.length + counts.create + counts.update + counts.rebaseline;
  const samples = {
    create: plan.create.slice(0, 3).map((p) => sampleLine("create", p.id, g)),
    update: plan.update.slice(0, 3).map((p) => sampleLine("update", p.id, g)),
    conflict: [...plan.conflict, ...plan.duplicate]
      .slice(0, 3)
      .map((c) => `  conflict ${c.id} · ${c.reason}`),
  };

  if (!apply) {
    if (flags.json) {
      out.stdout(
        JSON.stringify({
          project: g.project ? "exists" : "create",
          statesToCreate: missingStates.map((s) => s.name),
          counts,
          samples,
          heldByPattern,
          neededMaxWrites: needed,
        }) + "\n",
      );
    } else {
      out.stdout(
        `Plane bridge push (dry run): project ${g.project ? "exists" : "create"} · states +${missingStates.length} · create ${counts.create} · update ${counts.update} · rebaseline ${counts.rebaseline} · noop ${counts.noop} · pull-pending ${counts.pullPending} · conflict ${counts.conflict} · duplicate ${counts.duplicate} · held ${counts.held} · orphan ${counts.orphan} · needs --max-writes ${needed}\n`,
      );
      for (const k of ["create", "update", "conflict"]) {
        for (const l of samples[k]) out.stdout(`${l}\n`);
      }
    }
    out.rec.counts = counts;
    return counts.conflict + counts.duplicate > 0 ? 1 : 0;
  }

  let deferred = 0;
  let forbidden = 0;
  let project = g.project;
  let projectState = project ? "exists" : "created";
  const stateIdByName = new Map(g.states.map((s) => [String(s.name).toLowerCase(), s.id]));
  let statesAdded = 0;
  const note = (res) => {
    if (res?.deferred) deferred++;
    else if (res?.forbidden) forbidden++;
    return !res?.deferred && !res?.forbidden;
  };
  if (!project) {
    const res = await client.post(
      "projects/",
      { name: reg.project.name, identifier: reg.project.identifier, network: 2 },
      { ref: reg.project.identifier },
    );
    if (note(res)) {
      project = res;
      for (const s of await client.listAll(`projects/${project.id}/states/`)) {
        stateIdByName.set(String(s.name).toLowerCase(), s.id);
      }
    } else projectState = "deferred";
  }
  if (project) {
    for (const s of reg.states) {
      if (stateIdByName.has(s.name.toLowerCase())) continue;
      const res = await client.post(
        `projects/${project.id}/states/`,
        { name: s.name, group: s.group, color: s.color },
        { ref: s.name },
      );
      if (note(res) && res?.id) {
        stateIdByName.set(s.name.toLowerCase(), res.id);
        statesAdded++;
      }
    }
  }
  let created = 0;
  let updated = 0;
  let rebaselined = 0;
  let itemWrites = 0;
  const limit = flags.limit === undefined ? Infinity : Number(flags.limit);
  const todo = [
    ...plan.create.map((p) => ({ ...p, kind: "create" })),
    ...plan.update.map((p) => ({ ...p, kind: "update" })),
    ...plan.rebaseline.map((p) => ({ ...p, kind: "rebaseline" })),
  ];
  for (const t of todo) {
    if (itemWrites >= limit) break;
    const e = g.enc.get(t.id);
    const sid = stateIdByName.get(e.stateName.toLowerCase());
    const needsState = t.kind === "create" || t.fields.includes("stateName");
    if (!project || (needsState && !sid)) {
      deferred++;
      continue;
    }
    const res =
      t.kind === "create"
        ? await client.post(`projects/${project.id}/work-items/`, itemBody(e, sid), { ref: t.id })
        : await client.patch(
            `projects/${project.id}/work-items/${t.item.id}/`,
            itemPatch(e, t.item, t.fields, sid),
            { ref: t.id },
          );
    if (!note(res)) continue;
    itemWrites++;
    if (t.kind === "create") created++;
    else if (t.kind === "update") updated++;
    else rebaselined++;
  }
  out.rec.counts = { ...counts, create: created, update: updated, rebaseline: rebaselined };
  out.stdout(
    `Plane bridge push: project ${projectState} · states +${statesAdded} · create ${created} · update ${updated} · rebaseline ${rebaselined} · noop ${counts.noop} · pull-pending ${counts.pullPending} · conflict ${counts.conflict} · duplicate ${counts.duplicate} · held ${counts.held + forbidden} · orphan ${counts.orphan}${deferred ? ` · deferred ${deferred} (raise --max-writes)` : ""}\n`,
  );
  for (const l of samples.conflict) out.stdout(`${l}\n`);
  return counts.conflict + counts.duplicate > 0 || forbidden > 0 ? 1 : 0;
}

// F1: --out must be a fresh or empty directory outside the registry.
function outDirRefusal(dir, registryDir) {
  const target = resolve(dir);
  const rel = relative(resolve(registryDir), target);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    return "--out is the registry or inside it";
  }
  if (existsSync(target) && readdirSync(target).length > 0) return "--out directory is not empty";
  return null;
}

function writeTexts(dir, cmp, { onlyChanged = false } = {}) {
  let wrote = 0;
  mkdirSync(join(dir, "status"), { recursive: true });
  const put = (rel, text) => {
    const p = join(dir, rel);
    const cur = existsSync(p) ? readFileSync(p, "utf8") : null;
    if (onlyChanged && (cur ?? "") === text) return;
    writeFileSync(p, text);
    wrote++;
  };
  put("bugs.jsonl", cmp.planeCat);
  for (const [n, text] of Object.entries(cmp.planeShards)) put(join("status", `${n}.jsonl`), text);
  if (onlyChanged) {
    // a shard Plane no longer produces is emptied, never deleted
    for (const f of readdirSync(join(dir, "status")).filter((n) => n.endsWith(".jsonl"))) {
      if (!(f.slice(0, -".jsonl".length) in cmp.planeShards)) put(join("status", f), "");
    }
  }
  return wrote;
}

async function doRegen({ g, flags, registryDir, out }) {
  const cmp = compareRegen(g, { presentOnly: Boolean(flags["present-only"]), registryDir });
  for (const w of cmp.warnings) out.stderr(`Plane bridge warn: ${w}\n`);
  const unlinkedNote = g.unlinked ? `  unlinked ${g.unlinked} (plane:intake files them)\n` : "";
  if (flags.check) {
    if (!cmp.drift) {
      out.stdout("Plane bridge regen --check: clean\n");
      if (cmp.orderOnly) out.stdout(`  order-only ${cmp.orderOnly} (info, not drift)\n`);
      if (g.held.size) out.stdout(`  held ${g.held.size} (reported, not counted as drift)\n`);
      out.stdout(unlinkedNote);
      return 0;
    }
    out.stdout(
      `Plane bridge regen --check: drift · catalogue ${cmp.catDiffers ? "differs" : "same"} · shards differ ${cmp.shardsDiffer} · order-only ${cmp.orderOnly} · missing-in-plane ${cmp.missing.length} · held ${g.held.size} · problems ${cmp.problems.length} · edited-in-plane ${cmp.edited} · unlinked ${g.unlinked}\n`,
    );
    const ids = [...new Set([...cmp.diffIds, ...cmp.missing])].slice(0, 5);
    if (ids.length) out.stdout(`  ids: ${ids.join(", ")}\n`);
    for (const p of cmp.problems.slice(0, 5)) out.stdout(`  problem ${p}\n`);
    return 1;
  }
  if (flags.out) {
    const wrote = writeTexts(flags.out, cmp);
    out.stdout(`Plane bridge regen: wrote ${wrote} file(s) to ${flags.out}\n`);
    out.stdout(unlinkedNote);
    if (cmp.problems.length) {
      out.stdout(`  ${cmp.problems.length} item(s) skipped (${cmp.problems.join(", ")})\n`);
      return 1;
    }
    return 0;
  }
  // in place (the caller already checked owner === "plane")
  const refusals = [];
  if (cmp.problems.length) refusals.push(`${cmp.problems.length} item(s) with problems`);
  if (g.held.size) refusals.push(`${g.held.size} held row(s)`);
  if (cmp.missing.length && !flags["accept-removals"]) {
    refusals.push(`${cmp.missing.length} row(s) missing from Plane (--accept-removals)`);
  }
  if (refusals.length) {
    out.stderr(`Plane bridge regen: refused — ${refusals.join("; ")}\n`);
    return 1;
  }
  const wrote = writeTexts(registryDir, cmp, { onlyChanged: true });
  out.stdout(`Plane bridge regen: wrote ${wrote} file(s) in ${registryDir}\n`);
  out.stdout(unlinkedNote);
  return 0;
}

function doStatus({ reg, g, regName, registryDir, out }) {
  const plan = planPush(g);
  const cmp = compareRegen(g, { presentOnly: false, registryDir });
  const counts = {
    registry: g.records.size,
    plane: g.linked.size,
    held: g.held.size,
    conflicts: plan.conflict.length + plan.duplicate.length,
    problems: cmp.problems.length,
    orphans: plan.orphan.length,
    unlinked: g.unlinked,
  };
  const failing = [];
  if (counts.held) failing.push(`held ${counts.held}`);
  if (counts.conflicts) failing.push(`conflicts ${counts.conflicts}`);
  if (counts.problems) failing.push(`problems ${counts.problems}`);
  if (cmp.drift) failing.push("regen drift");
  out.stdout(
    `${regName}: owner ${reg.owner} · registry ${counts.registry} · plane ${counts.plane} · held ${counts.held} · conflicts ${counts.conflicts} · problems ${counts.problems} · orphans ${counts.orphans} · unlinked ${counts.unlinked}\n`,
  );
  out.stdout(`flip preconditions: ${failing.length ? `not met: ${failing.join(", ")}` : "met"}\n`);
  return 0;
}

export async function main(argv = process.argv.slice(2)) {
  const started = Date.now();
  const parsed = parseArgs(argv);
  if (parsed.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (parsed.error) {
    process.stderr.write(`Plane bridge: ${parsed.error}\n${USAGE}\n`);
    return 2;
  }
  const { verb, flags } = parsed;
  let token = null;
  const scrub = (s) => (token ? String(s).split(token).join("<redacted>") : String(s));
  const out = {
    stdout: (s) => process.stdout.write(scrub(s)),
    stderr: (s) => process.stderr.write(scrub(s)),
    rec: {},
  };
  const rec = { tool: "plane-bridge", verb, flags: Object.keys(flags).join(" ") };
  let code = 1;
  let client = null;
  try {
    let cfg;
    try {
      cfg = loadBridgeConfig();
    } catch (err) {
      out.stderr(`Plane bridge: ${err.message}\n`);
      return (code = 2);
    }
    const regName = flags.registry ?? "bugs";
    const reg = cfg.registries[regName];
    if (!reg || regName !== "bugs") {
      out.stderr(`Plane bridge: unknown registry "${regName}"\n`);
      return (code = 2);
    }
    const inPlace = verb === "regen" && !flags.check && !flags.out;
    if (inPlace && reg.owner !== "plane") {
      out.stderr(
        `Plane bridge regen: refused — ${regName} is registry-owned (use --check or --out)\n`,
      );
      return (code = 2);
    }
    token = readBridgeToken(cfg);
    if (!token) {
      out.stderr("Plane bridge: skipped (no token file)\n");
      rec.skipped = "no token file";
      return (code = (verb === "push" && flags.apply) || inPlace ? 2 : 0);
    }
    let registryDir;
    try {
      registryDir = process.env.PLANE_SYNC_REGISTRY_DIR || registryRoot();
    } catch (err) {
      out.stderr(`Plane bridge: ${err.message}\n`);
      return (code = 2);
    }
    if (verb === "regen" && flags.out) {
      const bad = outDirRefusal(flags.out, registryDir);
      if (bad) {
        out.stderr(`Plane bridge regen: refused — ${bad}\n`);
        return (code = 2);
      }
    }
    const maxWrites =
      flags["max-writes"] === undefined ? BRIDGE_DEFAULT_MAX_WRITES : Number(flags["max-writes"]);
    client = createClient({
      baseUrl: bridgeBaseUrl(cfg),
      slug: cfg.target.workspace,
      apiKey: token,
      tool: "plane-bridge",
      maxWrites,
      log: (msg) => out.stderr(`${msg}\n`),
    });
    const g = await gather({ client, reg, registryDir });
    const ctx = { client, reg, g, flags, regName, registryDir, out };
    if (verb === "push") code = await doPush(ctx);
    else if (verb === "regen") code = await doRegen(ctx);
    else code = doStatus(ctx);
    Object.assign(rec, out.rec);
  } catch (err) {
    out.stderr(`Plane bridge: ${scrub(err?.message ?? err)}\n`);
    rec.error = scrub(`${err?.name ?? "Error"}: ${String(err?.message ?? err).slice(0, 200)}`);
    code = 1;
  } finally {
    const { forbidden: forbiddenCount, ...rest } = client?.summary() ?? {};
    appendRun({
      ...rec,
      exit: code,
      durationMs: Date.now() - started,
      ...rest,
      forbidden: { count: forbiddenCount ?? 0, byPattern: {} },
    });
  }
  return code;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await main();
}
