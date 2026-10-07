import { dateAndShipmentFilters } from "./list-filters";

describe("dateAndShipmentFilters", () => {
  it("adds nothing when no filter is given (every existing caller is unchanged)", () => {
    expect(dateAndShipmentFilters({})).toEqual({});
  });

  it("keeps the requested-delivery window exactly as the list always built it", () => {
    expect(
      dateAndShipmentFilters({ deliveryDateFrom: "2026-10-01", deliveryDateTo: "2026-10-05" }),
    ).toEqual({
      requestedDeliveryDate: { gte: new Date("2026-10-01"), lte: new Date("2026-10-05") },
    });
    expect(dateAndShipmentFilters({ deliveryDateTo: "2026-10-05" })).toEqual({
      requestedDeliveryDate: { lte: new Date("2026-10-05") },
    });
  });

  it("shippedFrom filters on shippedAt (the ship transition's stamp)", () => {
    expect(dateAndShipmentFilters({ shippedFrom: "2026-09-27" })).toEqual({
      shippedAt: { gte: new Date("2026-09-27") },
    });
  });

  it("hasTracking=false means NO tracking number yet; true means one is set", () => {
    expect(dateAndShipmentFilters({ hasTracking: false })).toEqual({
      shippingTrackingNumber: null,
    });
    expect(dateAndShipmentFilters({ hasTracking: true })).toEqual({
      shippingTrackingNumber: { not: null },
    });
  });

  it("the filters compose", () => {
    expect(dateAndShipmentFilters({ shippedFrom: "2026-09-27", hasTracking: false })).toEqual({
      shippedAt: { gte: new Date("2026-09-27") },
      shippingTrackingNumber: null,
    });
  });
});
