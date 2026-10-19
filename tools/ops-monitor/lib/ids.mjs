// Ids and time helpers for the ops monitor. Pure.

const ALNUM = "abcdefghijklmnopqrstuvwxyz0123456789";

/** `<machine>-<13-digit epoch ms>-<4 chars>`; matches schema EVENT_ID_RE. */
export function newEventId(machine, now = Date.now(), rand = Math.random) {
  let tail = "";
  for (let i = 0; i < 4; i++) tail += ALNUM[Math.floor(rand() * ALNUM.length) % ALNUM.length];
  return `${machine}-${String(Math.floor(now)).padStart(13, "0")}-${tail}`;
}

/** Next numeric item id: max numeric id in state.items + 1 ("1" when there is none). */
export function nextItemId(state) {
  let max = 0;
  for (const id of state.items.keys()) {
    if (/^\d+$/.test(id)) max = Math.max(max, Number(id));
  }
  return String(max + 1);
}

/** UTC calendar date `YYYY-MM-DD` of an epoch-ms time. */
export function utcDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Item id carried in a branch name: tokens split on / _ . -; the first `b<digits>` token
 * (returned uppercased, known or not) or the first 3-5 digit token that is a known item id.
 */
export function itemIdFromBranch(branch, knownIds = new Set()) {
  if (typeof branch !== "string") return null;
  for (const tok of branch.split(/[/_.-]/)) {
    if (/^b\d{1,5}$/i.test(tok)) return tok.toUpperCase();
    if (/^\d{3,5}$/.test(tok) && knownIds.has(tok)) return tok;
  }
  return null;
}

/**
 * Parses a free-text ETA ("10-19 ~04:00Z", "10-19 to 10-21", "2026-10-20 ~18:00Z", "after census")
 * into epoch ms: the LAST date-like token wins; year defaults to now's UTC year; the time is a
 * `~HH:MMZ` right after that token, else end of day 23:59:59Z. No date → null.
 */
export function parseEta(text, now = Date.now()) {
  if (typeof text !== "string") return null;
  const re =
    /(?<![A-Za-z0-9-])(?:(\d{4})-)?(\d{1,2})-(\d{1,2})(?!\d)(\s*~?\s*(\d{1,2}):(\d{2})\s*Z)?/g;
  let m;
  let last = null;
  while ((m = re.exec(text)) !== null) last = m;
  if (!last) return null;
  const year = last[1] ? Number(last[1]) : new Date(now).getUTCFullYear();
  const month = Number(last[2]);
  const day = Number(last[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const hasTime = last[4] !== undefined;
  const h = hasTime ? Number(last[5]) : 23;
  const min = hasTime ? Number(last[6]) : 59;
  const s = hasTime ? 0 : 59;
  if (h > 23 || min > 59) return null;
  const ms = Date.UTC(year, month - 1, day, h, min, s);
  // Reject rollovers like 02-31.
  if (new Date(ms).getUTCDate() !== day) return null;
  return ms;
}
