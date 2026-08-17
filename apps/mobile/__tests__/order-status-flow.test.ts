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

  it("treats DELIVERED as terminal — the bug behind the stale reopen docstring", () => {
    expect(ORDER_STATUS_TRANSITIONS.DELIVERED).toEqual([]);
    for (const to of ["CONFIRMED", "PENDING", "OUT_FOR_DELIVERY", "CANCELLED"]) {
      expect(canTransitionOrder("DELIVERED", to)).toBe(false);
    }
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

  it("never offers a demotion out of DELIVERED", () => {
    for (const to of ["CONFIRMED", "PENDING", "OUT_FOR_DELIVERY"]) {
      expect(demotionRequiresReason("DELIVERED", to)).toBe(false);
    }
  });
});

describe("canDeleteOrder", () => {
  it("allows only the server's deletable statuses", () => {
    expect(canDeleteOrder("DRAFT")).toBe(true);
    expect(canDeleteOrder("PENDING")).toBe(true);
    expect(canDeleteOrder("CANCELLED")).toBe(true);
  });

  it("blocks the live statuses the tile used to 400 on", () => {
    for (const s of ["CONFIRMED", "OUT_FOR_DELIVERY", "PARTIALLY_DELIVERED", "DELIVERED"]) {
      expect(canDeleteOrder(s)).toBe(false);
    }
  });
});
