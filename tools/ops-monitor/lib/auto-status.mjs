// Statuses written from facts the monitor already polls (PRs, merges, deploys), so a lane that forgot
// `rf status` no longer leaves an item stuck. planAutoStatus is pure; runAutoStatus does the IO.
//
//   all explicitly linked PRs landed (train landings included) -> shipping
//   ... and the last of them landed at or before the latest SUCCESS api+web deploy -> live
//   an open (non-draft) linked PR                                -> review
//
// Guards: forward-only (a status is never lowered, and live/verified/parked/dropped never move);
// blocked items are skipped; an item a lane touched within GRACE_MS waits (the lane may be about to
// write its own status); a status the lane wrote AFTER the merge (work reopened) is never overridden;
// the same item + status + PR set is written once; only PRs linked to the item by an event count
// (never a branch or title that merely names it). Events carry actor `auto-status` and a note
// that names the PRs, which is also the dedupe key.
import { fold } from "./fold.mjs";
import { newEventId } from "./ids.mjs";
import { landedAt } from "./reconcile.mjs";
import { STATUSES } from "./schema.mjs";
import { deployCut } from "./snapshot.mjs";
import { machineId, loadConfig, opsHome, specsDir as defaultSpecsDir } from "./config.mjs";

export const AUTO_STATUS_ACTOR = "auto-status";
export const GRACE_MS = 2 * 3600_000;
export const MAX_EVENTS_PER_RUN = 20;

const rank = (s) => STATUSES.indexOf(s);
// Statuses auto-status never moves an item out of.
const FROZEN = new Set(["live", "verified", "parked", "dropped"]);
const NOTE_RE = /^auto-status: PR (#\d+(?:, #\d+)*)/;
const toMs = (t) => {
  const n = Date.parse(t ?? "");
  return Number.isFinite(n) ? n : null;
};

/** Dedupe keys of the auto-status events already written: `item|status|#11, #12`. */
function writtenKeys(events) {
  const keys = new Set();
  for (const e of events ?? []) {
    if (e.actor !== AUTO_STATUS_ACTOR || e.kind !== "status") continue;
    const m = NOTE_RE.exec(e.data?.note ?? "");
    if (m) keys.add(`${e.item}|${e.data.status}|${m[1]}`);
  }
  return keys;
}

/**
 * Pure: `{ events, capped }`. `state` = fold() of `events`; `prs` = { open, merged } as the github source
 * holds them; `deploys` = the railway/github deploy rows the snapshot reads.
 */
export function planAutoStatus({
  state,
  events = [],
  prs,
  deploys = [],
  master = null,
  now,
  machine,
  rand,
  max = MAX_EVENTS_PER_RUN,
  graceMs = GRACE_MS,
}) {
  const mergedRaw = prs?.merged ?? [];
  const openRaw = prs?.open ?? [];
  const mergedBy = new Map(mergedRaw.map((p) => [p.number, p]));
  const openBy = new Map(openRaw.map((p) => [p.number, p]));
  const cut = deployCut(deploys, mergedRaw, master);
  const written = writtenKeys(events);
  const due = [];

  for (const it of state.items.values()) {
    const linked = it.links?.prs ?? [];
    if (linked.length === 0 || FROZEN.has(it.status) || it.blocked) continue;
    const history = (it.history ?? []).filter((h) => h.actor !== AUTO_STATUS_ACTOR);
    const lastTouch = Math.max(0, ...history.map((h) => toMs(h.ts) ?? h.ts ?? 0));
    if (now - lastTouch < graceMs) continue;
    const explicitStatusAt = Math.max(
      0,
      ...history.filter((h) => h.status !== undefined).map((h) => toMs(h.ts) ?? h.ts ?? 0),
    );

    // Where each linked PR stands: landed (at ms), open, or unknown (not seen, closed, or in an unlanded train).
    let landed = 0;
    let latestLanded = -Infinity;
    let openOne = false;
    for (const n of linked) {
      const m = mergedBy.get(n);
      const at = m ? landedAt(m, mergedRaw).at : null;
      if (at !== null && at !== undefined) {
        landed++;
        latestLanded = Math.max(latestLanded, at);
      } else if (openBy.has(n) && !openBy.get(n).draft) openOne = true;
    }
    const allLanded = landed === linked.length;

    let target = null;
    let reason = null;
    if (allLanded) {
      if (latestLanded <= cut) {
        target = "live";
        reason = "merged and in the latest deploy";
      } else {
        target = "shipping";
        reason = "merged to master";
      }
    } else if (openOne) {
      target = "review";
      reason = "open for review";
    }
    if (!target || rank(target) <= rank(it.status)) continue;
    // Work reopened by a lane after the merge: its status stands.
    if (allLanded && rank(it.status) < rank("shipping") && explicitStatusAt > latestLanded)
      continue;

    const prKey = linked.map((n) => `#${n}`).join(", ");
    if (written.has(`${it.id}|${target}|${prKey}`)) continue;
    due.push({ id: it.id, status: target, note: `auto-status: PR ${prKey} ${reason}` });
  }

  due.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const out = due.slice(0, max).map((d, i) => ({
    v: 1,
    id: newEventId(machine, now + i, rand),
    ts: new Date(now + i).toISOString(),
    machine,
    actor: AUTO_STATUS_ACTOR,
    lane: null,
    kind: "status",
    item: d.id,
    data: { status: d.status, note: d.note.slice(0, 500) },
  }));
  return { events: out, capped: Math.max(0, due.length - max) };
}

/**
 * IO, run inside the collector's specs pass (`lockHeld`: the lock is held and the clone was just pulled).
 * `sources` = the collector sources with the github + railway deploy rows merged. A missing or failing
 * github source plans nothing (never write from a stale picture). `store` is injectable for tests.
 */
export async function runAutoStatus({
  dir = defaultSpecsDir(),
  home,
  env = process.env,
  machine,
  now = Date.now(),
  push = true,
  lockHeld = true,
  sources,
  store,
  rand,
} = {}) {
  const gh = sources?.github;
  if (!gh?.data || gh.ok === false) return { ran: true, appended: 0, pushed: false };
  store = store ?? (await import("./store.mjs"));
  home = home ?? opsHome(env);
  const me = machine ?? machineId(loadConfig(dir), env);
  const pulled = lockHeld ? null : await store.syncSpecs(dir);
  if (pulled?.ok === false) {
    return { ran: true, appended: 0, pushed: false, pullError: pulled.error };
  }
  const events = store.readAllEvents(dir);
  const { events: planned, capped } = planAutoStatus({
    state: fold(events),
    events,
    prs: { open: gh.data.open ?? [], merged: gh.data.merged ?? [] },
    deploys: sources.railway?.data?.deploys ?? [],
    master: gh.data.master ?? null,
    now,
    machine: me,
    rand,
  });
  if (planned.length === 0) return { ran: true, appended: 0, pushed: false, capped };
  const res = await store.appendEvents(planned, { dir, home, push, lockHeld: true });
  return {
    ran: true,
    appended: res.events.length,
    pushed: res.pushed,
    warnings: res.warnings,
    capped,
  };
}
