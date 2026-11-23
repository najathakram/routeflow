// The team board's conversation: which comments are for "me", which of them are unread, how a
// comment reads on one line, and an item's thread. Members on other computers and other Claude
// accounts cannot message a session, so comments on the item are the only channel.
//
// "Me" is { lane, actor, member }: a comment is mine to read when it mentions my
// lane or my name (`to`), answers a comment I wrote (`replyTo`), or sits on an item my lane has
// claimed. Comments I wrote myself are never in my inbox.
//
// Read state is kept BY EVENT ID, never by time: events from other machines reach this clone late
// (push lag, a rejected push and its retry, "kept local" until the next sync, clock skew), so a
// comment can arrive with a ts older than one already read. A time high-water mark would hide it.
//
// Pure except readInboxSeen / writeInboxSeen (the per-person read marker under the ops home, sync
// fs only, so the prompt hook can use them). No clock: callers pass `now`.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fallbackMaskText, maskText } from "./mask.mjs";
import { redact } from "./cloud.mjs";

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

/**
 * The comments for `me`, oldest first: `[{ comment, reason }]`, reason "mention" | "reply" |
 * "claimed" (first that applies).
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
  return out;
}

/**
 * True when I hold the item's claim: a member's claim is that member's; any other claim (a lane
 * session, or a hook writing under RF_ACTOR on the lane) belongs to the lane, and is read by the
 * lane session (a member reads only their own claims).
 */
function claimedByMe(it, me) {
  if (!it?.claimedBy) return false;
  if (it.claimedMember) return it.claimedMember === me.member;
  return !me.member && Boolean(me.lane) && it.claimedBy === me.lane;
}

/**
 * True when the comment's id is not in the read marker. The marker `{ v: 2, floorTs, ids }` holds
 * the ids read in the last SEEN_KEEP_MS (id -> ts); anything older than `floorTs` counts as read,
 * which keeps the file small. A comment that arrives late, with an older ts than one already read,
 * is still unread, because its id was never marked.
 */
export function isUnread(comment, marker) {
  const seen = marker?.v === 2 ? marker : normalizeSeen(marker);
  if (!seen) return true;
  if (Object.hasOwn(seen.ids, comment.id)) return false;
  return !(Number.isFinite(seen.floorTs) && comment.ts <= seen.floorTs);
}

/**
 * Comment text as it is STORED: client names masked (the machine-local list, then the slug and
 * email fallback) and anything that looks like a credential blanked. Runs before the event is
 * written, so a pushed comment never carries a name or a token; printing masks again.
 */
export function scrubCommentText(text, clientNames = []) {
  return redact(fallbackMaskText(maskText(String(text ?? ""), clientNames)));
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
  const hint = replyHint ? ` (reply: rf comment ${c.item} --reply-to ${c.id})` : "";
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

/** Read ids are kept this long behind the newest one read; older comments count as read. */
export const SEEN_KEEP_MS = 30 * 24 * 3600_000;

/** A marker read from disk -> `{ v: 2, floorTs, ids }`; the old `{ lastEventId, ts }` upgrades. */
export function normalizeSeen(v) {
  if (!v || typeof v !== "object") return null;
  if (v.v === 2 && v.ids && typeof v.ids === "object") {
    const ids = {};
    for (const [id, ts] of Object.entries(v.ids)) if (Number.isFinite(ts)) ids[id] = ts;
    return { v: 2, floorTs: Number.isFinite(v.floorTs) ? v.floorTs : null, ids };
  }
  // Version 1 was a time high-water mark: what it covered stays read, nothing after it is.
  if (Number.isFinite(v.ts)) {
    const ids = typeof v.lastEventId === "string" ? { [v.lastEventId]: v.ts } : {};
    return { v: 2, floorTs: v.ts, ids };
  }
  return null;
}

/** The read marker, or null. */
export function readInboxSeen(home, me) {
  try {
    return normalizeSeen(JSON.parse(readFileSync(inboxFile(home, me), "utf8")));
  } catch {
    return null;
  }
}

/** `seen` plus `comments` marked read, ids older than SEEN_KEEP_MS behind the newest folded in. */
export function markSeen(seen, comments) {
  const ids = { ...(seen?.ids ?? {}) };
  for (const c of comments) if (c && typeof c.id === "string") ids[c.id] = c.ts;
  const newest = Math.max(...Object.values(ids), -Infinity);
  let floorTs = seen?.floorTs ?? null;
  if (Number.isFinite(newest)) {
    const cut = newest - SEEN_KEEP_MS;
    for (const [id, ts] of Object.entries(ids)) if (ts < cut) delete ids[id];
    if (!(floorTs >= cut)) floorTs = Math.max(floorTs ?? -Infinity, cut);
  }
  return { v: 2, floorTs, ids };
}

/** Marks `comments` read for `me` (atomic temp + rename). */
export function writeInboxSeen(home, me, comments) {
  const file = inboxFile(home, me);
  mkdirSync(dirname(file), { recursive: true });
  const next = markSeen(readInboxSeen(home, me), comments);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(next));
  renameSync(tmp, file);
}
