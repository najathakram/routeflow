/**
 * #2348 — the buyer "Track your delivery" states and copy, shared with web via
 * @routeflow/types (api/order-tracking-view.ts). Web's delivery-tracking.logic
 * spec pins deriveTrackingView; this pins the copy the rebuilt mobile screen
 * renders, so the two platforms can never say different things about a stop.
 * Fixtures are placeholders.
 */
// The REAL shared source, by path: mobile's Jest maps the bare "@routeflow/types"
// specifier to a hand stub (__mocks__/@routeflow/types.js) that carries only a few
// runtime values. Importing the source pins the code web and mobile actually run,
// without adding another hand copy to the stub (same reason @routeflow/pricing is
// mapped to its src in jest.config.js).
import type { OrderTracking } from "../../../packages/types/api/order-tracking";
import {
  TRACKING_PILL_LABEL,
  deriveTrackingView,
  describeTrackingView,
  trackingFacts,
  type TrackingView,
  type TrackingViewKind,
} from "../../../packages/types/api/order-tracking-view";

const ALL_VIEWS: TrackingView[] = [
  { kind: "cancelled" },
  { kind: "delivered", deliveredAt: "2026-09-24T18:14:00.000Z" },
  { kind: "delivered", deliveredAt: null },
  { kind: "unscheduled" },
  { kind: "out-for-delivery" },
  { kind: "partly-delivered" },
  { kind: "rescheduling" },
  { kind: "skipped" },
  { kind: "stop-completed" },
  { kind: "route-finished" },
  {
    kind: "scheduled",
    scheduledDate: "2026-09-29T00:00:00.000Z",
    driverName: "Sam",
    window: "9:00 AM – 11:00 AM",
  },
  { kind: "on-the-way", stopsAhead: 2, driverName: "Sam", window: null },
  { kind: "arriving", driverName: null },
];

describe("TRACKING_PILL_LABEL", () => {
  it("has a non-empty label for every state", () => {
    const kinds = new Set(ALL_VIEWS.map((v) => v.kind));
    expect(Object.keys(TRACKING_PILL_LABEL).sort()).toEqual([...kinds].sort());
    for (const k of kinds) expect(TRACKING_PILL_LABEL[k as TrackingViewKind]).toBeTruthy();
  });
});

describe("describeTrackingView", () => {
  it.each(ALL_VIEWS.map((v) => [v.kind, v]))("%s has a headline and a detail", (_k, v) => {
    const d = describeTrackingView(v as TrackingView);
    expect(d.headline.length).toBeGreaterThan(0);
    expect(d.detail.length).toBeGreaterThan(0);
  });

  it("on-the-way leads with the stops-before-you count", () => {
    expect(
      describeTrackingView({ kind: "on-the-way", stopsAhead: 0, driverName: null, window: null }),
    ).toEqual({ headline: "You're next", detail: "Your driver is on the way." });
    expect(
      describeTrackingView({ kind: "on-the-way", stopsAhead: 3, driverName: "Sam", window: null }),
    ).toEqual({ headline: "3 stops before you", detail: "Sam is on the way." });
  });

  it("delivered names the delivery time when known, else a plain line", () => {
    expect(describeTrackingView({ kind: "delivered", deliveredAt: null }).detail).toBe(
      "Your order has been delivered.",
    );
    expect(
      describeTrackingView({ kind: "delivered", deliveredAt: "2026-09-24T18:14:00.000Z" }).detail,
    ).toMatch(/^Delivered on Sep 2[45], 2026 at \d{1,2}:\d{2}\s?[AP]M\.$/);
  });

  it("a skipped stop never reads as 'You're next' (the stop outranks the run)", () => {
    const tracking: OrderTracking = {
      runId: "run-1",
      routeName: null,
      driverName: "Sam Driver",
      runStatus: "IN_PROGRESS",
      stopNumber: 3,
      stopStatus: "SKIPPED",
      stopsAhead: 0,
      scheduledDate: "2026-09-29T00:00:00.000Z",
      estimatedArrivalWindow: { start: null, end: null },
    };
    const view = deriveTrackingView({ status: "CONFIRMED", deliveredAt: null, tracking });
    expect(view.kind).toBe("skipped");
    expect(describeTrackingView(view).headline).toBe("Stop skipped");
  });
});

describe("trackingFacts", () => {
  it("scheduled shows the UTC calendar day, the driver and the window", () => {
    expect(
      trackingFacts({
        kind: "scheduled",
        scheduledDate: "2026-09-29T00:00:00.000Z",
        driverName: "Sam",
        window: "9:00 AM – 11:00 AM",
      }),
    ).toEqual([
      { label: "Delivery date", value: "Tue, Sep 29" },
      { label: "Driver", value: "Sam" },
      { label: "Delivery window", value: "9:00 AM – 11:00 AM" },
    ]);
  });

  it("arriving shows the driver only; states with no live facts show none", () => {
    expect(trackingFacts({ kind: "arriving", driverName: "Sam" })).toEqual([
      { label: "Driver", value: "Sam" },
    ]);
    for (const v of ALL_VIEWS.filter(
      (x) => !["scheduled", "on-the-way", "arriving"].includes(x.kind),
    )) {
      expect(trackingFacts(v)).toEqual([]);
    }
  });
});
