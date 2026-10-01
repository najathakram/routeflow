/**
 * Internal, non-routable email sentinels minted when a customer has no real
 * address: `no-email+<uuid>@placeholder.local` (User.email is required + unique
 * per tenant) and `<username>@imported.local` (CSV import). Never email one of
 * these and never render one to a user — treat one exactly like "no email on
 * file".
 *
 * ONE implementation for web and mobile (B910): `apps/web/lib/formatting.ts` and
 * `apps/mobile/lib/internal-email.ts` re-export from here. The api keeps a LOCAL copy
 * (`apps/api/src/common/internal-email.ts`) — runtime source cannot value-import this
 * package — pinned functionally equal to this one by `internal-email.spec.ts`.
 */

/**
 * The addr-spec of a recipient string: unwraps `Name <x@y>` / `<x@y>` forms
 * (last trailing angle group wins) and trims padding — a guard that only
 * suffix-matches the raw string misses every formatted recipient (B910).
 */
function addrSpecOf(recipient: string): string {
  const trimmed = recipient.trim();
  const angle = trimmed.match(/<([^<>]*)>$/);
  return (angle?.[1] ?? trimmed).trim();
}

/** True when the recipient (bare, padded, or display-name form) is a sentinel. */
export function isInternalEmail(email?: string | null): boolean {
  if (!email) return false;
  const addr = addrSpecOf(email).toLowerCase();
  return addr.endsWith("@placeholder.local") || addr.endsWith("@imported.local");
}

/** The ONE empty-state copy for email fields — every render site uses this string. */
export const NO_EMAIL_COPY = "No email";

/**
 * Render-side email gate (L-225 shared-helper shape): returns the email only
 * when it is real — null for absent values AND for import sentinels, so every
 * screen treats both identically as "no email on file". String sites render
 * `displayEmail(e) ?? NO_EMAIL_COPY`; conditional sites hide on null.
 */
export function displayEmail(email?: string | null): string | null {
  return email && !isInternalEmail(email) ? email : null;
}
