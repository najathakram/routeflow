/**
 * Order status-flow gating (PR-1): mirrors of the server's `changeStatus`
 * transition table, its demote-needs-a-reason rule, and `deleteOrder`'s allowed
 * statuses. These exist so a visible control never earns a guaranteed 400 —
 * every case below corresponds to a specific server guard.
 */
import {
  ORDER_STATUS_TRANSITIONS,
  canDeleteOrder,
  canTransitionOrder,
  demotionRequiresReason,
  isPosOrder,
  posStatusMoveAllowed,
} from "../lib/order-status-flow";

describe("canTransitionOrder", () => {
  it("allows the forward moves the server allows", () => {
    expect(canTransitionOrder("DRAFT", "PENDING")).toBe(true);
    expect(canTransitionOrder("PENDING", "CONFIRMED")).toBe(true);
    expect(canTransitionOrder("CONFIRMED", "OUT_FOR_DELIVERY")).toBe(true);
    expect(canTransitionOrder("CONFIRMED", "DELIVERED")).toBe(true);
    expect(canTransitionOrder("OUT_FOR_DELIVERY", "PARTIALLY_DELIVERED")).toBe(true);
    expect(canTransitionOrder("PARTIALLY_DELIVERED", "DELIVERED")).toBe(true);
  });

  it("allows cancelling from every live status", () => {
    for (const s of ["DRAFT", "PENDING", "CONFIRMED", "OUT_FOR_DELIVERY", "PARTIALLY_DELIVERED"]) {
      expect(canTransitionOrder(s, "CANCELLED")).toBe(true);
    }
  });

  // Owner reversed policy 2026-08-25: DELIVERED is no longer terminal — it steps
  // back one stage like every other status. Still exactly one stage, though.
  it("lets DELIVERED step back one stage, and no further", () => {
    expect(ORDER_STATUS_TRANSITIONS.DELIVERED).toEqual(["CONFIRMED", "PARTIALLY_DELIVERED"]);
    expect(canTransitionOrder("DELIVERED", "CONFIRMED")).toBe(true);
    expect(canTransitionOrder("DELIVERED", "PARTIALLY_DELIVERED")).toBe(true);
    for (const to of ["PENDING", "DRAFT", "OUT_FOR_DELIVERY", "CANCELLED"]) {
      expect(canTransitionOrder("DELIVERED", to)).toBe(false);
    }
  });

  it("lets PENDING step back to DRAFT", () => {
    expect(canTransitionOrder("PENDING", "DRAFT")).toBe(true);
  });

  it("rejects OUT_FOR_DELIVERY → PENDING (skips a step) and unknown statuses", () => {
    expect(canTransitionOrder("OUT_FOR_DELIVERY", "PENDING")).toBe(false);
    expect(canTransitionOrder("PENDING", "DELIVERED")).toBe(false);
    expect(canTransitionOrder("CANCELLED", "PENDING")).toBe(false); // goes via /reopen
    expect(canTransitionOrder("NOPE", "PENDING")).toBe(false);
  });
});

describe("demotionRequiresReason", () => {
  it("requires a reason for every demotion the UI can offer", () => {
    expect(demotionRequiresReason("CONFIRMED", "PENDING")).toBe(true);
    expect(demotionRequiresReason("OUT_FOR_DELIVERY", "CONFIRMED")).toBe(true);
    expect(demotionRequiresReason("PARTIALLY_DELIVERED", "OUT_FOR_DELIVERY")).toBe(true);
  });

  it("mirrors the server's unreachable OUT_FOR_DELIVERY → PENDING arm", () => {
    // The transition table rejects this first, so it never reaches the reason
    // check — kept faithful to the server so it stays correct if that changes.
    expect(demotionRequiresReason("OUT_FOR_DELIVERY", "PENDING")).toBe(true);
    expect(canTransitionOrder("OUT_FOR_DELIVERY", "PENDING")).toBe(false);
  });

  it("does not ask for a reason on promotions or cancellations", () => {
    expect(demotionRequiresReason("PENDING", "CONFIRMED")).toBe(false);
    expect(demotionRequiresReason("CONFIRMED", "OUT_FOR_DELIVERY")).toBe(false);
    expect(demotionRequiresReason("CONFIRMED", "DELIVERED")).toBe(false);
    expect(demotionRequiresReason("OUT_FOR_DELIVERY", "DELIVERED")).toBe(false);
    expect(demotionRequiresReason("CONFIRMED", "CANCELLED")).toBe(false);
  });

  it("treats both DELIVERED demotions and PENDING → DRAFT as reasoned", () => {
    expect(demotionRequiresReason("DELIVERED", "CONFIRMED")).toBe(true);
    expect(demotionRequiresReason("DELIVERED", "PARTIALLY_DELIVERED")).toBe(true);
    expect(demotionRequiresReason("PENDING", "DRAFT")).toBe(true);
    // Not a one-step-back move, so not in the server's isDemotion set either.
    expect(demotionRequiresReason("DELIVERED", "PENDING")).toBe(false);
  });
});

describe("canDeleteOrder", () => {
  // Delete-any (2026-08-25): status stopped being the gate server-side — money
  // is. The only remaining block (a linked invoice with recorded payments) is
  // invisible from the status alone, so the action shows and the 409 toasts.
  it("allows every status — the server gates on payments, not status", () => {
    for (const s of [
      "DRAFT",
      "PENDING",
      "CONFIRMED",
      "OUT_FOR_DELIVERY",
      "PARTIALLY_DELIVERED",
      "DELIVERED",
      "CANCELLED",
    ]) {
      expect(canDeleteOrder(s)).toBe(true);
    }
  });
});

describe("POS mode predicate and status pin (SA-763r P-2)", () => {
  it("isPosOrder is PICKUP and not a counter sale, literally", () => {
    expect(isPosOrder({ fulfillPath: "PICKUP", counterSale: false })).toBe(true);
    expect(isPosOrder({ fulfillPath: "PICKUP" })).toBe(true);
    expect(isPosOrder({ fulfillPath: "PICKUP", counterSale: null })).toBe(true);
    expect(isPosOrder({ fulfillPath: "PICKUP", counterSale: true })).toBe(false);
    expect(isPosOrder({ fulfillPath: "ROUTE" })).toBe(false);
    expect(isPosOrder({ fulfillPath: "SHIP", counterSale: false })).toBe(false);
    expect(isPosOrder(null)).toBe(false);
    expect(isPosOrder(undefined)).toBe(false);
  });

  it("a POS order is offered no Out-for-delivery and no DELIVERED move; everything else is", () => {
    const pos = { fulfillPath: "PICKUP", counterSale: false };
    expect(posStatusMoveAllowed(pos, "OUT_FOR_DELIVERY")).toBe(false);
    expect(posStatusMoveAllowed(pos, "DELIVERED")).toBe(false);
    expect(posStatusMoveAllowed(pos, "CONFIRMED")).toBe(true);
    expect(posStatusMoveAllowed(pos, "CANCELLED")).toBe(true);
    // ROUTE, SHIP and counter sales are untouched by the pin.
    for (const o of [
      { fulfillPath: "ROUTE" },
      { fulfillPath: "SHIP" },
      { fulfillPath: "PICKUP", counterSale: true },
    ]) {
      expect(posStatusMoveAllowed(o, "OUT_FOR_DELIVERY")).toBe(true);
      expect(posStatusMoveAllowed(o, "DELIVERED")).toBe(true);
    }
  });
});
