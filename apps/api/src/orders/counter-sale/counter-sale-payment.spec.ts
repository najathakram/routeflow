import { BadRequestException } from "@nestjs/common";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { CounterSalePaymentDto } from "./counter-sale.dto";
import {
  allocateOldestFirst,
  assertCheckNotPostdated,
  assertCheckNotPostdatedForTenant,
  assertPaymentShape,
  planCounterPayment,
  toPrismaMethod,
} from "./counter-sale-payment";

/**
 * Counter sale payment rules (SA-655). Shape checks run BEFORE anything is written; the tender
 * checks need the server-computed POST-send balance, so `planCounterPayment` is a pure decision the
 * service takes after the sale commits. Fixtures are plain numbers, no tenant data.
 */
const codeOf = (fn: () => void) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(BadRequestException);
    return (e as BadRequestException).getResponse() as { code?: string };
  }
  throw new Error("expected a BadRequestException");
};

describe("assertPaymentShape (pre-create)", () => {
  it("a CHECK needs a check number", () => {
    expect(codeOf(() => assertPaymentShape({ method: "CHECK" }, false)).code).toBe(
      "COUNTER_CHECK_NUMBER_REQUIRED",
    );
    expect(
      codeOf(() => assertPaymentShape({ method: "CHECK", reference: "   " }, false)).code,
    ).toBe("COUNTER_CHECK_NUMBER_REQUIRED");
    expect(() => assertPaymentShape({ method: "CHECK", reference: "1042" }, false)).not.toThrow();
  });

  it("a walk-in cannot buy on account; a named customer can", () => {
    expect(codeOf(() => assertPaymentShape({ method: "ON_ACCOUNT" }, true)).code).toBe(
      "WALK_IN_NO_ACCOUNT",
    );
    expect(() => assertPaymentShape({ method: "ON_ACCOUNT" }, false)).not.toThrow();
  });

  it("a negative or non-finite amount is a 400", () => {
    expect(() => assertPaymentShape({ method: "CASH", amount: -1 }, false)).toThrow(
      BadRequestException,
    );
    expect(() => assertPaymentShape({ method: "CASH", amount: Number.NaN }, false)).toThrow(
      BadRequestException,
    );
    expect(() => assertPaymentShape({ method: "CASH", amount: 0 }, false)).not.toThrow();
  });
});

describe("toPrismaMethod", () => {
  it("CARD is stored as CREDIT_CARD; CASH and CHECK are unchanged; ON_ACCOUNT has no payment", () => {
    expect(toPrismaMethod("CARD")).toBe("CREDIT_CARD");
    expect(toPrismaMethod("CASH")).toBe("CASH");
    expect(toPrismaMethod("CHECK")).toBe("CHECK");
    expect(toPrismaMethod("ON_ACCOUNT")).toBeNull();
  });
});

describe("planCounterPayment (against the POST-send balance)", () => {
  it("CASH tendered above the balance pays the balance and reports the change", () => {
    expect(planCounterPayment({ method: "CASH", amount: 50, balance: 37.25 })).toEqual({
      kind: "pay",
      amount: 37.25,
      tendered: 50,
    });
  });

  it("CASH with no amount is the exact balance", () => {
    expect(planCounterPayment({ method: "CASH", balance: 37.25 })).toEqual({
      kind: "pay",
      amount: 37.25,
      tendered: 37.25,
    });
  });

  it("CASH below the balance is a PARTIAL payment of exactly what was tendered (no change)", () => {
    expect(planCounterPayment({ method: "CASH", amount: 30, balance: 37.25 })).toEqual({
      kind: "pay",
      amount: 30,
      tendered: 30,
    });
  });

  it("a zero tender is refused as TENDER_SHORT for CASH, CARD and CHECK", () => {
    for (const method of ["CASH", "CARD", "CHECK"] as const) {
      expect(planCounterPayment({ method, amount: 0, balance: 37.25 })).toEqual({
        kind: "refuse",
        code: "COUNTER_TENDER_SHORT",
      });
    }
  });

  it("CARD / CHECK: omitted = exact; above is COUNTER_PAYMENT_EXCEEDS_TOTAL; below is a partial", () => {
    for (const method of ["CARD", "CHECK"] as const) {
      expect(planCounterPayment({ method, balance: 12.5 })).toMatchObject({
        kind: "pay",
        amount: 12.5,
      });
      expect(planCounterPayment({ method, amount: 12.5, balance: 12.5 })).toMatchObject({
        kind: "pay",
        amount: 12.5,
      });
      expect(planCounterPayment({ method, amount: 13, balance: 12.5 })).toEqual({
        kind: "refuse",
        code: "COUNTER_PAYMENT_EXCEEDS_TOTAL",
      });
      expect(planCounterPayment({ method, amount: 10, balance: 12.5 })).toEqual({
        kind: "pay",
        amount: 10,
        tendered: 10,
      });
    }
  });

  it("rounds to cents before comparing (0.1 + 0.2 style float dust never refuses an exact tender)", () => {
    expect(planCounterPayment({ method: "CASH", amount: 0.3, balance: 0.1 + 0.2 })).toMatchObject({
      kind: "pay",
      amount: 0.3,
    });
  });

  it("ON_ACCOUNT, or nothing left to pay (credit covered it), records no payment", () => {
    expect(planCounterPayment({ method: "ON_ACCOUNT", balance: 20 })).toEqual({ kind: "none" });
    expect(planCounterPayment({ method: "CASH", amount: 5, balance: 0 })).toEqual({ kind: "none" });
  });
});

describe("allocateOldestFirst (a mixed regulated order's sibling invoices)", () => {
  const siblings = [
    { id: "inv-1", balance: 30 },
    { id: "inv-2", balance: 7.25 },
  ];
  it("settles the oldest invoice first and never over-allocates", () => {
    expect(allocateOldestFirst(siblings, 37.25)).toEqual([
      { invoiceId: "inv-1", amount: 30 },
      { invoiceId: "inv-2", amount: 7.25 },
    ]);
    expect(allocateOldestFirst(siblings, 12)).toEqual([{ invoiceId: "inv-1", amount: 12 }]);
  });
  it("skips an invoice with nothing owing", () => {
    expect(
      allocateOldestFirst(
        [
          { id: "a", balance: 0 },
          { id: "b", balance: 4 },
        ],
        4,
      ),
    ).toEqual([{ invoiceId: "b", amount: 4 }]);
  });
});

describe("assertCheckNotPostdated (pre-create, tenant day)", () => {
  const today = "2026-10-22";
  it("a CHECK dated after the tenant's today is 400 COUNTER_CHECK_POSTDATED", () => {
    expect(
      codeOf(() =>
        assertCheckNotPostdated(
          { method: "CHECK", reference: "1", checkDate: "2026-10-23" },
          today,
        ),
      ).code,
    ).toBe("COUNTER_CHECK_POSTDATED");
  });
  it("today, earlier, no date, and any other method pass", () => {
    for (const checkDate of ["2026-10-22", "2026-10-21", "2025-01-01", undefined]) {
      expect(() =>
        assertCheckNotPostdated({ method: "CHECK", reference: "1", checkDate }, today),
      ).not.toThrow();
    }
    expect(() =>
      assertCheckNotPostdated({ method: "CASH", checkDate: "2027-01-01" }, today),
    ).not.toThrow();
  });
  it("a checkDate that is not a real calendar day is a plain 400", () => {
    for (const checkDate of ["2026-02-30", "tomorrow", "2026-10-2", "2026-10-23T00:00:00Z"]) {
      expect(() =>
        assertCheckNotPostdated({ method: "CHECK", reference: "1", checkDate }, today),
      ).toThrow(BadRequestException);
    }
  });
});

describe("CounterSalePaymentDto.checkDate", () => {
  const errs = (o: object) => validate(plainToInstance(CounterSalePaymentDto, o));
  it("accepts a YYYY-MM-DD day or nothing; rejects anything else", async () => {
    expect(await errs({ method: "CHECK", reference: "1", checkDate: "2026-10-22" })).toHaveLength(
      0,
    );
    expect(await errs({ method: "CHECK", reference: "1" })).toHaveLength(0);
    expect(await errs({ method: "CHECK", reference: "1", checkDate: "soon" })).not.toHaveLength(0);
    expect(await errs({ method: "CHECK", reference: "1", checkDate: 20261022 })).not.toHaveLength(
      0,
    );
  });
});

describe("assertCheckNotPostdatedForTenant (the one tenant-today reader)", () => {
  const prismaFor = (timezone: string | null, tenantId: string | null = "t-1") => ({
    getTenantId: () => tenantId,
    tenantConfig: { findUnique: jest.fn().mockResolvedValue(timezone ? { timezone } : null) },
  });
  // 03:00Z on the 23rd: UTC is already the 23rd, Los Angeles is still the 22nd.
  const now = new Date("2026-10-23T03:00:00.000Z");

  it("tenant today while UTC is already tomorrow: a check dated the tenant's today is ACCEPTED", async () => {
    await expect(
      assertCheckNotPostdatedForTenant(
        prismaFor("America/Los_Angeles"),
        { method: "CHECK", reference: "1", checkDate: "2026-10-22" },
        now,
      ),
    ).resolves.toBeUndefined();
  });

  it("the same tenant: the UTC day (its tomorrow) is refused", async () => {
    await expect(
      assertCheckNotPostdatedForTenant(
        prismaFor("America/Los_Angeles"),
        { method: "CHECK", reference: "1", checkDate: "2026-10-23" },
        now,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("a tenant with no zone falls back to FALLBACK_ZONE (UTC): its UTC today is accepted, UTC tomorrow refused", async () => {
    const noZone = prismaFor(null);
    await expect(
      assertCheckNotPostdatedForTenant(
        noZone,
        { method: "CHECK", reference: "1", checkDate: "2026-10-23" },
        now,
      ),
    ).resolves.toBeUndefined();
    await expect(
      assertCheckNotPostdatedForTenant(
        noZone,
        { method: "CHECK", reference: "1", checkDate: "2026-10-24" },
        now,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
