// One-time import of the hand-kept files (register, release plan, owner queue, Work Board
// state.json) into item.new events. Pure parsers + a pure event builder + one IO wrapper.
// Bugs are NOT imported: they are derived live from the bug registry on origin/master.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { ITEM_ID_RE, STATUSES, TYPES } from "./schema.mjs";
import { DEFAULT_CONFIG, loadConfig, machineId, normalizeLane } from "./config.mjs";
import { newEventId, nextItemId } from "./ids.mjs";
import { guessDomainFromText } from "./areas.mjs";

// ---------------------------------------------------------------------------------------------
// Markdown helpers

/** Markdown cell/text to plain text: links keep their text, bold/code/<br> removed. */
export function plain(md) {
  if (md === null || md === undefined) return "";
  return String(md)
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\*\*/g, "")
    .replace(/`/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const clip = (s, n) => (s.length > n ? s.slice(0, n).trimEnd() : s);
const isEmptyCell = (s) => s === "" || s === "-" || s === "—";

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

/** All pipe tables in a markdown text: [{ header: string[], rows: [{ cells, line }] }]. */
function tables(md) {
  const lines = String(md).split(/\r?\n/);
  const out = [];
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim().startsWith("|")) {
      cur = null;
      continue;
    }
    const cells = splitRow(line);
    if (!cur) {
      cur = { header: cells, rows: [] };
      out.push(cur);
    } else if (cells.every((c) => /^:?-{2,}:?$/.test(c) || c === "")) {
      // separator row
    } else {
      cur.rows.push({ cells, line: i + 1 });
    }
  }
  return out;
}

const colIndex = (header) => {
  const m = new Map();
  header.forEach((h, i) => {
    const k = plain(h).toLowerCase();
    if (!m.has(k)) m.set(k, i);
  });
  return m;
};

// ---------------------------------------------------------------------------------------------
// Register

/**
 * Register table -> { drafts: [{ id, fields }], failed: [{ line, reason, raw }] }.
 * Fields are item.new data; empty cells are omitted.
 */
export function parseRegisterReport(md, config = DEFAULT_CONFIG) {
  const drafts = [];
  const failed = [];
  for (const t of tables(md)) {
    const cols = colIndex(t.header);
    if (!cols.has("id") || !cols.has("title")) continue;
    for (const row of t.rows) {
      const c = row.cells;
      const cell = (name) => (cols.has(name) ? (c[cols.get(name)] ?? "") : "");
      if (c.length < t.header.length) {
        failed.push({ line: row.line, reason: "too few cells", raw: c.join(" | ").slice(0, 80) });
        continue;
      }
      const id = plain(cell("id"));
      if (!ITEM_ID_RE.test(id)) {
        failed.push({ line: row.line, reason: `bad id "${id}"`, raw: c.join(" | ").slice(0, 80) });
        continue;
      }
      const title = clip(plain(cell("title")), 300);
      if (!title) {
        failed.push({ line: row.line, reason: "empty title", raw: id });
        continue;
      }
      const rawType = plain(cell("type")).toLowerCase();
      const type = rawType === "fix" ? "bug" : TYPES.includes(rawType) ? rawType : "chore";
      const prio = plain(cell("priority")).toUpperCase();
      const priority = /^P[0-3]$/.test(prio) ? prio : "P2";
      const sm = /^([a-z]+)/.exec(plain(cell("status")).toLowerCase());
      const status = sm && STATUSES.includes(sm[1]) ? sm[1] : "planned";
      const fields = { title, type, priority, status, source: "register" };
      const lane = normalizeLane(plain(cell("lane")), config);
      if (lane) fields.lane = lane;
      const trainText = plain(cell("train"));
      if (!isEmptyCell(trainText)) {
        fields.trainLabel = clip(trainText, 120);
        const tm = /\bR(\d{1,2})\b/.exec(trainText);
        if (tm) fields.train = `R${tm[1]}`;
      }
      const gate = plain(cell("gate"));
      if (!isEmptyCell(gate)) fields.gate = clip(gate, 400);
      const eta = plain(cell("eta"));
      if (!isEmptyCell(eta)) fields.eta = clip(eta, 80);
      const prs = [];
      for (const m of String(cell("links")).matchAll(/\/pull\/(\d+)|#(\d{3,5})\b/g)) {
        const n = Number(m[1] ?? m[2]);
        if (n > 0 && !prs.includes(n)) prs.push(n);
      }
      if (prs.length) fields.links = { prs };
      const dom = guessDomainFromText(title);
      if (dom) fields.area = `domain:${dom}`;
      drafts.push({ id, fields });
    }
  }
  return { drafts, failed };
}

export function parseRegister(md, config = DEFAULT_CONFIG) {
  return parseRegisterReport(md, config).drafts;
}

// ---------------------------------------------------------------------------------------------
// Release plan, owner queue, board

/** "## Trains" table -> [{ id, title, membersText, lanes, gates, eta }]. */
export function parsePlanTrains(md) {
  const out = [];
  for (const t of tables(md)) {
    const cols = colIndex(t.header);
    if (!cols.has("train") || !cols.has("members")) continue;
    for (const row of t.rows) {
      const first = plain(row.cells[cols.get("train")] ?? "");
      const m = /^(R\d{1,2})\b[\s:.-]*(.*)$/.exec(first);
      if (!m) continue;
      const at = (name) => plain(row.cells[cols.get(name)] ?? "");
      const etaKey = [...cols.keys()].find((k) => k.startsWith("eta"));
      out.push({
        id: m[1],
        title: m[2] || m[1],
        membersText: plain(row.cells[cols.get("members")] ?? ""),
        lanes: at("lanes"),
        gates: at("gates"),
        eta: etaKey ? plain(row.cells[cols.get(etaKey)] ?? "") : "",
      });
    }
  }
  return out;
}

/**
 * Item ids mentioned in free text: `row 593`, `rows 555/556`, `rows 1, 2` and `B###`. Numeric ids
 * are kept only when in `knownIds` (when given); B ids are always kept. Order of appearance.
 */
export function trainMembers(text, knownIds = null) {
  const out = [];
  const add = (id) => {
    if (!out.includes(id)) out.push(id);
  };
  const re = /\b[Rr]ows?\s+(\d+(?:\s*[/,]\s*\d+)*)|\b(B\d{2,5})\b/g;
  for (const m of String(text ?? "").matchAll(re)) {
    if (m[2]) add(m[2]);
    else
      for (const n of m[1].split(/\s*[/,]\s*/)) {
        if (!knownIds || knownIds.has(n)) add(n);
      }
  }
  return out;
}

/** Every table with a "Recommended answer" header -> [{ key, title, register, recommended, why }]. */
export function parseOwnerQueue(md) {
  const out = [];
  for (const t of tables(md)) {
    const cols = colIndex(t.header);
    if (!cols.has("recommended answer") || !cols.has("item")) continue;
    const keyCol = cols.has("#") ? cols.get("#") : 0;
    for (const row of t.rows) {
      const c = row.cells;
      const key = plain(c[keyCol] ?? "");
      const title = plain(c[cols.get("item")] ?? "");
      if (!key || !title) continue;
      const regCell = cols.has("register") ? plain(c[cols.get("register")] ?? "") : "";
      const register = [];
      for (const m of regCell.matchAll(/\d+/g)) if (!register.includes(m[0])) register.push(m[0]);
      out.push({
        key,
        title,
        register,
        recommended: plain(c[cols.get("recommended answer")] ?? ""),
        why: cols.has("why") ? plain(c[cols.get("why")] ?? "") : "",
      });
    }
  }
  return out;
}

/** state.json of the Work Board export (text or object). Bad input -> empty board. */
export function parseBoardState(input) {
  let j = input;
  if (typeof input === "string") {
    try {
      j = JSON.parse(input);
    } catch {
      j = null;
    }
  }
  const arr = (v) => (Array.isArray(v) ? v : []);
  if (!j || typeof j !== "object") j = {};
  return {
    asOf: typeof j.asOf === "string" ? j.asOf : null,
    trains: arr(j.trains),
    lanes: arr(j.lanes),
    owner: arr(j.owner),
    problems: arr(j.problems),
  };
}

// ---------------------------------------------------------------------------------------------
// Events

const BOARD_STATUS = {
  proofs: "building",
  fixing: "building",
  testing: "building",
  building: "building",
  waiting: "planned",
  planned: "planned",
  shipped: "live",
  live: "live",
};

const normTitle = (s) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
const trainNum = (id) => Number(String(id).slice(1));
const s = (v) => (typeof v === "string" ? v : v === null || v === undefined ? "" : String(v));

/**
 * Pure: drafts -> item.new events. `parsed` = { register: drafts, plan, ownerQueue, board }.
 * Trains first, then register rows (ids from the register, skipping ids in state), then owner
 * queue decisions, board owner asks and board problems (new sequential ids; skipped when an item
 * with the same normalized title exists).
 */
export function buildBackfillEvents(
  { register = [], plan = [], ownerQueue = [], board = parseBoardState({}) },
  { state, config = DEFAULT_CONFIG, machine, now, actor = "backfill", rand = Math.random },
) {
  void config;
  const items = state?.items ?? new Map();
  const known = new Set([...register.map((d) => d.id), ...items.keys()]);
  const existingTitles = new Set([...items.values()].map((i) => normTitle(i.title)));

  const events = [];
  const usedEventIds = new Set();
  const push = (item, data) => {
    const tsMs = now + events.length;
    let id = newEventId(machine, tsMs, rand);
    while (usedEventIds.has(id)) id = newEventId(machine, tsMs, rand);
    usedEventIds.add(id);
    events.push({
      v: 1,
      id,
      ts: new Date(tsMs).toISOString(),
      machine,
      actor,
      lane: null,
      kind: "item.new",
      item,
      data,
    });
  };

  // Trains
  const planBy = new Map(plan.map((t) => [t.id, t]));
  const boardBy = new Map();
  for (const t of board.trains) {
    const id = s(t?.train).trim();
    if (/^R\d{1,2}$/.test(id)) boardBy.set(id, t);
  }
  const trainIds = [...new Set([...planBy.keys(), ...boardBy.keys()])].sort(
    (a, b) => trainNum(a) - trainNum(b),
  );
  for (const id of trainIds) {
    if (items.has(id)) continue;
    const p = planBy.get(id);
    const b = boardBy.get(id);
    const members = [];
    const addMembers = (ids) => {
      for (const m of ids) if (!members.includes(m)) members.push(m);
    };
    if (p) addMembers(trainMembers(p.membersText, known));
    if (b) addMembers(trainMembers(s(b.members), known));
    addMembers(register.filter((d) => d.fields.train === id).map((d) => d.id));
    const data = {
      title: clip(plain(s(b?.name)) || p?.title || id, 300),
      type: "release",
      priority: "P1",
      status: BOARD_STATUS[s(b?.state).toLowerCase()] ?? "planned",
      source: b ? "board" : "plan",
    };
    const eta = plain(s(b?.target)) || p?.eta || "";
    if (eta) data.eta = clip(eta, 80);
    if (p?.gates) data.gate = clip(p.gates, 400);
    if (members.length) data.members = members.slice(0, 200);
    push(id, data);
  }

  // Register rows
  for (const d of register) {
    if (items.has(d.id)) continue;
    push(d.id, d.fields);
  }

  // New sequential ids for everything else
  let nextId = Math.max(
    Number(nextItemId({ items })),
    ...register.filter((d) => /^\d+$/.test(d.id)).map((d) => Number(d.id) + 1),
  );
  const draft = (title, data) => {
    const key = normTitle(title);
    if (!key || existingTitles.has(key)) return;
    existingTitles.add(key);
    push(String(nextId++), { title: clip(title, 300), ...data });
  };
  const recGate = (rec) => (rec ? clip(`Recommended: ${rec}`, 400) : undefined);
  const compact = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

  for (const q of ownerQueue) {
    const related = q.register.filter((r) => known.has(r) && ITEM_ID_RE.test(r)).slice(0, 50);
    draft(
      q.title,
      compact({
        type: "decision",
        lane: "owner",
        priority: "P1",
        status: "planned",
        gate: recGate(q.recommended),
        related: related.length ? related : undefined,
        tags: ["owner-queue", clip(q.key, 60)],
        source: "owner-queue",
      }),
    );
  }
  for (const o of board.owner) {
    const eta = plain(s(o?.when));
    draft(
      plain(s(o?.ask)),
      compact({
        type: "decision",
        lane: "owner",
        priority: "P1",
        status: "planned",
        gate: recGate(plain(s(o?.recommended))),
        eta: eta ? clip(eta, 80) : undefined,
        tags: ["owner-ask"],
        source: "board",
      }),
    );
  }
  for (const pr of board.problems) {
    const fix = plain(s(pr?.fix));
    draft(
      plain(s(pr?.problem)),
      compact({
        type: "incident",
        priority: "P0",
        status: "building",
        gate: fix ? clip(fix, 400) : undefined,
        tags: ["problem"],
        source: "board",
      }),
    );
  }
  return events;
}

// ---------------------------------------------------------------------------------------------
// IO

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

async function resolveDeps(deps = {}) {
  const d = { ...deps };
  d.readText ??= (p) => {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return null;
    }
  };
  d.listDir ??= (p) => {
    try {
      return readdirSync(p);
    } catch {
      return [];
    }
  };
  d.writeText ??= (p, t) => {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, t);
  };
  d.loadConfig ??= loadConfig;
  d.machineId ??= machineId;
  d.now ??= () => Date.now();
  if (!d.readAllEvents || !d.appendEvents) {
    const store = await import("./store.mjs");
    d.readAllEvents ??= store.readAllEvents;
    d.appendEvents ??= store.appendEvents;
  }
  if (!d.fold) d.fold = (await import("./fold.mjs")).fold;
  return d;
}

/**
 * Reads the hand-kept sources, folds the existing events, builds the backfill events and appends
 * them in one commit (unless `dry`). Records ops/state/backfill.json { at, registerSha256, counts }.
 */
export async function runBackfill({ specsDir, boardDir, dry = false, deps = {} }) {
  const d = await resolveDeps(deps);
  const read = (...parts) => d.readText(join(...parts));
  const missing = [];
  const need = (name, text) => {
    if (text === null || text === undefined) missing.push(name);
    return text ?? "";
  };
  const registerText = need(
    "register/WORK-REGISTER.md",
    read(specsDir, "register", "WORK-REGISTER.md"),
  );
  const planFile = d
    .listDir(join(specsDir, "releases"))
    .filter((f) => /^PLAN-.*\.md$/.test(f))
    .sort()
    .pop();
  const planText = planFile
    ? need(`releases/${planFile}`, read(specsDir, "releases", planFile))
    : (missing.push("releases/PLAN-*.md"), "");
  const queueText = need(
    "priorities/OWNER-QUEUE.md",
    read(specsDir, "priorities", "OWNER-QUEUE.md"),
  );
  const boardText = need("board/state.json", read(boardDir, "state.json"));

  const config = d.loadConfig(specsDir);
  const machine = d.machineId(config);
  const now = d.now();
  const state = d.fold(await d.readAllEvents(specsDir), { bugs: new Map() });
  const report = parseRegisterReport(registerText, config);
  const events = buildBackfillEvents(
    {
      register: report.drafts,
      plan: parsePlanTrains(planText),
      ownerQueue: parseOwnerQueue(queueText),
      board: parseBoardState(boardText),
    },
    { state, config, machine, now, actor: "backfill", rand: d.rand ?? Math.random },
  );
  const counts = {
    trains: events.filter((e) => e.data.type === "release").length,
    register: events.filter((e) => e.data.source === "register").length,
    owner: events.filter((e) => e.data.type === "decision" && e.data.source !== "register").length,
    problems: events.filter((e) => e.data.type === "incident").length,
    events: events.length,
    failedRows: report.failed.length,
  };
  const result = { dry: Boolean(dry), counts, missing, failed: report.failed, pushed: false };
  if (dry) return result;
  if (events.length) {
    const r = await d.appendEvents(events, { dir: specsDir });
    result.pushed = Boolean(r?.pushed);
    result.warnings = r?.warnings ?? [];
  }
  d.writeText(
    join(specsDir, "ops", "state", "backfill.json"),
    `${JSON.stringify({ at: new Date(now).toISOString(), registerSha256: sha256(registerText), counts }, null, 2)}\n`,
  );
  return result;
}
