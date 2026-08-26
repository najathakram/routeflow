/**
 * `statusActions` (extracted from `(operator)/(tabs)/orders/[id].tsx`, plan
 * §WP11) drives the order-detail action bar. Three things are pinned here:
 *  - ROUTE (the default) is byte-identical to the pre-extraction switch.
 *  - SHIP relabels the shipping-shaped actions and drops "Partial delivery".
 *  - Every action's `toStatus`, for BOTH fulfillment paths, is a transition
 *    the server's `changeStatus` actually allows — cross-checked against
 *    `canTransitionOrder` (`lib/order-status-flow.ts`) so a visible button
 *    never earns a guaranteed 400 (except the CANCELLED reopen action, which
 *    deliberately routes through POST /reopen instead of PATCH /status).
 */
import { statusActions } from "../lib/order-actions";
import { canTransitionOrder, ORDER_STATUS_TRANSITIONS } from "../lib/order-status-flow";
import type { OrderStatus } from "../lib/api/orders";

const ALL_STATUSES: OrderStatus[] = [
  "DRAFT",
  "PENDING",
  "CONFIRMED",
  "OUT_FOR_DELIVERY",
  "PARTIALLY_DELIVERED",
  "DELIVERED",
  "CANCELLED",
];

describe("statusActions — ROUTE (default) is byte-identical to the pre-extraction switch", () => {
  it("DRAFT", () => {
    expect(statusActions("DRAFT")).toEqual([
      {
        label: "Submit for review",
        toStatus: "PENDING",
        style: "primary",
        icon: "arrow-forward-circle-outline",
      },
    ]);
  });

  it("PENDING", () => {
    expect(statusActions("PENDING", "ROUTE")).toEqual([
      {
        label: "Confirm order",
        toStatus: "CONFIRMED",
        style: "primary",
        icon: "checkmark-circle-outline",
      },
      {
        label: "Cancel order",
        toStatus: "CANCELLED",
        style: "danger",
        icon: "close-circle-outline",
        confirmMessage: "Cancel this order? It cannot be undone easily.",
      },
    ]);
  });

  it("CONFIRMED", () => {
    expect(statusActions("CONFIRMED")).toEqual([
      {
        label: "Deliver & send invoice",
        toStatus: "DELIVERED",
        style: "primary",
        icon: "flash-outline",
        confirmMessage: "Mark as delivered without going through dispatch?",
      },
      {
        label: "Send for delivery",
        toStatus: "OUT_FOR_DELIVERY",
        style: "secondary",
        icon: "car-outline",
      },
      {
        label: "Back to pending",
        toStatus: "PENDING",
        style: "warning",
        icon: "arrow-back-circle-outline",
        confirmMessage: "Revert order back to Pending?",
      },
      {
        label: "Cancel order",
        toStatus: "CANCELLED",
        style: "danger",
        icon: "close-circle-outline",
        confirmMessage: "Cancel this order?",
      },
    ]);
  });

  it("OUT_FOR_DELIVERY", () => {
    expect(statusActions("OUT_FOR_DELIVERY")).toEqual([
      {
        label: "Mark delivered",
        toStatus: "DELIVERED",
        style: "primary",
        icon: "checkmark-done-circle-outline",
      },
      {
        label: "Partial delivery",
        toStatus: "PARTIALLY_DELIVERED",
        style: "secondary",
        icon: "git-branch-outline",
      },
      {
        label: "Back to confirmed",
        toStatus: "CONFIRMED",
        style: "warning",
        icon: "arrow-back-circle-outline",
        confirmMessage: "Revert order back to Confirmed?",
      },
      {
        label: "Cancel order",
        toStatus: "CANCELLED",
        style: "danger",
        icon: "close-circle-outline",
        confirmMessage: "Cancel this order?",
      },
    ]);
  });

  it("PARTIALLY_DELIVERED", () => {
    expect(statusActions("PARTIALLY_DELIVERED")).toEqual([
      {
        label: "Mark fully delivered",
        toStatus: "DELIVERED",
        style: "primary",
        icon: "checkmark-done-circle-outline",
      },
      {
        label: "Back out for delivery",
        toStatus: "OUT_FOR_DELIVERY",
        style: "warning",
        icon: "arrow-back-circle-outline",
        confirmMessage: "Revert back to Out for delivery?",
      },
      {
        label: "Cancel order",
        toStatus: "CANCELLED",
        style: "danger",
        icon: "close-circle-outline",
        confirmMessage: "Cancel this order?",
      },
    ]);
  });

  it("CANCELLED", () => {
    expect(statusActions("CANCELLED")).toEqual([
      {
        label: "Reopen order",
        toStatus: "PENDING",
        style: "primary",
        icon: "refresh-outline",
        confirmMessage: "Reopen this cancelled order back to Pending?",
        reopenCancelled: true,
      },
    ]);
  });

  it("DELIVERED — Reopen order (2026-08-25: BUG-ORD-01 reversed by owner)", () => {
    expect(statusActions("DELIVERED")).toEqual([
      {
        label: "Reopen order",
        toStatus: "CONFIRMED",
        style: "warning",
        icon: "refresh-outline",
        confirmMessage:
          "Reopen this delivered order back to Confirmed? Its delivered date is cleared.",
      },
    ]);
  });
});

describe("statusActions — SHIP relabels + drops Partial delivery", () => {
  it("CONFIRMED: relabels the OUT_FOR_DELIVERY- and DELIVERED-bound actions, leaves the rest alone", () => {
    const actions = statusActions("CONFIRMED", "SHIP");
    expect(actions.map((a) => a.label)).toEqual([
      "Mark delivered",
      "Mark shipped",
      "Back to pending",
      "Cancel order",
    ]);
    // Relabeling never touches the toStatus targets themselves.
    expect(actions.map((a) => a.toStatus)).toEqual([
      "DELIVERED",
      "OUT_FOR_DELIVERY",
      "PENDING",
      "CANCELLED",
    ]);
  });

  it("OUT_FOR_DELIVERY: drops Partial delivery, relabels Back to confirmed to Unmark shipped", () => {
    const actions = statusActions("OUT_FOR_DELIVERY", "SHIP");
    expect(actions.map((a) => a.label)).toEqual([
      "Mark delivered",
      "Unmark shipped",
      "Cancel order",
    ]);
    expect(actions.some((a) => a.toStatus === "PARTIALLY_DELIVERED")).toBe(false);
  });

  it("PARTIALLY_DELIVERED: relabels both delivery-bound actions (no Partial-delivery action to drop here)", () => {
    const actions = statusActions("PARTIALLY_DELIVERED", "SHIP");
    expect(actions.map((a) => a.label)).toEqual(["Mark delivered", "Mark shipped", "Cancel order"]);
  });

  it("statuses with no shipping-shaped action are unaffected by SHIP", () => {
    expect(statusActions("DRAFT", "SHIP")).toEqual(statusActions("DRAFT", "ROUTE"));
    expect(statusActions("PENDING", "SHIP")).toEqual(statusActions("PENDING", "ROUTE"));
    expect(statusActions("CANCELLED", "SHIP")).toEqual(statusActions("CANCELLED", "ROUTE"));
    // DELIVERED's "Reopen order" targets CONFIRMED, not OUT_FOR_DELIVERY/DELIVERED,
    // so none of SHIP's relabeling rules touch it — same list either way.
    expect(statusActions("DELIVERED", "SHIP")).toEqual(statusActions("DELIVERED", "ROUTE"));
  });

  it("ROUTE and SHIP produce independently-labeled lists for the same status", () => {
    expect(statusActions("CONFIRMED", "SHIP")[0].label).toBe("Mark delivered");
    expect(statusActions("CONFIRMED", "ROUTE")[0].label).toBe("Deliver & send invoice");
  });
});

describe("statusActions × canTransitionOrder cross-check", () => {
  it.each(ALL_STATUSES)(
    "every ROUTE action's toStatus is a legal /status transition from %s",
    (status) => {
      for (const action of statusActions(status, "ROUTE")) {
        if (action.reopenCancelled) continue; // routes through POST /reopen, not PATCH /status
        expect(canTransitionOrder(status, action.toStatus)).toBe(true);
      }
    },
  );

  it.each(ALL_STATUSES)(
    "every SHIP action's toStatus is a legal /status transition from %s",
    (status) => {
      for (const action of statusActions(status, "SHIP")) {
        if (action.reopenCancelled) continue;
        expect(canTransitionOrder(status, action.toStatus)).toBe(true);
      }
    },
  );

  it("the CANCELLED reopen action is deliberately absent from the /status transition table", () => {
    expect(canTransitionOrder("CANCELLED", "PENDING")).toBe(false);
  });
});

describe("map parity — mirrors the server's universal one-step demotion (2026-08-25)", () => {
  it("PENDING can step back to DRAFT (no UI action yet, map-only)", () => {
    expect(ORDER_STATUS_TRANSITIONS.PENDING).toContain("DRAFT");
    expect(canTransitionOrder("PENDING", "DRAFT")).toBe(true);
  });

  it("DELIVERED demotes to CONFIRMED (the Reopen order button above) and PARTIALLY_DELIVERED", () => {
    expect(ORDER_STATUS_TRANSITIONS.DELIVERED).toEqual(
      expect.arrayContaining(["CONFIRMED", "PARTIALLY_DELIVERED"]),
    );
    expect(canTransitionOrder("DELIVERED", "CONFIRMED")).toBe(true);
    expect(canTransitionOrder("DELIVERED", "PARTIALLY_DELIVERED")).toBe(true);
  });

  it("DELIVERED still can't jump to a status that isn't one step back", () => {
    expect(canTransitionOrder("DELIVERED", "OUT_FOR_DELIVERY")).toBe(false);
    expect(canTransitionOrder("DELIVERED", "PENDING")).toBe(false);
    expect(canTransitionOrder("DELIVERED", "DRAFT")).toBe(false);
    expect(canTransitionOrder("DELIVERED", "CANCELLED")).toBe(false);
  });
});
