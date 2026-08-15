/**
 * True for the internal, non-routable email sentinels minted when a customer has
 * no real address: `no-email+<uuid>@placeholder.local` (User.email is required +
 * unique per tenant) and `<username>@imported.local` (CSV import). Never email
 * one of these and never render one to a user — a send to a sentinel can only
 * bounce, and callers should treat it exactly like "no email on file".
 *
 * Triple mirror — this file (canonical) + web `lib/formatting.ts#isInternalEmail`
 * + mobile `lib/internal-email.ts`. Keep in sync.
 */
export function isInternalEmail(email?: string | null): boolean {
  if (!email) return false;
  const e = email.toLowerCase();
  return e.endsWith("@placeholder.local") || e.endsWith("@imported.local");
}
