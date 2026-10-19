// Register sync: until the lead switches the register to generated mode, the hand-edited
// register/WORK-REGISTER.md and priorities/OWNER-QUEUE.md stay the source for those rows. This
// module turns what changed in them into events. It is idempotent: it diffs each register row
// against the last register-sourced values the fold recorded (`item.registerFields`), so running
// it twice emits nothing the second time, and a lane's own edit of a field the register never
// touched again is never overwritten.
//
// syncEvents / planSync are pure. runSync does the IO (pull, build, append) and is what
// `rf sync`, the PC monitor's 5-minute timer and `rf brief --refresh` call.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { BUG_ID_RE } from "./schema.mjs";
import { parseRegisterReport, plain, tables } from "./backfill.mjs";
import { loadConfig, machineId, specsDir as defaultSpecsDir } from "./config.mjs";
import { newEventId } from "./ids.mjs";
import { fold } from "./fold.mjs";
import { validateEvent } from "./schema.mjs";

export const SYNC_ACTOR = "register-sync";
export const BOARD_DROP_NOTE = "board snapshot is a generated view, not a source (lead 10-19)";
const ANSWERED_WORDS = new Set(["ANSWERED", "DONE", "STANDING YES", "DEFAULT IN EFFECT"]);
const QUEUE_STATUS_RE = /\b(ANSWERED|DONE|STANDING YES|DEFAULT IN EFFECT|BOOKED|OPEN|CHECK)\b/;
const DECISION_FILE_RE = /\bD-\d{4}-\d{2}-\d{2}-[A-Za-z0-9._-]*?\.md\b/;
// Fields a register cell can empty; an emptied cell clears them (other fields are never cleared).
const NULLABLE = new Set(["lane", "train", "area", "parent", "eta", "gate", "trainLabel"]);

const clip = (s, n) => (s.length > n ? s.slice(0, n).trimEnd() : s);
const norm = (s) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

/** "human" (default) or "generated". */
export function registerModeOf(config) {
  return config?.registerMode === "generated" ? "generated" : "human";
}

/** Order-insensitive structural equality for the plain JSON values a draft holds. */
function same(a, b) {
  return stable(a) === stable(b);
}
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(v[k])}`)
      .join(",")}}`;
  return JSON.stringify(v === undefined ? null : v);
}

// ---------------------------------------------------------------------------------------------
// Owner queue

/**
 * Every decision table of OWNER-QUEUE.md (header has "Recommended answer") ->
 * [{ key, title, register, recommended, statusWord, decisionFile }]. `key` is the leading token of
 * the first cell (`N1`, `12`); `statusWord` the first status word in that cell; `decisionFile`
 * the first `D-YYYY-MM-DD-….md` anywhere in the row.
 */
export function parseOwnerQueueRows(md) {
  const out = [];
  for (const t of tables(md ?? "")) {
    const head = t.header.map((h) => plain(h).toLowerCase());
    const itemCol = head.indexOf("item");
    const recCol = head.indexOf("recommended answer");
    if (itemCol < 0 || recCol < 0) continue;
    const keyCol = head.indexOf("#") >= 0 ? head.indexOf("#") : 0;
    const regCol = head.indexOf("register");
    for (const row of t.rows) {
      const c = row.cells;
      const first = plain(c[keyCol] ?? "");
      const key = (/^\S+/.exec(first) ?? [""])[0];
      const title = plain(c[itemCol] ?? "");
      if (!key || !title) continue;
      const register = [];
      if (regCol >= 0)
        for (const m of plain(c[regCol] ?? "").matchAll(/\d+/g))
          if (!register.includes(m[0])) register.push(m[0]);
      out.push({
        key,
        title,
        register,
        recommended: plain(c[recCol] ?? ""),
        statusWord: QUEUE_STATUS_RE.exec(first)?.[1] ?? null,
        decisionFile: DECISION_FILE_RE.exec(c.join(" "))?.[0] ?? null,
      });
    }
  }
  return out;
}

/**
 * An owner-queue row is answered by a status word ANSWERED / DONE / STANDING YES / DEFAULT IN
 * EFFECT, or (with no status word at all) by linking a decisions/D-*.md file. BOOKED, OPEN and
 * CHECK are never answered, even when they cite a decision file.
 */
export function rowAnswer(row) {
  if (row.statusWord) {
    return ANSWERED_WORDS.has(row.statusWord) ? row.statusWord : null;
  }
  return row.decisionFile ? "ANSWERED" : null;
}

/** The queue decision items a row stands for: same title, else the one item carrying its key tag. */
function itemsForRow(row, queueItems) {
  const t = norm(clip(row.title, 300));
  const byTitle = queueItems.filter((it) => norm(it.title) === t);
  if (byTitle.length) return byTitle;
  const byKey = queueItems.filter((it) =>
    it.tags.some((tag) => tag === row.key || tag.startsWith(`${row.key} `)),
  );
  return byKey.length === 1 ? byKey : [];
}

// ---------------------------------------------------------------------------------------------
// Plan

/**
 * The events that bring the fold in line with the hand-kept files, plus a summary.
 * `state` is fold(events). Pure.
 */
export function planSync({
  state,
  registerMd = "",
  ownerQueueMd = "",
  config,
  machine,
  now,
  rand = Math.random,
}) {
  const events = [];
  const summary = {
    registerNew: 0,
    registerEdits: 0,
    answered: 0,
    dropped: 0,
    skipped: [],
    invalid: [],
  };
  const emit = (kind, item, data) => {
    const tsMs = now + events.length;
    const ev = {
      v: 1,
      id: newEventId(machine, tsMs, rand),
      ts: new Date(tsMs).toISOString(),
      machine,
      actor: SYNC_ACTOR,
      lane: null,
      kind,
      item,
      data,
    };
    const v = validateEvent(ev);
    if (!v.ok) {
      summary.invalid.push({ item, kind, errors: v.errors });
      return false;
    }
    events.push(ev);
    return true;
  };

  // ---- register rows ----
  const releases = new Set(
    [...state.items.values()].filter((i) => i.type === "release").map((i) => i.id),
  );
  const known = new Set(state.items.keys());
  const { drafts } = parseRegisterReport(registerMd ?? "", config);
  for (const draft of drafts) {
    const id = draft.id;
    if (BUG_ID_RE.test(id)) {
      summary.skipped.push({ item: id, reason: "registry bug id" });
      continue;
    }
    const fields = { ...draft.fields };
    // A train the fold does not know cannot be set (it would refuse the whole batch); the label
    // still carries it. The same filter runs on every pass, so the diff stays stable.
    if (fields.train && !releases.has(fields.train)) delete fields.train;
    const it = state.items.get(id);
    if (!it) {
      if (emit("item.new", id, fields)) {
        summary.registerNew++;
        known.add(id);
        if (fields.type === "release") releases.add(id);
      }
      continue;
    }
    const owned = it.source === "register" || Object.keys(it.registerFields ?? {}).length > 0;
    if (!owned) {
      summary.skipped.push({ item: id, reason: "not a register item" });
      continue;
    }
    const last = it.registerFields ?? {};
    const diff = {};
    for (const [k, v] of Object.entries(fields)) {
      if (k === "source") continue;
      if (!(k in last) || !same(v, last[k])) diff[k] = v;
    }
    for (const k of Object.keys(last)) {
      if (NULLABLE.has(k) && !(k in fields) && last[k] !== null) diff[k] = null;
    }
    if (Object.keys(diff).length === 0) continue;
    if (emit("item.edit", id, { fields: { ...diff, source: "register" } })) summary.registerEdits++;
  }

  // ---- owner queue ----
  const queueItems = [...state.items.values()].filter(
    (it) => Array.isArray(it.tags) && it.tags.includes("owner-queue"),
  );
  const answeredNow = new Set();
  for (const row of parseOwnerQueueRows(ownerQueueMd ?? "")) {
    const word = rowAnswer(row);
    if (!word) continue;
    for (const it of itemsForRow(row, queueItems)) {
      if (it.answeredAt || answeredNow.has(it.id)) continue;
      const data = {
        question: clip(row.title, 600),
        answer: clip(`${word} → ${row.decisionFile ?? "-"}`, 600),
      };
      if (row.recommended) data.recommended = clip(row.recommended, 600);
      if (emit("owner-decision", it.id, data)) {
        answeredNow.add(it.id);
        summary.answered++;
      }
    }
  }

  // ---- board-sourced items ----
  for (const it of state.items.values()) {
    if (it.status === "dropped") continue;
    const tags = it.tags ?? [];
    if (!tags.includes("problem") && !tags.includes("owner-ask")) continue;
    if (emit("status", it.id, { status: "dropped", note: BOARD_DROP_NOTE })) summary.dropped++;
  }

  return { events, summary };
}

/** Pure: the events only (see planSync). */
export function syncEvents(args) {
  return planSync(args).events;
}

// ---------------------------------------------------------------------------------------------
// IO

const readText = (p) => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
};

/**
 * Pull, build, append: one sync pass over the specs clone. The pull runs under the non-waiting
 * lock, so a busy lock (a lane is writing) skips this pass with `{ ran: false, reason: "busy" }`.
 * Returns `{ ran, events, appended, pushed, warnings, summary, pullError }`; `dry` builds without
 * appending. In generated register mode nothing runs (the register is an output).
 */
export async function runSync({
  dir = defaultSpecsDir(),
  home,
  env = process.env,
  machine,
  now = Date.now(),
  dry = false,
  push = true,
  bugIds,
  rand,
} = {}) {
  const store = await import("./store.mjs");
  const config = loadConfig(dir);
  if (registerModeOf(config) === "generated") return { ran: false, reason: "generated" };
  const pulled = await store.tryWithSpecsLock(() => store.syncSpecs(dir, { bugIds }), { home });
  if (!pulled.ran) return { ran: false, reason: "busy" };
  const state = fold(store.readAllEvents(dir));
  const out = planSync({
    state,
    registerMd: readText(join(dir, "register", "WORK-REGISTER.md")) ?? "",
    ownerQueueMd: readText(join(dir, "priorities", "OWNER-QUEUE.md")) ?? "",
    config,
    machine: machine ?? machineId(config, env),
    now,
    rand,
  });
  const result = {
    ran: true,
    events: out.events,
    summary: out.summary,
    appended: 0,
    pushed: false,
    warnings: [],
    pullError: pulled.value?.error ?? null,
  };
  if (dry || out.events.length === 0) return result;
  const res = await store.appendEvents(out.events, { dir, home, push, bugIds });
  result.appended = res.events.length;
  result.pushed = res.pushed;
  result.warnings = res.warnings;
  return result;
}
