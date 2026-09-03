import { readFileSync } from "fs";
import { join } from "path";
import { buildReorderItems, canReorder, trackingStepIndex } from "../lib/order-tracking-logic";

describe("buildReorderItems", () => {
  it("drops CANCELLED lines and lines with no productId", () => {
    const order = {
      lineItems: [
        { id: "1", productId: "p1", qty: 3, status: "CONFIRMED" },
        { id: "2", productId: "p2", qty: 1, status: "CANCELLED" },
        { id: "3", productId: "", qty: 2, status: "CONFIRMED" },
      ],
    } as any;
    expect(buildReorderItems(order)).toEqual([{ productId: "p1", qty: 3 }]);
  });

  it("carries boxes/pieces through unchanged for boxed lines", () => {
    const order = {
      lineItems: [{ id: "1", productId: "p1", qty: 24, boxes: 2, pieces: 0, status: "DELIVERED" }],
    } as any;
    expect(buildReorderItems(order)).toEqual([{ productId: "p1", qty: 24, boxes: 2, pieces: 0 }]);
  });

  it("drops zero/negative-qty lines", () => {
    const order = {
      lineItems: [{ id: "1", productId: "p1", qty: 0, status: "CONFIRMED" }],
    } as any;
    expect(buildReorderItems(order)).toEqual([]);
  });
});

describe("canReorder", () => {
  it("is false for DRAFT and PENDING, true otherwise", () => {
    expect(canReorder({ status: "DRAFT" })).toBe(false);
    expect(canReorder({ status: "PENDING" })).toBe(false);
    expect(canReorder({ status: "CONFIRMED" })).toBe(true);
    expect(canReorder({ status: "DELIVERED" })).toBe(true);
    expect(canReorder({ status: "CANCELLED" })).toBe(true);
  });
});

describe("trackingStepIndex", () => {
  it("indexes the happy-path statuses in order", () => {
    expect(trackingStepIndex("PENDING")).toBe(0);
    expect(trackingStepIndex("DELIVERED")).toBe(4);
  });
  it("returns -1 for CANCELLED / unknown", () => {
    expect(trackingStepIndex("CANCELLED")).toBe(-1);
  });
});

/**
 * F11 (REG-B146): the buyer tracking card must never claim "You're next on
 * the route" for a stop that was SKIPPED (or CANCELLED-run stopped
 * tracking), and the poll must keep refreshing for the whole IN_PROGRESS
 * run, not only while the order itself sits at OUT_FOR_DELIVERY. Both
 * helpers are new exports of ../lib/order-tracking-logic — loaded via
 * `require` (not a static import) so a pre-impl run fails on the assertion
 * below, not on an unresolved import (module exists today; only these two
 * exports are missing).
 */
describe("trackingHeadline / trackingRefetchInterval (F11)", () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const logic: any = require("../lib/order-tracking-logic");
  const headline = (t: any) => {
    expect(typeof logic.trackingHeadline).toBe("function");
    return logic.trackingHeadline(t);
  };
  const interval = (d: any) => {
    expect(typeof logic.trackingRefetchInterval).toBe("function");
    return logic.trackingRefetchInterval(d);
  };

  const SKIPPED_COPY =
    "Your stop was skipped on this run — the seller will follow up to reschedule.";

  it(`REG-B146: a skipped own-stop never reads as "You're next on the route"`, () => {
    // T17 · R8
    expect(headline({ runStatus: "IN_PROGRESS", stopStatus: "SKIPPED", stopsAhead: 0 })).toBe(
      SKIPPED_COPY,
    );
    expect(
      headline({ runStatus: "IN_PROGRESS", stopStatus: "SKIPPED", stopsAhead: 0 }),
    ).not.toMatch(/next on the route/);
    // stopsAhead is ignored once the stop is SKIPPED.
    expect(headline({ runStatus: "IN_PROGRESS", stopStatus: "SKIPPED", stopsAhead: 3 })).toBe(
      SKIPPED_COPY,
    );
  });

  // T18 · R8 — precedence: CANCELLED run > SKIPPED stop > live IN_PROGRESS copy > null.
  it.each([
    ["CANCELLED", "PENDING", 0, "match", /cancelled/i],
    ["CANCELLED", "SKIPPED", 0, "match", /cancelled/i],
    ["COMPLETED", "SKIPPED", 0, "exact", SKIPPED_COPY],
    ["IN_PROGRESS", "PENDING", 0, "exact", "You're next on the route"],
    ["IN_PROGRESS", "PENDING", 1, "exact", "1 stop ahead of you"],
    ["IN_PROGRESS", "PENDING", 4, "exact", "4 stops ahead of you"],
    ["SCHEDULED", "PENDING", 0, "null", null],
    ["COMPLETED", "COMPLETED", 0, "null", null],
  ] as const)(
    "REG-B146: headline precedence — cancelled run, skipped stop, live run copy, finished run → null (runStatus=%s stopStatus=%s stopsAhead=%s)",
    (runStatus, stopStatus, stopsAhead, kind, expected) => {
      const result = headline({ runStatus, stopStatus, stopsAhead });
      if (kind === "match") {
        expect(result).toMatch(expected as RegExp);
      } else if (kind === "null") {
        expect(result).toBeNull();
      } else {
        expect(result).toBe(expected);
      }
    },
  );

  it("REG-B146 wiring: the buyer order screen renders trackingHeadline, hides the ETA line for a skipped stop, and no longer hardcodes the stops-ahead ternary", () => {
    // T19 · R8
    const screenSrc = readFileSync(
      join(__dirname, "..", "app", "(customer)", "orders", "[id].tsx"),
      "utf8",
    );
    expect(screenSrc).toMatch(/trackingHeadline\(/);
    expect(screenSrc).not.toMatch(/You're next on the route/);
    expect(screenSrc).not.toMatch(/stopsAhead === 0\s*\?/);
    expect(screenSrc).toMatch(
      /stopStatus\s*!==\s*"SKIPPED"[\s\S]{0,200}estimatedArrivalWindow|estimatedArrivalWindow[\s\S]{0,200}stopStatus\s*!==\s*"SKIPPED"/,
    );
  });

  it("REG-B146: the tracking poll keeps refreshing while the run is IN_PROGRESS, not only while the order is OUT_FOR_DELIVERY", () => {
    // T20 · R8
    expect(interval({ status: "CONFIRMED", tracking: { runStatus: "IN_PROGRESS" } })).toBe(20000);
    expect(interval({ status: "OUT_FOR_DELIVERY", tracking: null })).toBe(20000);
    expect(interval({ status: "CONFIRMED", tracking: { runStatus: "SCHEDULED" } })).toBe(false);
    expect(interval({ status: "DELIVERED", tracking: { runStatus: "COMPLETED" } })).toBe(false);
    // A terminal order keeps its stop pointer, so its payload still reports the
    // run's live status — the poll must still pause, not follow the run.
    expect(interval({ status: "DELIVERED", tracking: { runStatus: "IN_PROGRESS" } })).toBe(false);
    expect(interval({ status: "CANCELLED", tracking: { runStatus: "IN_PROGRESS" } })).toBe(false);
    expect(interval(undefined)).toBe(false);

    const buyerSrc = readFileSync(join(__dirname, "..", "lib", "api", "buyer.ts"), "utf8");
    expect(buyerSrc).toMatch(/trackingRefetchInterval\(/);
    expect(buyerSrc).not.toMatch(
      /s === "OUT_FOR_DELIVERY" \|\| s === "PARTIALLY_DELIVERED" \? 20_000/,
    );
  });
});
