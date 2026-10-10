/**
 * #2095 — the pure rules behind the buyer's "Track your delivery" card: which state the card is
 * in, the "N stops before you" copy, the delivery-window text and the first-name-only driver.
 * When the card keeps refreshing is the query hook's rule (lib/api/buyer.order-tracking.test.tsx).
 * Fixtures are placeholders.
 */
import type { OrderTracking } from "@routeflow/types";
import {
  deriveTrackingView,
  firstNameOnly,
  formatDeliveryWindow,
  formatWindowTime,
  stopsBeforeYouLabel,
} from "./delivery-tracking.logic";

function tracking(over: Partial<OrderTracking> = {}): OrderTracking {
  return {
    runId: "run-1",
    routeName: null,
    driverName: "Sam",
    runStatus: "IN_PROGRESS",
    stopNumber: 4,
    stopStatus: "PENDING",
    stopsAhead: 3,
    scheduledDate: "2026-09-29T00:00:00.000Z",
    estimatedArrivalWindow: { start: "09:00", end: "11:30" },
    ...over,
  };
}

describe("stopsBeforeYouLabel", () => {
  it.each([
    [0, "You're next"],
    [1, "1 stop before you"],
    [2, "2 stops before you"],
    [12, "12 stops before you"],
  ])("%p → %p", (n, label) => {
    expect(stopsBeforeYouLabel(n)).toBe(label);
  });
});

describe("formatWindowTime / formatDeliveryWindow", () => {
  it.each([
    ["00:00", "12:00 AM"],
    ["09:00", "9:00 AM"],
    ["11:30", "11:30 AM"],
    ["12:00", "12:00 PM"],
    ["13:05", "1:05 PM"],
    ["23:59", "11:59 PM"],
  ])("%p reads %p", (raw, shown) => {
    expect(formatWindowTime(raw)).toBe(shown);
  });

  it("a value that is not HH:mm is shown as the seller wrote it", () => {
    expect(formatWindowTime(" after lunch ")).toBe("after lunch");
    expect(formatWindowTime("25:00")).toBe("25:00");
  });

  it("both ends, one end, or none", () => {
    expect(formatDeliveryWindow({ start: "09:00", end: "11:30" })).toBe("9:00 AM – 11:30 AM");
    expect(formatDeliveryWindow({ start: "09:00", end: null })).toBe("From 9:00 AM");
    expect(formatDeliveryWindow({ start: null, end: "11:30" })).toBe("By 11:30 AM");
    expect(formatDeliveryWindow({ start: null, end: null })).toBeNull();
    expect(formatDeliveryWindow({ start: " ", end: "" })).toBeNull();
  });
});

describe("firstNameOnly", () => {
  it("keeps the first word only, whatever it is given", () => {
    expect(firstNameOnly("Sam Rivera")).toBe("Sam");
    expect(firstNameOnly("  Sam  ")).toBe("Sam");
    expect(firstNameOnly("")).toBeNull();
    expect(firstNameOnly(null)).toBeNull();
  });
});

describe("deriveTrackingView", () => {
  const base = { deliveredAt: null };

  it("a cancelled order is cancelled, whatever the run says", () => {
    expect(deriveTrackingView({ ...base, status: "CANCELLED", tracking: tracking() }).kind).toBe(
      "cancelled",
    );
  });

  it("a delivered order carries its delivered time", () => {
    const view = deriveTrackingView({
      status: "DELIVERED",
      deliveredAt: "2026-09-24T17:14:00.000Z",
      tracking: tracking({ stopStatus: "COMPLETED" }),
    });
    expect(view).toEqual({ kind: "delivered", deliveredAt: "2026-09-24T17:14:00.000Z" });
  });

  it.each(["DRAFT", "PENDING", "CONFIRMED"])(
    "%s with no route stop is not scheduled yet",
    (status) => {
      expect(deriveTrackingView({ ...base, status, tracking: null }).kind).toBe("unscheduled");
    },
  );

  it("OUT_FOR_DELIVERY set by the office with no route stop is out for delivery, without live detail", () => {
    expect(deriveTrackingView({ ...base, status: "OUT_FOR_DELIVERY", tracking: null }).kind).toBe(
      "out-for-delivery",
    );
  });

  it("PARTIALLY_DELIVERED with no route stop, or with its stop done, is partly delivered", () => {
    expect(
      deriveTrackingView({ ...base, status: "PARTIALLY_DELIVERED", tracking: null }).kind,
    ).toBe("partly-delivered");
    expect(
      deriveTrackingView({
        ...base,
        status: "PARTIALLY_DELIVERED",
        tracking: tracking({ stopStatus: "COMPLETED" }),
      }).kind,
    ).toBe("partly-delivered");
  });

  it("a scheduled run shows its date, driver and window", () => {
    expect(
      deriveTrackingView({
        ...base,
        status: "CONFIRMED",
        tracking: tracking({ runStatus: "SCHEDULED", stopsAhead: 3 }),
      }),
    ).toEqual({
      kind: "scheduled",
      scheduledDate: "2026-09-29T00:00:00.000Z",
      driverName: "Sam",
      window: "9:00 AM – 11:30 AM",
    });
  });

  it("a live run with the own stop still pending is on the way, N stops out", () => {
    expect(
      deriveTrackingView({ ...base, status: "CONFIRMED", tracking: tracking({ stopsAhead: 3 }) }),
    ).toEqual({
      kind: "on-the-way",
      stopsAhead: 3,
      driverName: "Sam",
      window: "9:00 AM – 11:30 AM",
    });
  });

  it("the driver working the own stop is arriving", () => {
    expect(
      deriveTrackingView({
        ...base,
        status: "OUT_FOR_DELIVERY",
        tracking: tracking({ stopStatus: "IN_PROGRESS", stopsAhead: 0 }),
      }),
    ).toEqual({ kind: "arriving", driverName: "Sam" });
  });

  it("a skipped own stop is skipped — never 'You're next' (its stopsAhead can read 0)", () => {
    expect(
      deriveTrackingView({
        ...base,
        status: "CONFIRMED",
        tracking: tracking({ stopStatus: "SKIPPED", stopsAhead: 0 }),
      }).kind,
    ).toBe("skipped");
  });

  it("an own stop completed before the order reads delivered is a completed stop", () => {
    expect(
      deriveTrackingView({
        ...base,
        status: "CONFIRMED",
        tracking: tracking({ stopStatus: "COMPLETED", stopsAhead: 0 }),
      }).kind,
    ).toBe("stop-completed");
  });

  it("a cancelled run (defensive: the server sends no tracking for one) is being rescheduled", () => {
    expect(
      deriveTrackingView({
        ...base,
        status: "CONFIRMED",
        tracking: tracking({ runStatus: "CANCELLED" }),
      }).kind,
    ).toBe("rescheduling");
  });

  it("a finished run whose own stop was never closed is a finished route", () => {
    expect(
      deriveTrackingView({
        ...base,
        status: "CONFIRMED",
        tracking: tracking({ runStatus: "COMPLETED", stopStatus: "PENDING" }),
      }).kind,
    ).toBe("route-finished");
  });

  it("never passes on more than the driver's first name", () => {
    const view = deriveTrackingView({
      ...base,
      status: "CONFIRMED",
      tracking: tracking({ driverName: "Sam Rivera" }),
    });
    expect(view).toEqual(expect.objectContaining({ driverName: "Sam" }));
  });
});
