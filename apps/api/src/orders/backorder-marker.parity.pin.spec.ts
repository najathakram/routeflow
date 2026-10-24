import { LIVE_BACKORDER_ORDER_STATUSES } from "./backorder-marker";
import { lineBackorderPieces } from "../../../../packages/types/order-line-backorder";

/**
 * The API cannot import the UI rule at runtime (the types package is type-only for the API), so the live
 * order-status set is copied in backorder-marker.ts. This pins the two against each other for EVERY order
 * status, so the copy cannot drift from what web/mobile show.
 */
const STATUSES = [
  "DRAFT",
  "PENDING",
  "CONFIRMED",
  "OUT_FOR_DELIVERY",
  "PARTIALLY_DELIVERED",
  "DELIVERED",
  "CANCELLED",
];

describe("live-order rule parity (API copy vs packages/types)", () => {
  it.each(STATUSES)("%s", (status) => {
    expect(LIVE_BACKORDER_ORDER_STATUSES.has(status)).toBe(
      lineBackorderPieces({ backorderedPieces: 3, status: "PENDING" }, status) > 0,
    );
  });
});
