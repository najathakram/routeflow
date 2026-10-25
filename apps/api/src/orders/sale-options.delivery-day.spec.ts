import { UserRole } from "@prisma/client";
import { BadRequestException } from "@nestjs/common";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import type { CreateSaleDto } from "./dto/create-sale.dto";
import { resolveSaleDelivery } from "./sale-options";

/**
 * Row 735(b) — resolveSaleDelivery (the delivery-date picker of POST /orders/sell and the counter sale)
 * decides "delivered on a past/today date" vs "scheduled for a later date" on the TENANT's calendar day
 * (its zone, the same helpers as delivery-date-guard.ts), not on the UTC day. A day AFTER the tenant's
 * today is scheduled (deliveredNow false, requestedDeliveryDate carries it); today and earlier is a
 * delivered sale on that day.
 */

const staff = { sub: "op-1", role: UserRole.OPERATOR } as unknown as JwtPayload;
const sale = (deliveredOn: string) =>
  ({ customerId: "c1", items: [], deliveredNow: false, deliveredOn }) as unknown as CreateSaleDto;

const delivered = (r: ReturnType<typeof resolveSaleDelivery>, day: string) => {
  expect(r.deliveredNow).toBe(true);
  expect(r.deliveredAt?.toISOString().slice(0, 10)).toBe(day);
  expect(r.requestedDeliveryDate).toBeUndefined();
};
const scheduled = (r: ReturnType<typeof resolveSaleDelivery>, day: string) => {
  expect(r.deliveredNow).toBe(false);
  expect(r.requestedDeliveryDate).toBe(day);
};

describe("resolveSaleDelivery — the tenant's day (row 735b)", () => {
  it("UTC tenant (or none): today delivers, tomorrow schedules (unchanged)", () => {
    const now = new Date("2026-10-22T15:00:00Z");
    for (const zone of ["UTC", null, undefined]) {
      delivered(resolveSaleDelivery(sale("2026-10-22"), staff, zone, now), "2026-10-22");
      delivered(resolveSaleDelivery(sale("2026-10-21"), staff, zone, now), "2026-10-21");
      scheduled(resolveSaleDelivery(sale("2026-10-23"), staff, zone, now), "2026-10-23");
    }
  });

  it("UTC-10 (Pacific/Honolulu): at 05:00Z on the 22nd it is still the 21st there, so the 22nd is LATER", () => {
    const now = new Date("2026-10-22T05:00:00Z"); // 19:00 on the 21st in Honolulu
    const zone = "Pacific/Honolulu";
    delivered(resolveSaleDelivery(sale("2026-10-21"), staff, zone, now), "2026-10-21");
    scheduled(resolveSaleDelivery(sale("2026-10-22"), staff, zone, now), "2026-10-22");
    // the UTC reading it replaces would have delivered the 22nd
    delivered(resolveSaleDelivery(sale("2026-10-22"), staff, "UTC", now), "2026-10-22");
  });

  it("UTC-10 at 10:00Z: the tenant has crossed midnight, the 22nd is today", () => {
    const now = new Date("2026-10-22T10:00:00Z"); // 00:00 on the 22nd in Honolulu
    delivered(
      resolveSaleDelivery(sale("2026-10-22"), staff, "Pacific/Honolulu", now),
      "2026-10-22",
    );
    scheduled(
      resolveSaleDelivery(sale("2026-10-23"), staff, "Pacific/Honolulu", now),
      "2026-10-23",
    );
  });

  it("ahead of UTC (Pacific/Auckland): at 20:00Z on the 22nd it is the 23rd there, so the 23rd is TODAY and delivers", () => {
    const now = new Date("2026-10-22T20:00:00Z"); // 09:00 on the 23rd in Auckland (UTC+13)
    // parseOrderDate's UTC "future" bound must not turn the tenant's own today into a 400
    delivered(
      resolveSaleDelivery(sale("2026-10-23"), staff, "Pacific/Auckland", now),
      "2026-10-23",
    );
    scheduled(
      resolveSaleDelivery(sale("2026-10-24"), staff, "Pacific/Auckland", now),
      "2026-10-24",
    );
  });

  it("an invalid or empty zone falls back to the UTC day, never throws", () => {
    const now = new Date("2026-10-22T05:00:00Z");
    for (const zone of ["Not/AZone", ""]) {
      delivered(resolveSaleDelivery(sale("2026-10-22"), staff, zone, now), "2026-10-22");
      scheduled(resolveSaleDelivery(sale("2026-10-23"), staff, zone, now), "2026-10-23");
    }
  });

  it("reads the literal day of a datetime string, ignoring its offset (the house rule)", () => {
    const now = new Date("2026-10-22T15:00:00Z"); // the 22nd in New York
    // 2026-10-23T00:30-04:00 is the 23rd on its face (04:30Z): a later day than the tenant's 22nd
    scheduled(
      resolveSaleDelivery(sale("2026-10-23T00:30:00-04:00"), staff, "America/New_York", now),
      "2026-10-23T00:30:00-04:00",
    );
  });

  describe("DST transitions", () => {
    // America/Chicago falls back on 2026-11-01 at 02:00 CDT: that day is 25 hours long.
    // Midnight Nov 1 is 05:00Z (CDT, UTC-5); midnight Nov 2 is 06:00Z (CST, UTC-6).
    const chicago = "America/Chicago";

    it("fall-back day, before the repeated hour (01:30 CDT = 06:30Z): the 1st is today", () => {
      const now = new Date("2026-11-01T06:30:00Z");
      delivered(resolveSaleDelivery(sale("2026-11-01"), staff, chicago, now), "2026-11-01");
      scheduled(resolveSaleDelivery(sale("2026-11-02"), staff, chicago, now), "2026-11-02");
    });

    it("fall-back day, in the repeated hour (01:30 CST = 07:30Z): still the 1st", () => {
      const now = new Date("2026-11-01T07:30:00Z");
      delivered(resolveSaleDelivery(sale("2026-11-01"), staff, chicago, now), "2026-11-01");
      scheduled(resolveSaleDelivery(sale("2026-11-02"), staff, chicago, now), "2026-11-02");
    });

    it("fall-back day, 23:30 CST (05:30Z on the 2nd UTC): the tenant's day is still the 1st", () => {
      // a fixed CDT offset (UTC-5) would call this 00:30 on the 2nd
      const now = new Date("2026-11-02T05:30:00Z");
      delivered(resolveSaleDelivery(sale("2026-11-01"), staff, chicago, now), "2026-11-01");
      scheduled(resolveSaleDelivery(sale("2026-11-02"), staff, chicago, now), "2026-11-02");
    });

    it("fall-back day, just past local midnight (00:30 CST = 06:30Z on the 2nd): the 2nd is today", () => {
      const now = new Date("2026-11-02T06:30:00Z");
      delivered(resolveSaleDelivery(sale("2026-11-02"), staff, chicago, now), "2026-11-02");
      scheduled(resolveSaleDelivery(sale("2026-11-03"), staff, chicago, now), "2026-11-03");
    });

    it("spring-forward day (America/New_York, 2026-03-08, a 23-hour day): 23:30 EDT is still the 8th", () => {
      const now = new Date("2026-03-09T03:30:00Z"); // 23:30 EDT (UTC-4) on the 8th
      delivered(
        resolveSaleDelivery(sale("2026-03-08"), staff, "America/New_York", now),
        "2026-03-08",
      );
      scheduled(
        resolveSaleDelivery(sale("2026-03-09"), staff, "America/New_York", now),
        "2026-03-09",
      );
    });
  });

  it("without deliveredOn nothing changes: deliveredNow and requestedDeliveryDate pass through", () => {
    const dto = {
      customerId: "c1",
      items: [],
      deliveredNow: true,
      requestedDeliveryDate: "2026-12-01",
    } as unknown as CreateSaleDto;
    expect(resolveSaleDelivery(dto, staff, "Pacific/Honolulu")).toEqual({
      deliveredNow: true,
      deliveredAt: undefined,
      requestedDeliveryDate: "2026-12-01",
    });
  });

  it("a deliveredOn that is not a date is still refused 400", () => {
    expect(() => resolveSaleDelivery(sale("not-a-date"), staff, "UTC")).toThrow(
      BadRequestException,
    );
  });
});
