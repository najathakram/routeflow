import { shipmentListShippedAt } from "@/lib/shipment-display";

describe("shipmentListShippedAt (Shipments list, fold 1)", () => {
  const shippedAt = "2026-06-20T12:00:00.000Z";

  it.each(["CONFIRMED", "PENDING"])("an unmarked order (%s) shows no shipped date", (status) => {
    expect(shipmentListShippedAt({ shippedAt, order: { status } })).toBeNull();
  });

  it.each(["OUT_FOR_DELIVERY", "PARTIALLY_DELIVERED", "DELIVERED"])(
    "a shipped order (%s) keeps the date",
    (status) => {
      expect(shipmentListShippedAt({ shippedAt, order: { status } })).toBe(shippedAt);
    },
  );

  it("unchanged: no order (standalone invoice) keeps the date; no date stays empty", () => {
    expect(shipmentListShippedAt({ shippedAt })).toBe(shippedAt);
    expect(shipmentListShippedAt({ shippedAt, order: null })).toBe(shippedAt);
    expect(shipmentListShippedAt({ shippedAt: null, order: { status: "DELIVERED" } })).toBeNull();
  });
});
