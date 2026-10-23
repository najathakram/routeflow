// Status files (<opsHome>/status/*.json, written by .claude/hooks/ops-status.mjs) -> `heartbeat`
// events. planStatusSync is pure; runStatusSync does the IO. Each machine emits ONLY its own
// sessions' heartbeats (to its own events/<machine>/ file). Identical state emits nothing; a change
// of `last`/lastActiveAt alone emits at most one keep-alive per session per KEEPALIVE_MS.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { LANE_RE, MACHINE_RE } from "./schema.mjs";
import { machineId, loadConfig, opsHome, specsDir as defaultSpecsDir } from "./config.mjs";
import { newEventId } from "./ids.mjs";
import { fold } from "./fold.mjs";

export const STATUS_ACTOR = "status-sync";
export const MAX_FILE_AGE_MS = 24 * 3600_000;
export const KEEPALIVE_MS = 10 * 60_000;
export const MAX_EVENTS_PER_RUN = 20;

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

/** Real change = lane/machine/title/branch/pr/head differ from the session's last heartbeat. */
export function realChange(prev, data, lane) {
  if (!prev) return true;
  if ((prev.lane ?? null) !== (lane ?? null)) return true;
  return ["machine", "title", "branch", "pr", "head"].some(
    (k) => (prev[k] ?? null) !== (data[k] ?? null),
  );
}

/**
 * Pure: `{ events, capped }` for this machine's status files. `state` = fold() result. A real
 * change emits at once; otherwise a keep-alive only when the session was active since its last
 * heartbeat and that heartbeat is >= KEEPALIVE_MS old. At most `max` events per run, oldest
 * lastActiveAt first (`capped` = how many were left for the next run).
 */
export function planStatusSync({ records, state, machine, now, rand, max = MAX_EVENTS_PER_RUN }) {
  const due = [];
  const seen = new Set();
  for (const r of records) {
    const t = Date.parse(r?.lastActiveAt);
    if (typeof r?.sessionId !== "string" || !r.sessionId || seen.has(r.sessionId)) continue;
    if (r.machine !== machine) continue;
    if (!Number.isFinite(t) || now - t > MAX_FILE_AGE_MS) continue;
    seen.add(r.sessionId);
    const data = heartbeatData(r);
    const lane = typeof r.lane === "string" && LANE_RE.test(r.lane) ? r.lane : null;
    const prev = state.sessions?.get(r.sessionId);
    const keepAlive =
      prev &&
      now - prev.ts >= KEEPALIVE_MS &&
      (prev.lastActiveAt !== data.lastActiveAt || (prev.last ?? null) !== (data.last ?? null));
    if (realChange(prev, data, lane) || keepAlive) due.push({ t, data, lane });
  }
  due.sort((a, b) => a.t - b.t || (a.data.session < b.data.session ? -1 : 1));
  const events = due.slice(0, max).map(({ data, lane }, i) => ({
    v: 1,
    id: newEventId(machine, now + i, rand),
    ts: new Date(now + i).toISOString(),
    machine,
    actor: STATUS_ACTOR,
    lane,
    kind: "heartbeat",
    item: null,
    data,
  }));
  return { events, capped: Math.max(0, due.length - max) };
}

/**
 * IO: under ONE specs-lock hold (waits up to `lockWaitMs`; busy -> `{ ran:false, reason:"busy" }`)
 * pulls the clone, plans from the fresh state and appends. A failed pull appends nothing (never
 * push from a stale clone) and returns `pullError`. `push:false` commits locally only.
 */
export async function runStatusSync({
  dir = defaultSpecsDir(),
  home,
  env = process.env,
  machine,
  now = Date.now(),
  push = true,
  lockWaitMs = 0,
  lockHeld = false, // the caller holds the specs lock and just pulled
  rand,
} = {}) {
  const store = await import("./store.mjs");
  home = home ?? opsHome(env);
  const records = readStatusFiles(home);
  if (records.length === 0) return { ran: true, appended: 0, pushed: false };
  const me = machine ?? machineId(loadConfig(dir), env);
  const work = async () => {
    const pulled = lockHeld ? null : await store.syncSpecs(dir);
    if (pulled?.ok === false)
      return { ran: true, appended: 0, pushed: false, pullError: pulled.error };
    const { events, capped } = planStatusSync({
      records,
      state: fold(store.readAllEvents(dir)),
      machine: me,
      now,
      rand,
    });
    if (events.length === 0) return { ran: true, appended: 0, pushed: false, capped };
    const res = await store.appendEvents(events, { dir, home, push, lockHeld: true });
    return {
      ran: true,
      appended: res.events.length,
      pushed: res.pushed,
      warnings: res.warnings,
      capped,
    };
  };
  try {
    if (lockHeld) return await work();
    if (lockWaitMs > 0) return await store.withSpecsLock(work, { home, waitMs: lockWaitMs });
    const r = await store.tryWithSpecsLock(work, { home });
    return r.ran ? r.value : { ran: false, reason: "busy", appended: 0 };
  } catch (err) {
    if (!/could not acquire specs lock/.test(String(err?.message ?? err))) throw err;
    return { ran: false, reason: "busy", appended: 0 };
  }
}
