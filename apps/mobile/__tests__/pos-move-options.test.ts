import {
  POS_COPY,
  posMoveConfirm,
  posMoveFailedCopy,
  posMoveOptions,
  posOrderActions,
} from "../lib/pos-mode";
import { staffFormFulfilment } from "../lib/fulfilment-caps";

/**
 * Row 505 (mobile twin of web M8, #3440): "Ship by carrier…" beside "Switch to delivery" on a pickup (POS)
 * order. Same rule as web `posMoveOptions`, fed by the same capability answer (`capabilities.fulfilment`).
 */
const features = (methods: string[], staffDefault = methods[0], consistent = true) => ({
  capabilities: { fulfilment: { methods, staffDefault, consistent, portalMethods: [] } },
});
const keys = (a: { key: string }[]) => a.map((x) => x.key);
const pathOf = (a: { key: string; path?: string }[], key: string) =>
  a.find((x) => x.key === key)?.path;

describe("staffFormFulfilment (the capability source, same as web useStaffFulfilment)", () => {
  it("no answer yet / an older API without the block: today's ROUTE + SHIP, ROUTE default", () => {
    for (const f of [undefined, null, {}, { capabilities: {} }]) {
      expect(staffFormFulfilment(f as never)).toEqual({
        formMethods: ["ROUTE", "SHIP"],
        formDefault: "ROUTE",
      });
    }
  });
  it("an inconsistent answer (delivery mode whose fleet is gone) keeps today's pair", () => {
    expect(staffFormFulfilment(features(["ROUTE"], "ROUTE", false) as never).formMethods).toEqual([
      "ROUTE",
      "SHIP",
    ]);
  });
  it("keeps only the ROUTE / SHIP methods the form can hold, in the account's order", () => {
    expect(staffFormFulfilment(features(["PICKUP", "SHIP"]) as never).formMethods).toEqual([
      "SHIP",
    ]);
    expect(staffFormFulfilment(features(["PICKUP"]) as never).formMethods).toEqual([]);
  });
  it("PICKUP as the staff default falls back to SHIP as a form value (web toFormPath)", () => {
    expect(staffFormFulfilment(features(["PICKUP"]) as never).formDefault).toBe("SHIP");
    expect(staffFormFulfilment(features(["ROUTE", "PICKUP"], "ROUTE") as never).formDefault).toBe(
      "ROUTE",
    );
  });
});

describe("posMoveOptions (web posMoveOptions, verbatim rule)", () => {
  it("a full account (ROUTE + SHIP): Switch to delivery goes to ROUTE, plus Ship by carrier…", () => {
    expect(posMoveOptions(["ROUTE", "SHIP"], "ROUTE")).toEqual({ delivery: "ROUTE", ship: true });
    expect(posMoveOptions(["SHIP", "ROUTE"], "SHIP")).toEqual({ delivery: "ROUTE", ship: true });
  });
  it("a route-only account: the lone Switch to delivery, no ship button", () => {
    expect(posMoveOptions(["ROUTE"], "ROUTE")).toEqual({ delivery: "ROUTE", ship: false });
  });
  it("a ship-only account: no delivery button, only Ship by carrier…", () => {
    expect(posMoveOptions(["SHIP"], "SHIP")).toEqual({ delivery: null, ship: true });
  });
  it("a pickup-only account: today's lone Switch to delivery, to the account default (SHIP fallback)", () => {
    expect(posMoveOptions([], "SHIP")).toEqual({ delivery: "SHIP", ship: false });
  });
});

describe.each(["PENDING", "CONFIRMED"])(
  "posOrderActions with move options, a %s order",
  (status) => {
    const order = { invoices: [] };
    const moves = (o: Parameters<typeof posOrderActions>[2]) =>
      posOrderActions(order, status, o).filter(
        (a) => a.key === "switchToDelivery" || a.key === "shipByCarrier",
      );

    it("full account: both buttons, adjacent and last; Switch to delivery -> ROUTE, Ship -> SHIP", () => {
      const all = posOrderActions(order, status, { delivery: "ROUTE", ship: true });
      expect(keys(all).slice(-2)).toEqual(["switchToDelivery", "shipByCarrier"]);
      expect(pathOf(all, "switchToDelivery")).toBe("ROUTE");
      expect(pathOf(all, "shipByCarrier")).toBe("SHIP");
      expect(all.find((a) => a.key === "shipByCarrier")?.label).toBe("Ship by carrier…");
      expect(POS_COPY.shipByCarrier).toBe("Ship by carrier…");
    });
    it("ship-only account: only Ship by carrier… (the same SHIP handler), no Switch to delivery", () => {
      const m = moves({ delivery: null, ship: true });
      expect(keys(m)).toEqual(["shipByCarrier"]);
      expect(pathOf(m, "shipByCarrier")).toBe("SHIP");
    });
    it("pickup-only account: only the lone Switch to delivery (to the fallback path)", () => {
      const m = moves({ delivery: "SHIP", ship: false });
      expect(keys(m)).toEqual(["switchToDelivery"]);
      expect(pathOf(m, "switchToDelivery")).toBe("SHIP");
    });
    it("route-only account: the lone Switch to delivery to ROUTE", () => {
      expect(pathOf(moves({ delivery: "ROUTE", ship: false }), "switchToDelivery")).toBe("ROUTE");
    });
    it("no options passed: today's single Switch to delivery to ROUTE (nothing else changes)", () => {
      const m = moves(undefined);
      expect(keys(m)).toEqual(["switchToDelivery"]);
      expect(pathOf(m, "switchToDelivery")).toBe("ROUTE");
    });
  },
);

describe("posOrderActions: the carrier move is not offered once the server refuses it", () => {
  const both = { delivery: "ROUTE", ship: true } as const;
  it.each(["OUT_FOR_DELIVERY", "DELIVERED", "CANCELLED"])("%s offers neither move", (status) => {
    const k = keys(posOrderActions({ invoices: [{ id: "i", status: "SENT" }] }, status, both));
    expect(k).not.toContain("shipByCarrier");
    expect(k).not.toContain("switchToDelivery");
  });
  it("CONFIRMED keeps its other buttons ahead of the moves", () => {
    expect(keys(posOrderActions({ invoices: [] }, "CONFIRMED", both))).toEqual([
      "createInvoice",
      "handOver",
      "readyForPickup",
      "switchToDelivery",
      "shipByCarrier",
    ]);
  });
});

describe("posMoveConfirm (web FulfillPathMoveConfirm copy)", () => {
  it("ROUTE keeps the existing Switch to delivery confirm", () => {
    expect(posMoveConfirm("ROUTE")).toEqual({
      title: "Switch to delivery",
      message: "Move this order onto the delivery route instead of pickup?",
      confirmText: "Switch to delivery",
    });
  });
  it("SHIP names the carrier and tracking, word for word with web", () => {
    const c = posMoveConfirm("SHIP");
    expect(c.title).toBe("Move this order off in-store pickup?");
    expect(c.message).toBe(
      "It will no longer be a pickup order. It will ship by carrier: add the carrier and tracking number in the Shipment card, then mark it shipped.",
    );
    expect(c.message).toMatch(/carrier/);
    expect(c.message).toMatch(/tracking number/);
    expect(c.confirmText).toBe("Move order");
  });
  it("a failed move names the path it tried", () => {
    expect(posMoveFailedCopy("ROUTE")).toBe(
      "Couldn't switch to delivery. Check the order and try again.",
    );
    expect(posMoveFailedCopy("SHIP")).toBe(
      "Couldn't ship by carrier. Check the order and try again.",
    );
  });
});
