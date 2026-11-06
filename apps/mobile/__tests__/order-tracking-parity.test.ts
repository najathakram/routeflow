/**
 * #2095 — the buyer tracking card refreshes in exactly the same states on mobile (every 20 s,
 * `trackingRefetchInterval`) and on the web (every 60 s). The web reads the shared
 * `isTrackingLive` (packages/types/api/order-tracking.ts); this pins mobile's own rule to it,
 * state for state, across every order status and every run status (plus "not on a run").
 *
 * Required by path: jest.config.js maps "@routeflow/types" to a hand stub for runtime values,
 * and a copy of the rule in that stub would only test the copy.
 */
import { trackingRefetchInterval } from "../lib/order-tracking-logic";
import { isTrackingLive } from "../../../packages/types/api/order-tracking";
import { ORDER_STATUS_VALUES, ROUTE_RUN_STATUS_VALUES } from "../../../packages/types/api/enums";

const cases = ORDER_STATUS_VALUES.flatMap((status) => [
  { status, tracking: null as { runStatus: string } | null },
  ...ROUTE_RUN_STATUS_VALUES.map((runStatus) => ({ status, tracking: { runStatus } })),
]);

describe("buyer tracking poll: mobile and web refresh in the same states (#2095)", () => {
  it("covers every order status x run state", () => {
    expect(cases).toHaveLength(ORDER_STATUS_VALUES.length * (ROUTE_RUN_STATUS_VALUES.length + 1));
  });

  it.each(cases)("status $status, tracking $tracking", (data) => {
    expect(trackingRefetchInterval(data) !== false).toBe(isTrackingLive(data));
  });

  it("a REFUSED order never polls on either platform, even on a live run (SA-1101)", () => {
    const data = { status: "REFUSED", tracking: { runStatus: "IN_PROGRESS" } };
    expect(trackingRefetchInterval(data)).toBe(false);
    expect(isTrackingLive(data)).toBe(false);
  });

  it("no data: neither polls", () => {
    expect(trackingRefetchInterval(undefined)).toBe(false);
    expect(isTrackingLive(undefined)).toBe(false);
  });
});
