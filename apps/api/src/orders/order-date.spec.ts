/**
 * W-1188: the one order-date gate. Master values read at 27d8125e1 (the red run): R2 400 "cannot be in the future";
 * R4 accepted 2026-11-10 (the UTC-day leak, `Math.max` in parseOrderDate); R6 400 "more than 2 years" (an instant
 * floor); R7 400 "in the future". R3 and R5 are guards (status / unchanged).
 */
import { BadRequestException, ConflictException, ForbiddenException } from "@nestjs/common";
import { assertOrderDateOpen, orderDatePolicyFor, resolveOrderDate } from "./order-date";

const CHI = "America/Chicago";
const monNoon = new Date("2026-11-09T18:00:00.000Z"); // Mon 12:00 CST
const monEvening = new Date("2026-11-10T02:00:00.000Z"); // Mon 20:00 CST, the UTC day is already the 10th
const gate = (raw: string, policy: "COUNTER" | "OFFICE", now: Date, extra: object = {}) =>
  resolveOrderDate(raw, { role: "OPERATOR", deniedGroups: [], zone: CHI, policy, now, ...extra });
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e: any) {
    return e.getResponse();
  }
  return null;
};

describe("resolveOrderDate", () => {
  it("R2: the counter accepts a future day, stored as midnight UTC of that day", () => {
    expect(gate("2026-11-16", "COUNTER", monNoon)?.toISOString()).toBe("2026-11-16T00:00:00.000Z");
  });

  it("R3 (guard on status, red on code): the office refuses the same day with ORDER_DATE_OUT_OF_RANGE", () => {
    expect(() => gate("2026-11-16", "OFFICE", monNoon)).toThrow(BadRequestException);
    expect(code(() => gate("2026-11-16", "OFFICE", monNoon))).toMatchObject({
      code: "ORDER_DATE_OUT_OF_RANGE",
      policy: "OFFICE",
      max: "2026-11-09",
    });
  });

  it("R4: office, Chicago evening: the tenant's tomorrow is refused (no UTC-day leak)", () => {
    expect(() => gate("2026-11-10", "OFFICE", monEvening)).toThrow(BadRequestException);
  });

  it("R5 (guard): the tenant's own today is accepted at the same instant", () => {
    expect(gate("2026-11-09", "OFFICE", monEvening)?.toISOString()).toBe(
      "2026-11-09T00:00:00.000Z",
    );
  });

  it("R6: two years minus one day is accepted in the evening (the floor is a day, not an instant)", () => {
    expect(gate("2024-11-10", "OFFICE", monEvening)?.toISOString()).toBe(
      "2024-11-10T00:00:00.000Z",
    );
    expect(() => gate("2024-11-08", "OFFICE", monEvening)).toThrow(BadRequestException);
  });

  it("R7: the counter's cap is 366 days: 367 ahead is refused with the max named", () => {
    expect(code(() => gate("2027-11-11", "COUNTER", monNoon))).toMatchObject({
      code: "ORDER_DATE_OUT_OF_RANGE",
      max: "2027-11-10",
    });
    expect(gate("2027-11-10", "COUNTER", monNoon)).toBeDefined();
  });

  it("reads a datetime by its literal day and refuses a day that does not exist", () => {
    expect(gate("2026-11-06T23:59:00-05:00", "OFFICE", monNoon)?.toISOString()).toBe(
      "2026-11-06T00:00:00.000Z",
    );
    expect(() => gate("2026-02-31", "OFFICE", monNoon)).toThrow("Invalid order date");
  });

  it("an unknown zone reads UTC; nothing sent is nothing resolved", () => {
    expect(() => gate("2026-11-10", "OFFICE", monEvening, { zone: "Not/AZone" })).not.toThrow();
    expect(
      resolveOrderDate(undefined, {
        role: "CUSTOMER",
        deniedGroups: [],
        zone: CHI,
        policy: "OFFICE",
      }),
    ).toBeUndefined();
  });

  it("only staff who hold SET_ORDER_DATE: customer, driver and a denied operator get 403", () => {
    for (const role of ["CUSTOMER", "DRIVER", "SUPER_ADMIN"]) {
      expect(() => gate("2026-11-06", "OFFICE", monNoon, { role })).toThrow(ForbiddenException);
    }
    expect(() => gate("2026-11-06", "OFFICE", monNoon, { deniedGroups: ["ORDERS"] })).toThrow(
      ForbiddenException,
    );
    expect(gate("2026-11-06", "OFFICE", monNoon, { role: "TENANT_ADMIN" })).toBeDefined();
  });

  it("the policy comes from the counter flag only", () => {
    expect(orderDatePolicyFor({ counterSale: true })).toBe("COUNTER");
    expect(orderDatePolicyFor({})).toBe("OFFICE");
    expect(orderDatePolicyFor(undefined)).toBe("OFFICE");
  });
});

describe("assertOrderDateOpen (R15 unit side: refused before any read of the cart when nothing is locked)", () => {
  const day = new Date("2026-10-28T00:00:00.000Z");
  const db = (locked: boolean, regulated: boolean) => ({
    regulatedFiling: {
      findMany: jest.fn().mockImplementation(async (args: any) =>
        args.take === 1
          ? locked
            ? [{ id: "f1" }]
            : []
          : [
              {
                id: "f1",
                trackedCategoryId: "cat1",
                periodKey: "2026-10",
                periodStart: new Date("2026-10-01T00:00:00Z"),
                periodEnd: new Date("2026-11-01T00:00:00Z"),
                status: "LOCKED",
              },
            ],
      ),
    },
    product: {
      findMany: jest
        .fn()
        .mockResolvedValue([{ id: "p1", trackedCategoryId: regulated ? "cat1" : null }]),
    },
    trackedCategory: { findMany: jest.fn().mockResolvedValue([{ id: "cat1", name: "Tobacco" }]) },
  });

  it("a tenant with no locked filing pays one read and never reads the cart", async () => {
    const d = db(false, true);
    await assertOrderDateOpen(d, { tenantId: "t1", orderDay: day, productIds: ["p1"] });
    expect(d.product.findMany).not.toHaveBeenCalled();
  });

  it("a locked month with a regulated line: 409 ORDER_DATE_PERIOD_LOCKED with the period and category", async () => {
    const err: any = await assertOrderDateOpen(db(true, true), {
      tenantId: "t1",
      orderDay: day,
      productIds: ["p1"],
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({
      code: "ORDER_DATE_PERIOD_LOCKED",
      periodKey: "2026-10",
      categoryName: "Tobacco",
    });
  });

  it("R16 (guard): the same month with no regulated line is not refused", async () => {
    await expect(
      assertOrderDateOpen(db(true, false), { tenantId: "t1", orderDay: day, productIds: ["p1"] }),
    ).resolves.toBeUndefined();
  });
});
