/**
 * Internal, non-routable email sentinels minted when a customer has no real
 * address: `no-email+<uuid>@placeholder.local` (User.email is required + unique
 * per tenant) and `<username>@imported.local` (CSV import). Never email one of
 * these and never render one to a user — treat one exactly like "no email on
 * file".
 *
 * B910: the canonical implementation lives in `@routeflow/types`
 * (`internal-email.ts` there), which web and mobile re-export directly. The api
 * CANNOT value-import that package from runtime source (its `main` is raw TS —
 * see the "API runtime imports" tripwire spec), so this file keeps a local copy
 * that `internal-email.spec.ts` pins FUNCTIONALLY EQUAL to the shared one
 * across every recipient form. Change both together.
 */

/** The addr-spec of a recipient: unwraps `Name <x@y>` / `<x@y>` and trims padding. */
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
