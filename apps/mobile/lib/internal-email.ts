/**
 * True for the internal, non-routable email sentinels minted when a customer has
 * no real address: `no-email+<uuid>@placeholder.local` (User.email is required +
 * unique per tenant) and `<username>@imported.local` (CSV import). Never email
 * one of these and never render one to a user — treat it like "no email on file".
 *
 * Triple mirror — api `common/internal-email.ts` (canonical) + web
 * `lib/formatting.ts#isInternalEmail` + this file. Keep in sync.
 */
export function isInternalEmail(email?: string | null): boolean {
  if (!email) return false;
  const e = email.toLowerCase();
  return e.endsWith("@placeholder.local") || e.endsWith("@imported.local");
}

/** The ONE empty-state copy for email fields — every render site uses this string. */
export const NO_EMAIL_COPY = "No email";

/**
 * Render-side email gate (mirror of web `lib/formatting.ts#displayEmail`): returns
 * the email only when it is real — null for absent values AND for import sentinels,
 * so every screen treats both identically as "no email on file". String sites
 * render `displayEmail(e) ?? NO_EMAIL_COPY`; conditional sites hide on null.
 */
export function displayEmail(email?: string | null): string | null {
  return email && !isInternalEmail(email) ? email : null;
}
