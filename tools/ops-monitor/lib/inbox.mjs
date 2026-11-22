// The team board's conversation: which comments are for "me", which of them are unread, how a
// comment reads on one line, and an item's thread. Members on other computers and other Claude
// accounts cannot message a session, so comments on the item are the only channel.
//
// "Me" is { lane, actor, member }: a comment is mine to read when it mentions my
// lane or my name (`to`), answers a comment I wrote (`replyTo`), or sits on an item my lane has
// claimed. Comments I wrote myself are never in my inbox.
//
// Pure except readInboxSeen / writeInboxSeen (the per-person read marker under the ops home, sync
// fs only, so the prompt hook can use them). No clock: callers pass `now`.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { maskText } from "./mask.mjs";

const HOUR = 3600_000;
const TEXT_CLIP = 140;

const one = (s) =>
  String(s ?? "")
    .replace(/\s+/g, " ")
    .trim();
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

function ago(ms, now) {
  const d = Math.max(0, now - ms);
  if (d < 60_000) return "just now";
  if (d < HOUR) return `${Math.round(d / 60_000)} min ago`;
  if (d < 48 * HOUR) return `${Math.round(d / HOUR)} h ago`;
  return `${Math.round(d / (24 * HOUR))} days ago`;
}

/** The names "me" answers to: lane, actor and member id (whichever are set). */
export function myKeys(me = {}) {
  return new Set([me.lane, me.actor, me.member].filter((k) => typeof k === "string" && k));
}

/** The author's name as the board shows it: the actor (a member id or a lane). */
export const authorOf = (c) => c.actor || c.lane || c.machine;

/** An assignment as an inbox entry (kind "assign"), so one list, marker and renderer serve both. */
const assignEntry = (a) => ({
  id: a.id,
  ts: a.ts,
  item: a.item,
  kind: "assign",
  text: a.note ? `assigned to you: ${a.note}` : "assigned to you",
  to: [a.to],
  replyTo: null,
  actor: a.actor,
  lane: a.lane,
  machine: a.machine,
});

/**
 * The comments and assignments for `me`, oldest first: `[{ comment, reason }]`, reason "mention" |
 * "reply" | "claimed" | "assigned" (first that applies). An assignment entry has kind "assign".
 */
export function commentsFor(state, me) {
  const keys = myKeys(me);
  if (keys.size === 0) return [];
  const byId = new Map((state.comments ?? []).map((c) => [c.id, c]));
  const out = [];
  for (const c of state.comments ?? []) {
    if (keys.has(c.actor)) continue; // my own
    let reason = null;
    if (c.to.some((t) => keys.has(t))) reason = "mention";
    else if (c.replyTo && keys.has(byId.get(c.replyTo)?.actor)) reason = "reply";
    else if (claimedByMe(state.items.get(c.item), me)) reason = "claimed";
    if (reason) out.push({ comment: c, reason });
  }
  for (const a of state.assignments ?? []) {
    if (keys.has(a.actor) || !keys.has(a.to)) continue;
    out.push({ comment: assignEntry(a), reason: "assigned" });
  }
  // One fold order (ts, then id) for both kinds, so the read marker works for either.
  return out.sort((x, y) => x.comment.ts - y.comment.ts || (x.comment.id < y.comment.id ? -1 : 1));
}

/** "2 new comments and 1 assignment" (either part alone when the other is zero). */
export function inboxHeadline(entries) {
  const k = entries.filter((x) => x.comment.kind === "assign").length;
  const c = entries.length - k;
  const word = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
  if (k === 0) return `${word(c, "new comment")}`;
  if (c === 0) return `${word(k, "new assignment")}`;
  return `${word(c, "new comment")} and ${word(k, "assignment")}`;
}

/**
 * True when I hold the item's claim: the claimer's name is mine (a member, or a lane session whose
 * name is the lane); an old claim with no name falls back to the lane.
 */
function claimedByMe(it, me) {
  if (!it?.claimedBy) return false;
  if (it.claimedActor) return it.claimedActor === me.actor || it.claimedActor === me.member;
  return Boolean(me.lane) && it.claimedBy === me.lane;
}

/** True when the comment comes after the read marker `{ lastEventId, ts }` (fold order). */
export function isUnread(comment, seen) {
  if (!seen || !Number.isFinite(seen.ts)) return true;
  if (comment.ts !== seen.ts) return comment.ts > seen.ts;
  return typeof seen.lastEventId === "string" ? comment.id > seen.lastEventId : false;
}

/**
 * One line: `- [W-1] sa, 5 min ago: <text> (reply: rf comment W-1 --reply-to <id>)`. The text is
 * masked BEFORE it is clipped, so a client name never survives as a fragment.
 */
export function renderComment(
  c,
  state,
  { now = Date.now(), clientNames = [], replyHint = true } = {},
) {
  void state;
  const text = clip(one(maskText(c.text, clientNames)), TEXT_CLIP);
  const hint = !replyHint
    ? ""
    : c.kind === "assign"
      ? ` (rf next; rf claim ${c.item})`
      : ` (reply: rf comment ${c.item} --reply-to ${c.id})`;
  return maskText(`- [${c.item}] ${authorOf(c)}, ${ago(c.ts, now)}: ${text}${hint}`, clientNames);
}

/** An item's comments as a thread: `[{ comment, depth }]`, each reply under its parent. */
export function threadOf(state, itemId) {
  const mine = (state.comments ?? []).filter((c) => c.item === itemId);
  const ids = new Set(mine.map((c) => c.id));
  const kids = new Map();
  const roots = [];
  for (const c of mine) {
    if (c.replyTo && ids.has(c.replyTo)) {
      if (!kids.has(c.replyTo)) kids.set(c.replyTo, []);
      kids.get(c.replyTo).push(c);
    } else roots.push(c);
  }
  const out = [];
  const walk = (c, depth) => {
    out.push({ comment: c, depth });
    for (const k of kids.get(c.id) ?? []) walk(k, depth + 1);
  };
  for (const r of roots) walk(r, 0);
  return out;
}

// ── read marker (per person, machine-local) ──────────────────────────────────

const safeKey = (k) =>
  String(k)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .slice(0, 60) || "unknown";

/** Whose marker this is: the member, else the actor, else the lane. */
export const inboxKey = (me = {}) => safeKey(me.member || me.actor || me.lane || "unknown");

export const inboxFile = (home, me) => join(home, "inbox", `${inboxKey(me)}.json`);

/** The read marker `{ lastEventId, ts }`, or null. */
export function readInboxSeen(home, me) {
  try {
    const v = JSON.parse(readFileSync(inboxFile(home, me), "utf8"));
    return v && typeof v === "object" && Number.isFinite(v.ts) ? v : null;
  } catch {
    return null;
  }
}

/** Moves the read marker to `comment` (atomic temp + rename). */
export function writeInboxSeen(home, me, comment) {
  const file = inboxFile(home, me);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ lastEventId: comment.id, ts: comment.ts }));
  renameSync(tmp, file);
}
