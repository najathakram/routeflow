// The lead's view of the monitor, in the owner's words. Pure: no IO, no clock (callers pass `now`).
//   renderBrief  - session-start brief: what hurts, what ships next, what waits on the owner,
//                  who is working on what, the lane's own queue, drift.
//   renderSince  - one line: what changed since the session last looked.
//   orderEvents / splitAtMarker - the "last seen" bookkeeping the hook needs.
// Item ids appear only in [brackets]; priorities and statuses are plain words (Urgent, Being built).
import { DONE_STATUSES } from "./schema.mjs";
import { parseEta } from "./ids.mjs";
import { deepMasker, maskText } from "./mask.mjs";
import { laneNow, pickNext } from "./next.mjs";

// Same owner-facing words as snapshot.mjs STATUS_WORDS (not imported: the hooks must load fast).
const STATUS_WORDS = {
  live: "Fixed",
  verified: "Fixed",
  spec: "Being specified",
  building: "Being built",
  review: "In review",
  ready: "Ready to ship",
  shipping: "Shipping",
  planned: "Planned",
  idea: "Idea",
  parked: "Parked",
  dropped: "Dropped",
};
const FIXED = new Set(["live", "verified"]);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const HOUR = 3600_000;

const one = (s) =>
  String(s ?? "")
    .replace(/\s+/g, " ")
    .trim();
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

const isDone = (it) => DONE_STATUSES.includes(it.status);
const plural = (n, one_, many) => `${n} ${n === 1 ? one_ : many}`;

function compareIds(a, b) {
  const an = /^\d+$/.test(a);
  const bn = /^\d+$/.test(b);
  if (an && bn) return Number(a) - Number(b);
  if (an) return -1;
  if (bn) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}
const PRIORITY_RANK = { P0: 0, P1: 1, P2: 2, P3: 3 };
const byPriorityThenId = (a, b) =>
  (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9) || compareIds(a.id, b.id);

/** "12 min ago", "3 h ago", "2 days ago". */
export function ageWords(ms, now) {
  const d = Math.max(0, now - ms);
  if (d < 60_000) return "just now";
  if (d < HOUR) return `${Math.round(d / 60_000)} min ago`;
  if (d < 48 * HOUR) return `${Math.round(d / HOUR)} h ago`;
  return `${Math.round(d / (24 * HOUR))} days ago`;
}

/**
 * An ETA as the owner reads it: "about Oct 19, evening". `utcOffsetMin` shifts UTC to the viewer's
 * zone (0 = UTC). A date without a clock time means the end of that day (evening). Free text that
 * is not a date ("after census") comes back as written; no ETA -> null.
 */
export function etaWords(eta, now, utcOffsetMin = 0) {
  if (typeof eta !== "string" || !eta.trim()) return null;
  const ms = parseEta(eta, now);
  if (ms === null) return clip(one(eta), 40);
  const d = new Date(ms + utcOffsetMin * 60_000);
  let part = "evening";
  if (/\d{1,2}:\d{2}/.test(eta)) {
    const h = d.getUTCHours();
    part = h < 12 ? "morning" : h < 17 ? "afternoon" : "evening";
  }
  return `about ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${part}`;
}

/** The plain-language line for an item: its problem statement, else its title. */
export const headline = (it, n = 110) => clip(one(it.problem) || one(it.title) || it.id, n);
const withId = (it, n) => `${headline(it, n)} [${it.id}]`;
const statusWord = (it) => STATUS_WORDS[it.status] ?? it.status;
const priorityWord = (it) => (it.priority === "P0" ? "Urgent" : it.priority === "P1" ? "High" : "");
const hurtWords = (it) =>
  [priorityWord(it), it.type === "incident" ? "Incident" : "", statusWord(it)]
    .filter(Boolean)
    .join(" · ");

// ── sections ────────────────────────────────────────────────────────────────

function hurtingNow(state, snapshot) {
  // Same rule as the page: the snapshot's own problems list wins (an id the fold does not know,
  // e.g. an incident file, uses the snapshot's own item); else open P0/P1 bug/incident items
  // whose harm is not latent/none.
  const ids = Array.isArray(snapshot?.problems) ? snapshot.problems.map(String) : null;
  const rows = (
    ids
      ? ids.map(
          (id) =>
            state.items.get(id) ??
            snapshot.items?.find((i) => i?.id === id) ?? { id, title: id, status: "planned" },
        )
      : [...state.items.values()].filter(
          (it) =>
            !isDone(it) &&
            ["bug", "incident"].includes(it.type) &&
            (it.priority === "P0" || it.priority === "P1") &&
            it.harm !== "latent" &&
            it.harm !== "none",
        )
  ).sort(byPriorityThenId);
  return {
    total: rows.length,
    lines: rows.slice(0, 5).map((it) => `- ${withId(it)} · ${hurtWords(it)}`),
  };
}

function waitingOnOwner(state, snapshot) {
  let rows;
  if (Array.isArray(snapshot?.ownerQueue)) {
    // The snapshot knows which queue rows are already answered or booked.
    rows = snapshot.ownerQueue.map((q) => ({
      ...(state.items.get(q.id) ?? { id: q.id, title: q.title, status: q.status }),
      booked: q.state === "booked",
    }));
  } else {
    rows = [...state.items.values()]
      .filter((it) => !isDone(it) && it.answeredAt === null && it.type === "decision")
      .sort(byPriorityThenId);
  }
  return {
    total: rows.length,
    lines: rows
      .slice(0, 5)
      .map(
        (it) =>
          `- ${clip(one(it.ownerAsk) || one(it.title) || it.id, 110)} [${it.id}]${it.booked ? " (booked)" : ""}`,
      ),
  };
}

function shippingNext(state, now, utcOffsetMin) {
  const rows = [...state.items.values()]
    .filter((it) => it.type === "release" && !isDone(it))
    .sort(
      (a, b) =>
        (Number(/\d+/.exec(a.id)?.[0]) || 99) - (Number(/\d+/.exec(b.id)?.[0]) || 99) ||
        compareIds(a.id, b.id),
    );
  const lines = [];
  for (const rel of rows.slice(0, 2)) {
    const ids = new Set(rel.members);
    for (const it of state.items.values()) if (it.train === rel.id) ids.add(it.id);
    const members = [...ids]
      .map((id) => state.items.get(id))
      .filter((m) => m && !["release", "epic"].includes(m.type))
      .sort(byPriorityThenId);
    const done = members.filter((m) => isDone(m)).length;
    const facts = [statusWord(rel)];
    if (members.length) facts.push(`${done} of ${members.length} done`);
    facts.push(etaWords(rel.eta, now, utcOffsetMin) ?? "no date yet");
    lines.push(
      `- ${clip(one(rel.trainLabel) || one(rel.title), 70)} [${rel.id}] · ${facts.join(" · ")}`,
    );
    const delivers = members
      .filter((m) => !isDone(m))
      .slice(0, 2)
      .map((m) => headline(m, 60));
    if (delivers.length) lines.push(`    delivers: ${delivers.join("; ")}`);
  }
  return { total: rows.length, lines };
}

function laneLines(state, config, now) {
  const rows = [];
  for (const l of state.lanes.values()) {
    if (l.id === "owner") continue;
    const recent = l.lastEventAt !== null && now - l.lastEventAt < 24 * HOUR;
    if (l.claims.length === 0 && !recent) continue;
    const title = config?.lanes?.find((x) => x.id === l.id)?.title;
    const work = l.claims
      .slice(0, 2)
      .map((id) => state.items.get(id))
      .filter(Boolean)
      .map((it) => withId(it, 50));
    const more = l.claims.length > 2 ? ` (+${l.claims.length - 2} more)` : "";
    const seen = l.lastEventAt !== null ? ` (last activity ${ageWords(l.lastEventAt, now)})` : "";
    rows.push({
      n: l.claims.length,
      line: `- ${l.id}${title ? ` (${clip(title, 28)})` : ""}: ${work.length ? `working on ${work.join("; ")}${more}` : "no claimed work"}${seen}`,
    });
  }
  rows.sort((a, b) => b.n - a.n || (a.line < b.line ? -1 : 1));
  return { total: rows.length, lines: rows.slice(0, 6).map((r) => r.line) };
}

function yourQueue(state, lane, config, now) {
  const lines = laneNow(state, lane)
    .slice(0, 4)
    .map((id) => state.items.get(id))
    .filter(Boolean)
    .map((it) => `- Now: ${withId(it, 80)} · ${statusWord(it)}`);
  const next = pickNext(state, lane, config, { now });
  if (next)
    lines.push(
      `- Next up: ${withId(next.item, 80)}${priorityWord(next.item) ? ` · ${priorityWord(next.item)}` : ""}`,
    );
  if (lines.length === 0) lines.push("- Nothing queued for you.");
  return { total: lines.length, lines };
}

function driftLines(snapshot, state, now) {
  if (snapshot && Array.isArray(snapshot.alarms)) {
    const c = { error: 0, warn: 0, info: 0 };
    for (const a of snapshot.alarms) if (a.severity in c) c[a.severity]++;
    const parts = [];
    if (c.error) parts.push(plural(c.error, "error", "errors"));
    if (c.warn) parts.push(plural(c.warn, "warning", "warnings"));
    if (c.info) parts.push(`${c.info} info`);
    const at = Date.parse(snapshot.generatedAt);
    return [
      `Drift: ${parts.length ? `${parts.join(", ")} (open the monitor for details)` : "none"}`,
      Number.isFinite(at)
        ? `Monitor data as of ${ageWords(at, now)}.`
        : "Monitor data age unknown.",
    ];
  }
  const last = state.lastEventAt;
  return [
    `Live monitor data is not available here; this shows recorded events only${
      last ? ` (latest recorded ${ageWords(last, now)})` : ""
    }.`,
  ];
}

/** The brief's inputs with every string masked (a copy; no names -> the inputs themselves). */
function maskInputs(inputs, names) {
  const deep = deepMasker(names);
  const { state, snapshot, config } = inputs;
  const items = new Map();
  for (const [k, v] of state.items) items.set(k, deep(v));
  return {
    state: { ...state, items },
    snapshot: snapshot ? deep(snapshot) : snapshot,
    config: config ? deep(config) : config,
  };
}

// ── brief ───────────────────────────────────────────────────────────────────

/**
 * Plain-text brief, at most `maxLines` lines (default 25). `short` keeps only the global part
 * (hurting now, waiting on the owner, freshness) for sessions with no lane. Sections are trimmed
 * lowest-priority first; a trimmed section says how many it shows ("3 of 9").
 */
export function renderBrief(
  state,
  {
    lane = null,
    now = Date.now(),
    snapshot = null,
    config = null,
    clientNames = [],
    maxLines = 25,
    short = false,
    utcOffsetMin = 0,
  } = {},
) {
  // Mask every input text BEFORE a line is built, clipped or cut: a client name must never
  // survive as a fragment. (The final maskText below stays as a belt-and-braces pass.)
  ({ state, snapshot, config } = maskInputs({ state, snapshot, config }, clientNames));
  const sections = [];
  const add = (key, title, part) => {
    if (part.lines.length === 0) return;
    sections.push({ key, title, total: part.total, lines: part.lines });
  };
  add("hurting", "Hurting now", hurtingNow(state, snapshot));
  add("owner", "Waiting on the owner", waitingOnOwner(state, snapshot));
  if (!short) {
    if (lane) add("queue", "Your queue", yourQueue(state, lane, config, now));
    add("shipping", "Shipping next", shippingNext(state, now, utcOffsetMin));
    add("lanes", "Lanes", laneLines(state, config, now));
  }
  const footer = driftLines(snapshot, state, now);
  const header = lane
    ? `Ops monitor brief for lane ${lane}`
    : "Ops monitor brief (no lane set here: rf whoami --lane <id>)";

  // Trim to fit: take lines from the lowest-priority section that still has more than one line,
  // then drop whole sections from the bottom.
  const priority = ["hurting", "owner", "queue", "shipping", "lanes"];
  const rank = (s) => priority.indexOf(s.key);
  const size = () => 1 + footer.length + sections.reduce((n, s) => n + 1 + s.lines.length, 0);
  while (size() > maxLines && sections.length > 0) {
    const trimmable = sections.filter((s) => s.lines.length > 1).sort((a, b) => rank(b) - rank(a));
    if (trimmable.length > 0) trimmable[0].lines.pop();
    else sections.splice(sections.indexOf([...sections].sort((a, b) => rank(b) - rank(a))[0]), 1);
  }

  const out = [header];
  for (const s of sections.sort((a, b) => order(a.key) - order(b.key))) {
    const shown = s.lines.filter((l) => !l.startsWith("    ")).length;
    const count =
      s.total > shown && s.key !== "queue" && s.key !== "shipping"
        ? ` (showing ${shown} of ${s.total})`
        : "";
    out.push(`${s.title}${count}:`, ...s.lines);
  }
  out.push(...footer);
  return maskText(out.slice(0, maxLines).join("\n"), clientNames);
}

// Display order (differs from trim priority: shipping reads before the owner's list).
const DISPLAY = ["hurting", "queue", "shipping", "owner", "lanes"];
const order = (k) => DISPLAY.indexOf(k);

// ── since ───────────────────────────────────────────────────────────────────

const ids4 = (ids) =>
  `[${ids.slice(0, 4).join(", ")}${ids.length > 4 ? `, +${ids.length - 4} more` : ""}]`;

/**
 * One line about what changed between two folded states, or "" when nothing the lead needs to
 * know changed. Categories: done, new, blocked, unblocked, ETA moved, assigned, owner decisions.
 */
export function renderSince(
  before,
  now,
  { lane = null, nowMs = Date.now(), utcOffsetMin = 0, config = null, clientNames = [] } = {},
) {
  // Mask the item texts BEFORE any clip (a trainLabel is cut at 40 characters).
  ({ state: before } = maskInputs({ state: before }, clientNames));
  ({ state: now } = maskInputs({ state: now }, clientNames));
  const done = [];
  const created = [];
  const blocked = [];
  const unblocked = [];
  const assigned = [];
  const etaItems = [];
  const releaseEta = [];
  for (const it of now.items.values()) {
    const was = before.items.get(it.id);
    if (!was) {
      if (!it.overlay) created.push(it.id);
      if (it.blocked) blocked.push(it.id);
      continue;
    }
    if (FIXED.has(it.status) && !FIXED.has(was.status)) done.push(it.id);
    if (it.blocked && !was.blocked) blocked.push(it.id);
    if (!it.blocked && was.blocked) unblocked.push(it.id);
    if ((it.lane && it.lane !== was.lane) || (it.claimedBy && it.claimedBy !== was.claimedBy))
      assigned.push(it.id);
    if (it.eta && it.eta !== was.eta && !isDone(it)) {
      if (it.type === "release") releaseEta.push(it);
      else etaItems.push(it.id);
    }
  }
  const parts = [];
  if (done.length) parts.push(`${plural(done.length, "item", "items")} done ${ids4(done)}`);
  if (created.length) parts.push(`${created.length} new`);
  if (blocked.length) parts.push(`${blocked.length} blocked ${ids4(blocked)}`);
  if (unblocked.length) parts.push(`${unblocked.length} unblocked ${ids4(unblocked)}`);
  if (assigned.length) parts.push(`${assigned.length} assigned or claimed ${ids4(assigned)}`);
  for (const rel of releaseEta) {
    parts.push(
      `${clip(one(rel.trainLabel) || one(rel.title), 40)} ETA moved to ${etaWords(rel.eta, nowMs, utcOffsetMin)}`,
    );
  }
  if (etaItems.length)
    parts.push(`${plural(etaItems.length, "ETA", "ETAs")} changed ${ids4(etaItems)}`);
  const decisions = now.decisions.length - before.decisions.length;
  if (parts.length === 0 && decisions <= 0) return "";

  let line = "Since you last looked: ";
  line += parts.join(", ");
  if (decisions > 0) {
    line += `${parts.length ? "; " : ""}${plural(decisions, "owner decision", "owner decisions")} recorded`;
  }
  if (lane) {
    const touched = new Set([
      ...done,
      ...created,
      ...blocked,
      ...unblocked,
      ...assigned,
      ...etaItems,
    ]);
    for (const rel of releaseEta) touched.add(rel.id);
    const mine = [...touched].filter((id) => {
      const it = now.items.get(id);
      return it && (it.lane === lane || it.claimedBy === lane);
    }).length;
    if (mine > 0) line += ` (${mine} in your lane)`;
  }
  return maskText(`${line}.`, clientNames);
}

// ── last-seen bookkeeping ───────────────────────────────────────────────────

/** Events shaped well enough to order, sorted exactly as fold() orders them (ts, then id). */
export function orderEvents(events) {
  return (events ?? [])
    .filter(
      (e) => e && !e.__invalid && typeof e.id === "string" && Number.isFinite(Date.parse(e.ts)),
    )
    .sort((a, b) => {
      const d = Date.parse(a.ts) - Date.parse(b.ts);
      return d !== 0 ? d : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
}

/** The id of the newest event (fold order), or null for an empty log. */
export const lastEventId = (events) => {
  const o = orderEvents(events);
  return o.length ? o[o.length - 1].id : null;
};

/**
 * Splits the log at a seen-marker `{ lastEventId, ts }`: `before` = everything up to and including
 * that event, `after` = the rest. A marker whose event vanished falls back to its time `ts`
 * (events at or before it count as seen). `own(ev)` marks events the viewer wrote itself; those
 * count as seen too, so "since you last looked" lists other people's changes only.
 */
export function splitAtMarker(events, marker, own = () => false) {
  const sorted = orderEvents(events);
  let cut = -1;
  if (marker?.lastEventId) {
    cut = sorted.findIndex((e) => e.id === marker.lastEventId);
    if (cut < 0 && Number.isFinite(marker.ts)) {
      for (let i = 0; i < sorted.length; i++) if (Date.parse(sorted[i].ts) <= marker.ts) cut = i;
    }
  }
  const before = sorted.slice(0, cut + 1);
  const after = [];
  for (const e of sorted.slice(cut + 1)) (own(e) ? before : after).push(e);
  return { before, after, sorted };
}
