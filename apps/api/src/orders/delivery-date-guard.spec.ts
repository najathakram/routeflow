import { BadRequestException } from "@nestjs/common";
import { assertDeliveryDateNotPast, tenantTodayDay } from "./delivery-date-guard";

/**
 * Row 718 — the server-side twin of the Create Order modal's "That day has passed" check. A requested
 * delivery day before the TENANT's today (its own time zone, `common/tenant-time-zone.ts`) is refused
 * with a coded 400; today is fine. On a change, only a date that CHANGES to a past day is refused.
 */

const stubPrisma = (timezone: string | null | undefined, tenantId: string | null = "t-1") => ({
  getTenantId: () => tenantId,
  tenantConfig: { findUnique: jest.fn(async () => (timezone === undefined ? null : { timezone })) },
});

/** The code the 400 carries (a literal on purpose: this spec must fail on behaviour, not on a missing constant). */
const CODE = "DELIVERY_DATE_IN_PAST";

async function refusal(p: Promise<unknown>): Promise<BadRequestException> {
  try {
    await p;
  } catch (e) {
    return e as BadRequestException;
  }
  throw new Error("expected a refusal, got a resolve");
}

describe("tenantTodayDay", () => {
  it("is the tenant's calendar day, not the UTC day", () => {
    // 03:00Z on the 23rd is still the 22nd in Los Angeles and already the 23rd in Auckland.
    const now = new Date("2026-10-23T03:00:00Z");
    expect(tenantTodayDay("America/Los_Angeles", now)).toBe("2026-10-22");
    expect(tenantTodayDay("UTC", now)).toBe("2026-10-23");
    expect(tenantTodayDay("Pacific/Auckland", now)).toBe("2026-10-23");
  });
});

describe("assertDeliveryDateNotPast", () => {
  const NOW = new Date("2026-10-22T15:00:00Z"); // 11:00 on the 22nd in New York

  it("refuses a day before the tenant's today with 400 DELIVERY_DATE_IN_PAST", async () => {
    const e = await refusal(
      assertDeliveryDateNotPast(stubPrisma("America/New_York"), "2026-10-21", { now: NOW }),
    );
    expect(e).toBeInstanceOf(BadRequestException);
    expect(e.getStatus()).toBe(400);
    expect(e.getResponse()).toMatchObject({
      code: CODE,
      today: "2026-10-22",
      requestedDeliveryDate: "2026-10-21",
    });
    expect((e.getResponse() as { message: string }).message).toMatch(/passed|past/i);
  });

  it("accepts today and any later day, and a missing date", async () => {
    const prisma = stubPrisma("America/New_York");
    for (const raw of ["2026-10-22", "2026-10-23", "2027-01-01", undefined, null, ""]) {
      await expect(assertDeliveryDateNotPast(prisma, raw, { now: NOW })).resolves.toBeUndefined();
    }
  });

  it("measures on the TENANT's day when it differs from the UTC day (behind UTC)", async () => {
    // 03:00Z on the 23rd: UTC says the 23rd, a Los Angeles tenant is still on the 22nd.
    const now = new Date("2026-10-23T03:00:00Z");
    const la = stubPrisma("America/Los_Angeles");
    await expect(assertDeliveryDateNotPast(la, "2026-10-22", { now })).resolves.toBeUndefined();
    const e = await refusal(assertDeliveryDateNotPast(la, "2026-10-21", { now }));
    expect(e.getResponse()).toMatchObject({ code: CODE, today: "2026-10-22" });
    // The same instant for a UTC tenant: the 22nd has passed.
    const e2 = await refusal(assertDeliveryDateNotPast(stubPrisma("UTC"), "2026-10-22", { now }));
    expect(e2.getResponse()).toMatchObject({ code: CODE, today: "2026-10-23" });
  });

  it("measures on the TENANT's day when it differs from the UTC day (ahead of UTC)", async () => {
    // 20:00Z on the 22nd: UTC says the 22nd, an Auckland tenant (UTC+13) is already on the 23rd.
    const now = new Date("2026-10-22T20:00:00Z");
    const nz = stubPrisma("Pacific/Auckland");
    const e = await refusal(assertDeliveryDateNotPast(nz, "2026-10-22", { now }));
    expect(e.getResponse()).toMatchObject({ code: CODE, today: "2026-10-23" });
    await expect(assertDeliveryDateNotPast(nz, "2026-10-23", { now })).resolves.toBeUndefined();
  });

  it("reads the literal day of a datetime string, ignoring its offset", async () => {
    const prisma = stubPrisma("America/New_York");
    const e = await refusal(
      assertDeliveryDateNotPast(prisma, "2026-10-21T23:30:00-05:00", { now: NOW }),
    );
    expect(e.getResponse()).toMatchObject({ code: CODE });
    await expect(
      assertDeliveryDateNotPast(prisma, "2026-10-22T00:00:00.000Z", { now: NOW }),
    ).resolves.toBeUndefined();
  });

  it("falls back to the UTC day for a tenant with no valid zone", async () => {
    const now = new Date("2026-10-22T01:00:00Z");
    for (const tz of [null, undefined, "Not/AZone"]) {
      const prisma = stubPrisma(tz as never);
      await expect(
        assertDeliveryDateNotPast(prisma, "2026-10-22", { now }),
      ).resolves.toBeUndefined();
      await refusal(assertDeliveryDateNotPast(prisma, "2026-10-21", { now }));
    }
  });

  it("uses the tenant id the caller passes, ahead of the ambient one", async () => {
    const prisma = stubPrisma("UTC", "ambient");
    await assertDeliveryDateNotPast(prisma, "2026-10-23", { now: NOW, tenantId: "explicit" });
    expect(prisma.tenantConfig.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: "explicit" } }),
    );
  });

  describe("on a change (an existing date)", () => {
    const prisma = stubPrisma("America/New_York");

    it("an unchanged past date is accepted (the order is still editable)", async () => {
      await expect(
        assertDeliveryDateNotPast(prisma, "2026-10-10", {
          now: NOW,
          existing: new Date("2026-10-10T00:00:00.000Z"),
        }),
      ).resolves.toBeUndefined();
      await expect(
        assertDeliveryDateNotPast(prisma, "2026-10-10T00:00:00.000Z", {
          now: NOW,
          existing: "2026-10-10T00:00:00.000Z",
        }),
      ).resolves.toBeUndefined();
    });

    it("a change to a different past day is refused", async () => {
      const e = await refusal(
        assertDeliveryDateNotPast(prisma, "2026-10-11", {
          now: NOW,
          existing: new Date("2026-10-10T00:00:00.000Z"),
        }),
      );
      expect(e.getResponse()).toMatchObject({ code: CODE });
    });

    it("a change to today or later is accepted, even from a past date", async () => {
      for (const raw of ["2026-10-22", "2026-11-01"]) {
        await expect(
          assertDeliveryDateNotPast(prisma, raw, {
            now: NOW,
            existing: new Date("2026-10-10T00:00:00.000Z"),
          }),
        ).resolves.toBeUndefined();
      }
    });

    it("no date in the change means nothing to judge", async () => {
      await expect(
        assertDeliveryDateNotPast(prisma, undefined, {
          now: NOW,
          existing: new Date("2026-10-10T00:00:00.000Z"),
        }),
      ).resolves.toBeUndefined();
    });
  });
});

// Row 735(c): the tenant's day for a UTC-10 tenant and across DST transitions.
describe("assertDeliveryDateNotPast — UTC-10 and DST (row 735)", () => {
  const ok = (zone: string, raw: string, iso: string) =>
    expect(
      assertDeliveryDateNotPast(stubPrisma(zone), raw, { now: new Date(iso) }),
    ).resolves.toBeUndefined();
  const refused = async (zone: string, raw: string, iso: string, today: string) => {
    const e = await refusal(
      assertDeliveryDateNotPast(stubPrisma(zone), raw, { now: new Date(iso) }),
    );
    expect(e.getResponse()).toMatchObject({ code: CODE, today });
  };

  it("Pacific/Honolulu (UTC-10): 05:00Z on the 22nd is 19:00 on the 21st, so the 21st is today and the 20th is past", async () => {
    await ok("Pacific/Honolulu", "2026-10-21", "2026-10-22T05:00:00Z");
    await refused("Pacific/Honolulu", "2026-10-20", "2026-10-22T05:00:00Z", "2026-10-21");
    // five hours later the tenant is on the 22nd and the 21st has passed
    await refused("Pacific/Honolulu", "2026-10-21", "2026-10-22T10:00:00Z", "2026-10-22");
  });

  it("America/Chicago fall-back (2026-11-01 is 25 hours long): the day boundary follows CST, not the CDT offset", async () => {
    await ok("America/Chicago", "2026-11-01", "2026-11-02T05:30:00Z"); // 23:30 CST on the 1st
    await refused("America/Chicago", "2026-11-01", "2026-11-02T06:30:00Z", "2026-11-02"); // 00:30 CST on the 2nd
    await ok("America/Chicago", "2026-11-01", "2026-11-01T06:30:00Z"); // 01:30 CDT
    await ok("America/Chicago", "2026-11-01", "2026-11-01T07:30:00Z"); // 01:30 CST, the repeated hour
  });

  it("America/New_York spring-forward (2026-03-08 is 23 hours long): 23:30 EDT is still the 8th, 00:30 EDT the 9th", async () => {
    await ok("America/New_York", "2026-03-08", "2026-03-09T03:30:00Z");
    await refused("America/New_York", "2026-03-08", "2026-03-09T04:30:00Z", "2026-03-09");
  });

  it("America/New_York fall-back (2026-11-01): 23:30 EST on the 1st is 04:30Z on the 2nd", async () => {
    await ok("America/New_York", "2026-11-01", "2026-11-02T04:30:00Z");
    await refused("America/New_York", "2026-11-01", "2026-11-02T05:30:00Z", "2026-11-02");
  });
});
