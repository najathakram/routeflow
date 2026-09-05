// Shared evidence-text normaliser. Used by BOTH bugs.mjs (discharge's
// identical-evidence guard, which REFUSES two T2 rows given the same text)
// and campaign-check.mjs (the T2 gate's byte-identical-evidence warning,
// which WARNS about the same shape after the fact) — a single trailing
// space or a capitalization difference must not let one side see two
// strings as distinct while the other sees them as identical. Keep this in
// one place rather than two copies that can drift apart.
export function normalizeEvidence(text) {
  return String(text ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}
