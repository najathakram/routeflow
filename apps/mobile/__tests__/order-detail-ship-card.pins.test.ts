import { readFileSync } from "fs";
import { join } from "path";
import { shipmentCardPlacement } from "../lib/shipment-display";

/**
 * Row 505 (mobile twin of web M8): on a SHIP order the Shipment card sits ABOVE the totals (web: above
 * Summary; mobile's Summary is the Items card with its totals). Any other order keeps today's slot, after
 * the Invoice card. The path move goes through ONE fulfil-path PATCH carrying the chosen path.
 */
const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");
const screen = read("app/(operator)/(tabs)/orders/[id].tsx");
const posApi = read("lib/api/pos-orders.ts");

describe("shipmentCardPlacement", () => {
  it("a SHIP order puts the card first; everything else keeps the after-invoice slot", () => {
    expect(shipmentCardPlacement("SHIP")).toBe("aboveItems");
    for (const p of ["ROUTE", "PICKUP", null, undefined, ""]) {
      expect(shipmentCardPlacement(p)).toBe("afterInvoice");
    }
  });
});

describe("order detail card order", () => {
  const at = (needle: string) => {
    const i = screen.indexOf(needle);
    expect(i).toBeGreaterThan(-1);
    return i;
  };
  it("renders the Shipment card once, in two mutually exclusive slots", () => {
    expect(screen.match(/<ShipmentSection\b/g)).toHaveLength(1);
    expect(screen).toContain(
      'const shipFirst = shipmentCardPlacement(order.fulfillPath) === "aboveItems"',
    );
    expect(screen).toContain("{shipFirst && shipmentCard}");
    expect(screen).toContain("{!shipFirst && shipmentCard}");
  });
  it("the SHIP slot is above Items (the totals); the other slot is after the Invoice card", () => {
    expect(at("{shipFirst && shipmentCard}")).toBeLessThan(at("{/* Items */}"));
    expect(at("{/* Status + customer */}")).toBeLessThan(at("{shipFirst && shipmentCard}"));
    expect(at("{!shipFirst && shipmentCard}")).toBeGreaterThan(at("R3: Invoice"));
    expect(at("{!shipFirst && shipmentCard}")).toBeLessThan(at("{/* POS mode:"));
  });
  it("keeps the shared M8 pieces on the card: not-shipped note, save decision, edit modal", () => {
    expect(screen).toContain("shipmentNotShippedNote(");
    expect(screen).toContain("shipmentSaveDecision(order, carrier, trackingNumber)");
    expect(screen).toContain("<ShipmentEditModal");
  });
});

describe("the POS action area", () => {
  it("feeds posOrderActions the account's move options (the capability source), not a constant", () => {
    expect(screen).toMatch(/useStaffFulfilment\(\)/);
    expect(screen).toMatch(/posMoveOptions\(/);
    expect(screen).toMatch(/posOrderActions\(order, order\.status, [^)]*moveOptions/);
  });
  it("one handler runs both moves with the action's own path and the path's confirm copy", () => {
    expect(screen).toContain('case "shipByCarrier":');
    expect(screen).toContain("posMoveConfirm(path)");
    expect(screen).toContain("posMoveFailedCopy(path)");
    expect(screen).not.toMatch(/switchToDeliveryMut\.mutate\(order\.id,/);
  });
  it("the moves sit in the POS card (one list, one wrap unit); Delete order stays last of the screen", () => {
    const pos = screen.indexOf("{/* POS mode: Confirmed");
    const more = screen.indexOf("<Text style={styles.cardTitle}>More</Text>");
    const del = screen.lastIndexOf("Delete order");
    expect(pos).toBeGreaterThan(-1);
    expect(pos).toBeLessThan(more);
    expect(more).toBeLessThan(del);
    // nothing but the closing tags follow the Delete button
    expect(screen.slice(del)).not.toMatch(/onPress=/);
    expect(screen.slice(pos, more)).toContain("posActions.map(");
  });
});

describe("the move endpoint", () => {
  it("PATCHes /orders/:id/fulfill-path with the chosen path (web usePatchOrderFulfillPath), no hard-coded ROUTE", () => {
    const m = posApi.slice(posApi.indexOf("export function useMoveOrderOffPickup"));
    // row 510: the restriction ack rides along (`...ack`); the path is still the chosen one
    expect(m).toContain("apiClient.patch(`/orders/${id}/fulfill-path`, { fulfillPath, ...ack })");
    const fn = m.split("\n").find((l) => l.includes("mutationFn")) ?? "";
    expect(fn).not.toContain("ROUTE");
  });
});
