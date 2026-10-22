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

/** Next monitor-owned id `W-<n>`: n = 1 + the highest existing W- number ("W-1" when none). */
export function nextWorkId(state) {
  let max = 0;
  for (const id of state.items.keys()) {
    const m = /^W-(\d+)$/.exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `W-${max + 1}`;
}

/**
 * The id a new item gets when none is given: `W-<n>` in human register mode (plain numbers belong
 * to the hand-kept register), the numeric max+1 in generated mode.
 */
export function allocateItemId(state, { generated = false } = {}) {
  return generated ? nextItemId(state) : nextWorkId(state);
}

/** UTC calendar date `YYYY-MM-DD` of an epoch-ms time. */
export function utcDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Every item id carried in a branch name, in token order: tokens split on / _ . -; each
 * `b<digits>` token (uppercased, known or not) and each 3-5 digit token that is a known item id.
 * 4-digit 2020-2039 tokens are years in date-stamped branch names, never item ids.
 */
export function itemIdsFromBranch(branch, knownIds = new Set()) {
  if (typeof branch !== "string") return [];
  const out = [];
  for (const tok of branch.split(/[/_.-]/)) {
    let id = null;
    if (/^b\d{1,5}$/i.test(tok)) id = tok.toUpperCase();
    else if (/^20[23]\d$/.test(tok)) continue;
    else if (/^\d{3,5}$/.test(tok) && knownIds.has(tok)) id = tok;
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/** The first item id carried in a branch name (see itemIdsFromBranch), else null. */
export function itemIdFromBranch(branch, knownIds = new Set()) {
  return itemIdsFromBranch(branch, knownIds)[0] ?? null;
}

const DATE = String.raw`(?:(\d{4})-)?(\d{1,2})-(\d{1,2})`;
const TIME = String.raw`(?:\s*~?\s*(\d{1,2}):(\d{2})\s*Z)?`;
// The WHOLE trimmed string must be a date or a date range, with an optional "~HH:MMZ" after each
// date and an optional trailing parenthetical. Anything else ("plan 10-16", "after census",
// "Phase 3", "unscheduled (slipped past 10-17)") is free text, not an ETA.
const ETA_RE = new RegExp(
  `^~?\\s*${DATE}${TIME}(?:\\s*(?:to|-|–|—)\\s*${DATE}${TIME})?(?:\\s*\\([^)]*\\))?$`,
  "i",
);

/**
 * Parses an ETA ("10-19 ~04:00Z", "10-19 to 10-21", "2026-10-20 ~18:00Z", "~10-19 (evening)")
 * into epoch ms. Only a real date or range counts (ETA_RE); a range uses its END date. The year
 * defaults to now's UTC year (a defaulted date more than ~6 months past means next year); the
 * time is the `~HH:MMZ` after the date used, else end of day 23:59:59Z. Free text -> null.
 */
export function parseEta(text, now = Date.now()) {
  if (typeof text !== "string") return null;
  const m = ETA_RE.exec(text.trim());
  if (!m) return null;
  const [, y1, mo1, d1, h1, mi1, y2, mo2, d2, h2, mi2] = m;
  const range = mo2 !== undefined;
  const month = Number(range ? mo2 : mo1);
  const day = Number(range ? d2 : d1);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (range && (Number(mo1) < 1 || Number(mo1) > 12 || Number(d1) < 1 || Number(d1) > 31))
    return null;
  const hh = range ? h2 : h1;
  const mm = range ? mi2 : mi1;
  const hasTime = hh !== undefined;
  const h = hasTime ? Number(hh) : 23;
  const min = hasTime ? Number(mm) : 59;
  const s = hasTime ? 0 : 59;
  if (h > 23 || min > 59) return null;
  const explicit = (range ? y2 : y1) ?? (range ? y1 : undefined);
  let year = explicit ? Number(explicit) : new Date(now).getUTCFullYear();
  // "2026-12-30 to 01-02": an end date without a year that lands before the start is next year.
  if (range && !y2 && y1 && month * 100 + day < Number(mo1) * 100 + Number(d1)) year += 1;
  let ms = Date.UTC(year, month - 1, day, h, min, s);
  // A defaulted year that lands more than ~6 months in the past means next year ("01-05" on 12-20).
  if (!y1 && !y2 && ms < now - 183 * 86400_000) {
    year += 1;
    ms = Date.UTC(year, month - 1, day, h, min, s);
  }
  // Reject rollovers like 02-31.
  if (new Date(ms).getUTCDate() !== day) return null;
  return ms;
}
