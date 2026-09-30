import { fmtCalendarDate } from "@/lib/formatting";

/**
 * Pure display seam for the licence-expiry line in `AuthorizationsTab.tsx`
 * (`:274` — ``` `Expires ${renderLicenceExpiry(auth.expiresAt)}` ```), one of the nine
 * web call sites that used to render a stored UTC-midnight CALENDAR date through the
 * LOCAL formatter and therefore showed the PREVIOUS day to every negative-UTC-offset
 * viewer (B91-web).
 *
 * `AuthorizationsTab.tsx:274` renders through this function, so the unit test below
 * asserts the string the component actually produces rather than a dead copy.
 *
 * A calendar date has no zone, so its rendering must be identical for every viewer —
 * hence the delegation to the UTC-anchored `fmtCalendarDate`. Note that the unit
 * test's red bar is HOST-ZONE-DEPENDENT: the old `fmtDate` body is only wrong west of
 * UTC, so the test passes on the pre-fix body under `TZ=UTC`. The zone-driven proof is
 * e2e spec 34 flow 2, which pins `timezoneId: "America/Los_Angeles"`.
 */
export function renderLicenceExpiry(expiresAt?: string | null): string {
  return fmtCalendarDate(expiresAt);
}
