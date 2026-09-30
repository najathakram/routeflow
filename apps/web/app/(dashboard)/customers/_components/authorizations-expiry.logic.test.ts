/**
 * B91-web — a stored UTC-midnight calendar date (`expiresAt`) must render as its OWN
 * calendar day for every viewer. Nine web call sites currently render it through the
 * LOCAL formatter (`fmtDate`), which shows the PREVIOUS day to any negative-UTC-offset
 * viewer; `renderLicenceExpiry` is the extracted seam for the `AuthorizationsTab.tsx:274`
 * call site.
 *
 * REPLACES the previous T6, which asserted on `fmtCalendarDate` — an export that is
 * ALREADY UTC-anchored and already correct — plus a comparator asserting today's
 * to-be-removed `fmtDate` behavior. That test could not distinguish pre-fix from
 * post-fix in any zone (it passed on the host and failed on its comparator under UTC).
 * This one asserts the thing B91-web actually changes: what a call site renders.
 *
 * This red bar is HOST-ZONE-DEPENDENT: the pre-fix `fmtDate` body only shows the wrong
 * day west of UTC, so under `TZ=UTC` it would print "Nov 1, 2026" too (`process.env.TZ`
 * is inert under Jest). The zone-driven proof is e2e spec 34 flow 2, which pins
 * `timezoneId: "America/Los_Angeles"`; this test pins the call site's rendering.
 */
import { renderLicenceExpiry } from "./authorizations-expiry.logic";

describe("renderLicenceExpiry", () => {
  it("REG-B91 renders the calendar date, not one day early, for a negative-offset viewer", () => {
    // 2026-11-01T00:00:00.000Z is the stored calendar day 2026-11-01. Today's local
    // rendering shows "Oct 31, 2026" to an America/Los_Angeles viewer.
    expect(renderLicenceExpiry("2026-11-01T00:00:00.000Z")).toBe("Nov 1, 2026");
  });
});
