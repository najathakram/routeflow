// Shared REG-B### token grammar. Used by BOTH bugs.mjs (`prove`'s own-token
// check and its T3 manual-verification requirement) and campaign-check.mjs
// (test-title indexing and the T3 gate) — the two used to keep what a comment
// called "a literal duplicate" that had quietly drifted: bugs.mjs accepted
// REG-<id> at ANY digit count while campaign-check required exactly 2-3
// digits, so a single-digit id (B1..B9) could be proven but could never be
// discharged — an unrepairable claim. Kept in one place so that cannot
// happen again.
export const REG_TOKEN_RE = /REG-B(\d{1,4})(?![0-9])/g;

// The bug-id grammar itself, stated once so campaign-check's ROW-ID check and
// bugs.mjs's own id-argument checks cannot drift the way REG_TOKEN_RE's digit
// count and campaign-check's row-id digit count already had: campaign-check
// hard-coded /^B\d{1,3}$/ while REG_TOKEN_RE (and bugs.mjs's own
// `/^B\d+$/`-style checks) allow 4 digits, so `file` could mint B1000 — a row
// campaign-check would then refuse forever, an unrepairable claim of the
// opposite shape from the one REG_TOKEN_RE was fixed for.
export const BUG_ID_RE = /^B\d{1,4}$/;

// True when `text` contains the EXACT token for `id` — never a prefix match
// ("REG-B12" must not be satisfied by "REG-B120"). `id` may be given with or
// without its leading "B" ("B12" or "12").
export function hasRegToken(text, id) {
  const bare = String(id).replace(/^B/i, "");
  // A fresh, non-global RegExp per call — REG_TOKEN_RE carries the `g` flag
  // for `matchAll`, and reusing a global regex's own `.test()` across calls
  // is stateful (lastIndex persists), which is exactly the kind of bug this
  // shared module exists to not reintroduce.
  return new RegExp(`REG-B${bare}(?![0-9])`).test(String(text ?? ""));
}

// Extracts the "## Manual verification" section from `text` (up to the next
// H2, EOF, or a blank final line) — the same boundary bugs.mjs's `prove` and
// campaign-check.mjs's T3 gate must agree on, since drift here is exactly how
// a row could pass one side and fail the other. Returns `null` when the
// section itself is absent, so a caller can tell "no section" from "section,
// but empty" — as campaign-check.mjs's own comment says, "section absent =
// zero rows, not missing tool".
function manualVerificationSection(text) {
  const m = String(text ?? "").match(/## Manual verification\s*\n([\s\S]*?)(?:\n## |\n$|$)/);
  return m ? m[1] : null;
}

// The ids a T3 row may be discharged by: a REG-B### token, but ONLY when it
// appears in a TABLE ROW (a line matching /^\s*\|/) of the section above,
// after stripping fenced code blocks — T3's whole proof is "a
// manual-verification ROW in the batch's own build-plan.md", so a token
// merely mentioned in prose, or sitting inside a fence that explicitly says
// not to use it, must not count as one on either side.
export function manualVerificationIds(text) {
  const section = manualVerificationSection(text);
  if (section === null) return new Set();
  const stripped = section.replace(/```[\s\S]*?```/g, "");
  const ids = new Set();
  for (const line of stripped.split("\n")) {
    if (!/^\s*\|/.test(line)) continue;
    for (const m of line.matchAll(REG_TOKEN_RE)) ids.add(`B${m[1]}`);
  }
  return ids;
}

// Convenience wrapper for the single-id question `prove` actually asks.
export function hasManualVerificationRow(text, id) {
  const bare = String(id).replace(/^B/i, "").toUpperCase();
  return manualVerificationIds(text).has(`B${bare}`);
}
