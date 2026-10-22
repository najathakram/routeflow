// Status files (<opsHome>/status/*.json, written by .claude/hooks/ops-status.mjs) -> `heartbeat`
// events. planStatusSync is pure; runStatusSync does the IO. Identical state emits nothing.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { LANE_RE, MACHINE_RE } from "./schema.mjs";
import { machineId, loadConfig, opsHome, specsDir as defaultSpecsDir } from "./config.mjs";
import { newEventId } from "./ids.mjs";
import { fold } from "./fold.mjs";

export const STATUS_ACTOR = "status-sync";
export const MAX_FILE_AGE_MS = 24 * 3600_000;
export const JITTER_MS = 2 * 60_000;

/** Reads every status file; unreadable or non-object files are skipped. */
export function readStatusFiles(home) {
  const dir = join(home, "status");
  const out = [];
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const f of names) {
    if (!f.endsWith(".json") || f.startsWith(".")) continue;
    try {
      const r = JSON.parse(readFileSync(join(dir, f), "utf8"));
      if (r && typeof r === "object") out.push(r);
    } catch {
      // skip
    }
  }
  return out;
}

/** Heartbeat data from a status record (omits empty optional fields). */
export function heartbeatData(r) {
  const d = { session: r.sessionId, lastActiveAt: r.lastActiveAt };
  if (r.machine && MACHINE_RE.test(r.machine)) d.machine = r.machine;
  if (r.title) d.title = String(r.title).slice(0, 200);
  if (r.branch) d.branch = String(r.branch).slice(0, 200);
  if (Number.isInteger(r.pr) && r.pr > 0) d.pr = r.pr;
  if (r.head?.sha) d.head = r.head.sha;
  if (r.lastMessage) d.last = String(r.lastMessage).slice(0, 300);
  return d;
}

/** True when the record differs from the session's last heartbeat beyond lastActiveAt jitter. */
export function changedSince(prev, data, lane) {
  if (!prev) return true;
  if ((prev.lane ?? null) !== (lane ?? null)) return true;
  for (const k of ["machine", "title", "branch", "pr", "head", "last"])
    if ((prev[k] ?? null) !== (data[k] ?? null)) return true;
  return Math.abs(Date.parse(data.lastActiveAt) - Date.parse(prev.lastActiveAt)) >= JITTER_MS;
}

/** Pure: heartbeat events for status files whose state changed. `state` = fold() result. */
export function planStatusSync({ records, state, machine, now, rand }) {
  const events = [];
  const seen = new Set();
  for (const r of records) {
    const t = Date.parse(r?.lastActiveAt);
    if (typeof r?.sessionId !== "string" || !r.sessionId || seen.has(r.sessionId)) continue;
    if (!Number.isFinite(t) || now - t > MAX_FILE_AGE_MS) continue;
    seen.add(r.sessionId);
    const data = heartbeatData(r);
    const lane = typeof r.lane === "string" && LANE_RE.test(r.lane) ? r.lane : null;
    if (!changedSince(state.sessions?.get(r.sessionId), data, lane)) continue;
    events.push({
      v: 1,
      id: newEventId(machine, now + events.length, rand),
      ts: new Date(now + events.length).toISOString(),
      machine,
      actor: STATUS_ACTOR,
      lane,
      kind: "heartbeat",
      item: null,
      data,
    });
  }
  return events;
}

/** IO: pulls the clone (when the lock is free), plans, appends. Returns { ran, appended, ... }. */
export async function runStatusSync({
  dir = defaultSpecsDir(),
  home,
  env = process.env,
  machine,
  now = Date.now(),
  push = true,
  pull = true,
} = {}) {
  const store = await import("./store.mjs");
  home = home ?? opsHome(env);
  const records = readStatusFiles(home);
  if (records.length === 0) return { ran: true, appended: 0, pushed: false };
  if (pull) {
    const pulled = await store.tryWithSpecsLock(() => store.syncSpecs(dir), { home });
    if (!pulled.ran) return { ran: false, reason: "busy", appended: 0 };
  }
  const state = fold(store.readAllEvents(dir));
  const events = planStatusSync({
    records,
    state,
    machine: machine ?? machineId(loadConfig(dir), env),
    now,
  });
  if (events.length === 0) return { ran: true, appended: 0, pushed: false };
  const res = await store.appendEvents(events, { dir, home, push });
  return { ran: true, appended: res.events.length, pushed: res.pushed, warnings: res.warnings };
}
